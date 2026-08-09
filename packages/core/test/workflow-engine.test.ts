import { Effect, Exit, Fiber } from "effect"
import { readFile } from "node:fs/promises"
import * as NodePath from "node:path"
import { expect, it } from "vitest"
import {
  agentTask,
  BlockDef,
  BlockId,
  CheckpointService,
  correctivePolicy,
  RunId,
  runCommand,
  verifyOutput,
  WorkflowEngine,
  WorkflowNode,
} from "../src/index.js"
import {
  block,
  catalog,
  id,
  of,
  spawnedArgv,
  startedIds,
  waitFor,
  withEngine,
} from "./engine-harness.js"
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
  expect(startedIds(events)).toEqual(["implement", "verify"])
  expect(of(events, "PromptComposed").at(1)?.blockId).toBe("verify")
}, 30_000)

it("runs a block under the model its node names and the effort only its definition names", async () => {
  const opinionated: BlockDef = { ...agentTask, id: "opinionated", model: "sonnet", effort: "low" }

  const outcome = await withEngine(
    { opinionated: summary("done") },
    ({ start }) =>
      start(
        block("implement", opinionated.id, { overrides: { model: "opus" } }),
        catalog([opinionated]),
      ),
  )

  expect(outcome.status).toBe("succeeded")
  expect((await spawnedArgv(opinionated.id)).join(" ")).toContain("--model opus --effort low")
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
    expect(startedIds(events)).toEqual(blocks)
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

it("refuses a second execution of a run already under way", async () => {
  const { events, refusal } = await withEngine({ "agent-task": { hang: true } }, ({ runId, start }) =>
    Effect.gen(function* () {
      const running = yield* Effect.fork(start(implementThenVerify))
      yield* waitFor(runId, (seen) => of(seen, "PromptComposed").length > 0)
      // The claim is the journal's, so an unclaimed second entry has to collide with it.
      const refusal = yield* Effect.flip(start(implementThenVerify))
      yield* Fiber.interrupt(running)
      return { refusal, events: yield* readEvents(runId) }
    }),
  )

  expect(refusal).toMatchObject({ _tag: "JournalError", op: "startRun" })
  expect(of(events, "RunStarted")).toHaveLength(1)
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

it("fails an attempt whose required input was never produced, with a verdict", async () => {
  const { events, outcome } = await withEngine(
    { report: verdict(false), "agent-task": summary("took the other branch") },
    ({ runId, start }) =>
      Effect.gen(function* () {
        const outcome = yield* start(
          branchedTree(block("review", verifyOutput.id, { inputs: [id("implement")] })),
          catalog([reporter]),
        )
        return { outcome, events: yield* readEvents(runId) }
      }),
  )

  // A starved input is a semantic failure of the attempt, not an engine error: the run closes
  // through finishRun with a packet, and a retrying policy could still recover it.
  expect(outcome.status).toBe("failed")
  expect(of(events, "ErrorRaised")[0].payload).toMatchObject({ signature: "missing-input" })
  expect(of(events, "AttemptFinished").map((event) => event.payload.verdict)).toContain(
    "semantic-failure",
  )
  expect(startedIds(events)).toEqual([
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

it("skips a block on a live request without ever spawning it", async () => {
  const result = await withEngine({}, ({ runId, start }) =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine
      yield* engine.requestSkip(runId, id("implement"))
      const outcome = yield* start(block("implement", agentTask.id))
      return { outcome, events: yield* readEvents(runId) }
    }),
  )

  expect(result.outcome.status).toBe("succeeded")
  expect(of(result.events, "BlockSkipped")[0].payload.reason).toBe("skipped by user request")
  expect(of(result.events, "AttemptStarted")).toHaveLength(0)
}, 30_000)

it("honours a skip recorded before the run started", async () => {
  const result = await withEngine({}, ({ start, runId }) =>
    Effect.gen(function* () {
      const outcome = yield* start(
        block("implement", agentTask.id),
        undefined,
        undefined,
        new Set(["implement"]),
      )
      return { outcome, events: yield* readEvents(runId) }
    }),
  )

  expect(result.outcome.status).toBe("succeeded")
  expect(of(result.events, "BlockSkipped")).toHaveLength(1)
}, 30_000)

it("keeps a skip recorded for one run away from another run's same-named node", async () => {
  const result = await withEngine(
    { "agent-task": { output: { summary: "done" } } },
    ({ runId, start }) =>
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine
        yield* engine.requestSkip(RunId.make("some-other-run"), id("implement"))
        const outcome = yield* start(block("implement", agentTask.id))
        return { outcome, events: yield* readEvents(runId) }
      }),
  )

  expect(result.outcome.status).toBe("succeeded")
  expect(of(result.events, "BlockSkipped")).toHaveLength(0)
  expect(of(result.events, "AttemptStarted")).toHaveLength(1)
}, 30_000)

// One scenario, two guarantees: the skip is consumed at its next visit so the loop's second
// iteration executes, and the starved verify fails its attempt semantically — with a packet —
// instead of escaping the engine as a run-pipeline error.
it("consumes a loop-body skip at one visit and fails the starved block semantically", async () => {
  const loop: WorkflowNode = {
    _tag: "Loop",
    body: {
      _tag: "Sequence",
      children: [
        block("implement", agentTask.id),
        block("verify", verifyOutput.id, { inputs: [id("implement")] }),
      ],
    },
    policy: correctivePolicy.id,
    kind: "corrective",
    feedbackRoute: { from: id("verify"), to: id("implement") },
  }

  const result = await withEngine(
    {
      "agent-task": { output: { summary: "done" } },
      "verify-output": { output: { passed: true, findings: [] } },
    },
    ({ runId, start }) =>
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine
        yield* engine.requestSkip(runId, id("implement"))
        const outcome = yield* start(loop)
        return { outcome, events: yield* readEvents(runId) }
      }),
  )

  expect(result.outcome.status).toBe("succeeded")
  expect(of(result.events, "BlockSkipped")).toHaveLength(1)
  const missing = of(result.events, "ErrorRaised").filter(
    (event) => event.payload.signature === "missing-input",
  )
  expect(missing).toHaveLength(1)
  expect(
    of(result.events, "AttemptFinished").map((event) => event.payload.verdict),
  ).toContain("semantic-failure")
  expect(of(result.events, "FailureFeedbackForwarded")).toHaveLength(1)
  // The consumed request lets iteration two actually run the implementation.
  expect(of(result.events, "BlockStarted").some((event) => event.blockId === "implement#2")).toBe(
    true,
  )
}, 60_000)

it("fails a starved single-attempt block as a run failure with a verdict, not an engine error", async () => {
  const result = await withEngine({}, ({ runId, start }) =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine
      yield* engine.requestSkip(runId, id("implement"))
      const outcome = yield* start({
        _tag: "Sequence",
        children: [
          block("implement", agentTask.id),
          block("verify", verifyOutput.id, { inputs: [id("implement")] }),
        ],
      })
      return { outcome, events: yield* readEvents(runId) }
    }),
  )

  expect(result.outcome.status).toBe("failed")
  expect(of(result.events, "RunFinished")[0].payload.status).toBe("failed")
  expect(of(result.events, "AttemptFinished")[0].payload.verdict).toBe("semantic-failure")
}, 30_000)

