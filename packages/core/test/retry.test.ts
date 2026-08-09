import { Effect, Fiber, Layer, Ref, TestClock, TestContext } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import * as NodePath from "node:path"
import { expect, it } from "vitest"
import {
  agentTask,
  BlockId,
  buildRetryContext,
  correctivePolicy,
  FailurePacket,
  Journal,
  minimumContextChars,
  ProviderError,
  renderRetryContext,
  RetryCoordinator,
  RunId,
  singleAttemptPolicy,
  verifyOutput,
  WorkflowEngine,
} from "../src/index.js"
import { block, catalog, id, of, startedIds, waitFor, withEngine } from "./engine-harness.js"
import { EngineContext, engineLayer, readEvents, tempHome } from "./helpers.js"

const summary = (text: string) => ({ output: { summary: text } })
const verdict = (passed: boolean) => ({ output: { passed, findings: [] } })

/** Attempts to spare, so the no-progress rule is what stops the loop rather than the count. */
const patientRetries = catalog([{ ...agentTask, retryPolicy: "patient" }], [
  { ...correctivePolicy, id: "patient", maxAttempts: 5 },
])

const correctiveLoop = (policy: string) => ({
  _tag: "Loop" as const,
  body: {
    _tag: "Sequence" as const,
    children: [
      block("implement", agentTask.id),
      block("verify", verifyOutput.id, { inputs: [id("implement")] }),
    ],
  },
  policy,
  kind: "corrective" as const,
  feedbackRoute: { from: id("verify"), to: id("implement") },
})

const runId = RunId.make("run-retry")
const blockId = BlockId.make("block-retry")

const onTestClock = <A, E>(body: Effect.Effect<A, E, EngineContext>, home: string) =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(body, engineLayer(home))).pipe(
      Effect.provide(Layer.mergeAll(TestContext.TestContext)),
    ),
  )

it("backs off technical failures on a schedule without spending a semantic attempt", async () => {
  const home = await tempHome()
  const { events, tries } = await onTestClock(
    Effect.gen(function* () {
      const journal = yield* Journal
      yield* journal.createRun({ runId, projectId: "proj", prompt: "x" })
      yield* journal.startRun(runId)
      yield* journal.startBlock({ runId, blockId, defId: agentTask.id, kind: "agent" })

      const coordinator = yield* RetryCoordinator
      const attempts = yield* Ref.make(0)
      const flaky = Effect.flatMap(Ref.updateAndGet(attempts, (n) => n + 1), (n) =>
        n < 3
          ? Effect.fail(new ProviderError({ kind: "crash", detail: "the CLI died" }))
          : Effect.succeed(n),
      )

      const running = yield* Effect.fork(
        coordinator.withTechnicalRetries(
          { runId, blockId, policy: { ...singleAttemptPolicy, backoff: { initialMs: 500, factor: 2, maxMs: 10_000 } } },
          flaky,
        ),
      )

      yield* TestClock.adjust("499 millis")
      const beforeFirst = yield* Ref.get(attempts)
      yield* TestClock.adjust("1 millis")
      const afterFirst = yield* Ref.get(attempts)
      yield* TestClock.adjust("999 millis")
      const beforeSecond = yield* Ref.get(attempts)
      yield* TestClock.adjust("1 millis")

      yield* Fiber.join(running)
      return {
        tries: { beforeFirst, afterFirst, beforeSecond },
        events: yield* readEvents(runId),
      }
    }),
    home,
  )

  expect(tries).toEqual({ beforeFirst: 1, afterFirst: 2, beforeSecond: 2 })
  expect(of(events, "RetryScheduled").map((event) => event.payload)).toMatchObject([
    { class: "technical", nextAttempt: 2, delayMs: 500 },
    { class: "technical", nextAttempt: 3, delayMs: 1000 },
  ])
  // Technical retries stay inside one attempt: nothing opened a second one.
  expect(of(events, "AttemptStarted")).toHaveLength(0)
})

it("hands the next semantic attempt what the last one broke", async () => {
  const prompts = await withEngine(
    {
      "agent-task:1": { ...summary("guessed at it"), stderr: "TypeError: cannot read length" },
      "agent-task:2": summary("read the code first"),
      "verify-output:1": verdict(false),
      "verify-output:2": verdict(true),
    },
    ({ runId, start }) =>
      Effect.gen(function* () {
        yield* start(
          {
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
          },
          catalog(),
        )
        const events = yield* readEvents(runId)
        const paths = new Map(
          of(events, "ArtifactCreated").map((event) => [event.payload.artifactId, event.payload.path]),
        )
        return yield* Effect.forEach(
          of(events, "PromptComposed").filter((event) => event.blockId?.startsWith("implement")),
          (event) => Effect.promise(() => readFile(paths.get(event.payload.promptRef)!, "utf8")),
        )
      }),
  )

  expect(prompts).toHaveLength(2)
  expect(prompts[0]).not.toContain("Previous attempts")
  expect(prompts[1]).toContain("## Previous attempts")
  expect(prompts[1]).toContain("What failed:")
  expect(prompts[1]).toContain("verification-passed")
  expect(prompts[1]).toContain("Do not repeat:")
}, 60_000)

