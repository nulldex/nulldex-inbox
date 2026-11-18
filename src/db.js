const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const config = require("./config");

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, "attachments"), { recursive: true });

const db = new DatabaseSync(path.join(config.dataDir, "inbox.db"));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created    INTEGER NOT NULL,
  expires    INTEGER NOT NULL,
  ip         TEXT,
  ua         TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  folder        TEXT    NOT NULL DEFAULT 'inbox',   -- inbox | sent | archive | trash
  source        TEXT    NOT NULL,                   -- email | form | sent
  message_id    TEXT,
  in_reply_to   TEXT,
  references_   TEXT,
  from_name     TEXT,
  from_addr     TEXT,
  reply_to      TEXT,
  to_addr       TEXT,
  cc_addr       TEXT,
  subject       TEXT,
  text          TEXT,
  html          TEXT,
  date          INTEGER NOT NULL,
  read          INTEGER NOT NULL DEFAULT 0,
  starred       INTEGER NOT NULL DEFAULT 0,
  has_attach    INTEGER NOT NULL DEFAULT 0,
  meta          TEXT,
  created       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_folder_date ON messages(folder, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages(message_id);

CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename     TEXT,
  content_type TEXT,
  size         INTEGER,
  path         TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject, from_name, from_addr, text,
  content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, from_name, from_addr, text)
  VALUES (new.id, new.subject, new.from_name, new.from_addr, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_addr, text)
  VALUES ('delete', old.id, old.subject, old.from_name, old.from_addr, old.text);
END;
`);

module.exports = db;
