import { Effect, Exit, Fiber } from "effect"
import { readFile } from "node:fs/promises"
import * as NodePath from "node:path"
import { expect, it } from "vitest"
import {
  agentTask,
  BlockId,
  runCommand,
  verifyOutput,
  WorkflowEngine,
  WorkflowNode,
} from "../src/index.js"
import { block, catalog, id, of, waitFor, withEngine } from "./engine-harness.js"
import { readEvents, tempDir } from "./helpers.js"

const summary = (text: string) => ({ output: { summary: text } })
const verdict = (passed: boolean) => ({ output: { passed, findings: [] } })

/** Reports a verdict without judging the block on it, so both condition branches are reachable. */
const reportingVerifier = catalog([{ ...verifyOutput, input: [], successCriteria: [] }])

/** A verdict block under its own def id, so a tree can hold two verifiers with separate scripts. */
const reporter = { ...verifyOutput, id: "report", input: [], successCriteria: [] }

const implementThenVerify = {
  _tag: "Sequence" as const,
  children: [
    block("implement", agentTask.id),
    block("verify", verifyOutput.id, { inputs: [id("implement")] }),
  ],
}

it("runs a sequence in order and hands each output to the next block", async () => {
  const { events, outcome } = await withEngine(
    { "agent-task": summary("edited the parser"), "verify-output": verdict(true) },
    ({ runId, start }) =>
      Effect.gen(function* () {
        const outcome = yield* start(implementThenVerify)
        return { outcome, events: yield* readEvents(runId) }
      }),
  )

  expect(outcome.status).toBe("succeeded")
  expect(outcome.outputs).toMatchObject({
    implement: { summary: "edited the parser" },
    verify: { passed: true },
  })
  expect(of(events, "BlockStarted").map((event) => event.blockId)).toEqual(["implement", "verify"])
  expect(of(events, "PromptComposed").at(1)?.blockId).toBe("verify")
}, 30_000)

it("shows the next block only the fields its input contract declares", async () => {
  const prompt = await withEngine(
    {
      "agent-task": { output: { summary: "rewrote the tokenizer", secret: "not for the verifier" } },
      "verify-output": verdict(true),
    },
    ({ runId, start }) =>
      Effect.gen(function* () {
        yield* start(implementThenVerify)
        const events = yield* readEvents(runId)
        const composed = of(events, "PromptComposed").at(1)!
        const artifact = of(events, "ArtifactCreated").find(
          (event) => event.payload.artifactId === composed.payload.promptRef,
        )!
        return yield* Effect.promise(() =>
          import("node:fs/promises").then((fs) => fs.readFile(artifact.payload.path, "utf8")),
        )
      }),
  )

  expect(prompt).toContain("rewrote the tokenizer")
  expect(prompt).not.toContain("not for the verifier")
}, 30_000)

it("runs parallel branches concurrently", async () => {
  const events = await withEngine(
    {
      "agent-task": { ...summary("slow"), delayMs: 300 },
      "read-only-task": { ...summary("slow"), delayMs: 300 },
    },
    ({ runId, start }) =>
      Effect.gen(function* () {
        yield* start(
          {
            _tag: "Parallel",
            branches: [
              { node: block("a", agentTask.id), workspaceAccess: "write" },
              { node: block("b", "read-only-task"), workspaceAccess: "read" },
            ],
          },
          catalog([{ ...agentTask, id: "read-only-task", workspaceAccess: "read" }]),
        )
        return yield* readEvents(runId)
      }),
  )

  // Both attempts are open at once, which sequential execution could never produce.
  const tags = events.map((event) => event.payload._tag)
  expect(tags.lastIndexOf("AttemptStarted")).toBeLessThan(tags.indexOf("AttemptFinished"))
  expect(of(events, "AttemptFinished")).toHaveLength(2)
}, 30_000)