it("stops early and asks a human when two attempts fail the same way", async () => {
  const { attempts, events } = await withEngine(
    { "agent-task": { ...summary("same as before"), isError: true, text: "failed the same way" } },
    ({ runId, start }) =>
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine
        const running = yield* Effect.fork(start(block("implement", agentTask.id), patientRetries))
        yield* waitFor(runId, (seen) => of(seen, "ApprovalRequested").length > 0)
        yield* engine.approveGate(runId, BlockId.make("implement"), false, "no progress")
        yield* Fiber.join(running)
        const events = yield* readEvents(runId)
        return { attempts: of(events, "AttemptStarted").length, events }
      }),
  )

  // Two identical failures is the limit; the policy allowed five attempts.
  expect(attempts).toBe(2)
  expect(of(events, "ApprovalRequested")).toHaveLength(1)
  expect(of(events, "ApprovalDecided")[0].payload).toMatchObject({ approved: false })
  expect(of(events, "RunFinished")[0].payload).toMatchObject({ status: "failed" })
}, 60_000)

it("resumes the same session across attempts only when the block declares it", async () => {
  const sessions = await withEngine(
    {
      "agent-task:1": { ...summary("first try"), isError: true },
      "agent-task:2": summary("second try"),
      "sticky:1": { ...summary("first try"), isError: true },
      "sticky:2": summary("second try"),
    },
    ({ runId, start }) =>
      Effect.gen(function* () {
        yield* start(
          {
            _tag: "Sequence",
            children: [block("fresh", agentTask.id), block("kept", "sticky")],
          },
          catalog(
            [
              { ...agentTask, retryPolicy: "twice" },
              { ...agentTask, id: "sticky", sessionPolicy: "continue", retryPolicy: "twice" },
            ],
            [{ ...correctivePolicy, id: "twice", maxAttempts: 2 }],
          ),
        )
        const events = yield* readEvents(runId)
        const per = (blockId: string) => ({
          started: of(events, "SessionStarted")
            .filter((event) => event.blockId === blockId)
            .map((event) => event.payload.sessionId),
          resumed: of(events, "SessionResumed")
            .filter((event) => event.blockId === blockId)
            .map((event) => event.payload.sessionId),
        })
        return { fresh: per("fresh"), kept: per("kept") }
      }),
  )

  expect(sessions.fresh.resumed).toHaveLength(0)
  expect(sessions.fresh.started).toHaveLength(2)
  expect(sessions.fresh.started[0]).not.toBe(sessions.fresh.started[1])

  expect(sessions.kept.started).toHaveLength(1)
  expect(sessions.kept.resumed).toEqual(sessions.kept.started)
}, 60_000)

it.each([
  { onRetry: "rollback" as const, survives: false },
  { onRetry: "continue" as const, survives: true },
])("$onRetry $survives the scratch file a failed attempt left behind", async ({ onRetry, survives }) => {
  const present = await withEngine(
    {
      "agent-task:1": {
        ...summary("wrote something"),
        writes: { "scratch.txt": "half-finished\n" },
        isError: true,
      },
      "agent-task:2": { ...summary("still stuck"), isError: true },
    },
    ({ start, workspace }) =>
      Effect.gen(function* () {
        yield* start(
          block("implement", agentTask.id),
          catalog([{ ...agentTask, retryPolicy: "under-test" }], [
            { ...correctivePolicy, id: "under-test", maxAttempts: 2, onRetry },
          ]),
        )
        return existsSync(NodePath.join(workspace.path, "scratch.txt"))
      }),
  )

  expect(present).toBe(survives)
}, 60_000)

it("salvages a failed attempt that changed files", async () => {
  const kinds = await withEngine(
    {
      "agent-task": {
        ...summary("wrote something"),
        writes: { "scratch.txt": "half-finished\n" },
        isError: true,
      },
    },
    ({ runId, start }) =>
      Effect.gen(function* () {
        yield* start(block("implement", agentTask.id))
        const events = yield* readEvents(runId)
        return of(events, "CheckpointCreated").map((event) => event.payload.kind)
      }),
  )

  expect(kinds).toEqual(["success", "salvage"])
}, 60_000)

