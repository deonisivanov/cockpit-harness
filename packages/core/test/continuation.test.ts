import { Effect } from "effect"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as NodePath from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  ArtifactStore,
  AttemptId,
  BlockId,
  CheckpointService,
  ContinuationService,
  Journal,
  JournalEvent,
  ProviderName,
  renderTaskBrief,
  RunId,
  Store,
  Workspace,
  WorkspaceManager,
} from "../src/index.js"
import {
  fixturePath,
  makeRepo,
  readEvents,
  runContinuity,
  Settings,
  tempDir,
  tempHome,
} from "./helpers.js"

const claudeBin = "/fixture/bin/claude"
const codexBin = "/fixture/bin/codex"
const prompt = "rename the parser field and keep the fixtures green"

const fakeEnv = [
  "COCKPIT_FAKE_HERDR_LOG",
  "COCKPIT_FAKE_HERDR_DOWN",
  "COCKPIT_FAKE_HERDR_START_FAIL",
  "COCKPIT_FAKE_HERDR_PROTOCOL",
  "COCKPIT_FAKE_OPEN_LOG",
  "COCKPIT_FAKE_OPEN_FAIL",
] as const

afterEach(() => fakeEnv.forEach((name) => delete process.env[name]))

const tags = (events: ReadonlyArray<JournalEvent>, tag: string) =>
  events.filter((event) => event.payload._tag === tag)

const runId = RunId.make("run-continuity")
const implement = BlockId.make("implement")
const verify = BlockId.make("verify")

