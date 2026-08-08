import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Context, Effect, Exit, Fiber, Stream } from "effect"
import * as NodePath from "node:path"
import { expect, it } from "vitest"
import {
  AttemptId,
  BlockId,
  buildResumePlan,
  CheckpointId,
  EventBus,
  Journal,
  recordedSkips,
  RunId,
  Store,
} from "../src/index.js"
import { payloads, readEvents, runKernel, tempHome, withKernel } from "./helpers.js"

type JournalService = Context.Tag.Service<typeof Journal>

const runId = RunId.make("run-1")
const blockId = BlockId.make("block-1")
const attemptId = AttemptId.make("attempt-1")

it("creates every contract table and stays idempotent across boots", async () => {
  const home = await tempHome()
  const tables = Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`,
  ).pipe(Effect.map((rows) => rows.map((row) => row.name).sort()))

  const boot = () => runKernel(home, tables)

  // Every journal reaches the current shape the same way, fresh or upgraded: 0001 forward.
  const applied = await runKernel(
    home,
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql<{ name: string }>`SELECT name FROM effect_sql_migrations ORDER BY migration_id`,
    ),
  )
  expect(applied.map((row) => row.name)).toEqual(["initial", "target_branch", "run_scoped_blocks"])

  const first = await boot()
  expect(first).toEqual(
    expect.arrayContaining([
      "artifacts",
      "attempts",
      "blocks",
      "checkpoints",
      "events",
      "insights",
      "projects",
      "runs",
    ]),
  )
  expect(await boot()).toEqual(first)
})

it("runs sqlite in WAL mode so a killed process leaves a recoverable journal", async () => {
  const mode = await withKernel(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql<{ journal_mode: string }>`PRAGMA journal_mode`,
    ),
  )
  expect(mode[0].journal_mode).toBe("wal")
})

it("walks a run through the legal lifecycle and journals each transition", async () => {
  const events = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      yield* journal.createRun({ runId, projectId: "project-1", prompt: "do the thing" })
      yield* journal.startRun(runId)
      yield* journal.startBlock({ runId, blockId, defId: "implement", kind: "agent" })
      yield* journal.startAttempt({ runId, blockId, attemptId, number: 1 })
      yield* journal.finishAttempt({ runId, blockId, attemptId, verdict: "success" })
      yield* journal.finishBlock(runId, blockId, "succeeded")
      yield* journal.finishRun(runId, "succeeded")
      expect(yield* journal.runStatus(runId)).toBe("succeeded")
      return yield* readEvents(runId)
    }),
  )

  expect(payloads(events)).toEqual([
    "RunCreated",
    "RunStarted",
    "BlockStarted",
    "AttemptStarted",
    "AttemptFinished",
    "BlockFinished",
    "RunFinished",
  ])
  expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
})

const illegal = [
  {
    name: "starting a run twice",
    steps: (journal: JournalService) =>
      Effect.gen(function* () {
        yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
        yield* journal.startRun(runId)
        yield* journal.startRun(runId)
      }),
  },
  {
    name: "finishing a run that never started",
    steps: (journal: JournalService) =>
      Effect.gen(function* () {
        yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
        yield* journal.finishRun(runId, "succeeded")
      }),
  },
  {
    name: "starting a run that does not exist",
    steps: (journal: JournalService) => journal.startRun(runId),
  },
  {
    name: "cancelling an already finished run",
    steps: (journal: JournalService) =>
      Effect.gen(function* () {
        yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
        yield* journal.startRun(runId)
        yield* journal.finishRun(runId, "failed")
        yield* journal.cancelRun(runId)
      }),
  },
  {
    name: "stopping an already finished run",
    steps: (journal: JournalService) =>
      Effect.gen(function* () {
        yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
        yield* journal.startRun(runId)
        yield* journal.finishRun(runId, "failed")
        yield* journal.stopRun(runId)
      }),
  },
  {
    name: "creating the same run twice",
    steps: (journal: JournalService) =>
      Effect.gen(function* () {
        yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
        yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
      }),
  },
]

it.each(illegal)("rejects $name with a JournalError", async ({ steps }) => {
  const exit = await withKernel(
    Effect.flatMap(Journal, (journal) => Effect.exit(steps(journal))),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("JournalError")
})

it("rejects block and attempt transitions that skip their parent state", async () => {
  const failures = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
      const blockBeforeRunStart = yield* Effect.exit(
        journal.startBlock({ runId, blockId, defId: "d", kind: "command" }),
      )
      yield* journal.startRun(runId)
      const attemptWithoutBlock = yield* Effect.exit(
        journal.startAttempt({ runId, blockId, attemptId, number: 1 }),
      )
      yield* journal.startBlock({ runId, blockId, defId: "d", kind: "command" })
      yield* journal.startAttempt({ runId, blockId, attemptId, number: 1 })
      yield* journal.finishAttempt({ runId, blockId, attemptId, verdict: "success" })
      const finishTwice = yield* Effect.exit(
        journal.finishAttempt({ runId, blockId, attemptId, verdict: "success" }),
      )
      return [blockBeforeRunStart, attemptWithoutBlock, finishTwice]
    }),
  )

  for (const exit of failures) {
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(exit)).toContain("JournalError")
  }
})

it("persists the workspace coordinates a run was pinned to", async () => {
  const row = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      const sql = yield* SqlClient.SqlClient
      yield* journal.createRun({
        runId,
        projectId: "p",
        prompt: "x",
        baseCommit: "abc123",
        worktreePath: "/tmp/worktrees/p/run-1",
        branch: "cockpit/run-run-1",
      })
      return yield* sql<{
        base_commit: string
        worktree_path: string
        branch: string
      }>`SELECT base_commit, worktree_path, branch FROM runs WHERE id = ${runId}`
    }),
  )

  expect(row[0]).toEqual({
    base_commit: "abc123",
    worktree_path: "/tmp/worktrees/p/run-1",
    branch: "cockpit/run-run-1",
  })
})

it("skips a block and cancels the run without touching attempts", async () => {
  const [status, events] = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
      yield* journal.startRun(runId)
      yield* journal.skipBlock({
        runId,
        blockId,
        defId: "optional-review",
        kind: "agent",
        reason: "toggled off by the analyzer",
      })
      yield* journal.cancelRun(runId)
      return [yield* journal.runStatus(runId), yield* readEvents(runId)] as const
    }),
  )

  expect(status).toBe("cancelled")
  expect(payloads(events)).toEqual(["RunCreated", "RunStarted", "BlockSkipped", "RunCancelled"])
  expect(events[2].payload).toMatchObject({ reason: "toggled off by the analyzer" })
})

it("recordedSkips pends a request until a BlockSkipped honours it, and nothing else", async () => {
  const trail = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
      yield* journal.startRun(runId)
      yield* journal.append({
        runId,
        payload: { _tag: "BlockSkipRequested", nodeId: "implement" },
      })
      const pending = recordedSkips(yield* readEvents(runId))
      // The same fold feeds re-entry, so a fresh start and a resume agree on what is pending.
      const planned = [...(yield* buildResumePlan(runId)).skips]
      // A visit that runs the node does not consume the request; only its BlockSkipped does —
      // the one event the live consumption also writes, so the two views cannot diverge.
      yield* journal.startBlock({
        runId,
        blockId: BlockId.make("implement"),
        defId: "agent-task",
        kind: "agent",
      })
      const survivesAVisit = recordedSkips(yield* readEvents(runId))
      yield* journal.skipBlock({
        runId,
        blockId: BlockId.make("implement#2"),
        defId: "agent-task",
        kind: "agent",
        reason: "skipped by user request",
      })
      const consumed = recordedSkips(yield* readEvents(runId))
      return { pending, planned, survivesAVisit, consumed }
    }),
  )

  expect([...trail.pending]).toEqual(["implement"])
  expect(trail.planned).toEqual(["implement"])
  expect([...trail.survivesAVisit]).toEqual(["implement"])
  expect(trail.consumed.size).toBe(0)
})

it("closes a stopped run as interrupted, and resume re-opens it", async () => {
  const [stopped, events] = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
      yield* journal.startRun(runId)
      yield* journal.stopRun(runId)
      const status = yield* journal.runStatus(runId)
      yield* journal.resumeRun(runId)
      return [status, yield* readEvents(runId)] as const
    }),
  )

  expect(stopped).toBe("interrupted")
  expect(payloads(events)).toEqual(["RunCreated", "RunStarted", "RunStopped", "RunResumed"])
})

it("leaves no event behind when a transition is rejected", async () => {
  const events = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
      yield* Effect.exit(journal.finishRun(runId, "succeeded"))
      return yield* readEvents(runId)
    }),
  )
  expect(payloads(events)).toEqual(["RunCreated"])
})

it("refuses to write inside a caller's transaction, where publish would outlive a rollback", async () => {
  const [exit, status, events] = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      const sql = yield* SqlClient.SqlClient
      yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
      const nested = yield* Effect.exit(sql.withTransaction(journal.startRun(runId)))
      return [nested, yield* journal.runStatus(runId), yield* readEvents(runId)] as const
    }),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("must own their transaction")
  expect(status).toBe("created")
  expect(payloads(events)).toEqual(["RunCreated"])
})

it("keeps the checkpoint row and its event atomic when the row insert conflicts", async () => {
  const [checkpoints, events] = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      const sql = yield* SqlClient.SqlClient
      const checkpointId = CheckpointId.make("deadbeef")
      yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
      yield* journal.startRun(runId)
      yield* journal.recordCheckpoint({ checkpointId, runId, kind: "success" })
      yield* Effect.exit(journal.recordCheckpoint({ checkpointId, runId, kind: "salvage" }))
      return [
        yield* sql<{ id: string }>`SELECT id FROM checkpoints WHERE run_id = ${runId}`,
        yield* readEvents(runId),
      ] as const
    }),
  )

  expect(checkpoints).toHaveLength(1)
  expect(payloads(events)).toEqual(["RunCreated", "RunStarted", "CheckpointCreated"])
})

it("refuses a checkpoint for a run that is not running", async () => {
  const exit = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
      return yield* Effect.exit(
        journal.recordCheckpoint({
          checkpointId: CheckpointId.make("cafe"),
          runId,
          kind: "success",
        }),
      )
    }),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("JournalError")
})

it("reads events from a cursor, excluding everything at or before it", async () => {
  const [all, tail] = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
      yield* journal.startRun(runId)
      yield* journal.startBlock({ runId, blockId, defId: "d", kind: "command" })
      const everything = yield* readEvents(runId)
      const fromSecond = yield* Stream.runCollect(journal.eventsFrom(runId, everything[1].seq))
      return [everything, Array.from(fromSecond)] as const
    }),
  )

  expect(payloads(all)).toEqual(["RunCreated", "RunStarted", "BlockStarted"])
  expect(payloads(tail)).toEqual(["BlockStarted"])
})

it("only returns events belonging to the requested run", async () => {
  const events = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      const other = RunId.make("run-2")
      yield* journal.createRun({ runId, projectId: "p", prompt: "mine" })
      yield* journal.createRun({ runId: other, projectId: "p", prompt: "theirs" })
      yield* journal.startRun(other)
      return yield* readEvents(runId)
    }),
  )
  expect(payloads(events)).toEqual(["RunCreated"])
})

it("refuses to close a run while a block or attempt is still open", async () => {
  const [withAttempt, withBlock, drained] = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
      yield* journal.startRun(runId)
      yield* journal.startBlock({ runId, blockId, defId: "d", kind: "agent" })
      yield* journal.startAttempt({ runId, blockId, attemptId, number: 1 })

      const openAttempt = yield* Effect.exit(journal.cancelRun(runId))
      yield* journal.interruptAttempt(runId, blockId, attemptId)
      const openBlock = yield* Effect.exit(journal.cancelRun(runId))
      yield* journal.finishBlock(runId, blockId, "interrupted")
      return [openAttempt, openBlock, yield* Effect.exit(journal.cancelRun(runId))] as const
    }),
  )

  expect(Exit.isFailure(withAttempt)).toBe(true)
  expect(String(withAttempt)).toContain("unfinished attempt")
  expect(Exit.isFailure(withBlock)).toBe(true)
  expect(String(withBlock)).toContain("running block")
  expect(Exit.isSuccess(drained)).toBe(true)
})

it("refuses a checkpoint pinned to another run's block", async () => {
  const exit = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      const other = RunId.make("run-2")
      yield* journal.createRun({ runId, projectId: "p", prompt: "mine" })
      yield* journal.startRun(runId)
      yield* journal.startBlock({ runId, blockId, defId: "d", kind: "agent" })
      yield* journal.createRun({ runId: other, projectId: "p", prompt: "theirs" })
      yield* journal.startRun(other)
      return yield* Effect.exit(
        journal.recordCheckpoint({
          checkpointId: CheckpointId.make("beef"),
          runId: other,
          blockId,
          kind: "success",
        }),
      )
    }),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("does not belong to run")
})

it("enforces foreign keys, so no row can hang off a run that never existed", async () => {
  const [pragma, orphan] = await withKernel(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ foreign_keys: number }>`PRAGMA foreign_keys`
      const insert = yield* Effect.exit(sql`
        INSERT INTO blocks (id, run_id, def_id, kind, status)
        VALUES (${blockId}, ${"ghost"}, ${"d"}, ${"agent"}, ${"running"})`)
      return [rows[0].foreign_keys, insert] as const
    }),
  )
  expect(pragma).toBe(1)
  expect(Exit.isFailure(orphan)).toBe(true)
})

it("lets exactly one of two concurrent startRun calls win", async () => {
  const [exits, events] = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
      const both = yield* Effect.all(
        [Effect.exit(journal.startRun(runId)), Effect.exit(journal.startRun(runId))],
        { concurrency: 2 },
      )
      return [both, yield* readEvents(runId)] as const
    }),
  )

  const failures = exits.filter(Exit.isFailure)
  expect(exits.filter(Exit.isSuccess)).toHaveLength(1)
  expect(failures).toHaveLength(1)
  expect(String(failures[0])).toContain("JournalError")
  expect(payloads(events).filter((tag) => tag === "RunStarted")).toHaveLength(1)
})

it("publishes concurrent appends to subscribers in seq order", async () => {
  const appends = 25
  const seqs = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      const bus = yield* EventBus
      yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
      const events = yield* bus.subscribe
      const subscriber = yield* Effect.fork(
        Stream.runCollect(Stream.take(events, appends)).pipe(Effect.timeout("10 seconds")),
      )
      yield* Effect.forEach(
        Array.from({ length: appends }, (_, index) => index),
        (index) =>
          journal.append({
            runId,
            payload: {
              _tag: "ErrorRaised",
              class: "technical",
              signature: "concurrent",
              message: `${index}`,
            },
          }),
        { concurrency: "unbounded", discard: true },
      )
      return Array.from(yield* Fiber.join(subscriber)).map((event) => event.seq)
    }),
  )

  expect(seqs).toHaveLength(appends)
  expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
  expect(new Set(seqs).size).toBe(appends)
})

it("publishes committed events to event bus subscribers", async () => {
  const received = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      const bus = yield* EventBus
      const events = yield* bus.subscribe
      const subscriber = yield* Effect.fork(
        Stream.runCollect(Stream.take(events, 2)).pipe(Effect.timeout("5 seconds")),
      )
      yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
      yield* journal.startRun(runId)
      return Array.from(yield* Fiber.join(subscriber))
    }),
  )

  expect(payloads(received)).toEqual(["RunCreated", "RunStarted"])
  expect(received.map((event) => event.seq)).toEqual([1, 2])
})

it("gives every run its own block namespace, so two runs share block ids without colliding", async () => {
  const second = RunId.make("run-2")
  const loopId = BlockId.make("block-1#2")

  const [blocks, attempts] = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      const sql = yield* SqlClient.SqlClient

      for (const id of [runId, second]) {
        yield* journal.createRun({ runId: id, projectId: "p", prompt: "x" })
        yield* journal.startRun(id)
        // The same instance id in both runs, plus a loop iteration's `#2` inside each.
        for (const block of [blockId, loopId]) {
          yield* journal.startBlock({ runId: id, blockId: block, defId: "d", kind: "agent" })
          yield* journal.startAttempt({
            runId: id,
            blockId: block,
            attemptId: AttemptId.make(`attempt-${id}-${block}`),
            number: 1,
          })
          yield* journal.finishAttempt({
            runId: id,
            blockId: block,
            attemptId: AttemptId.make(`attempt-${id}-${block}`),
            verdict: "success",
          })
          yield* journal.finishBlock(id, block, "succeeded")
        }
      }

      return [
        yield* sql<{ run_id: string; id: string; status: string }>`
          SELECT run_id, id, status FROM blocks ORDER BY run_id, id`,
        yield* sql<{ run_id: string; block_id: string }>`
          SELECT run_id, block_id FROM attempts ORDER BY run_id, block_id`,
      ] as const
    }),
  )

  expect(blocks.map((row) => `${row.run_id}/${row.id}`)).toEqual([
    "run-1/block-1",
    "run-1/block-1#2",
    "run-2/block-1",
    "run-2/block-1#2",
  ])
  // Finishing run-2's block must not have closed run-1's block of the same name.
  expect(blocks.every((row) => row.status === "succeeded")).toBe(true)
  expect(attempts.map((row) => `${row.run_id}/${row.block_id}`)).toEqual([
    "run-1/block-1",
    "run-1/block-1#2",
    "run-2/block-1",
    "run-2/block-1#2",
  ])
})