it("spends a single attempt when the policy calls semantic failure non-retryable", async () => {
  const events = await withEngine(
    { "agent-task": { ...summary("no good"), isError: true } },
    ({ runId, start }) =>
      Effect.gen(function* () {
        yield* start(
          block("implement", agentTask.id),
          catalog(
            [{ ...agentTask, retryPolicy: "final" }],
            [{ ...correctivePolicy, id: "final", maxAttempts: 3, nonRetryable: ["semantic"] }],
          ),
        )
        return yield* readEvents(runId)
      }),
  )

  expect(of(events, "AttemptStarted")).toHaveLength(1)
  expect(of(events, "RetryScheduled").filter((event) => event.payload.class === "semantic")).toEqual(
    [],
  )
}, 60_000)

it("asks a human on the failure that ends the loop, not only before it", async () => {
  const { attempts, events } = await withEngine(
    { "agent-task": { ...summary("still broken"), isError: true } },
    ({ runId, start }) =>
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine
        const running = yield* Effect.fork(
          start(
            block("implement", agentTask.id),
            catalog(
              [{ ...agentTask, retryPolicy: "gated" }],
              [
                {
                  ...correctivePolicy,
                  id: "gated",
                  maxAttempts: 2,
                  humanGateAfterFailures: 2,
                  noProgress: { sameFailureSignatureLimit: 5 },
                },
              ],
            ),
          ),
        )
        yield* waitFor(runId, (seen) => of(seen, "ApprovalRequested").length > 0)
        yield* engine.approveGate(runId, BlockId.make("implement"), true, "seen it")
        yield* Fiber.join(running)
        const events = yield* readEvents(runId)
        return { attempts: of(events, "AttemptStarted").length, events }
      }),
  )

  // The second failure is the last one the policy allows, and it is still shown to a human.
  expect(attempts).toBe(2)
  expect(of(events, "ApprovalRequested")).toHaveLength(1)
  expect(of(events, "RunFinished")[0].payload).toMatchObject({ status: "failed" })
}, 60_000)

it("rolls a loop back to the worktree it entered with, not to a step inside it", async () => {
  const present = await withEngine(
    {
      "agent-task:1": { ...summary("wrote a scratch file"), writes: { "scratch.txt": "half\n" } },
      "agent-task:2": summary("left the tree alone"),
      "verify-output:1": verdict(false),
      "verify-output:2": verdict(true),
    },
    ({ start, workspace }) =>
      Effect.gen(function* () {
        yield* start(
          correctiveLoop("rolling-back"),
          catalog([], [{ ...correctivePolicy, id: "rolling-back", maxAttempts: 2, onRetry: "rollback" }]),
        )
        return existsSync(NodePath.join(workspace.path, "scratch.txt"))
      }),
  )

  // The implementer checkpoints inside the loop; undoing the iteration has to reach past that.
  expect(present).toBe(false)
}, 60_000)

it("keeps a salvaged attempt reachable after the retry rolls the worktree back", async () => {
  const { salvaged, worktree } = await withEngine(
    {
      "agent-task:1": {
        ...summary("wrote something"),
        writes: { "scratch.txt": "half-finished\n" },
        isError: true,
      },
      "agent-task:2": { ...summary("still stuck"), isError: true },
    },
    ({ runId, start, workspace }) =>
      Effect.gen(function* () {
        yield* start(
          block("implement", agentTask.id),
          catalog(
            [{ ...agentTask, retryPolicy: "salvaging" }],
            [{ ...correctivePolicy, id: "salvaging", maxAttempts: 2, onRetry: "rollback" }],
          ),
        )
        const events = yield* readEvents(runId)
        return {
          salvaged: of(events, "CheckpointCreated")
            .filter((event) => event.payload.kind === "salvage")
            .map((event) => event.payload.checkpointId),
          worktree: workspace.path,
        }
      }),
  )

  const git = (...args: string[]) => execFileSync("git", args, { cwd: worktree, encoding: "utf8" })
  expect(salvaged).toHaveLength(1)
  expect(() => git("cat-file", "-e", salvaged[0])).not.toThrow()
  expect(git("tag", "-l", "cockpit/salvage/*").trim()).not.toBe("")
}, 60_000)

it("hangs loop events on the block instance that actually ran", async () => {
  const events = await withEngine(
    {
      "agent-task": summary("tried again"),
      "verify-output:1": verdict(false),
      "verify-output:2": verdict(false),
      "verify-output:3": verdict(true),
    },
    ({ runId, start }) =>
      Effect.gen(function* () {
        yield* start(
          correctiveLoop("three-tries"),
          catalog(
            [],
            [
              {
                ...correctivePolicy,
                id: "three-tries",
                maxAttempts: 3,
                noProgress: { sameFailureSignatureLimit: 5 },
              },
            ],
          ),
        )
        return yield* readEvents(runId)
      }),
  )

  expect(of(events, "FailureFeedbackForwarded").map((event) => event.blockId)).toEqual([
    "implement",
    "implement#2",
  ])
  expect(of(events, "RetryScheduled").map((event) => event.blockId)).toEqual([
    "implement",
    "implement#2",
  ])
  const opened = new Set(startedIds(events))
  expect(
    events.filter((event) => event.blockId !== undefined && !opened.has(event.blockId)),
  ).toEqual([])
}, 60_000)