it("refuses a tree where two parallel branches would write to one worktree", async () => {
  const exit = await withEngine({}, ({ start }) =>
    Effect.exit(
      start({
        _tag: "Parallel",
        branches: [
          { node: block("a", agentTask.id), workspaceAccess: "write" },
          { node: block("b", agentTask.id), workspaceAccess: "write" },
        ],
      }),
    ),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("parallel-write-conflict")
}, 30_000)

it.each([
  { passed: true, taken: "on-true" },
  { passed: false, taken: "on-false" },
])("takes the $taken branch when the predicate is $passed", async ({ passed, taken }) => {
  const outputs = await withEngine(
    { "verify-output": verdict(passed), "agent-task": summary("branch ran") },
    ({ start }) =>
      Effect.map(
        start(
          {
            _tag: "Sequence",
            children: [
              block("check", verifyOutput.id),
              {
                _tag: "Condition",
                predicate: { blockId: id("check"), path: ["passed"], comparator: "eq", value: true },
                onTrue: block("on-true", agentTask.id),
                onFalse: block("on-false", agentTask.id),
              },
            ],
          },
          reportingVerifier,
        ),
        (outcome) => outcome.outputs,
      ),
  )

  expect(Object.keys(outputs).sort()).toEqual(["check", taken].sort())
}, 30_000)

const gateTree = {
  _tag: "Sequence" as const,
  children: [
    {
      _tag: "Gate" as const,
      id: id("approve"),
      payload: { title: "Approve the plan", summary: "the next block writes to the worktree" },
    },
    block("implement", agentTask.id),
  ],
}

it.each([
  { approved: true, status: "succeeded", blocks: ["implement"] },
  { approved: false, status: "failed", blocks: [] as ReadonlyArray<string> },
])(
  "$status the run when the approval gate is answered with $approved",
  async ({ approved, status, blocks }) => {
    const { events, outcome } = await withEngine(
      { "agent-task": summary("done") },
      ({ runId, start }) =>
        Effect.gen(function* () {
          const engine = yield* WorkflowEngine
          const running = yield* Effect.fork(start(gateTree))
          yield* waitFor(runId, (seen) => of(seen, "ApprovalRequested").length > 0)
          yield* engine.approveGate(runId, BlockId.make("approve"), approved, "reviewed")
          const outcome = yield* Fiber.join(running)
          return { outcome, events: yield* readEvents(runId) }
        }),
    )

    expect(outcome.status).toBe(status)
    expect(of(events, "ApprovalDecided")[0].payload).toMatchObject({ approved, note: "reviewed" })
    expect(of(events, "BlockStarted").map((event) => event.blockId)).toEqual(blocks)
  },
  30_000,
)

it("leaves an interrupted run open: the caller owns the close", async () => {
  const events = await withEngine({ "agent-task": { hang: true } }, ({ runId, start }) =>
    Effect.gen(function* () {
      const running = yield* Effect.fork(start(block("implement", agentTask.id)))
      yield* waitFor(runId, (seen) => of(seen, "PromptComposed").length > 0)
      yield* Fiber.interrupt(running)
      return yield* readEvents(runId)
    }),
  )

  const tags = events.map((event) => event.payload._tag)
  expect(tags).toContain("AttemptInterrupted")
  expect(of(events, "BlockFinished")[0].payload).toMatchObject({ status: "interrupted" })
  // Only the caller knows whether this was a Stop, a Cancel, or the daemon going down.
  expect(of(events, "RunCancelled")).toHaveLength(0)
  expect(of(events, "RunFinished")).toHaveLength(0)
}, 30_000)

it("fails a block whose required artifact never appeared", async () => {
  const { events, outcome } = await withEngine(
    { "agent-task": summary("said it wrote the report") },
    ({ runId, start }) =>
      Effect.gen(function* () {
        const outcome = yield* start(
          block("implement", agentTask.id),
          catalog([
            { ...agentTask, expectedArtifacts: [{ glob: "report.json", required: true }] },
          ]),
        )
        return { outcome, events: yield* readEvents(runId) }
      }),
  )

  expect(outcome.status).toBe("failed")
  expect(of(events, "AttemptFinished")[0].payload).toMatchObject({ verdict: "semantic-failure" })
}, 30_000)

it("runs a command block and journals what it ran", async () => {
  const { events, outcome } = await withEngine({}, ({ runId, start }) =>
    Effect.gen(function* () {
      const outcome = yield* start(
        block("check", runCommand.id, {
          overrides: { command: { argv: ["git", "status", "--porcelain"] } },
        }),
      )
      return { outcome, events: yield* readEvents(runId) }
    }),
  )

  expect(outcome.status).toBe("succeeded")
  expect(outcome.outputs).toMatchObject({ check: { success: true, exitCode: 0 } })
  expect(of(events, "CommandExecuted")[0].payload).toMatchObject({ success: true })
}, 30_000)

it("never reads the result a previous technical try left behind", async () => {
  const { events, outcome } = await withEngine(
    {
      "agent-task:1": { ...summary("wrote a result, then died"), exitCode: 3 },
      "agent-task:2": { text: "came back and wrote nothing" },
    },
    ({ runId, start }) =>
      Effect.gen(function* () {
        const outcome = yield* start(block("implement", agentTask.id))
        return { outcome, events: yield* readEvents(runId) }
      }),
  )

  // The second try is what makes this a regression: it ran, and it wrote nothing of its own.
  expect(of(events, "RetryScheduled")[0].payload).toMatchObject({ class: "technical" })
  expect(outcome.status).toBe("failed")
  expect(outcome.outputs).toEqual({})
  expect(of(events, "AttemptFinished")[0].payload).toMatchObject({ verdict: "semantic-failure" })
}, 30_000)

it("refuses a result the agent pointed somewhere else with a symlink", async () => {
  const elsewhere = NodePath.join(await tempDir("cockpit-elsewhere-"), "borrowed.json")
  const { events, outcome } = await withEngine(
    { "agent-task": { symlinkOutputTo: elsewhere, text: "linked it in" } },
    ({ runId, start }) =>
      Effect.gen(function* () {
        const outcome = yield* start(block("implement", agentTask.id))
        return { outcome, events: yield* readEvents(runId) }
      }),
  )

  expect(outcome.status).toBe("failed")
  expect(outcome.outputs).toEqual({})
  expect(of(events, "AttemptFinished")[0].payload).toMatchObject({ verdict: "semantic-failure" })
}, 30_000)

it("refuses a result larger than a block is allowed to hand back", async () => {
  const { events, outcome } = await withEngine(
    { "agent-task": summary("x".repeat(1_100_000)) },
    ({ runId, start }) =>
      Effect.gen(function* () {
        const outcome = yield* start(block("implement", agentTask.id))
        return { outcome, events: yield* readEvents(runId) }
      }),
  )

  expect(outcome.status).toBe("failed")
  expect(of(events, "AttemptFinished")[0].payload).toMatchObject({ verdict: "semantic-failure" })
  expect(of(events, "ResultProduced")).toHaveLength(0)
}, 30_000)

it("keeps a large result out of the journal and out of the next block's prompt", async () => {
  const bulk = "y".repeat(20_000)
  const { produced, prompt } = await withEngine(
    { "agent-task": summary(bulk), "verify-output": verdict(true) },
    ({ runId, start }) =>
      Effect.gen(function* () {
        yield* start(implementThenVerify)
        const events = yield* readEvents(runId)
        const composed = of(events, "PromptComposed").at(1)!
        const artifact = of(events, "ArtifactCreated").find(
          (event) => event.payload.artifactId === composed.payload.promptRef,
        )!
        return {
          produced: of(events, "ResultProduced")[0].payload,
          prompt: yield* Effect.promise(() => readFile(artifact.payload.path, "utf8")),
        }
      }),
  )

  expect(produced.outputRef).toBeDefined()
  expect(produced.outputInline).toBeUndefined()
  expect(prompt).not.toContain("y".repeat(5_000))
  expect(prompt).toContain("[truncated, full value in artifact ")
}, 30_000)

/** Only one branch produces `implement`, so wiring past the condition can go unfilled at runtime. */
const branchedTree = (tail: WorkflowNode): WorkflowNode => ({
  _tag: "Sequence",
  children: [
    block("check", reporter.id),
    {
      _tag: "Condition",
      predicate: { blockId: id("check"), path: ["passed"], comparator: "eq", value: true },
      onTrue: block("implement", agentTask.id),
      onFalse: block("other", agentTask.id),
    },
    tail,
  ],
})

it("fails an attempt whose required input was never produced", async () => {
  const { events, failure } = await withEngine(
    { report: verdict(false), "agent-task": summary("took the other branch") },
    ({ runId, start }) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          start(
            branchedTree(block("review", verifyOutput.id, { inputs: [id("implement")] })),
            catalog([reporter]),
          ),
        )
        return { failure: String(exit), events: yield* readEvents(runId) }
      }),
  )

  expect(failure).toContain("missing required input")
  expect(of(events, "ErrorRaised")[0].payload).toMatchObject({ signature: "missing-input" })
  expect(of(events, "BlockStarted").map((event) => event.blockId)).toEqual([
    "check",
    "other",
    "review",
  ])
}, 30_000)

