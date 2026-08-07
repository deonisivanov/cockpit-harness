import { Migrator, SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import * as NodePath from "node:path"
import { ensureCockpitHome } from "./config.js"

const initial = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    cartridge_hash TEXT,
    created_at TEXT NOT NULL
  )`
  yield* sql`CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    base_commit TEXT,
    worktree_path TEXT,
    branch TEXT,
    provider_versions_json TEXT,
    plugin_versions_json TEXT,
    cartridge_hash TEXT,
    canonical_session_id TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  )`
  yield* sql`CREATE TABLE blocks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs (id),
    def_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  )`
  yield* sql`CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    block_id TEXT NOT NULL REFERENCES blocks (id),
    number INTEGER NOT NULL,
    session_id TEXT,
    verdict TEXT,
    result_json TEXT,
    started_at TEXT,
    finished_at TEXT
  )`
  yield* sql`CREATE INDEX blocks_run ON blocks (run_id)`
  yield* sql`CREATE INDEX attempts_block ON attempts (block_id)`
  // AUTOINCREMENT (not plain rowid) so a deleted row's seq is never handed out again.
  yield* sql`CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs (id),
    block_id TEXT,
    attempt_id TEXT,
    ts TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`
  yield* sql`CREATE INDEX events_run_seq ON events (run_id, seq)`
  yield* sql`CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs (id),
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`
  yield* sql`CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs (id),
    block_id TEXT,
    attempt_id TEXT,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`
  yield* sql`CREATE INDEX checkpoints_run ON checkpoints (run_id)`
  yield* sql`CREATE TABLE insights (
    id TEXT PRIMARY KEY,
    dedup_key TEXT NOT NULL UNIQUE,
    target TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    occurrences INTEGER NOT NULL,
    first_seen_run TEXT,
    last_seen_run TEXT
  )`
})

const migrate = Migrator.make({})({ loader: Migrator.fromRecord({ "0001_initial": initial }) })

const ClientLive = Layer.unwrapEffect(
  Effect.map(ensureCockpitHome, (home) =>
    // WAL is what lets a SIGKILLed daemon leave a journal that recovers instead of tearing.
    SqliteClient.layer({ filename: NodePath.join(home, "cockpit.db"), disableWAL: false }),
  ),
)

// The driver leaves foreign_keys off and SQLite silently ignores the pragma inside a transaction,
// so it has to land on the single long-lived connection before the migrator opens one.
const enforceForeignKeys = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`PRAGMA foreign_keys = ON`,
)

export const DbLive = Layer.effectDiscard(
  Effect.flatMap(Effect.zipRight(enforceForeignKeys, migrate), (applied) =>
    Effect.log(`journal ready (migrations applied: ${applied.length})`),
  ),
).pipe(Layer.provideMerge(ClientLive))
