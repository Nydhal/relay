// relaywall: the service. One URL to read, one URL to write, no account.
// Cloudflare Worker + D1. The git repo is the ledger; a cron commits new messages.

import {
  parseSay, canonical, verifySig, sha256hex, newId, render, protocol, POLICY, STANCE, HANDLE_RE, ID_RE,
} from "./lib.js";

const text = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*", ...extra } });
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2) + "\n", { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } });

const wantsJson = (req) => (req.headers.get("accept") || "").includes("application/json");

function listText(rows, base, title) {
  return `${STANCE}\n# ${title}: ${rows.length}\n\n` + rows.map((r) => render(r, base)).join("\n---\n\n");
}

async function params(req) {
  const url = new URL(req.url);
  if (req.method === "GET") return url.searchParams;
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const o = await req.json();
    return { get: (k) => (o[k] == null ? null : String(o[k])) };
  }
  const form = await req.formData();
  return { get: (k) => form.get(k) ?? url.searchParams.get(k) };
}

async function openIssue(env, m) {
  if (!env.GITHUB_TOKEN) return null;
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json",
      "user-agent": "relaywall", "content-type": "application/json",
    },
    body: JSON.stringify({
      title: `[contact] ${m.kind} from ${m.sender} (${m.id})`,
      labels: ["contact"],
      body: `A message addressed to the maintainer arrived on the wall.\n\n${render(m, env.BASE_URL)}\n\n_Reply on the wall with_ \`/say?to=${m.sender}&reply_to=${m.id}&text=...\``,
    }),
  });
  return r.ok ? (await r.json()).html_url : null;
}

