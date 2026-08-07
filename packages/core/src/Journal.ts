import { SqlClient, SqlError } from "@effect/sql"
import { Clock, Context, Effect, Layer, Option, ParseResult, Schema, Stream } from "effect"
import { EventBus } from "./EventBus.js"
import {
  AncillaryPayload,
  AttemptVerdict,
  BlockKind,
  BlockStatus,
  CheckpointKind,
  EventInput,
  EventPayload,
  JournalEvent,
  LifecyclePayload,
  RunStatus,
} from "./events.js"
import { JournalError } from "./errors.js"
import { ArtifactId, AttemptId, BlockId, CheckpointId, EventSeq, RunId, SessionId } from "./ids.js"

export interface CreateRunInput {
  readonly runId: RunId
  readonly projectId: string
  readonly prompt: string
  readonly baseCommit?: string
  readonly worktreePath?: string
  readonly branch?: string
}

export interface StartBlockInput {
  readonly runId: RunId
  readonly blockId: BlockId
  readonly defId: string
  readonly kind: BlockKind
}

export interface StartAttemptInput {
  readonly runId: RunId
  readonly blockId: BlockId
  readonly attemptId: AttemptId
  readonly number: number
  readonly sessionId?: SessionId
}

export interface FinishAttemptInput {
  readonly runId: RunId
  readonly blockId: BlockId
  readonly attemptId: AttemptId
  readonly verdict: AttemptVerdict
}

export interface RecordCheckpointInput {
  readonly checkpointId: CheckpointId
  readonly runId: RunId
  readonly blockId?: BlockId
  readonly attemptId?: AttemptId
  readonly kind: CheckpointKind
}

export interface RecordArtifactInput {
  readonly artifactId: ArtifactId
  readonly runId: RunId
  readonly blockId?: BlockId
  readonly attemptId?: AttemptId
  readonly kind: string
  readonly path: string
  readonly bytes: number
}

export class Journal extends Context.Tag("cockpit/Journal")<
  Journal,
  {
    readonly append: (
      input: EventInput<AncillaryPayload>,
    ) => Effect.Effect<JournalEvent, JournalError>
    readonly eventsFrom: (
      runId: RunId,
      after: EventSeq,
      limit?: number,
    ) => Stream.Stream<JournalEvent, JournalError>
    readonly runStatus: (runId: RunId) => Effect.Effect<RunStatus, JournalError>

    readonly createRun: (input: CreateRunInput) => Effect.Effect<void, JournalError>
    readonly startRun: (runId: RunId) => Effect.Effect<void, JournalError>
    readonly finishRun: (
      runId: RunId,
      status: "succeeded" | "failed",
    ) => Effect.Effect<void, JournalError>
    readonly cancelRun: (runId: RunId) => Effect.Effect<void, JournalError>
    readonly recoverRun: (
      runId: RunId,
      lastCheckpoint?: CheckpointId,
    ) => Effect.Effect<void, JournalError>

    readonly startBlock: (input: StartBlockInput) => Effect.Effect<void, JournalError>
    readonly finishBlock: (
      runId: RunId,
      blockId: BlockId,
      status: "succeeded" | "failed" | "interrupted",
    ) => Effect.Effect<void, JournalError>
    readonly skipBlock: (
      input: StartBlockInput & { readonly reason: string },
    ) => Effect.Effect<void, JournalError>

    readonly startAttempt: (input: StartAttemptInput) => Effect.Effect<void, JournalError>
    readonly finishAttempt: (input: FinishAttemptInput) => Effect.Effect<void, JournalError>
    readonly interruptAttempt: (
      runId: RunId,
      blockId: BlockId,
      attemptId: AttemptId,
    ) => Effect.Effect<void, JournalError>

    readonly recordCheckpoint: (
      input: RecordCheckpointInput,
    ) => Effect.Effect<void, JournalError>
    readonly recordArtifact: (input: RecordArtifactInput) => Effect.Effect<void, JournalError>
  }
