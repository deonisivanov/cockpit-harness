import { Effect, Fiber, Schedule } from "effect"
import { execFileSync, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import * as NodePath from "node:path"
import { expect, it } from "vitest"
import {
  agentTask,
  ArtifactId,
  AttemptId,
  BlockDef,
  BlockId,
  buildResumePlan,
  CheckpointService,
  coreBlocks,
  coreRetryPolicies,
  correctivePolicy,
  Journal,
  JournalEvent,
  recoverInterruptedRuns,
  RunId,
  singleAttemptPolicy,
  Store,
  verifyOutput,
  WorkflowCatalog,
  WorkflowEngine,
  WorkflowNode,
  Workspace,
} from "../src/index.js"
import { FakeScript, fakeProviders, of, waitFor, withEngine } from "./engine-harness.js"
import {
  fixturePath,
  makeRepo,
  readEvents,
  runEngine,
  tempDir,
  tempHome,
} from "./helpers.js"
import { block, catalog, id } from "./trees.js"

const childScript = fixturePath("engine-crash-child.mjs")
const prompt = "make the parser handle empty input"
const unlimited = 1_000_000

/** Carries a prior block's output, so a resumed attempt shows whether the journal rehydrated it. */
const implementBlock: BlockDef = {
  ...agentTask,
  id: "implement-block",
  input: [{ name: "summary", type: "string", required: true }],
}

const correctiveLoop = (policy: string): WorkflowNode => ({
  _tag: "Loop",
  body: {
    _tag: "Sequence",
    children: [
      block("implement", implementBlock.id, { inputs: [id("explore")] }),
      block("verify", verifyOutput.id, { inputs: [id("implement")] }),
    ],
  },
  policy,
  kind: "corrective",
  feedbackRoute: { from: id("verify"), to: id("implement") },
})

const gatedTree: WorkflowNode = {
  _tag: "Sequence",
  children: [
    { _tag: "Gate", id: id("plan-approval"), payload: { title: "Approve the plan", summary: "one fix, then verify it" } },
    block("explore", agentTask.id),
    correctiveLoop(correctivePolicy.id),
  ],
}

const gatedCatalog: WorkflowCatalog = {
  blocks: [...coreBlocks, implementBlock],
  policies: [...coreRetryPolicies],
}

/** The stand-in counts its calls per block on disk, which survives the process that made them. */
const callsTo = (scriptPath: string, block: string) => {
  try {
    return Number(readFileSync(`${scriptPath}.${block}.count`, "utf8"))
  } catch {
    return 0
  }
}

const writeJson = async (prefix: string, name: string, value: unknown) => {
  const path = NodePath.join(await tempDir(prefix), name)
  await writeFile(path, JSON.stringify(value))
  return path
}

interface Interrupted {
  readonly home: string
  readonly repoPath: string
  readonly runId: RunId
  readonly scriptPath: string
}

/**
 * Runs the tree in a child process and SIGKILLs it once `ready` says the run got far enough. No
 * journal write announces the end, which is exactly what a daemon killed with -9 leaves behind.
 */
const interrupt = async (input: {
  readonly script: FakeScript
  readonly root: WorkflowNode
  readonly catalog: WorkflowCatalog
  readonly approve: boolean
  readonly ready: (state: { lines: ReadonlyArray<string>; scriptPath: string }) => boolean
}): Promise<Interrupted> => {
  const home = await tempHome()
  const { repoPath } = await makeRepo()
  const pluginHome = await tempDir("cockpit-claude-")
  const scriptPath = await writeJson("cockpit-script-", "script.json", input.script)
  const runId = RunId.make(`run-${NodePath.basename(NodePath.dirname(scriptPath))}`)
  const planPath = await writeJson("cockpit-plan-", "plan.json", {
    prompt,
    root: input.root,
    catalog: input.catalog,
    approve: input.approve,
  })
  // The parent runs the resumed half in this process, so the stand-in has to find the same script.
  process.env.COCKPIT_FAKE_SCRIPT = scriptPath

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [childScript, repoPath, runId, planPath], {
      env: {
        ...process.env,
        ...fakeProviders,
        COCKPIT_HOME: home,
        COCKPIT_FAKE_SCRIPT: scriptPath,
        CLAUDE_CONFIG_DIR: pluginHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const lines: string[] = []
    let stderr = ""
    let armed = false
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.stdout.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) if (line !== "") lines.push(line)
    })

    const stop = () => {
      clearInterval(poll)
      clearTimeout(deadline)
    }
    child.once("exit", (code) => {
      if (armed) return
      stop()
      reject(new Error(`the run ended before it was interrupted (${code}): ${stderr}`))
    })
    const poll = setInterval(() => {
      if (armed || !input.ready({ lines, scriptPath })) return
      armed = true
      stop()
      child.once("exit", (_code, signal) =>
        signal === "SIGKILL"
          ? resolve()
          : reject(new Error(`the run ended by ${signal ?? "code"} instead of SIGKILL: ${stderr}`)),
      )
      child.kill("SIGKILL")
    }, 25)
    const deadline = setTimeout(() => {
      stop()
      child.kill("SIGKILL")
      reject(new Error(`the run never reached the interruption point: ${lines.join(", ")} ${stderr}`))
    }, 60_000)
  })

  return { home, repoPath, runId, scriptPath }
}