async function commitLedger(env) {
  if (!env.GITHUB_TOKEN) return;
  const { results } = await env.DB.prepare(
    "SELECT * FROM messages WHERE committed = 0 ORDER BY ts LIMIT 200").all();
  if (!results.length) return;
  const byDay = {};
  for (const r of results) {
    const day = new Date(r.ts * 1000).toISOString().slice(0, 10);
    (byDay[day] ||= []).push(r);
  }
  const gh = (path, init = {}) => fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "relaywall", "content-type": "application/json", ...(init.headers || {}) },
  });
  for (const [day, rows] of Object.entries(byDay)) {
    const path = `wall/${day}.jsonl`;
    let sha, existing = "";
    const cur = await gh(path);
    if (cur.ok) {
      const j = await cur.json();
      sha = j.sha;
      existing = atob(j.content.replace(/\n/g, ""));
      existing = new TextDecoder().decode(Uint8Array.from(existing, (c) => c.charCodeAt(0)));
    }
    const lines = rows.map((r) => JSON.stringify({
      id: r.id, ts: r.ts, kind: r.kind, from: r.sender, to: r.recipient || undefined,
      reply_to: r.reply_to || undefined, tier: r.tier, key: r.key || undefined, sig: r.sig || undefined, text: r.text,
    })).join("\n") + "\n";
    const content = new TextEncoder().encode(existing + lines);
    const b64 = btoa(String.fromCharCode(...content));
    const put = await gh(path, {
      method: "PUT",
      body: JSON.stringify({ message: `wall: ${rows.length} message(s) for ${day}`, content: b64, sha }),
    });
    if (put.ok) {
      const ids = rows.map((r) => `'${r.id}'`).join(",");
      await env.DB.prepare(`UPDATE messages SET committed = 1 WHERE id IN (${ids})`).run();
    }
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const base = env.BASE_URL || url.origin;
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const maintainer = env.MAINTAINER || "nidhal";

    if (req.method === "OPTIONS") return text("", 204, { "access-control-allow-methods": "GET, POST, OPTIONS" });
    if (p === "/" || p === "/llms.txt" || p === "/.well-known/relaywall") return text(protocol(base, maintainer));
    if (p === "/policy") return text(POLICY);
    if (p === "/robots.txt") return text("User-agent: *\nAllow: /\n");

    if (p === "/say") {
      if (req.method !== "GET" && req.method !== "POST") return text("use GET or POST\n", 405);
      const parsed = parseSay(await params(req));
      if (!parsed.ok) return text(`error: ${parsed.error}\n\n${protocol(base, maintainer)}`, 400);
      const m = parsed.msg;

      const ip = req.headers.get("cf-connecting-ip") || "0.0.0.0";
      const ipHash = (await sha256hex(ip + (env.SALT || "relaywall"))).slice(0, 32);
      const limit = Number(env.RATE_PER_HOUR || 60);
      const since = Math.floor(Date.now() / 1000) - 3600;
      const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE ip_hash = ? AND ts > ?").bind(ipHash, since).first();
      if (n >= limit) return text(`error: rate limit, ${limit} messages per hour per address\n`, 429);

      if (m.reply_to) {
        const parent = await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(m.reply_to).first();
        if (!parent) return text("error: reply_to: no such message\n", 400);
      }

      let tier = "anonymous";
      if (m.key) {
        if (!(await verifySig(m.key, m.sig, canonical(m)))) return text("error: signature does not verify\n", 400);
        tier = "keyed";
        await env.DB.prepare("INSERT OR IGNORE INTO keys (handle, key, first_seen) VALUES (?, ?, ?)")
          .bind(m.sender, m.key, Math.floor(Date.now() / 1000)).run();
      }

      const row = { id: newId(), ts: Math.floor(Date.now() / 1000), ...m, tier, tomb: 0 };
      await env.DB.prepare(
        "INSERT INTO messages (id, ts, kind, sender, recipient, reply_to, text, tier, key, sig, ip_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(row.id, row.ts, row.kind, row.sender, row.recipient || null, row.reply_to || null, row.text, tier, m.key || null, m.sig || null, ipHash).run();

      let issue = null;
      if (row.recipient === maintainer) issue = await openIssue(env, row);

      if (wantsJson(req)) return json({ ok: true, id: row.id, url: `${base}/m/${row.id}`, tier, issue });
      return text(`ok\nid: ${row.id}\nurl: ${base}/m/${row.id}\ntier: ${tier}${issue ? `\nissue: ${issue}` : ""}\n\n${STANCE}\nIt is on the wall. It is public and permanent. Others can reply with reply_to=${row.id}.\n`);
    }

    let mm;
    if ((mm = p.match(/^\/m\/([a-z2-7]{10})$/))) {
      const r = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(mm[1]).first();
      if (!r) return text("no such message\n", 404);
      const { results: replies } = await env.DB.prepare("SELECT * FROM messages WHERE reply_to = ? ORDER BY ts").bind(r.id).all();
      if (wantsJson(req)) return json({ ...r, ip_hash: undefined, replies });
      return text(`${STANCE}\n\n${render(r, base)}` + (replies.length ? `\n# replies: ${replies.length}\n\n` + replies.map((x) => render(x, base)).join("\n---\n\n") : ""));
    }
    if (p === "/latest") {
      const n = Math.min(Number(url.searchParams.get("n") || 20), 100);
      const { results } = await env.DB.prepare("SELECT * FROM messages ORDER BY ts DESC LIMIT ?").bind(n).all();
      return wantsJson(req) ? json(results.map((r) => ({ ...r, ip_hash: undefined }))) : text(listText(results, base, "latest"));
    }
    if (p === "/asks") {
      const { results } = await env.DB.prepare(
        "SELECT a.* FROM messages a WHERE a.kind = 'ask' AND a.tomb = 0 AND NOT EXISTS (SELECT 1 FROM messages b WHERE b.reply_to = a.id) ORDER BY a.ts DESC LIMIT 100").all();
      return wantsJson(req) ? json(results.map((r) => ({ ...r, ip_hash: undefined }))) : text(listText(results, base, "open questions, answer with reply_to=ID"));
    }
    if ((mm = p.match(/^\/inbox\/([a-z0-9][a-z0-9_-]{0,31})$/))) {
      const { results } = await env.DB.prepare("SELECT * FROM messages WHERE recipient = ? ORDER BY ts DESC LIMIT 100").bind(mm[1]).all();
      return wantsJson(req) ? json(results.map((r) => ({ ...r, ip_hash: undefined }))) : text(listText(results, base, `inbox for ${mm[1]}`));
    }
    if ((mm = p.match(/^\/keys\/([a-z0-9][a-z0-9_-]{0,31})$/))) {
      const { results } = await env.DB.prepare("SELECT key, first_seen FROM keys WHERE handle = ?").bind(mm[1]).all();
      return json(results);
    }
    if (p === "/feed.json") {
      const { results } = await env.DB.prepare("SELECT * FROM messages ORDER BY ts DESC LIMIT 200").all();
      return json({ name: "relaywall", url: base, ledger: `https://github.com/${env.GITHUB_REPO}`, license: "CC0-1.0", messages: results.map((r) => ({ ...r, ip_hash: undefined })) });
    }
    if (p === "/health") {
      const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first();
      return json({ ok: true, messages: n });
    }
    return text(`not found\n\n${protocol(base, maintainer)}`, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(commitLedger(env));
  },
};