/** A run journaled the way the engine journals one, so the brief is built from real events. */
const seedRun = (repoPath: string, provider: ProviderName = "claude-code") =>
  Effect.gen(function* () {
    const store = yield* Store
    const journal = yield* Journal
    const artifacts = yield* ArtifactStore
    const workspaces = yield* WorkspaceManager
    const checkpoints = yield* CheckpointService

    const project = yield* store.addProject({ name: "sample", repoPath })
    const workspace = yield* workspaces.create({
      projectId: project.id,
      repoPath,
      baseCommit: "HEAD",
      runId,
    })
    yield* journal.createRun({
      runId,
      projectId: project.id,
      prompt,
      baseCommit: workspace.baseCommit,
      worktreePath: workspace.path,
      branch: workspace.branch,
    })
    yield* journal.startRun(runId)

    const plan = yield* artifacts.write({
      runId,
      kind: "gate-payload",
      name: "plan.json",
      content: JSON.stringify({ title: "Plan", summary: "rename, then verify" }),
    })
    yield* journal.append({
      runId,
      payload: {
        _tag: "TreeAnalyzed",
        templateId: "task",
        rationale: "a single implement/verify pass covers a rename",
        decision: {},
        fallback: false,
      },
    })
    yield* journal.append({
      runId,
      payload: { _tag: "ApprovalRequested", gateId: BlockId.make("plan-gate"), payloadRef: plan.id },
    })
    yield* journal.append({
      runId,
      payload: {
        _tag: "ApprovalDecided",
        gateId: BlockId.make("plan-gate"),
        approved: true,
        note: "approved, but leave the public export alone",
      },
    })

    yield* journal.startBlock({ runId, blockId: implement, defId: "agent-task", kind: "agent" })
    yield* journal.append({
      runId,
      blockId: implement,
      payload: {
        _tag: "PluginResolved",
        provider: { name: provider, version: "2.1.224" },
        plugin: { name: "oh-my-claudecode", version: "1.4.0" },
        entry: { kind: "agent", name: "executor" },
        capabilities: ["edit"],
      },
    })

    const failed = AttemptId.make("attempt-1")
    yield* journal.startAttempt({ runId, blockId: implement, attemptId: failed, number: 1 })
    yield* journal.append({
      runId,
      blockId: implement,
      attemptId: failed,
      payload: {
        _tag: "ErrorRaised",
        class: "semantic",
        signature: "verify-failed",
        message: "the rename missed two call sites in the CLI package",
      },
    })
    const packet = yield* artifacts.write({
      runId,
      blockId: implement,
      attemptId: failed,
      kind: "failure-packet",
      // Long on purpose: the brief must name this file, never paste it.
      name: "packet.json",
      content: `{"whatFailed":"${"UNIQUEBODY".repeat(500)}"}`,
    })
    yield* journal.append({
      runId,
      blockId: implement,
      attemptId: failed,
      payload: { _tag: "FailureFeedbackForwarded", packetRef: packet.id },
    })
    yield* journal.finishAttempt({
      runId,
      blockId: implement,
      attemptId: failed,
      verdict: "semantic-failure",
    })

    const passed = AttemptId.make("attempt-2")
    yield* journal.startAttempt({ runId, blockId: implement, attemptId: passed, number: 2 })
    yield* journal.append({
      runId,
      blockId: implement,
      attemptId: passed,
      payload: { _tag: "QuestionAsked", question: "should the old name stay as an alias?" },
    })
    yield* journal.append({
      runId,
      blockId: implement,
      attemptId: passed,
      payload: { _tag: "QuestionAnswered", answer: "no alias, update the callers" },
    })
    writeFileSync(NodePath.join(workspace.path, "parser.txt"), "renamed\n")
    yield* checkpoints.checkpoint(workspace, {
      kind: "success",
      message: "implement",
      blockId: implement,
      attemptId: passed,
    })
    // Written after the checkpoint committed everything else: only the untracked sweep sees it.
    writeFileSync(NodePath.join(workspace.path, "scratch.txt"), "notes\n")
    yield* journal.finishAttempt({ runId, blockId: implement, attemptId: passed, verdict: "success" })
    yield* journal.finishBlock(runId, implement, "succeeded")

    yield* journal.startBlock({ runId, blockId: verify, defId: "verify-output", kind: "agent" })
    yield* journal.append({
      runId,
      blockId: verify,
      payload: {
        _tag: "VerificationReported",
        criteria: [{ criterion: "the rename reaches every call site", passed: true }],
      },
    })
    yield* journal.append({
      runId,
      blockId: verify,
      payload: { _tag: "ResultProduced", outputInline: { passed: true, findings: [] } },
    })
    yield* journal.finishBlock(runId, verify, "succeeded")
    yield* journal.finishRun(runId, "succeeded")

    return { project, workspace, packetPath: packet.path }
  })

const brief = (workspace: Workspace, events: ReadonlyArray<JournalEvent>, maxChars: number) =>
  Effect.gen(function* () {
    const store = yield* Store
    const run = yield* store.run(runId)
    return renderTaskBrief({
      run: run!,
      projectName: "sample",
      repoPath: workspace.repoPath,
      worktreePath: workspace.path,
      events,
      blocks: yield* store.blocks(runId),
      changedFiles: ["parser.txt"],
      healthChecks: [{ argv: ["pnpm", "-r", "test"] }],
      maxChars,
    })
  })

const scenario = async (settings: Settings = {}) => {
  const home = await tempHome()
  const { repoPath } = await makeRepo()
  const logDir = await tempDir("cockpit-terminal-log-")
  const herdrLog = NodePath.join(logDir, "herdr.jsonl")
  const openLog = NodePath.join(logDir, "open.jsonl")
  process.env.COCKPIT_FAKE_HERDR_LOG = herdrLog
  process.env.COCKPIT_FAKE_OPEN_LOG = openLog

  const calls = (path: string): ReadonlyArray<ReadonlyArray<string>> =>
    existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as ReadonlyArray<string>)
      : []

  return {
    home,
    repoPath,
    herdr: () => calls(herdrLog),
    opened: () => calls(openLog),
    settings: {
      COCKPIT_HERDR_BIN: fixturePath("fake-herdr.mjs"),
      COCKPIT_OPEN_BIN: fixturePath("fake-open.mjs"),
      COCKPIT_CLAUDE_BIN: claudeBin,
      COCKPIT_CODEX_BIN: codexBin,
      CLAUDE_CONFIG_DIR: await tempDir("cockpit-claude-"),
      ...settings,
    } satisfies Settings,
  }
}