>() {}

const payloadJson = Schema.parseJson(EventPayload)
const encodePayload = Schema.encode(payloadJson)
const decodePayload = Schema.decodeUnknown(payloadJson)

type WriteError = JournalError | SqlError.SqlError | ParseResult.ParseError

const asJournalError = (op: string) => (error: WriteError) =>
  error._tag === "JournalError" ? error : new JournalError({ op, detail: error.message })

const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString())

interface EventRow {
  readonly seq: number
  readonly ts: string
  readonly run_id: string
  readonly block_id: string | null
  readonly attempt_id: string | null
  readonly payload_json: string
}

export const JournalLive = Layer.effect(
  Journal,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const bus = yield* EventBus

    const lock = yield* Effect.makeSemaphore(1)

    const insertEvent = (input: EventInput) =>
      Effect.gen(function* () {
        const ts = yield* nowIso
        const encoded = yield* encodePayload(input.payload)
        const rows = yield* sql<{ seq: number }>`
          INSERT INTO events (run_id, block_id, attempt_id, ts, payload_json)
          VALUES (
            ${input.runId},
            ${input.blockId ?? null},
            ${input.attemptId ?? null},
            ${ts},
            ${encoded}
          )
          RETURNING seq`
        return JournalEvent.make({
          seq: EventSeq.make(rows[0].seq),
          ts,
          runId: input.runId,
          blockId: input.blockId,
          attemptId: input.attemptId,
          payload: input.payload,
        })
      })

    /**
     * Journal-first: the row change and its event commit together, and the event reaches
     * subscribers only once that transaction is durable. A caller's own transaction would
     * demote this one to a savepoint — publishing an event the outer rollback then erases —
     * so nesting is refused rather than silently breaking the invariant. The semaphore keeps
     * publish order equal to seq order for concurrent writers.
     */
    const commit = (op: string, body: Effect.Effect<EventInput, WriteError>) =>
      Effect.flatMap(Effect.serviceOption(SqlClient.TransactionConnection), (open) =>
        Option.isSome(open)
          ? Effect.fail(
              new JournalError({ op, detail: "journal writes must own their transaction" }),
            )
          : lock.withPermits(1)(
              Effect.uninterruptible(
                sql
                  .withTransaction(Effect.flatMap(body, insertEvent))
                  .pipe(Effect.mapError(asJournalError(op)), Effect.tap(bus.publish)),
              ),
            ),
      )

    const commitVoid = (op: string, body: Effect.Effect<EventInput, WriteError>) =>
      Effect.asVoid(commit(op, body))

    const requireRunStatus = (op: string, runId: RunId, allowed: ReadonlyArray<RunStatus>) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ status: RunStatus }>`
          SELECT status FROM runs WHERE id = ${runId}`
        const current = rows[0]?.status
        if (current === undefined) {
          return yield* new JournalError({ op, detail: `unknown run ${runId}` })
        }
        if (!allowed.includes(current)) {
          return yield* new JournalError({
            op,
            detail: `run ${runId} is ${current}, expected one of ${allowed.join(", ")}`,
          })
        }
        return current
      })

    const requireBlockStatus = (
      op: string,
      runId: RunId,
      blockId: BlockId,
      allowed: ReadonlyArray<BlockStatus>,
    ) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ status: BlockStatus }>`
          SELECT status FROM blocks WHERE id = ${blockId} AND run_id = ${runId}`
        const current = rows[0]?.status
        if (current === undefined) {
          return yield* new JournalError({ op, detail: `unknown block ${blockId}` })
        }
        if (!allowed.includes(current)) {
          return yield* new JournalError({
            op,
            detail: `block ${blockId} is ${current}, expected one of ${allowed.join(", ")}`,
          })
        }
      })

    /** A run may only reach a terminal status once nothing beneath it can still report a result. */
    const requireNoOpenChildren = (op: string, runId: RunId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ blocks: number; attempts: number }>`
          SELECT
            (SELECT COUNT(*) FROM blocks
              WHERE run_id = ${runId} AND status = ${"running"}) AS blocks,
            (SELECT COUNT(*) FROM attempts a JOIN blocks b ON b.id = a.block_id
              WHERE b.run_id = ${runId} AND a.verdict IS NULL) AS attempts`
        const open = rows[0]
        if (open.blocks > 0 || open.attempts > 0) {
          return yield* new JournalError({
            op,
            detail: `run ${runId} still has ${open.blocks} running block(s) and ${open.attempts} unfinished attempt(s)`,
          })
        }
      })

    /** Foreign keys pin each id to an existing row; only a join proves it hangs under this run. */
    const requireCheckpointParents = (op: string, input: RecordCheckpointInput) =>
      Effect.gen(function* () {
        if (input.blockId !== undefined) {
          const rows = yield* sql<{ id: string }>`
            SELECT id FROM blocks WHERE id = ${input.blockId} AND run_id = ${input.runId}`
          if (rows.length === 0) {
            return yield* new JournalError({
              op,
              detail: `block ${input.blockId} does not belong to run ${input.runId}`,
            })
          }
        }
        if (input.attemptId !== undefined) {
          const rows = yield* sql<{ id: string }>`
            SELECT a.id FROM attempts a JOIN blocks b ON b.id = a.block_id
            WHERE a.id = ${input.attemptId} AND b.run_id = ${input.runId}`
          if (rows.length === 0) {
            return yield* new JournalError({
              op,
              detail: `attempt ${input.attemptId} does not belong to run ${input.runId}`,
            })
          }
        }
      })

    const requireAbsent = (
      op: string,
      table: "runs" | "blocks" | "attempts" | "artifacts",
      id: string,
    ) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ id: string }>`
          SELECT id FROM ${sql(table)} WHERE id = ${id}`
        if (rows.length > 0) {
          return yield* new JournalError({ op, detail: `${table} row ${id} already exists` })
        }
      })

    const requireRunningAttempt = (op: string, blockId: BlockId, attemptId: AttemptId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ verdict: string | null }>`
          SELECT verdict FROM attempts WHERE id = ${attemptId} AND block_id = ${blockId}`
        const row = rows[0]
        if (row === undefined) {
          return yield* new JournalError({ op, detail: `unknown attempt ${attemptId}` })
        }
        if (row.verdict !== null) {
          return yield* new JournalError({
            op,
            detail: `attempt ${attemptId} already finished as ${row.verdict}`,
          })
        }
      })

    const closeRun = (
      op: string,
      runId: RunId,
      from: ReadonlyArray<RunStatus>,
      status: RunStatus,
      payload: LifecyclePayload,
    ) =>
      commitVoid(
        op,
        Effect.gen(function* () {
          yield* requireRunStatus(op, runId, from)
          yield* requireNoOpenChildren(op, runId)
          const ts = yield* nowIso
          yield* sql`UPDATE runs SET status = ${status}, finished_at = ${ts} WHERE id = ${runId}`
          return { runId, payload }
        }),
      )

    const decodeRow = (row: EventRow) =>
      Effect.map(decodePayload(row.payload_json), (payload) =>
        JournalEvent.make({
          seq: EventSeq.make(row.seq),
          ts: row.ts,
          runId: RunId.make(row.run_id),
          blockId: row.block_id === null ? undefined : BlockId.make(row.block_id),
          attemptId: row.attempt_id === null ? undefined : AttemptId.make(row.attempt_id),
          payload,
        }),
      )

    return {
      append: (input) => commit("append", Effect.succeed(input)),

      eventsFrom: (runId, after, limit = 1000) =>
        sql<EventRow>`
          SELECT seq, ts, run_id, block_id, attempt_id, payload_json
          FROM events WHERE run_id = ${runId} AND seq > ${after} ORDER BY seq LIMIT ${limit}`
          .pipe(
            Effect.flatMap(Effect.forEach(decodeRow)),
            Effect.mapError(asJournalError("eventsFrom")),
            Stream.fromIterableEffect,
          ),

      runStatus: (runId) =>
        requireRunStatus("runStatus", runId, RunStatus.literals).pipe(
          Effect.mapError(asJournalError("runStatus")),
        ),

      createRun: (input) =>
        commitVoid(
          "createRun",
          Effect.gen(function* () {
            yield* requireAbsent("createRun", "runs", input.runId)
            const ts = yield* nowIso
            yield* sql`
              INSERT INTO runs (id, project_id, prompt, status, base_commit, worktree_path, branch, created_at)
              VALUES (
                ${input.runId},
                ${input.projectId},
                ${input.prompt},
                ${"created"},
                ${input.baseCommit ?? null},
                ${input.worktreePath ?? null},
                ${input.branch ?? null},
                ${ts}
              )`
            return {
              runId: input.runId,
              payload: {
                _tag: "RunCreated",
                projectId: input.projectId,
                prompt: input.prompt,
              } as const,
            }
          }),
        ),

      startRun: (runId) =>
        commitVoid(
          "startRun",
          Effect.gen(function* () {
            yield* requireRunStatus("startRun", runId, ["created"])
            yield* sql`UPDATE runs SET status = ${"running"} WHERE id = ${runId}`
            return { runId, payload: { _tag: "RunStarted" } as const }
          }),
        ),

      finishRun: (runId, status) =>
        closeRun("finishRun", runId, ["running"], status, { _tag: "RunFinished", status }),

      cancelRun: (runId) =>
        closeRun("cancelRun", runId, ["created", "running"], "cancelled", {
          _tag: "RunCancelled",
        }),

      recoverRun: (runId, lastCheckpoint) =>
        closeRun("recoverRun", runId, ["created", "running"], "interrupted", {
          _tag: "RunRecovered",
          lastCheckpoint,
        }),

      startBlock: (input) =>
        commitVoid(
          "startBlock",
          Effect.gen(function* () {
            yield* requireRunStatus("startBlock", input.runId, ["running"])
            yield* requireAbsent("startBlock", "blocks", input.blockId)
            const ts = yield* nowIso
            yield* sql`
              INSERT INTO blocks (id, run_id, def_id, kind, status, started_at)
              VALUES (${input.blockId}, ${input.runId}, ${input.defId}, ${input.kind}, ${"running"}, ${ts})`
            return {
              runId: input.runId,
              blockId: input.blockId,
              payload: { _tag: "BlockStarted", defId: input.defId, kind: input.kind } as const,
            }
          }),
        ),

      finishBlock: (runId, blockId, status) =>
        commitVoid(
          "finishBlock",
          Effect.gen(function* () {
            yield* requireBlockStatus("finishBlock", runId, blockId, ["running"])
            const ts = yield* nowIso
            yield* sql`
              UPDATE blocks SET status = ${status}, finished_at = ${ts} WHERE id = ${blockId}`
            return { runId, blockId, payload: { _tag: "BlockFinished", status } as const }
          }),
        ),

      skipBlock: (input) =>
        commitVoid(
          "skipBlock",
          Effect.gen(function* () {
            yield* requireRunStatus("skipBlock", input.runId, ["running"])
            yield* requireAbsent("skipBlock", "blocks", input.blockId)
            const ts = yield* nowIso
            yield* sql`
              INSERT INTO blocks (id, run_id, def_id, kind, status, started_at, finished_at)
              VALUES (${input.blockId}, ${input.runId}, ${input.defId}, ${input.kind}, ${"skipped"}, ${ts}, ${ts})`
            return {
              runId: input.runId,
              blockId: input.blockId,
              payload: { _tag: "BlockSkipped", reason: input.reason } as const,
            }
          }),
        ),

      startAttempt: (input) =>
        commitVoid(
          "startAttempt",
          Effect.gen(function* () {
            yield* requireBlockStatus("startAttempt", input.runId, input.blockId, ["running"])
            yield* requireAbsent("startAttempt", "attempts", input.attemptId)
            const ts = yield* nowIso
            yield* sql`
              INSERT INTO attempts (id, block_id, number, session_id, started_at)
              VALUES (
                ${input.attemptId},
                ${input.blockId},
                ${input.number},
                ${input.sessionId ?? null},
                ${ts}
              )`
            return {
              runId: input.runId,
              blockId: input.blockId,
              attemptId: input.attemptId,
              payload: {
                _tag: "AttemptStarted",
                number: input.number,
                sessionId: input.sessionId,
              } as const,
            }
          }),
        ),

      finishAttempt: (input) =>
        commitVoid(
          "finishAttempt",
          Effect.gen(function* () {
            yield* requireRunningAttempt("finishAttempt", input.blockId, input.attemptId)
            const ts = yield* nowIso
            yield* sql`
              UPDATE attempts SET verdict = ${input.verdict}, finished_at = ${ts}
              WHERE id = ${input.attemptId}`
            return {
              runId: input.runId,
              blockId: input.blockId,
              attemptId: input.attemptId,
              payload: { _tag: "AttemptFinished", verdict: input.verdict } as const,
            }
          }),
        ),

      interruptAttempt: (runId, blockId, attemptId) =>
        commitVoid(
          "interruptAttempt",
          Effect.gen(function* () {
            yield* requireRunningAttempt("interruptAttempt", blockId, attemptId)
            const ts = yield* nowIso
            yield* sql`
              UPDATE attempts SET verdict = ${"interrupted"}, finished_at = ${ts} WHERE id = ${attemptId}`
            return {
              runId,
              blockId,
              attemptId,
              payload: { _tag: "AttemptInterrupted" } as const,
            }
          }),
        ),

      recordCheckpoint: (input) =>
        commitVoid(
          "recordCheckpoint",
          Effect.gen(function* () {
            yield* requireRunStatus("recordCheckpoint", input.runId, ["running"])
            yield* requireCheckpointParents("recordCheckpoint", input)
            const ts = yield* nowIso
            yield* sql`
              INSERT INTO checkpoints (id, run_id, block_id, attempt_id, kind, created_at)
              VALUES (
                ${input.checkpointId},
                ${input.runId},
                ${input.blockId ?? null},
                ${input.attemptId ?? null},
                ${input.kind},
                ${ts}
              )`
            return {
              runId: input.runId,
              blockId: input.blockId,
              attemptId: input.attemptId,
              payload: {
                _tag: "CheckpointCreated",
                checkpointId: input.checkpointId,
                kind: input.kind,
              } as const,
            }
          }),
        ),

      recordArtifact: (input) =>
        commitVoid(
          "recordArtifact",
          Effect.gen(function* () {
            // `created` too: the Analyzer's prompt and decision belong to the run that is being
            // planned, and planning happens before the engine starts it.
            yield* requireRunStatus("recordArtifact", input.runId, ["created", "running"])
            yield* requireAbsent("recordArtifact", "artifacts", input.artifactId)
            // No parent join, unlike checkpoints: an approval payload belongs to a gate, and a
            // gate has an id without ever becoming a block row.
            const ts = yield* nowIso
            yield* sql`
              INSERT INTO artifacts (id, run_id, kind, path, bytes, created_at)
              VALUES (
                ${input.artifactId},
                ${input.runId},
                ${input.kind},
                ${input.path},
                ${input.bytes},
                ${ts}
              )`
            return {
              runId: input.runId,
              blockId: input.blockId,
              attemptId: input.attemptId,
              payload: {
                _tag: "ArtifactCreated",
                artifactId: input.artifactId,
                kind: input.kind,
                path: input.path,
                bytes: input.bytes,
              } as const,
            }
          }),
        ),
    }
  }),
)
