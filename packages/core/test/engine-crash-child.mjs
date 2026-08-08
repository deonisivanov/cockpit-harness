// Runs a scripted tree through the built engine in its own process, so the parent test can SIGKILL
// it mid-run the way a dying daemon leaves a journal: with nothing written to announce the end.
import { NodeContext } from "@effect/platform-node"
import { Effect, Layer, Stream } from "effect"
import { readFileSync } from "node:fs"
import { EngineLive, EventBus, Journal, RunId, WorkflowEngine, WorkspaceManager } from "../dist/index.js"

const [repoPath, run, planPath] = process.argv.slice(2)
const runId = RunId.make(run)
const plan = JSON.parse(readFileSync(planPath, "utf8"))
const task = { prompt: plan.prompt, projectId: "proj" }

const program = Effect.gen(function* () {
  const journal = yield* Journal
  const bus = yield* EventBus
  const workspaces = yield* WorkspaceManager
  const engine = yield* WorkflowEngine

  // The parent reads this to know how far the run got before it kills it, and the gate is answered
  // here because a headless child has nobody else to answer it.
  const live = yield* bus.subscribe
  yield* Effect.forkScoped(
    Stream.runForEach(live, (event) =>
      Effect.sync(() =>
        process.stdout.write(`EVENT ${event.payload._tag} ${event.blockId ?? "-"}\n`),
      ).pipe(
        Effect.zipRight(
          plan.approve && event.payload._tag === "ApprovalRequested"
            ? Effect.ignore(engine.approveGate(runId, event.payload.gateId, true))
            : Effect.void,
        ),
      ),
    ),
  )

  const workspace = yield* workspaces.create({
    projectId: "proj",
    repoPath,
    baseCommit: "HEAD",
    runId,
  })
  yield* journal.createRun({
    runId,
    projectId: "proj",
    prompt: plan.prompt,
    baseCommit: workspace.baseCommit,
    worktreePath: workspace.path,
    branch: workspace.branch,
    targetBranch: workspace.targetBranch,
  })
  yield* engine.run({
    runId,
    task,
    tree: { runId, templateId: "resume", root: plan.root },
    workspace,
    catalog: plan.catalog,
  })
})

// A fiber parked on a gate holds no OS handle, so node would run out of work and exit while the
// run is still open — which is not the interruption these tests are after.
setInterval(() => {}, 1000)

Effect.runPromise(
  Effect.scoped(Effect.provide(program, EngineLive.pipe(Layer.provide(NodeContext.layer)))),
).then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error}\n`)
    process.exit(1)
  },
)