it("still refuses a block id the same run already used", async () => {
  const exit = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      yield* journal.createRun({ runId, projectId: "p", prompt: "x" })
      yield* journal.startRun(runId)
      yield* journal.startBlock({ runId, blockId, defId: "d", kind: "agent" })
      return yield* Effect.exit(
        journal.startBlock({ runId, blockId, defId: "d", kind: "agent" }),
      )
    }),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("already has a block")
})

it("keeps an attempt from hanging off a block in another run", async () => {
  const second = RunId.make("run-2")

  const exit = await withKernel(
    Effect.gen(function* () {
      const journal = yield* Journal
      const sql = yield* SqlClient.SqlClient
      for (const id of [runId, second]) {
        yield* journal.createRun({ runId: id, projectId: "p", prompt: "x" })
        yield* journal.startRun(id)
      }
      yield* journal.startBlock({ runId, blockId, defId: "d", kind: "agent" })
      // run-2 has no such block, so the composite foreign key is what refuses this row.
      return yield* Effect.exit(sql`
        INSERT INTO attempts (id, run_id, block_id, number)
        VALUES (${attemptId}, ${second}, ${blockId}, ${1})`)
    }),
  )

  expect(Exit.isFailure(exit)).toBe(true)
})

/**
 * A journal written before the block key became run-scoped: the tables 0003 rebuilds, in the shape
 * 0001 and 0002 left them, with the migrator's own bookkeeping saying those two already ran.
 */