/** What the daemon does for a resume, minus the worktree reconcile: the crash left it clean. */
const reenter = (input: {
  readonly runId: RunId
  readonly repoPath: string
  readonly root: WorkflowNode
  readonly catalog: WorkflowCatalog
}) =>
  Effect.gen(function* () {
    const journal = yield* Journal
    const store = yield* Store
    const engine = yield* WorkflowEngine
    const { repoPath, runId } = input

    yield* recoverInterruptedRuns
    const run = (yield* store.run(runId))!
    yield* journal.resumeRun(runId)
    const plan = yield* buildResumePlan(runId)
    const workspace: Workspace = {
      projectId: "proj",
      runId,
      repoPath,
      path: run.worktreePath as string,
      branch: run.branch as string,
      targetBranch: run.targetBranch ?? undefined,
      baseCommit: run.baseCommit as string,
    }
    return yield* engine.run({
      runId,
      task: { prompt, projectId: "proj" },
      tree: { runId, templateId: "resume", root: input.root },
      workspace,
      catalog: input.catalog,
      resume: plan,
    })
  })

const artifactText = (events: ReadonlyArray<JournalEvent>, ref: ArtifactId) =>
  readFile(
    of(events, "ArtifactCreated").find((event) => event.payload.artifactId === ref)!.payload.path,
    "utf8",
  )

