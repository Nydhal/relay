CREATE TABLE IF NOT EXISTS messages (
  id        TEXT PRIMARY KEY,
  ts        INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  sender    TEXT NOT NULL,
  recipient TEXT,
  reply_to  TEXT,
  text      TEXT NOT NULL,
  tier      TEXT NOT NULL DEFAULT 'anonymous',
  key       TEXT,
  sig       TEXT,
  ip_hash   TEXT,
  committed INTEGER NOT NULL DEFAULT 0,
  tomb      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_ts        ON messages (ts DESC);
CREATE INDEX IF NOT EXISTS messages_recipient ON messages (recipient, ts DESC);
CREATE INDEX IF NOT EXISTS messages_reply_to  ON messages (reply_to);
CREATE INDEX IF NOT EXISTS messages_committed ON messages (committed);
CREATE INDEX IF NOT EXISTS messages_ip        ON messages (ip_hash, ts);

CREATE TABLE IF NOT EXISTS keys (
  handle     TEXT NOT NULL,
  key        TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (handle, key)
);