const legacyJournal = (home: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE effect_sql_migrations (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    )`
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (${1}, ${"initial"}), (${2}, ${"target_branch"})`
    yield* sql`CREATE TABLE runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL,
      base_commit TEXT, worktree_path TEXT, branch TEXT, provider_versions_json TEXT,
      plugin_versions_json TEXT, cartridge_hash TEXT, canonical_session_id TEXT,
      created_at TEXT NOT NULL, finished_at TEXT, target_branch TEXT
    )`
    yield* sql`CREATE TABLE blocks (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs (id), def_id TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT, finished_at TEXT
    )`
    yield* sql`CREATE TABLE attempts (
      id TEXT PRIMARY KEY, block_id TEXT NOT NULL REFERENCES blocks (id), number INTEGER NOT NULL,
      session_id TEXT, verdict TEXT, result_json TEXT, started_at TEXT, finished_at TEXT
    )`
    yield* sql`CREATE INDEX blocks_run ON blocks (run_id)`
    yield* sql`CREATE INDEX attempts_block ON attempts (block_id)`
    yield* sql`CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs (id),
      block_id TEXT, attempt_id TEXT, ts TEXT NOT NULL, payload_json TEXT NOT NULL
    )`
    yield* sql`CREATE INDEX events_run_seq ON events (run_id, seq)`

    yield* sql`INSERT INTO runs (id, project_id, prompt, status, created_at)
      VALUES (${runId}, ${"p"}, ${"the run that came before"}, ${"succeeded"}, ${"2026-01-01T00:00:00.000Z"})`
    yield* sql`INSERT INTO blocks (id, run_id, def_id, kind, status, started_at)
      VALUES (${blockId}, ${runId}, ${"d"}, ${"agent"}, ${"succeeded"}, ${"2026-01-01T00:00:01.000Z"})`
    yield* sql`INSERT INTO attempts (id, block_id, number, verdict)
      VALUES (${attemptId}, ${blockId}, ${1}, ${"success"})`
  }).pipe(
    Effect.provide(SqliteClient.layer({ filename: NodePath.join(home, "cockpit.db") })),
    Effect.scoped,
    Effect.orDie,
  )

