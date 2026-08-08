import { Effect, Schedule } from "effect"
import { writeFile } from "node:fs/promises"
import * as NodePath from "node:path"
import {
  EventPayload,
  Journal,
  JournalEvent,
  ResumePlan,
  RunId,
  RunOutcome,
  Workspace,
  WorkflowCatalog,
  WorkflowEngine,
  WorkflowNode,
  WorkspaceManager,
} from "../src/index.js"
import {
  EngineContext,
  fixturePath,
  makeRepo,
  readEvents,
  runEngine,
  Settings,
  tempDir,
  tempHome,
} from "./helpers.js"
import { catalog } from "./trees.js"

export { block, catalog, id } from "./trees.js"

/** One entry of the fake provider's script; keyed by `<block def id>:<attempt>` or `<block def id>`. */
export interface FakeStep {
  readonly output?: unknown
  readonly text?: string
  readonly isError?: boolean
  readonly stderr?: string
  readonly delayMs?: number
  readonly hang?: boolean
  readonly writes?: Readonly<Record<string, string>>
  /** Asks it as a headless question, then ends the session without writing a result. */
  readonly question?: string
  /** Reports the prompt it was called with as its own answer, so a resume can be read back. */
  readonly echoPrompt?: boolean
  /** Exits with this status before reporting a result, which the adapter reads as a crash. */
  readonly exitCode?: number
  /** Dies only when invoked with `--resume`, standing in for a session the CLI has lost. */
  readonly failResume?: boolean
  /** Writes the result to this path instead, and leaves $COCKPIT_OUTPUT a symlink to it. */
  readonly symlinkOutputTo?: string
}

export type FakeScript = Readonly<Record<string, FakeStep>>

type Tagged<T extends EventPayload["_tag"]> = JournalEvent & {
  readonly payload: Extract<EventPayload, { _tag: T }>
}

export const of = <T extends EventPayload["_tag"]>(
  events: ReadonlyArray<JournalEvent>,
  tag: T,
): ReadonlyArray<Tagged<T>> =>
  events.filter((event): event is Tagged<T> => event.payload._tag === tag)

/** Polls the journal instead of the clock, so a slow machine waits rather than flakes. */
export const waitFor = (runId: RunId, ready: (events: ReadonlyArray<JournalEvent>) => boolean) =>
  Effect.retry(
    Effect.filterOrFail(readEvents(runId), ready, () => "not yet" as const),
    Schedule.spaced("20 millis").pipe(Schedule.intersect(Schedule.recurs(500))),
  )

export interface Harness {
  readonly runId: RunId
  readonly workspace: Workspace
  readonly start: (
    root: WorkflowNode,
    given?: WorkflowCatalog,
    resume?: ResumePlan,
    skips?: ReadonlySet<string>,
  ) => Effect.Effect<RunOutcome, unknown, EngineContext>
}

/** Both adapters and the preflight `--version` probe point at the scripted stand-in. */
export const fakeProviders: Settings = {
  COCKPIT_CLAUDE_BIN: fixturePath("fake-provider.mjs"),
  COCKPIT_CODEX_BIN: fixturePath("fake-provider.mjs"),
  COCKPIT_KILL_GRACE_MS: "200",
}

/**
 * The stand-in reads its script from the environment it is spawned with, not from Effect config.
 * The directory is returned because its name is unique, which makes it a run id no other test
 * running alongside can collide with.
 */
export const writeScript = async (script: FakeScript) => {
  const dir = await tempDir("cockpit-script-")
  await writeFile(NodePath.join(dir, "script.json"), JSON.stringify(script))
  process.env.COCKPIT_FAKE_SCRIPT = NodePath.join(dir, "script.json")
  return RunId.make(`run-${NodePath.basename(dir)}`)
}

export const withEngine = async <A, E>(
  script: FakeScript,
  body: (harness: Harness) => Effect.Effect<A, E, EngineContext>,
  settings: Settings = {},
  prompt = "make the thing work",
) => {
  const home = await tempHome()
  const { repoPath, baseCommit } = await makeRepo()
  // An empty config dir, so a run's preflight sees the plugins a test installs and no others.
  const pluginHome = await tempDir("cockpit-claude-")
  const runId = await writeScript(script)

  return runEngine(
    home,
    Effect.gen(function* () {
      const journal = yield* Journal
      const workspaces = yield* WorkspaceManager
      const engine = yield* WorkflowEngine

      const workspace = yield* workspaces.create({ projectId: "proj", repoPath, baseCommit, runId })
      yield* journal.createRun({
        runId,
        projectId: "proj",
        prompt,
        baseCommit,
        worktreePath: workspace.path,
        branch: workspace.branch,
      })

      return yield* body({
        runId,
        workspace,
        start: (root, given, resume, skips) =>
          engine.run({
            runId,
            task: { prompt, projectId: "proj" },
            tree: { runId, templateId: "test", root },
            workspace,
            catalog: given ?? catalog(),
            resume,
            skips,
          }),
      })
    }),
    { ...fakeProviders, CLAUDE_CONFIG_DIR: pluginHome, ...settings },
  )
}
