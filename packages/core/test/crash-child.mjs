// Runs the built kernel in its own process so the parent test can SIGKILL it mid-write.
import { NodeContext } from "@effect/platform-node"
import { ConfigProvider, Effect, Layer } from "effect"
import { AttemptId, BlockId, CheckpointId, Journal, KernelLive, RunId } from "../dist/index.js"

const [home, run, block, attempt, successCheckpoint, salvageCheckpoint] = process.argv.slice(2)

const runId = RunId.make(run)
const blockId = BlockId.make(block)
const attemptId = AttemptId.make(attempt)

const program = Effect.gen(function* () {
  const journal = yield* Journal
  yield* journal.createRun({ runId, projectId: "crash", prompt: "kill -9" })
  yield* journal.startRun(runId)
  yield* journal.startBlock({ runId, blockId, defId: "implement", kind: "agent" })
  yield* journal.startAttempt({ runId, blockId, attemptId, number: 1 })
  yield* journal.recordCheckpoint({
    checkpointId: CheckpointId.make(successCheckpoint),
    runId,
    blockId,
    attemptId,
    kind: "success",
  })
  // Newer than the success one, so recovery proves it reports the last *confirmed* checkpoint.
  yield* journal.recordCheckpoint({
    checkpointId: CheckpointId.make(salvageCheckpoint),
    runId,
    blockId,
    attemptId,
    kind: "salvage",
  })

  // Distinctive token: Effect's own boot logs also go to stdout and contain the word "ready".
  process.stdout.write("COCKPIT_CHILD_READY\n")

  yield* Effect.forever(
    journal.append({
      runId,
      blockId,
      attemptId,
      payload: {
        _tag: "ErrorRaised",
        class: "technical",
        signature: "loop",
        message: "still working",
      },
    }),
  )
})

const layer = KernelLive.pipe(
  Layer.provide(NodeContext.layer),
  Layer.provide(
    Layer.setConfigProvider(ConfigProvider.fromMap(new Map([["COCKPIT_HOME", home]]))),
  ),
)

Effect.runPromise(Effect.scoped(Effect.provide(program, layer))).catch((error) => {
  process.stderr.write(`${error}\n`)
  process.exit(1)
})
