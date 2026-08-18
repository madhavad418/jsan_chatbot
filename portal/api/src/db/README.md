# SQLite database

Self-contained SQLite database carrying the same schema the portal API uses on
PostgreSQL. It needs no service and no native dependency: it runs on the
`node:sqlite` module built into Node 22.5+ (Node 24 here). Node prints an
`ExperimentalWarning` for that module — set `NODE_NO_WARNINGS=1` to silence it.

## Commands

```bash
npm run db:init     # create data/jsan.db (idempotent — safe to re-run)
npm run db:status   # path, size, row counts, indexes, integrity check
npm run db:verify   # exercise the constraints against a throwaway database
npm run db:reset    # delete and recreate it — requires --force
```

The file lives at `portal/api/data/jsan.db`; set `SQLITE_PATH` to move it. The
`data/` directory is git-ignored, along with the `-wal` and `-shm` sidecars WAL
mode creates.

## Using it from code

```js
import { connect, transaction, nowIso } from './db/sqlite.js';

const db = connect();                                   // opens + applies schema
const user = db.prepare('SELECT * FROM jsan_users WHERE email=?').get(email);
transaction(db, () => { /* ... */ });                   // BEGIN IMMEDIATE + rollback
```

## Differences from the PostgreSQL schema

| PostgreSQL | SQLite | Why |
|---|---|---|
| `UUID` | `TEXT` | The app already generates `crypto.randomUUID()` strings. |
| `TIMESTAMPTZ` | `TEXT` ISO-8601 UTC | Same format `JSON.stringify(new Date())` emits, and lexically sortable, so `ORDER BY created_at` is unchanged. |
| `NOW()` | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` | |
| implicit type checking | `STRICT` tables | SQLite otherwise coerces silently. |
| `pg_advisory_xact_lock` | `BEGIN IMMEDIATE` | Serializes the seat-cap check against a concurrent signup. |

Two behaviours are per-connection rather than stored in the file, so
`openDatabase()` sets them on every open: `foreign_keys` (without it,
`ON DELETE CASCADE` silently does nothing) and `busy_timeout`.

SQLite allows one writer at a time. That is ample for a 20-seat portal, but it
does mean the database has to live on a disk local to the process — on Railway
that requires an attached volume, since the container filesystem is ephemeral.