it("re-enters an interrupted loop without repeating what the journal already finished", async () => {
  const crashed = await interrupt({
    root: gatedTree,
    catalog: gatedCatalog,
    approve: true,
    script: {
      "agent-task:1": { output: { summary: "explored: the parser drops empty lines" } },
      "implement-block:1": { output: { summary: "first fix" } },
      "verify-output:1": { output: { passed: false, findings: ["empty input still throws"] } },
      // Long enough that the kill lands while this attempt is running, never after it.
      "implement-block:2": { delayMs: 5_000 },
      "implement-block:3": { output: { summary: "second fix" } },
      "verify-output:2": { output: { passed: false, findings: ["a single space still throws"] } },
      "implement-block:4": { output: { summary: "third fix" } },
      "verify-output:3": { output: { passed: true, findings: [] } },
    },
    // The stand-in writes its counter before it does anything else, so two calls means the
    // second iteration's agent is running and the interruption is landing on real work.
    ready: ({ scriptPath }) => callsTo(scriptPath, implementBlock.id) === 2,
  })

  const after = await runEngine(
    crashed.home,
    Effect.gen(function* () {
      const outcome = yield* reenter({
        runId: crashed.runId,
        repoPath: crashed.repoPath,
        root: gatedTree,
        catalog: gatedCatalog,
      })
      const journal = yield* Journal
      return {
        outcome,
        status: yield* journal.runStatus(crashed.runId),
        events: yield* readEvents(crashed.runId, unlimited),
      }
    }),
    { ...fakeProviders, CLAUDE_CONFIG_DIR: await tempDir("cockpit-claude-") },
  )

  const { events, outcome } = after
  expect(outcome.status).toBe("succeeded")
  expect(after.status).toBe("succeeded")

  // The §17.6 criterion: the block the journal had as finished never reached a provider again.
  expect(callsTo(crashed.scriptPath, agentTask.id)).toBe(1)
  expect(of(events, "BlockReplayed").map((event) => event.blockId)).toEqual(["explore"])
  expect(of(events, "AttemptInterrupted").map((event) => event.blockId)).toEqual(["implement#2"])

  // Instance ids number past what the journal held, so no execution overwrote another's record.
  expect(of(events, "BlockStarted").map((event) => event.blockId)).toEqual([
    "explore",
    "implement",
    "verify",
    "implement#2",
    "implement#3",
    "verify#2",
    "implement#4",
    "verify#3",
  ])

  // The gate the run approved before the crash was not asked a second time.
  expect(of(events, "ApprovalRequested")).toHaveLength(1)
  expect(of(events, "ApprovalDecided")).toHaveLength(1)

  // Iteration counting carried on: the pass after the resumed one is the third, not the second.
  const scheduled = of(events, "RetryScheduled").filter(
    (event) => event.payload.class === "semantic",
  )
  expect(scheduled.map((event) => event.payload.nextAttempt)).toEqual([2, 3])

  // The context the interrupted attempt was given is the one its successor reads.
  const forwarded = of(events, "FailureFeedbackForwarded")
  expect(forwarded.map((event) => event.blockId)).toEqual([
    "implement",
    "implement#3",
    "implement#3",
  ])
  expect(forwarded[1].payload.packetRef).toBe(forwarded[0].payload.packetRef)

  const resumedPrompt = await artifactText(
    events,
    of(events, "PromptComposed").find((event) => event.blockId === "implement#3")!.payload
      .promptRef,
  )
  expect(resumedPrompt).toContain("explored: the parser drops empty lines")
  expect(resumedPrompt).toContain("empty input still throws")
}, 120_000)

it("raises a gate again when the interruption caught it undecided", async () => {
  const tree: WorkflowNode = {
    _tag: "Sequence",
    children: [
      { _tag: "Gate", id: id("plan-approval"), payload: { title: "Approve the plan", summary: "one fix, then verify it" } },
      block("explore", agentTask.id),
    ],
  }
  const crashed = await interrupt({
    root: tree,
    catalog: catalog(),
    approve: false,
    script: { "agent-task:1": { output: { summary: "explored" } } },
    ready: ({ lines }) => lines.some((line) => line.startsWith("EVENT ApprovalRequested")),
  })

  const after = await runEngine(
    crashed.home,
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine
      const running = yield* Effect.fork(
        reenter({
          runId: crashed.runId,
          repoPath: crashed.repoPath,
          root: tree,
          catalog: catalog(),
        }),
      )
      // The old Deferred died with the process, so the resumed run has to ask again before
      // anything can answer it.
      yield* waitFor(crashed.runId, (events) => of(events, "ApprovalRequested").length === 2)
      yield* Effect.retry(
        engine.approveGate(crashed.runId, BlockId.make("plan-approval"), true),
        Schedule.spaced("20 millis").pipe(Schedule.intersect(Schedule.recurs(500))),
      )
      const outcome = yield* Fiber.join(running)
      return { outcome, events: yield* readEvents(crashed.runId, unlimited) }
    }),
    { ...fakeProviders, CLAUDE_CONFIG_DIR: await tempDir("cockpit-claude-") },
  )

  expect(after.outcome.status).toBe("succeeded")
  expect(of(after.events, "ApprovalRequested")).toHaveLength(2)
  expect(of(after.events, "BlockStarted").map((event) => event.blockId)).toEqual(["explore"])
}, 120_000)

