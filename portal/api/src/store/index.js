// Storage driver selection.
//
// Every driver implements the same interface, so this is the only place that
// knows which one is live:
//
//   postgres  the production target (Railway, or any managed Postgres)
//   sqlite    a local file, for running before Postgres exists
//   memory    preview mode, AUTH_DISABLED=true, nothing persisted
//
// Choose with DB_DRIVER. Left unset it is inferred from DATABASE_URL, which keeps
// existing Postgres deployments behaving exactly as before.

import { createPostgresStore } from './postgres.js';
import { createSqliteStore } from './sqlite.js';
import { createMemoryStore } from './memory.js';

export const DEFAULT_SQLITE_PATH = './data/jsan-dev-ai.db';

/** The driver that will be used, without opening anything. */
export function resolveDriver() {
  const explicit = String(process.env.DB_DRIVER || '').trim().toLowerCase();
  if (explicit) return explicit === 'postgresql' ? 'postgres' : explicit;

  const url = String(process.env.DATABASE_URL || '').trim();
  if (/^file:/i.test(url) || /\.(db|sqlite|sqlite3)$/i.test(url)) return 'sqlite';
  return 'postgres';
}

/** The SQLite file path, accepting either SQLITE_PATH or a file: DATABASE_URL. */
function sqlitePath() {
  const explicit = String(process.env.SQLITE_PATH || '').trim();
  if (explicit) return explicit;
  const url = String(process.env.DATABASE_URL || '').trim();
  if (/^file:/i.test(url)) return url.replace(/^file:(\/\/)?/i, '');
  if (url) return url;
  return DEFAULT_SQLITE_PATH;
}

export async function createStore({ previewMode = false } = {}) {
  if (previewMode) return createMemoryStore();

  const driver = resolveDriver();

  if (driver === 'sqlite') {
    return await createSqliteStore({ file: sqlitePath() });
  }

  if (driver === 'postgres') {
    const connectionString = String(process.env.DATABASE_URL || '').trim();
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL must be configured for the postgres driver. ' +
        'To run locally without a database server, set DB_DRIVER=sqlite; ' +
        'to run with no database at all, set AUTH_DISABLED=true for preview mode.'
      );
    }
    return createPostgresStore({ connectionString });
  }

  throw new Error(`Unknown DB_DRIVER "${driver}". Use "postgres" or "sqlite".`);
}