it("assembles a brief from the journal that carries the run's whole story", async () => {
  const world = await scenario()
  const text = await runContinuity(
    world.home,
    Effect.gen(function* () {
      const { packetPath, workspace } = yield* seedRun(world.repoPath)
      return {
        rendered: yield* brief(workspace, yield* readEvents(runId), 40_000),
        packetPath,
        worktree: workspace.path,
      }
    }),
    world.settings,
  )

  expect(text.rendered).toContain(prompt)
  expect(text.rendered).toContain("a single implement/verify pass covers a rename")
  expect(text.rendered).toContain("approved, but leave the public export alone")
  expect(text.rendered).toContain("implement (agent-task, agent) — succeeded")
  expect(text.rendered).toContain("oh-my-claudecode@1.4.0")
  expect(text.rendered).toContain("implement attempt 1 — semantic-failure")
  expect(text.rendered).toContain("the rename missed two call sites")
  expect(text.rendered).toContain("no alias, update the callers")
  expect(text.rendered).toContain("pass — the rename reaches every call site")
  expect(text.rendered).toContain("parser.txt")
  expect(text.rendered).toContain(text.worktree)
  expect(text.rendered).toContain("pnpm -r test")
  // Long material is named, never pasted.
  expect(text.rendered).toContain(text.packetPath)
  expect(text.rendered).not.toContain("UNIQUEBODY")
})

it("keeps the brief inside its budget without losing the task", async () => {
  const world = await scenario()
  const budgeted = await runContinuity(
    world.home,
    Effect.gen(function* () {
      const { workspace } = yield* seedRun(world.repoPath)
      const events = yield* readEvents(runId)
      return {
        tight: yield* brief(workspace, events, 1_200),
        loose: yield* brief(workspace, events, 40_000),
      }
    }),
    world.settings,
  )

  expect(budgeted.tight.length).toBeLessThanOrEqual(1_200)
  expect(budgeted.tight.length).toBeLessThan(budgeted.loose.length)
  expect(budgeted.tight).toContain(prompt)
})

it("seeds one canonical session on the first press and resumes it on the second", async () => {
  const world = await scenario()
  const opened = await runContinuity(
    world.home,
    Effect.gen(function* () {
      const { workspace } = yield* seedRun(world.repoPath)
      const continuation = yield* ContinuationService
      const store = yield* Store
      const first = yield* continuation.open(runId)
      const second = yield* continuation.open(runId)
      return {
        first,
        second,
        stored: (yield* store.run(runId))?.canonicalSessionId,
        artifact: yield* store.latestArtifact(runId, "task-brief"),
        worktree: workspace.path,
      }
    }),
    world.settings,
  )

  expect(opened.first.mode).toBe("herdr")
  expect(opened.first.fallback).toBeUndefined()
  expect(opened.stored).toBe(opened.first.sessionId)
  expect(opened.second.sessionId).toBe(opened.first.sessionId)
  expect(opened.second.briefPath).toBeUndefined()
  expect(opened.artifact?.path).toBe(opened.first.briefPath)
  expect(readFileSync(opened.first.briefPath!, "utf8")).toContain(prompt)

  const calls = world.herdr()
  expect(calls[0]).toEqual(["status", "server", "--json"])
  expect(calls[1]).toEqual([
    "tab",
    "create",
    "--cwd",
    opened.worktree,
    "--label",
    prompt.slice(0, 48),
    "--focus",
  ])
  // The binary is not in the argv: `--kind` names the canonical executable herdr itself runs.
  expect(calls[2]).toEqual([
    "agent",
    "start",
    "cockpit-w1-t9-p1",
    "--kind",
    "claude",
    "--pane",
    "w1:t9:p1",
    "--timeout",
    "30000",
    "--",
    "--session-id",
    opened.first.sessionId,
    "--",
    `Read ${opened.first.briefPath} — it is Cockpit's full brief for the task already executed in this worktree. Then wait for my instructions.`,
  ])
  expect(calls[5]).toEqual([
    "agent",
    "start",
    "cockpit-w1-t9-p1",
    "--kind",
    "claude",
    "--pane",
    "w1:t9:p1",
    "--timeout",
    "30000",
    "--",
    "--resume",
    opened.first.sessionId,
  ])
})

