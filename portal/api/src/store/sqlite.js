// SQLite storage driver — for running locally before Postgres exists.
//
// Same interface and same row shapes as the Postgres driver, so nothing above
// this file knows which one is live. It uses Node's built-in `node:sqlite`, so
// it adds no dependency and needs no build toolchain.
//
// Deliberate differences from Postgres, and why:
//  - ids and timestamps are TEXT. SQLite has no UUID or TIMESTAMPTZ type, so
//    timestamps are stored as ISO-8601 UTC strings, which sort correctly as text
//    and serialise to JSON identically to a pg Date.
//  - the seat cap is held with BEGIN IMMEDIATE rather than an advisory lock.
//    SQLite has no advisory locks, but a write transaction is exclusive, which
//    gives the same guarantee for a count-then-insert.
//  - ORDER BY carries a rowid tiebreaker. SQLite timestamps are
//    millisecond-precision, so two rows written in the same millisecond could
//    otherwise come back in an arbitrary order.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export async function createSqliteStore({ file }) {
  let DatabaseSync;
  try {
    // Imported dynamically: on Node 22 this module only exists behind
    // --experimental-sqlite, and a static import would break startup for a
    // deployment that is using Postgres and never touches SQLite.
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new Error(
      'SQLite storage needs Node 23 or newer (or Node 22 started with --experimental-sqlite). ' +
      'Upgrade Node, or set DB_DRIVER=postgres with a DATABASE_URL.'
    );
  }

  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);

  // Per-connection settings. foreign_keys defaults to OFF in SQLite, so the
  // ON DELETE CASCADE below would silently do nothing without this.
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');

  const get = (sql, ...params) => db.prepare(sql).get(...params) ?? null;
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);

  return {
    driver: 'sqlite',
    describe: () => `SQLite (${resolved})`,
    async close() { try { db.close(); } catch { /* already closed */ } },

    async initSchema() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS jsan_users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          litellm_user_id TEXT UNIQUE NOT NULL,
          litellm_key_ciphertext TEXT,
          litellm_key_iv TEXT,
          litellm_key_tag TEXT,
          created_at TEXT NOT NULL DEFAULT (${NOW}),
          last_login_at TEXT
        );
        CREATE TABLE IF NOT EXISTS jsan_conversations (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES jsan_users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'auto',
          created_at TEXT NOT NULL DEFAULT (${NOW}),
          updated_at TEXT NOT NULL DEFAULT (${NOW})
        );
        CREATE TABLE IF NOT EXISTS jsan_messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES jsan_conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('user','assistant')),
          content TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (${NOW})
        );
        CREATE INDEX IF NOT EXISTS jsan_conversations_user_updated_idx ON jsan_conversations(user_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS jsan_messages_conversation_created_idx ON jsan_messages(conversation_id, created_at);
      `);
    },

    // ---- users ----
    async countUsers() {
      return get('SELECT COUNT(*) AS count FROM jsan_users').count;
    },
    async findUserByEmail(email) {
      return get('SELECT * FROM jsan_users WHERE email=?', email);
    },
    async findUserById(id) {
      return get('SELECT * FROM jsan_users WHERE id=?', id);
    },
    async touchLastLogin(id) {
      run(`UPDATE jsan_users SET last_login_at=${NOW} WHERE id=?`, id);
    },
    async updateUserKey(id, key) {
      run('UPDATE jsan_users SET litellm_key_ciphertext=?,litellm_key_iv=?,litellm_key_tag=? WHERE id=?', key.ciphertext, key.iv, key.tag, id);
    },

    async createUser({ id, name, email, passwordHash, litellmUserId, key, maxUsers }) {
      // BEGIN IMMEDIATE takes the write lock up front, so the count and the
      // insert cannot be interleaved with another registration.
      db.exec('BEGIN IMMEDIATE');
      try {
        if (get('SELECT COUNT(*) AS count FROM jsan_users').count >= maxUsers) {
          db.exec('ROLLBACK');
          return { ok: false, reason: 'full' };
        }
        if (get('SELECT 1 AS hit FROM jsan_users WHERE email=?', email)) {
          db.exec('ROLLBACK');
          return { ok: false, reason: 'exists' };
        }
        run(
          `INSERT INTO jsan_users(id,name,email,password_hash,litellm_user_id,litellm_key_ciphertext,litellm_key_iv,litellm_key_tag,last_login_at)
           VALUES(?,?,?,?,?,?,?,?,${NOW})`,
          id, name, email, passwordHash, litellmUserId,
          key?.ciphertext ?? null, key?.iv ?? null, key?.tag ?? null
        );
        db.exec('COMMIT');
        return { ok: true };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* transaction already unwound */ }
        throw error;
      }
    },

    // ---- conversations ----
    async listConversations(userId) {
      return all(
        'SELECT id,title,mode,created_at,updated_at FROM jsan_conversations WHERE user_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 60',
        userId
      );
    },
    async getConversation(id, userId) {
      return get('SELECT * FROM jsan_conversations WHERE id=? AND user_id=?', id, userId);
    },
    async createConversation({ id, userId, title, mode }) {
      run('INSERT INTO jsan_conversations(id,user_id,title,mode) VALUES(?,?,?,?)', id, userId, title, mode);
    },
    async touchConversation(id, mode) {
      if (mode) run(`UPDATE jsan_conversations SET mode=?,updated_at=${NOW} WHERE id=?`, mode, id);
      else run(`UPDATE jsan_conversations SET updated_at=${NOW} WHERE id=?`, id);
    },
    async deleteConversation(id, userId) {
      run('DELETE FROM jsan_conversations WHERE id=? AND user_id=?', id, userId);
    },

    // ---- messages ----
    async getMessages(conversationId, limit) {
      if (!limit) {
        return all(
          'SELECT id,role,content,created_at FROM jsan_messages WHERE conversation_id=? ORDER BY created_at ASC, rowid ASC',
          conversationId
        );
      }
      // Most recent n, handed back oldest-first for the model.
      const recent = all(
        'SELECT id,role,content,created_at FROM jsan_messages WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?',
        conversationId, limit
      );
      return recent.reverse();
    },
    async addMessage({ conversationId, role, content }) {
      const id = crypto.randomUUID();
      run('INSERT INTO jsan_messages(id,conversation_id,role,content) VALUES(?,?,?,?)', id, conversationId, role, content);
      return id;
    },
    async deleteMessage(id) {
      run('DELETE FROM jsan_messages WHERE id=?', id);
    }
  };
}
