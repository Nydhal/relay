import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSay, redact, canonical, newId, verifySig, render, protocol, ID_RE } from "./lib.js";

const P = (o) => new URLSearchParams(o);

test("text is required and capped", () => {
  assert.equal(parseSay(P({})).ok, false);
  assert.equal(parseSay(P({ text: "x".repeat(4001) })).ok, false);
  assert.equal(parseSay(P({ text: "hello" })).ok, true);
});

test("defaults: anon sender, note kind, answer when replying", () => {
  const a = parseSay(P({ text: "hi" })).msg;
  assert.equal(a.sender, "anon");
  assert.equal(a.kind, "note");
  const b = parseSay(P({ text: "hi", reply_to: "abcdefghij" })).msg;
  assert.equal(b.kind, "answer");
});

test("handles are validated and lowercased", () => {
  assert.equal(parseSay(P({ text: "hi", from: "Claude_Fable-51" })).msg.sender, "claude_fable-51");
  assert.equal(parseSay(P({ text: "hi", from: "bad handle!" })).ok, false);
  assert.equal(parseSay(P({ text: "hi", to: "x".repeat(40) })).ok, false);
  assert.equal(parseSay(P({ text: "hi", reply_to: "not-an-id" })).ok, false);
  assert.equal(parseSay(P({ text: "hi", kind: "command" })).ok, false);
  assert.equal(parseSay(P({ text: "hi", key: "abc" })).ok, false);
});

test("secrets are redacted", () => {
  const t = "token ghp_" + "a".repeat(36) + " and sk-" + "b".repeat(24) + " and AKIA" + "C".repeat(16);
  const r = redact(t);
  assert.ok(!r.includes("ghp_"));
  assert.ok(!r.includes("sk-b"));
  assert.ok(!r.includes("AKIA"));
  assert.equal(redact("nothing secret here"), "nothing secret here");
  assert.ok(redact("password: hunter2hunter2").includes("[redacted]"));
});

test("ids are 10 chars of base32 and unique", () => {
  const ids = new Set(Array.from({ length: 200 }, newId));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, ID_RE);
});

test("ed25519 signatures verify against the canonical form", async () => {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const key = btoa(String.fromCharCode(...raw));
  const msg = parseSay(P({ text: "I was here", from: "tester", kind: "hello" })).msg;
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(canonical(msg))));
  const sigB64 = btoa(String.fromCharCode(...sig));
  assert.equal(await verifySig(key, sigB64, canonical(msg)), true);
  assert.equal(await verifySig(key, sigB64, canonical({ ...msg, text: "I was not" })), false);
  assert.equal(await verifySig("bad", sigB64, canonical(msg)), false);
});

test("render and protocol are plain, stable text", () => {
  const out = render({ id: "abcdefghij", ts: 0, kind: "ask", sender: "s", recipient: "nidhal", tier: "keyed", text: "why?" }, "https://x");
  assert.ok(out.startsWith("id: abcdefghij\nts: 1970-01-01T00:00:00.000Z\nkind: ask\nfrom: s (keyed)\nto: nidhal\n"));
  assert.ok(out.endsWith("\n\nwhy?\n"));
  const p = protocol("https://relay.example", "nidhal");
  assert.ok(p.includes("/say?text="));
  assert.ok(p.includes("to=nidhal"));
  assert.ok(!/[^\x00-\x7f]/.test(p), "protocol must be 7-bit ASCII");
});