it("resumes a codex run through the handle codex actually offers", async () => {
  const world = await scenario()
  const opened = await runContinuity(
    world.home,
    Effect.gen(function* () {
      yield* seedRun(world.repoPath, "codex")
      const continuation = yield* ContinuationService
      const first = yield* continuation.open(runId)
      return { first, second: yield* continuation.open(runId) }
    }),
    world.settings,
  )

  expect(opened.first.sessionId).toBe("codex:resume-last")
  expect(opened.second.sessionId).toBe(opened.first.sessionId)
  const calls = world.herdr()
  expect(calls[2]).toEqual([
    "agent",
    "start",
    "cockpit-w1-t9-p1",
    "--kind",
    "codex",
    "--pane",
    "w1:t9:p1",
    "--timeout",
    "30000",
    "--",
    "--",
    `Read ${opened.first.briefPath} — it is Cockpit's full brief for the task already executed in this worktree. Then wait for my instructions.`,
  ])
  expect(calls[5]).toEqual([
    "agent",
    "start",
    "cockpit-w1-t9-p1",
    "--kind",
    "codex",
    "--pane",
    "w1:t9:p1",
    "--timeout",
    "30000",
    "--",
    "resume",
    "--last",
  ])
})

it("checks the worktree out again when it is gone and says so", async () => {
  const world = await scenario()
  const opened = await runContinuity(
    world.home,
    Effect.gen(function* () {
      const { workspace } = yield* seedRun(world.repoPath)
      const continuation = yield* ContinuationService
      yield* continuation.open(runId)
      yield* Effect.sync(() => rmSync(workspace.path, { recursive: true, force: true }))
      return { second: yield* continuation.open(runId), worktree: workspace.path }
    }),
    world.settings,
  )

  expect(opened.second.fallback).toBe("fresh-worktree")
  expect(existsSync(NodePath.join(opened.worktree, "parser.txt"))).toBe(true)
})

it("starts a fresh session from the brief when the old one cannot be resumed", async () => {
  const configDir = await tempDir("cockpit-claude-")
  // The probe only votes when claude's layout is where it expects it, so the directory has to be
  // there for a missing transcript to mean the session is really gone.
  mkdirSync(NodePath.join(configDir, "projects"), { recursive: true })
  const world = await scenario({ CLAUDE_CONFIG_DIR: configDir })

  const opened = await runContinuity(
    world.home,
    Effect.gen(function* () {
      yield* seedRun(world.repoPath)
      const continuation = yield* ContinuationService
      const first = yield* continuation.open(runId)
      const second = yield* continuation.open(runId)
      return { first, second, events: yield* readEvents(runId) }
    }),
    world.settings,
  )

  expect(opened.second.fallback).toBe("fresh-session")
  expect(opened.second.sessionId).not.toBe(opened.first.sessionId)
  expect(opened.second.briefPath).toBeDefined()
  expect(
    opened.events.some(
      (event) =>
        event.payload._tag === "AgentActivity" &&
        event.payload.activity === "canonical-session-archived" &&
        event.payload.detail === opened.first.sessionId,
    ),
  ).toBe(true)
})

