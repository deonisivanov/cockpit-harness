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

/** The branch the user's checkout was on when the run started; where finalize lands (plan §9). */
const targetBranch = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`ALTER TABLE runs ADD COLUMN target_branch TEXT`,
)

/**
 * A BlockId is a per-run instance id (`implement`, `implement#2`), unique only inside its run, so a
 * global `blocks.id` key made every second run of a template collide. SQLite cannot alter a primary
 * key, hence the rebuild.
 *
 * No `PRAGMA foreign_keys` toggling: the migrator runs every migration inside one transaction, and
 * SQLite ignores that pragma there. The order below never needs it — each child is dropped before
 * its parent, and the renames happen with enforcement *on*, which is precisely what rewrites
 * `attempts_new`'s REFERENCES clause to point at the renamed `blocks`.
 */
const runScopedBlocks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE blocks_new (
    id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs (id),
    def_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    PRIMARY KEY (run_id, id)
  )`
  yield* sql`
    INSERT INTO blocks_new (id, run_id, def_id, kind, status, started_at, finished_at)
    SELECT id, run_id, def_id, kind, status, started_at, finished_at FROM blocks`
  // `run_id` is what the composite parent key demands, and it pays for itself: every read of an
  // attempt asks which run it belongs to, and none of them has to reach through blocks to find out.
  yield* sql`CREATE TABLE attempts_new (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    session_id TEXT,
    verdict TEXT,
    result_json TEXT,
    started_at TEXT,
    finished_at TEXT,
    FOREIGN KEY (run_id, block_id) REFERENCES blocks_new (run_id, id)
  )`
  yield* sql`
    INSERT INTO attempts_new (id, run_id, block_id, number, session_id, verdict, result_json,
      started_at, finished_at)
    SELECT a.id, b.run_id, a.block_id, a.number, a.session_id, a.verdict, a.result_json,
      a.started_at, a.finished_at
    FROM attempts a JOIN blocks b ON b.id = a.block_id`
  yield* sql`DROP TABLE attempts`
  yield* sql`DROP TABLE blocks`
  yield* sql`ALTER TABLE blocks_new RENAME TO blocks`
  yield* sql`ALTER TABLE attempts_new RENAME TO attempts`
  // The composite primary key's own index already has run_id as its prefix, so `blocks_run` is not
  // recreated; attempts are read per block within a run.
  yield* sql`CREATE INDEX attempts_block ON attempts (run_id, block_id)`
})

const migrate = Migrator.make({})({
  loader: Migrator.fromRecord({
    "0001_initial": initial,
    "0002_target_branch": targetBranch,
    "0003_run_scoped_blocks": runScopedBlocks,
  }),
})

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