const qualityGate = { ...runCommand, id: "gate", skipWhenUnchanged: true }
const qualityGateNode = block("gate", qualityGate.id, {
  overrides: { command: { argv: ["true"] } },
})

/** The owner's question shape: reads the repository, answers into $COCKPIT_OUTPUT, writes nothing. */
const answerOnly = {
  ...verifyOutput,
  id: "answer",
  input: [],
  output: [{ name: "summary", type: "string", required: true }] as const,
  successCriteria: [],
}

const qualityGates = catalog([qualityGate, answerOnly])
const unchanged = "no files changed since the run's base commit"

// A writing block that wrote nothing still earns an empty checkpoint, so the run's branch is a
// commit ahead of its base with no file to show for it: what the diff answers, not the log.
it("skips a skipWhenUnchanged gate after a write block that changed nothing", async () => {
  const result = await withEngine(
    { "agent-task": summary("looked around and changed nothing") },
    ({ runId, start }) =>
      Effect.gen(function* () {
        const outcome = yield* start(
          { _tag: "Sequence", children: [block("implement", agentTask.id), qualityGateNode] },
          qualityGates,
        )
        return { outcome, events: yield* readEvents(runId) }
      }),
  )

  expect(result.outcome.status).toBe("succeeded")
  expect(of(result.events, "CheckpointCreated").length).toBeGreaterThan(0)
  expect(of(result.events, "BlockSkipped")[0].payload.reason).toBe(unchanged)
  expect(startedIds(result.events)).not.toContain("gate")
}, 30_000)

