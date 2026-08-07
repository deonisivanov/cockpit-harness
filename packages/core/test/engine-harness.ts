import { Effect, Schedule } from "effect"
import { writeFile } from "node:fs/promises"
import * as NodePath from "node:path"
import {
  EventPayload,
  Journal,
  JournalEvent,
  RunId,
  RunOutcome,
  Workspace,
  WorkflowCatalog,
  WorkflowEngine,
  WorkflowNode,
  WorkspaceManager,
} from "../src/index.js"
import { EngineContext, fixturePath, makeRepo, readEvents, runEngine, tempDir, tempHome } from "./helpers.js"
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
  /** Exits with this status before reporting a result, which the adapter reads as a crash. */
  readonly exitCode?: number
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
  ) => Effect.Effect<RunOutcome, unknown, EngineContext>
}

export const withEngine = async <A, E>(
  script: FakeScript,
  body: (harness: Harness) => Effect.Effect<A, E, EngineContext>,
) => {
  const home = await tempHome()
  const { repoPath, baseCommit } = await makeRepo()
  const scriptDir = await tempDir("cockpit-script-")
  const scriptPath = NodePath.join(scriptDir, "script.json")
  await writeFile(scriptPath, JSON.stringify(script))
  process.env.COCKPIT_FAKE_SCRIPT = scriptPath

  const runId = RunId.make(`run-${NodePath.basename(scriptDir)}`)

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
        prompt: "make the thing work",
        baseCommit,
        worktreePath: workspace.path,
        branch: workspace.branch,
      })

      return yield* body({
        runId,
        workspace,
        start: (root, given) =>
          engine.run({
            runId,
            task: { prompt: "make the thing work", projectId: "proj" },
            tree: { runId, templateId: "test", root },
            workspace,
            catalog: given ?? catalog(),
          }),
      })
    }),
    {
      COCKPIT_CLAUDE_BIN: fixturePath("fake-provider.mjs"),
      COCKPIT_KILL_GRACE_MS: "200",
    },
  )
}
