import { SqlClient } from "@effect/sql"
import { Effect, Layer } from "effect"
import { AttemptId, BlockId, CheckpointId, RunId } from "./ids.js"
import { Journal } from "./Journal.js"

/**
 * Marks state left behind by a crashed daemon: child processes died with their
 * process groups, so anything still open in the journal is interrupted, never resumed here.
 */
export const recoverInterruptedRuns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const journal = yield* Journal

  const runs = yield* sql<{ id: string }>`
    SELECT id FROM runs WHERE status IN (${"created"}, ${"running"})`

  return yield* Effect.forEach(runs, ({ id }) =>
    Effect.gen(function* () {
      const runId = RunId.make(id)

      const attempts = yield* sql<{ id: string; block_id: string }>`
        SELECT a.id, a.block_id FROM attempts a
        JOIN blocks b ON b.id = a.block_id
        WHERE b.run_id = ${runId} AND a.verdict IS NULL`
      yield* Effect.forEach(
        attempts,
        (attempt) =>
          journal.interruptAttempt(
            runId,
            BlockId.make(attempt.block_id),
            AttemptId.make(attempt.id),
          ),
        { discard: true },
      )

      const blocks = yield* sql<{ id: string }>`
        SELECT id FROM blocks WHERE run_id = ${runId} AND status = ${"running"}`
      yield* Effect.forEach(
        blocks,
        (block) => journal.finishBlock(runId, BlockId.make(block.id), "interrupted"),
        { discard: true },
      )

      // Only a success checkpoint is a confirmed resume point; salvage commits record failed work.
      // Insertion order, not created_at: a wall clock that stepped backwards would reorder these.
      const checkpoints = yield* sql<{ id: string }>`
        SELECT id FROM checkpoints
        WHERE run_id = ${runId} AND kind = ${"success"}
        ORDER BY rowid DESC LIMIT 1`
      const last = checkpoints[0]
      yield* journal.recoverRun(runId, last === undefined ? undefined : CheckpointId.make(last.id))

      return runId
    }),
  )
})

export const RecoveryScanLive = Layer.effectDiscard(
  Effect.flatMap(recoverInterruptedRuns, (runs) =>
    Effect.log(`recovery scan: ${runs.length} interrupted run(s)`),
  ),
)
