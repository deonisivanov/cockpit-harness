import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { AttemptId, BlockId, Journal, RunId, recoverInterruptedRuns } from "../src/index.js"
import { payloads, readEvents, runKernel, tempHome } from "./helpers.js"

const childScript = NodePath.join(NodePath.dirname(fileURLToPath(import.meta.url)), "crash-child.mjs")

const runId = RunId.make("run-crash")
const blockId = BlockId.make("block-crash")
const attemptId = AttemptId.make("attempt-crash")
const successCheckpoint = "1".repeat(40)
const salvageCheckpoint = "2".repeat(40)
// The crash child appends until it dies, well past the default page eventsFrom returns.
const unlimited = 1_000_000

const killChildMidWrite = (home: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [childScript, home, runId, blockId, attemptId, successCheckpoint, salvageCheckpoint],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    let stderr = ""
    let stdout = ""
    let armed = false
    child.stderr.on("data", (chunk) => (stderr += chunk))

    const failEarly = (code: number | null) =>
      reject(new Error(`crash child exited before it was ready (${code}): ${stderr}`))
    child.once("exit", failEarly)

    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`crash child never signalled ready: ${stderr}`))
    }, 30_000)

    child.stdout.on("data", (chunk) => {
      stdout += chunk
      if (armed || !stdout.includes("COCKPIT_CHILD_READY")) return
      armed = true
      child.off("exit", failEarly)
      clearTimeout(timer)
      // Registered before the kill is scheduled, so an exit in the meantime is still observed.
      child.once("exit", (_code, signal) => {
        if (signal === "SIGKILL") resolve()
        else reject(new Error(`crash child exited by ${signal ?? "code"} instead of SIGKILL`))
      })
      // Let the append loop get well underway so the kill lands mid-write.
      setTimeout(() => child.kill("SIGKILL"), 250)
    })
  })

it("recovers truthfully from a kill -9 in the middle of journal writes", async () => {
  const home = await tempHome()
  await killChildMidWrite(home)

  const after = await runKernel(
    home,
    Effect.gen(function* () {
      const journal = yield* Journal
      const sql = yield* SqlClient.SqlClient

      const beforeScan = yield* readEvents(runId, unlimited)
      const recovered = yield* recoverInterruptedRuns
      const secondScan = yield* recoverInterruptedRuns

      const attempts = yield* sql<{ id: string; verdict: string | null }>`
        SELECT id, verdict FROM attempts`
      const blocks = yield* sql<{ id: string; status: string }>`SELECT id, status FROM blocks`

      return {
        attempts,
        blocks,
        events: yield* readEvents(runId, unlimited),
        recovered,
        secondScan,
        status: yield* journal.runStatus(runId),
        writtenBeforeCrash: beforeScan.length,
      }
    }),
  )

  // The child really was killed while hammering the journal, not during setup.
  expect(after.writtenBeforeCrash).toBeGreaterThan(10)

  expect(after.recovered).toEqual([runId])
  expect(after.status).toBe("interrupted")
  expect(after.attempts).toEqual([{ id: attemptId, verdict: "interrupted" }])
  expect(after.blocks).toEqual([{ id: blockId, status: "interrupted" }])

  const tags = payloads(after.events)
  expect(tags.filter((tag) => tag === "RunCreated")).toHaveLength(1)
  expect(tags.filter((tag) => tag === "RunStarted")).toHaveLength(1)
  expect(tags.filter((tag) => tag === "BlockStarted")).toHaveLength(1)
  expect(tags.filter((tag) => tag === "AttemptStarted")).toHaveLength(1)
  expect(tags.filter((tag) => tag === "AttemptInterrupted")).toHaveLength(1)
  expect(tags.filter((tag) => tag === "RunRecovered")).toHaveLength(1)
  expect(tags.slice(-3)).toEqual(["AttemptInterrupted", "BlockFinished", "RunRecovered"])

  // The salvage checkpoint is newer, so this also pins "last *confirmed*", not "last".
  expect(after.events.at(-1)?.payload).toMatchObject({
    _tag: "RunRecovered",
    lastCheckpoint: successCheckpoint,
  })

  // Contiguous from 1: SIGKILL cannot tear a write() that already returned, so what this pins
  // is that no aborted transaction stayed partially visible.
  const seqs = after.events.map((event) => event.seq)
  expect(seqs).toEqual(seqs.map((_, index) => index + 1))

  // A second boot must not re-interrupt an already recovered run.
  expect(after.secondScan).toEqual([])
}, 60_000)

it("leaves runs in a terminal status untouched", async () => {
  const result = await runKernel(
    await tempHome(),
    Effect.gen(function* () {
      const journal = yield* Journal
      const finished = RunId.make("run-done")
      yield* journal.createRun({ runId: finished, projectId: "p", prompt: "x" })
      yield* journal.startRun(finished)
      yield* journal.finishRun(finished, "succeeded")

      const recovered = yield* recoverInterruptedRuns
      return { recovered, status: yield* journal.runStatus(finished) }
    }),
  )

  expect(result.recovered).toEqual([])
  expect(result.status).toBe("succeeded")
})

it("marks a run with no checkpoints as interrupted without one", async () => {
  const events = await runKernel(
    await tempHome(),
    Effect.gen(function* () {
      const journal = yield* Journal
      const bare = RunId.make("run-bare")
      yield* journal.createRun({ runId: bare, projectId: "p", prompt: "x" })
      yield* journal.startRun(bare)
      yield* recoverInterruptedRuns
      return yield* readEvents(bare)
    }),
  )

  expect(events.at(-1)?.payload).toEqual({ _tag: "RunRecovered" })
})