// The regression that fails if the `since` argument is ever dropped: the checkpoint after
// `implement` committed the file it wrote, which is exactly the state `git status --porcelain`
// reports as clean while the run has plainly done work.
it("runs a skipWhenUnchanged gate on work an earlier checkpoint already committed", async () => {
  const events = await withEngine(
    {
      "agent-task": {
        ...summary("wrote the feature"),
        writes: { "feature.ts": "export const x = 1\n" },
      },
    },
    ({ runId, start }) =>
      Effect.gen(function* () {
        yield* start(
          { _tag: "Sequence", children: [block("implement", agentTask.id), qualityGateNode] },
          qualityGates,
        )
        return yield* readEvents(runId)
      }),
  )

  expect(of(events, "CheckpointCreated").length).toBeGreaterThan(0)
  expect(of(events, "BlockSkipped")).toHaveLength(0)
  expect(startedIds(events)).toContain("gate")
}, 30_000)

it("runs a gate with no flag on a run that changed nothing", async () => {
  const events = await withEngine(
    { "agent-task": summary("looked around and changed nothing") },
    ({ runId, start }) =>
      Effect.gen(function* () {
        yield* start({
          _tag: "Sequence",
          children: [
            block("implement", agentTask.id),
            block("cmd", runCommand.id, { overrides: { command: { argv: ["true"] } } }),
          ],
        })
        return yield* readEvents(runId)
      }),
  )

  expect(of(events, "BlockSkipped")).toHaveLength(0)
  expect(startedIds(events)).toContain("cmd")
}, 30_000)

// A re-entry hands the engine the literal "HEAD" for a run whose base commit was never recorded.
// Diffed against the worktree's own HEAD nothing has ever changed, so the flag must not answer
// from it: that is porcelain by another name, and it would skip every gate for the rest of the run.
it("runs a skipWhenUnchanged gate when the run recorded no base commit", async () => {
  const events = await withEngine(
    { answer: summary("this project is a harness") },
    (harness) =>
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine
        const root: WorkflowNode = {
          _tag: "Sequence",
          children: [block("answer", answerOnly.id), qualityGateNode],
        }
        yield* engine.run({
          runId: harness.runId,
          task: { prompt: "make the thing work", projectId: "proj" },
          tree: { runId: harness.runId, templateId: "test", root },
          workspace: { ...harness.workspace, baseCommit: "HEAD" },
          catalog: qualityGates,
        })
        return yield* readEvents(harness.runId)
      }),
  )

  expect(of(events, "BlockSkipped")).toHaveLength(0)
  expect(startedIds(events)).toContain("gate")
}, 30_000)

// S11's headline scenario, pinned here rather than left to a manual pass: a question run answers
// into $COCKPIT_OUTPUT, which sits outside the worktree, so the quality gates behind it never fire.
it("skips the gate after an agent block that wrote only $COCKPIT_OUTPUT", async () => {
  const result = await withEngine({ answer: summary("this project is a harness") }, (harness) =>
    Effect.gen(function* () {
      const outcome = yield* harness.start(
        { _tag: "Sequence", children: [block("answer", answerOnly.id), qualityGateNode] },
        qualityGates,
      )
      const checkpoints = yield* CheckpointService
      return {
        outcome,
        changed: yield* checkpoints.changedFiles(harness.workspace, harness.workspace.baseCommit),
        events: yield* readEvents(harness.runId),
      }
    }),
  )

  expect(result.outcome.status).toBe("succeeded")
  expect(result.changed).toEqual([])
  expect(result.outcome.outputs).toMatchObject({ answer: { summary: "this project is a harness" } })
  expect(of(result.events, "BlockSkipped")[0].payload.reason).toBe(unchanged)
  expect(startedIds(result.events)).not.toContain("gate")
}, 30_000)