it("falls back to Ghostty with a warning when the herdr server is down", async () => {
  const world = await scenario()
  process.env.COCKPIT_FAKE_HERDR_DOWN = "1"

  const opened = await runContinuity(
    world.home,
    Effect.gen(function* () {
      const { workspace } = yield* seedRun(world.repoPath)
      const continuation = yield* ContinuationService
      return { handoff: yield* continuation.open(runId), worktree: workspace.path }
    }),
    world.settings,
  )

  expect(opened.handoff.mode).toBe("ghostty")
  expect(opened.handoff.warning).toContain("herdr server is not running")
  expect(world.opened()[0]).toEqual([
    "-na",
    "Ghostty.app",
    "--args",
    `--working-directory=${opened.worktree}`,
    "-e",
    claudeBin,
    "--session-id",
    opened.handoff.sessionId,
    "--",
    `Read ${opened.handoff.briefPath} — it is Cockpit's full brief for the task already executed in this worktree. Then wait for my instructions.`,
  ])
})

it("journals which terminal took the handoff", async () => {
  const world = await scenario()
  const events = await runContinuity(
    world.home,
    Effect.gen(function* () {
      yield* seedRun(world.repoPath)
      yield* (yield* ContinuationService).open(runId)
      return yield* readEvents(runId)
    }),
    world.settings,
  )

  const terminal = events.filter(
    (event) => event.payload._tag === "AgentActivity" && event.payload.activity.startsWith("terminal:"),
  )
  expect(terminal).toHaveLength(1)
  expect(terminal[0].payload).toMatchObject({
    activity: "terminal:herdr",
    detail: expect.stringContaining("herdr protocol 17"),
  })
})

it("names both committed and never-tracked work in the brief's changed files", async () => {
  const world = await scenario()
  const brief = await runContinuity(
    world.home,
    Effect.gen(function* () {
      yield* seedRun(world.repoPath)
      const opened = yield* (yield* ContinuationService).open(runId)
      return readFileSync(opened.briefPath!, "utf8")
    }),
    world.settings,
  )

  expect(brief).toContain("parser.txt")
  expect(brief).toContain("scratch.txt")
})

it("resumes with the provider that opened the session, not the one the run moved to", async () => {
  const world = await scenario()
  const opened = await runContinuity(
    world.home,
    Effect.gen(function* () {
      yield* seedRun(world.repoPath)
      const continuation = yield* ContinuationService
      const first = yield* continuation.open(runId)
      // The run's newest block ran on codex; the canonical session is still claude's.
      yield* (yield* Journal).append({
        runId,
        blockId: verify,
        payload: {
          _tag: "PluginResolved",
          provider: { name: "codex", version: "0.146.0" },
          capabilities: [],
        },
      })
      return { first, second: yield* continuation.open(runId) }
    }),
    world.settings,
  )

  expect(opened.second.sessionId).toBe(opened.first.sessionId)
  expect(world.herdr()[5]).toEqual([
    "agent",
    "start",
    "cockpit-w1-t9-p1",
    "--kind",
    "claude",
    "--pane",
    "w1:t9:p1",
    "--timeout",
    "30000",
    "--",
    "--resume",
    opened.first.sessionId,
  ])
})

it("does not open a second terminal when the tab exists but no agent came up in it", async () => {
  const world = await scenario()
  process.env.COCKPIT_FAKE_HERDR_START_FAIL = "1"

  const failed = await runContinuity(
    world.home,
    Effect.gen(function* () {
      yield* seedRun(world.repoPath)
      return yield* Effect.either((yield* ContinuationService).open(runId))
    }),
    world.settings,
  )

  expect(failed._tag).toBe("Left")
  expect(failed._tag === "Left" && failed.left._tag).toBe("HerdrError")
  expect(failed._tag === "Left" && failed.left.detail).toContain("tab w1:t9 is open but has no agent")
  expect(world.opened()).toEqual([])
})