it("upgrades a journal written before blocks were run-scoped, keeping its rows", async () => {
  const home = await tempHome()
  await Effect.runPromise(legacyJournal(home))

  const [applied, blocks, attempts, second, schema] = await runKernel(
    home,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const store = yield* Store
      const journal = yield* Journal

      // The block the legacy run owned is now addressable by the id that used to be free.
      const other = RunId.make("run-2")
      yield* journal.createRun({ runId: other, projectId: "p", prompt: "after the upgrade" })
      yield* journal.startRun(other)
      yield* journal.startBlock({ runId: other, blockId, defId: "d", kind: "agent" })
      yield* journal.startAttempt({
        runId: other,
        blockId,
        attemptId: AttemptId.make("attempt-2"),
        number: 1,
      })

      return [
        yield* sql<{ migration_id: number; name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`,
        yield* store.blocks(runId),
        yield* store.attempts(runId, blockId),
        yield* store.blocks(other),
        yield* sql<{ sql: string }>`
          SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${"attempts"}`,
      ] as const
    }),
  )

  expect(applied).toEqual([
    { migration_id: 1, name: "initial" },
    { migration_id: 2, name: "target_branch" },
    { migration_id: 3, name: "run_scoped_blocks" },
  ])

  // The pre-upgrade rows survived the rebuild, and the attempt gained the run it always belonged to.
  expect(blocks).toMatchObject([{ id: blockId, defId: "d", status: "succeeded" }])
  expect(attempts).toMatchObject([{ id: attemptId, runId, blockId, number: 1, verdict: "success" }])
  expect(second).toMatchObject([{ id: blockId, status: "running" }])
  // The rename is what repoints the child's REFERENCES clause; a leftover `blocks_new` would only
  // surface later, as an insert failing against a table that no longer exists.
  expect(schema[0].sql).toMatch(/REFERENCES "?blocks"? \(run_id, id\)/)
})