it("gates a loop under the instance id the run is actually waiting on", async () => {
  const { decided, gateId } = await withEngine(
    { "agent-task": summary("same as ever"), "verify-output": verdict(false) },
    ({ runId, start }) =>
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine
        const running = yield* Effect.fork(
          start(
            correctiveLoop("stubborn"),
            catalog([], [{ ...correctivePolicy, id: "stubborn", maxAttempts: 5 }]),
          ),
        )
        yield* waitFor(runId, (seen) => of(seen, "ApprovalRequested").length > 0)
        const requested = of(yield* readEvents(runId), "ApprovalRequested")[0]
        yield* engine.approveGate(runId, requested.payload.gateId, false, "stop")
        yield* Fiber.join(running)
        return {
          gateId: requested.payload.gateId,
          decided: of(yield* readEvents(runId), "ApprovalDecided")[0],
        }
      }),
  )

  // The second iteration is what failed; the gate — and the key that answers it — say so.
  expect(gateId).toBe("implement#2")
  expect(decided.blockId).toBe("implement#2")
  expect(decided.payload).toMatchObject({ approved: false })
}, 60_000)

const packet = (attemptNumber: number, noise: string): FailurePacket => ({
  attemptNumber,
  hypothesis: `the parser mishandles ${noise.repeat(40)}`,
  strategy: { binding: "oh-my-claudecode:plan", approach: `approach ${noise.repeat(30)}` },
  actionsTaken: Array.from({ length: 30 }, (_, index) => `edited file-${index}.ts ${noise}`),
  commandsRun: Array.from({ length: 20 }, (_, index) => `pnpm test --filter ${index} ${noise}`),
  whatFailed: `12 tests failed in suite ${noise.repeat(50)}`,
  diagnostics: Array.from({ length: 10 }, () => ({ excerpt: noise.repeat(200) })),
  failureReason: `the verifier rejected it because ${noise.repeat(40)}`,
  doNotRepeat: Array.from({ length: 10 }, (_, index) => `do not ${index} ${noise.repeat(20)}`),
  remainingDirections: Array.from({ length: 10 }, (_, index) => `try ${index} ${noise.repeat(20)}`),
})

it.each([200, minimumContextChars, 1_000, 4_000, 20_000])(
  "keeps a rendered retry context inside a %i character budget",
  (budget) => {
    const context = buildRetryContext(
      [packet(1, "abcdefgh"), ...Array.from({ length: 7 }, (_, index) => packet(index + 2, "abcdefgh"))],
      budget,
    )
    const rendered = renderRetryContext(context)

    expect(context.budget.maxChars).toBeGreaterThanOrEqual(minimumContextChars)
    expect(rendered.length).toBeLessThanOrEqual(context.budget.maxChars)
    // Structure survives the squeeze: the newest attempt and its failure are always present.
    expect(rendered).toContain("### Attempt 8 — most recent")
    expect(rendered).toContain("What failed:")
    expect(context.lastAttempt.attemptNumber).toBe(8)
  },
)

it("keeps the newest packet detailed and summarizes the older ones", () => {
  const context = buildRetryContext(
    [packet(1, "a"), packet(2, "b"), packet(3, "c")],
    100_000,
  )

  expect(context.olderAttempts.map((older) => older.attemptNumber)).toEqual([1, 2])
  for (const older of context.olderAttempts) {
    expect(older.summary.length).toBeLessThanOrEqual(240)
    expect(older.summary).toContain(`Attempt ${older.attemptNumber} tried`)
  }
  expect(context.lastAttempt.diagnostics).toHaveLength(10)
})

it("deduplicates identical failure signatures with a count", () => {
  const same = (attemptNumber: number): FailurePacket => ({
    ...packet(attemptNumber, "x"),
    whatFailed: `${attemptNumber * 3} tests failed in packages/core/test/a.test.ts`,
  })
  const context = buildRetryContext([same(1), same(2), same(3)], 100_000)

  expect(context.repeatedErrors).toHaveLength(1)
  expect(context.repeatedErrors[0]).toMatchObject({ count: 3 })
  expect(context.repeatedErrors[0].signature).not.toMatch(/\d/)
})
