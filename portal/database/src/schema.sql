-- JSAN Dev AI — SQLite schema
--
-- Mirrors the PostgreSQL schema in src/server.js (initDb) so the same
-- application logic works against either engine.
--
-- Translation notes:
--   UUID          -> TEXT   (crypto.randomUUID() strings, as the app already generates)
--   TIMESTAMPTZ   -> TEXT   ISO-8601 UTC, e.g. 2026-08-18T13:56:12.345Z
--                           Same wire format as JSON.stringify(new Date()), lexically
--                           sortable, so ORDER BY created_at keeps working unchanged.
--   NOW()         -> strftime('%Y-%m-%dT%H:%M:%fZ','now')
--
-- STRICT tables reject values of the wrong type instead of silently coercing
-- them, which SQLite would otherwise do. ON DELETE CASCADE only fires when the
-- connection has `PRAGMA foreign_keys = ON` — sqlite.js sets it on every open.

CREATE TABLE IF NOT EXISTS jsan_schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS jsan_users (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  -- The app lowercases emails before writing; NOCASE makes that a guarantee
  -- rather than a convention, so two casings cannot both claim a seat.
  email                  TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash          TEXT NOT NULL,
  litellm_user_id        TEXT NOT NULL UNIQUE,
  litellm_key_ciphertext TEXT NOT NULL,
  litellm_key_iv         TEXT NOT NULL,
  litellm_key_tag        TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at          TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS jsan_conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES jsan_users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  mode       TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','code','think','fast')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE IF NOT EXISTS jsan_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES jsan_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX IF NOT EXISTS jsan_conversations_user_updated_idx
  ON jsan_conversations(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS jsan_messages_conversation_created_idx
  ON jsan_messages(conversation_id, created_at);

INSERT INTO jsan_schema_meta(key, value) VALUES ('schema_version', '1')
  ON CONFLICT(key) DO NOTHING;