it("takes the false branch when a predicate reads a block that never ran", async () => {
  const { events, outcome } = await withEngine(
    { report: verdict(false), "agent-task": summary("took the other branch") },
    ({ runId, start }) =>
      Effect.gen(function* () {
        const outcome = yield* start(
          branchedTree({
            _tag: "Condition",
            // `neq` against a block that produced nothing would otherwise answer true.
            predicate: { blockId: id("implement"), path: ["summary"], comparator: "neq", value: "x" },
            onTrue: block("wrong", agentTask.id),
            onFalse: block("right", agentTask.id),
          }),
          catalog([reporter]),
        )
        return { outcome, events: yield* readEvents(runId) }
      }),
  )

  expect(outcome.status).toBe("succeeded")
  expect(Object.keys(outcome.outputs).sort()).toEqual(["check", "other", "right"])
  expect(of(events, "ErrorRaised")[0].payload).toMatchObject({
    signature: "predicate-source-missing",
  })
}, 30_000)

it("fails the run when a command block exits non-zero, keeping its output", async () => {
  const { events, outcome } = await withEngine({}, ({ runId, start }) =>
    Effect.gen(function* () {
      const outcome = yield* start(
        block("check", runCommand.id, {
          overrides: { command: { argv: ["git", "rev-parse", "--verify", "no-such-ref"] } },
        }),
      )
      return { outcome, events: yield* readEvents(runId) }
    }),
  )

  expect(outcome.status).toBe("failed")
  expect(of(events, "BlockFinished")[0].payload).toMatchObject({ status: "failed" })
  expect(of(events, "OutputChunk").map((event) => event.payload.streamKind)).toContain("stderr")
}, 30_000)
