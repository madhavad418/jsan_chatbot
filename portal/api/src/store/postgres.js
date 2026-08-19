// PostgreSQL storage driver — the production target.
//
// One of three interchangeable drivers behind the same interface (see
// ./index.js). Row shapes are snake_case and identical across drivers, so no
// route or component changes when the driver does.

import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;

// A fixed advisory-lock key, so concurrent registrations serialise on the seat
// count rather than racing past it.
const SEAT_LOCK_KEY = 20312026;

export function createPostgresStore({ connectionString }) {
  const pool = new Pool({ connectionString });

  return {
    driver: 'postgres',
    describe: () => 'PostgreSQL',
    async close() { await pool.end().catch(() => {}); },

    async initSchema() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS jsan_users (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          litellm_user_id TEXT UNIQUE NOT NULL,
          litellm_key_ciphertext TEXT,
          litellm_key_iv TEXT,
          litellm_key_tag TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_login_at TIMESTAMPTZ
        );
        CREATE TABLE IF NOT EXISTS jsan_conversations (
          id UUID PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES jsan_users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'auto',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS jsan_messages (
          id UUID PRIMARY KEY,
          conversation_id UUID NOT NULL REFERENCES jsan_conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('user','assistant')),
          content TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS jsan_conversations_user_updated_idx ON jsan_conversations(user_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS jsan_messages_conversation_created_idx ON jsan_messages(conversation_id, created_at);
      `);

      // A developer can now exist before the gateway has issued them a personal
      // key. `CREATE TABLE IF NOT EXISTS` never alters an existing table, so
      // databases created by an earlier version need this explicitly. Dropping a
      // constraint that is already absent is a no-op, so it is safe to re-run.
      await pool.query(`
        ALTER TABLE jsan_users ALTER COLUMN litellm_key_ciphertext DROP NOT NULL;
        ALTER TABLE jsan_users ALTER COLUMN litellm_key_iv DROP NOT NULL;
        ALTER TABLE jsan_users ALTER COLUMN litellm_key_tag DROP NOT NULL;
      `);
    },

    // ---- users ----
    async countUsers() {
      const r = await pool.query('SELECT COUNT(*)::int count FROM jsan_users');
      return r.rows[0].count;
    },
    async findUserByEmail(email) {
      const r = await pool.query('SELECT * FROM jsan_users WHERE email=$1', [email]);
      return r.rows[0] || null;
    },
    async findUserById(id) {
      const r = await pool.query('SELECT * FROM jsan_users WHERE id=$1', [id]);
      return r.rows[0] || null;
    },
    async touchLastLogin(id) {
      await pool.query('UPDATE jsan_users SET last_login_at=NOW() WHERE id=$1', [id]);
    },
    async updateUserKey(id, key) {
      await pool.query(
        'UPDATE jsan_users SET litellm_key_ciphertext=$1,litellm_key_iv=$2,litellm_key_tag=$3 WHERE id=$4',
        [key.ciphertext, key.iv, key.tag, id]
      );
    },

    /**
     * Insert a user, enforcing the seat cap and unique email atomically.
     * Expected outcomes are returned rather than thrown: the caller maps them to
     * a 409, while a genuine failure still raises.
     */
    async createUser({ id, name, email, passwordHash, litellmUserId, key, maxUsers }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [SEAT_LOCK_KEY]);

        const count = await client.query('SELECT COUNT(*)::int count FROM jsan_users');
        if (count.rows[0].count >= maxUsers) { await client.query('ROLLBACK'); return { ok: false, reason: 'full' }; }

        const exists = await client.query('SELECT 1 FROM jsan_users WHERE email=$1', [email]);
        if (exists.rowCount) { await client.query('ROLLBACK'); return { ok: false, reason: 'exists' }; }

        await client.query(
          `INSERT INTO jsan_users(id,name,email,password_hash,litellm_user_id,litellm_key_ciphertext,litellm_key_iv,litellm_key_tag,last_login_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
          [id, name, email, passwordHash, litellmUserId, key?.ciphertext ?? null, key?.iv ?? null, key?.tag ?? null]
        );
        await client.query('COMMIT');
        return { ok: true };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    // ---- conversations ----
    async listConversations(userId) {
      const r = await pool.query(
        'SELECT id,title,mode,created_at,updated_at FROM jsan_conversations WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 60',
        [userId]
      );
      return r.rows;
    },
    async getConversation(id, userId) {
      const r = await pool.query('SELECT * FROM jsan_conversations WHERE id=$1 AND user_id=$2', [id, userId]);
      return r.rows[0] || null;
    },
    async createConversation({ id, userId, title, mode }) {
      await pool.query('INSERT INTO jsan_conversations(id,user_id,title,mode) VALUES($1,$2,$3,$4)', [id, userId, title, mode]);
    },
    async touchConversation(id, mode) {
      if (mode) await pool.query('UPDATE jsan_conversations SET mode=$1,updated_at=NOW() WHERE id=$2', [mode, id]);
      else await pool.query('UPDATE jsan_conversations SET updated_at=NOW() WHERE id=$1', [id]);
    },
    async deleteConversation(id, userId) {
      await pool.query('DELETE FROM jsan_conversations WHERE id=$1 AND user_id=$2', [id, userId]);
    },

    // ---- messages ----
    // No limit means the whole thread, which is what reading a conversation
    // wants. A limit means the MOST RECENT n, oldest-first for the model: taking
    // the oldest n would freeze the context and the model would stop seeing what
    // the developer just typed.
    async getMessages(conversationId, limit) {
      if (!limit) {
        const r = await pool.query(
          'SELECT id,role,content,created_at FROM jsan_messages WHERE conversation_id=$1 ORDER BY created_at ASC',
          [conversationId]
        );
        return r.rows;
      }
      const r = await pool.query(
        `SELECT id,role,content,created_at FROM (
           SELECT id,role,content,created_at FROM jsan_messages WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT $2
         ) recent ORDER BY created_at ASC`,
        [conversationId, limit]
      );
      return r.rows;
    },
    /** Returns the new id so a caller can undo the write if what follows fails. */
    async addMessage({ conversationId, role, content }) {
      const id = crypto.randomUUID();
      await pool.query('INSERT INTO jsan_messages(id,conversation_id,role,content) VALUES($1,$2,$3,$4)', [id, conversationId, role, content]);
      return id;
    },
    async deleteMessage(id) {
      await pool.query('DELETE FROM jsan_messages WHERE id=$1', [id]);
    }
  };
}