it("falls back to a fresh session when the one a continue block resumes is gone", async () => {
  const continuing: BlockDef = {
    ...implementBlock,
    id: "continuing-block",
    sessionPolicy: "continue",
    retryPolicy: "brisk",
  }
  const once = catalog(
    [continuing],
    [
      { ...correctivePolicy, id: "once", maxAttempts: 1 },
      // The real path runs out of technical retries before the fallback, without the wait.
      {
        ...singleAttemptPolicy,
        id: "brisk",
        backoff: { initialMs: 1, factor: 1, maxMs: 1 },
      },
    ],
  )
  const root: WorkflowNode = {
    _tag: "Sequence",
    children: [
      block("explore", agentTask.id),
      {
        _tag: "Loop",
        body: {
          _tag: "Sequence",
          children: [
            block("implement", continuing.id, { inputs: [id("explore")] }),
            block("verify", verifyOutput.id, { inputs: [id("implement")] }),
          ],
        },
        policy: "once",
        kind: "corrective",
        feedbackRoute: { from: id("verify"), to: id("implement") },
      },
    ],
  }

  const result = await withEngine(
    {
      "agent-task:1": { output: { summary: "explored" } },
      // Every call refuses to resume; only one that drops the flag gets through.
      "continuing-block": { output: { summary: "a fix" }, failResume: true },
      "verify-output:1": { output: { passed: false, findings: ["not yet"] } },
      "verify-output": { output: { passed: true, findings: [] } },
    },
    ({ runId, start }) =>
      Effect.gen(function* () {
        const journal = yield* Journal
        const first = yield* start(root, once)
        yield* journal.resumeRun(runId)
        const plan = yield* buildResumePlan(runId)
        const second = yield* start(root, once, plan)
        return { first, second, plan, events: yield* readEvents(runId, unlimited) }
      }),
  )

  expect(result.first.status).toBe("failed")
  // The seeded session is the one the first iteration recorded, and it no longer resumes.
  expect(result.plan.nodes.get("implement")?.session).toBeDefined()
  expect(result.second.status).toBe("succeeded")

  const lost = of(result.events, "ErrorRaised").filter(
    (event) => event.payload.signature === "session-unresumable",
  )
  expect(lost).toHaveLength(1)
  expect(lost[0].payload.message).toContain(result.plan.nodes.get("implement")!.session)
  expect(lost[0].blockId).toBe("implement#2")
}, 120_000)

it("refuses to re-enter a run whose completed output cannot be read back", async () => {
  const oversized = "x".repeat(20_000)
  const root: WorkflowNode = {
    _tag: "Sequence",
    children: [
      block("big", implementBlock.id),
      block("verify", verifyOutput.id, { inputs: [id("big")] }),
    ],
  }
  const given = catalog([{ ...implementBlock, input: [] }])

  const result = await withEngine(
    {
      "implement-block": { output: { summary: oversized } },
      "verify-output": { output: { passed: false, findings: ["no"] } },
    },
    ({ runId, start }) =>
      Effect.gen(function* () {
        const journal = yield* Journal
        yield* start(root, given)
        yield* journal.resumeRun(runId)
        const events = yield* readEvents(runId, unlimited)
        // Too large to travel inline, so the plan has to read the artifact to rehydrate it.
        const produced = of(events, "ResultProduced").find((event) => event.blockId === "big")!
        const path = of(events, "ArtifactCreated").find(
          (event) => event.payload.artifactId === produced.payload.outputRef,
        )!.payload.path

        const rehydrated = yield* buildResumePlan(runId)
        yield* Effect.promise(() => rm(path))
        const gone = yield* Effect.either(buildResumePlan(runId))
        return { gone, produced: produced.payload, rehydrated }
      }),
  )

  expect(result.produced.outputInline).toBeUndefined()
  expect(result.rehydrated.nodes.get("big")?.done?.output).toEqual({ summary: oversized })
  // A silent undefined here would hand the blocks after it an empty envelope instead.
  expect(result.gone).toMatchObject({ _tag: "Left", left: { op: "buildResumePlan" } })
  expect(String(result.gone)).toContain("cannot be read back")
}, 120_000)