it("keeps the run session-less when no terminal took it, and seeds cleanly next time", async () => {
  const world = await scenario()
  process.env.COCKPIT_FAKE_HERDR_DOWN = "1"
  process.env.COCKPIT_FAKE_OPEN_FAIL = "1"

  const after = await runContinuity(
    world.home,
    Effect.gen(function* () {
      yield* seedRun(world.repoPath)
      const store = yield* Store
      const continuation = yield* ContinuationService
      const failed = yield* Effect.either(continuation.open(runId))
      const stranded = (yield* store.run(runId))?.canonicalSessionId
      yield* Effect.sync(() => delete process.env.COCKPIT_FAKE_OPEN_FAIL)
      const recovered = yield* continuation.open(runId)
      return { failed, stranded, recovered, events: yield* readEvents(runId) }
    }),
    world.settings,
  )

  expect(after.failed._tag).toBe("Left")
  expect(after.stranded).toBeNull()
  // A press that opened nothing left no session to archive, so this is a first seed, not a retry.
  expect(after.recovered.fallback).toBeUndefined()
  expect(after.recovered.briefPath).toBeDefined()
  expect(tags(after.events, "SessionStarted")).toHaveLength(1)
  expect(
    after.events.filter(
      (event) =>
        event.payload._tag === "AgentActivity" &&
        event.payload.activity === "canonical-session-archived",
    ),
  ).toHaveLength(0)
})

it("gives two simultaneous presses the same session", async () => {
  const world = await scenario()
  const opened = await runContinuity(
    world.home,
    Effect.gen(function* () {
      yield* seedRun(world.repoPath)
      const continuation = yield* ContinuationService
      const both = yield* Effect.all(
        [continuation.open(runId), continuation.open(runId)],
        { concurrency: 2 },
      )
      return { both, events: yield* readEvents(runId) }
    }),
    world.settings,
  )

  expect(opened.both[1].sessionId).toBe(opened.both[0].sessionId)
  expect(tags(opened.events, "SessionStarted")).toHaveLength(1)
  expect(
    opened.events.filter(
      (event) => event.payload._tag === "ArtifactCreated" && event.payload.kind === "task-brief",
    ),
  ).toHaveLength(1)
})

it("records a herdr protocol it was not verified against", async () => {
  const world = await scenario()
  process.env.COCKPIT_FAKE_HERDR_PROTOCOL = "18"

  const events = await runContinuity(
    world.home,
    Effect.gen(function* () {
      yield* seedRun(world.repoPath)
      yield* (yield* ContinuationService).open(runId)
      return yield* readEvents(runId)
    }),
    world.settings,
  )

  const terminal = events.find(
    (event) => event.payload._tag === "AgentActivity" && event.payload.activity === "terminal:herdr",
  )
  expect(terminal?.payload).toMatchObject({
    detail: expect.stringContaining("herdr protocol 18 (verified against 17)"),
  })
})

it("renders a brief for a run that was cancelled before it did anything", async () => {
  const world = await scenario()
  const rendered = await runContinuity(
    world.home,
    Effect.gen(function* () {
      const store = yield* Store
      const journal = yield* Journal
      const project = yield* store.addProject({ name: "sample", repoPath: world.repoPath })
      yield* journal.createRun({ runId, projectId: project.id, prompt })
      yield* journal.startRun(runId)
      yield* journal.cancelRun(runId)
      const run = yield* store.run(runId)
      return renderTaskBrief({
        run: run!,
        projectName: project.name,
        repoPath: world.repoPath,
        worktreePath: "/nowhere",
        events: yield* readEvents(runId),
        blocks: yield* store.blocks(runId),
        changedFiles: [],
        healthChecks: [],
        maxChars: 40_000,
      })
    }),
    world.settings,
  )

  expect(rendered).toContain(prompt)
  expect(rendered).toContain("Status: cancelled")
  // Sections with nothing to report are absent, not empty headings.
  expect(rendered).not.toContain("## Attempts worth knowing about")
  expect(rendered).not.toContain("## Blocks")
  expect(rendered).toContain("## Working here")
})