it("salvages the same interrupted attempt on every re-entry that finds work to keep", async () => {
  const blockId = BlockId.make("implement")
  const attemptId = AttemptId.make("attempt-1")

  const result = await withEngine(
    { "agent-task": { output: { summary: "unused" } } },
    ({ runId, workspace }) =>
      Effect.gen(function* () {
        const journal = yield* Journal
        const checkpoints = yield* CheckpointService
        yield* journal.startRun(runId)
        yield* journal.startBlock({ runId, blockId, defId: agentTask.id, kind: "agent" })
        yield* journal.startAttempt({ runId, blockId, attemptId, number: 1 })
        yield* journal.interruptAttempt(runId, blockId, attemptId)
        const confirmed = yield* checkpoints.checkpoint(workspace, {
          kind: "success",
          message: "cockpit: baseline",
        })

        // Two re-entries, each finding what the interrupted attempt left behind — the second one
        // being untracked, which a reset would not have cleared on its own.
        const kept = yield* Effect.forEach(["first\n", "second\n"], (body) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              writeFile(NodePath.join(workspace.path, "leftover.txt"), body),
            )
            const salvage = yield* checkpoints.salvage(workspace, {
              blockId,
              attemptId,
              message: `cockpit: salvage ${blockId}`,
            })
            yield* checkpoints.rollbackTo(workspace, confirmed)
            return salvage
          }),
        )
        return { kept, workspace }
      }),
  )

  const [first, second] = result.kept
  expect(first).toBeDefined()
  expect(second).toBeDefined()
  expect(first).not.toBe(second)
  // Both survive the reset that follows them: a tag named after the attempt would have collided
  // on the second, and taken the whole re-entry down with it.
  const tags = execFileSync("git", ["tag", "-l", "cockpit/salvage/*"], {
    cwd: result.workspace.path,
    encoding: "utf8",
  }).trim()
  expect(tags.split("\n")).toEqual([`cockpit/salvage/${first}`, `cockpit/salvage/${second}`].sort())
})

it("re-arms a failed loop for one fresh cycle and stops there", async () => {
  const twice = catalog(
    [implementBlock],
    [{ ...correctivePolicy, id: "twice", maxAttempts: 2 }],
  )
  const root: WorkflowNode = {
    _tag: "Sequence",
    children: [block("explore", agentTask.id), correctiveLoop("twice")],
  }
  const failing = { output: { passed: false, findings: ["still broken"] } }

  const result = await withEngine(
    {
      "agent-task:1": { output: { summary: "explored" } },
      "implement-block": { output: { summary: "a fix" } },
      "verify-output": failing,
    },
    ({ runId, start }) =>
      Effect.gen(function* () {
        const journal = yield* Journal
        const store = yield* Store
        const first = yield* start(root, twice)
        yield* journal.resumeRun(runId)
        const plan = yield* buildResumePlan(runId)
        const second = yield* start(root, twice, plan)
        return {
          first,
          second,
          blocks: yield* store.blocks(runId),
          events: yield* readEvents(runId, unlimited),
        }
      }),
  )

  expect(result.first.status).toBe("failed")
  expect(result.second.status).toBe("failed")

  // Two iterations before the run failed, one after resuming it, and no fourth: a resumed loop
  // spends what the journal left it, not a whole fresh budget.
  expect(result.blocks.filter((row) => row.defId === implementBlock.id).map((row) => row.id)).toEqual(
    ["implement", "implement#2", "implement#3"],
  )
  // The block outside the loop kept its result rather than running again.
  expect(of(result.events, "BlockReplayed").map((event) => event.blockId)).toEqual(["explore"])
  expect(
    of(result.events, "RetryScheduled")
      .filter((event) => event.payload.class === "semantic")
      .map((event) => event.payload.nextAttempt),
  ).toEqual([2])
}, 120_000)
