import { FileSystem } from "@effect/platform"
import {
  allEvents,
  Analyzer,
  ArtifactStore,
  BlockId,
  blocksIn,
  buildRegistry,
  buildResumePlan,
  CartridgeLoader,
  CheckpointService,
  clip,
  Journal,
  JournalError,
  PluginCatalog,
  ProjectRow,
  recordedSkips,
  ResumePlan,
  RetrospectiveService,
  RetryPolicy,
  RunId,
  RunRow,
  skipBreaksContract,
  Store,
  TransformPipeline,
  WorkflowEngine,
  WorkflowNode,
  Workspace,
  WorkspaceError,
  WorkspaceManager,
} from "@cockpit/core"
import { Cause, Context, Deferred, Effect, Fiber, HashMap, Layer, Option, Ref, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import * as NodePath from "node:path"

/** Where a run's executed tree is kept, so a client can read it back without replaying the log. */
export const treeArtifactKind = "workflow-tree"

const PlannedTree = Schema.Struct({
  tree: Schema.Struct({ runId: RunId, templateId: Schema.String, root: WorkflowNode }),
  policies: Schema.Array(RetryPolicy),
})
type PlannedTree = typeof PlannedTree.Type

const decodePlanned = Schema.decodeUnknown(Schema.parseJson(PlannedTree))

/**
 * What the run settled on before executing. Decoded, not cast: the artifact is a file on disk, and
 * a truncated or hand-edited one has to read as "no tree" rather than as a tree with holes in it.
 */
export const plannedTree = (path: string) =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(
    Effect.flatMap(decodePlanned),
    Effect.orElseSucceed(() => undefined),
  )

const causeChars = 4_000

export class RunSupervisor extends Context.Tag("cockpitd/RunSupervisor")<
  RunSupervisor,
  {
    readonly start: (input: {
      readonly project: ProjectRow
      readonly prompt: string
    }) => Effect.Effect<RunId, WorkspaceError | JournalError>
    /**
     * Re-enters a run the journal marked interrupted, or one that failed and the user asked to
     * carry on (plan §9). What it already completed is replayed, not executed again; the worktree
     * is put back under the engine inside the run, so a repository that has moved on is reported
     * the way any other run failure is.
     */
    readonly resume: (runId: RunId) => Effect.Effect<void, JournalError>
    /** False when this daemon process does not own the run — a recovered one never does. */
    readonly cancel: (runId: RunId) => Effect.Effect<boolean>
    /** Like cancel, but the run closes as interrupted and stays resumable. */
    readonly stop: (runId: RunId) => Effect.Effect<boolean>
    /**
     * Records a request to skip a node's next visit, refused when the tree would stop validating
     * without it. The request is durable; a live run also learns of it immediately.
     */
    readonly skip: (
      runId: RunId,
      nodeId: string,
    ) => Effect.Effect<SkipDecision, JournalError | WorkspaceError>
  }
>() {}

export type SkipDecision =
  | { readonly _tag: "accepted" }
  | { readonly _tag: "unknown" }
  | { readonly _tag: "refused"; readonly detail: string }

export const RunSupervisorLive = Layer.scoped(
  RunSupervisor,
  Effect.gen(function* () {
    // Runs outlive the request that starts them, so they are forked into the daemon's own scope.
    const scope = yield* Effect.scope
    const fs = yield* FileSystem.FileSystem
    const journal = yield* Journal
    const store = yield* Store
    const artifacts = yield* ArtifactStore
    const workspaces = yield* WorkspaceManager
    const checkpoints = yield* CheckpointService
    const analyzer = yield* Analyzer
    const transforms = yield* TransformPipeline
    const loader = yield* CartridgeLoader
    const plugins = yield* PluginCatalog
    const engine = yield* WorkflowEngine
    const retrospectives = yield* RetrospectiveService

    const running = yield* Ref.make(HashMap.empty<RunId, Fiber.RuntimeFiber<void>>())
    /**
     * Why an interrupted run is being unwound. Three cases, and the absent one is load-bearing:
     * no marker means the daemon itself is going down, so nobody closes the run — the row stays
     * `running` for the next boot's recovery scan to mark interrupted and resumable.
     */
    const closing = yield* Ref.make(HashMap.empty<RunId, "stop" | "cancel">())

    /** A project without a cartridge runs on core templates; a broken one is an error, not a default. */
    const cartridgeFor = (repoPath: string) =>
      Effect.gen(function* () {
        const path = NodePath.join(repoPath, ".cockpit", "cockpit.config.ts")
        const present = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
        return present ? yield* loader.load(repoPath) : undefined
      })

    const capabilities = Effect.gen(function* () {
      const [claude, codex, installed] = yield* Effect.all([
        plugins.providerVersion("claude-code"),
        plugins.providerVersion("codex"),
        plugins.plugins,
      ])
      return [
        ...(claude === undefined ? [] : [`claude-code ${claude}`]),
        ...(codex === undefined ? [] : [`codex ${codex}`]),
        ...installed
          .filter((plugin) => plugin.enabled)
          .flatMap((plugin) =>
            plugin.capabilities.map((capability) => `${plugin.name} ${capability}`),
          ),
      ]
    })

    const execute = (input: {
      readonly runId: RunId
      readonly project: ProjectRow
      readonly prompt: string
      readonly workspace: Workspace
    }) =>
      Effect.gen(function* () {
        const { project, prompt, runId, workspace } = input
        const cartridge = yield* cartridgeFor(project.repoPath)
        const registry = yield* buildRegistry(cartridge?.config)
        const rules = cartridge?.config.rules ?? {}

        const analyzed = yield* analyzer.analyze({
          runId,
          prompt,
          project: { name: project.name, rules },
          templates: registry.templates,
          policies: registry.catalog.policies,
          capabilities: yield* capabilities,
          cwd: workspace.path,
        })

        // The Analyzer's retry counts arrive as derived policies, so the catalog the run validates
        // and executes against is the registry's blocks with those policies, not the template's.
        const catalog = { blocks: registry.catalog.blocks, policies: analyzed.policies }
        const tree = yield* transforms.apply({
          tree: analyzed.tree,
          cartridge: cartridge?.config,
          context: { projectName: project.name, prompt, rules },
          catalog,
        })
        // The policies travel with the tree: a Loop node names one by id, and the attempt ceiling
        // behind that id is not derivable from the tree alone.
        yield* artifacts.write({
          runId,
          kind: treeArtifactKind,
          name: "tree.json",
          content: JSON.stringify({ tree, policies: catalog.policies }),
        })

        yield* engine.run({
          runId,
          task: { prompt, projectId: project.id },
          tree,
          workspace,
          catalog,
          // Requests recorded while the run was still being planned survive a daemon restart.
          skips: recordedSkips(yield* allEvents(journal, runId)),
        })
      })

    /**
     * Puts the run's worktree back under the engine: at the path it recorded while that path is
     * still its worktree, rebuilt from the last confirmed checkpoint when it is gone (plan §9).
     * Whatever the interrupted attempt left uncommitted is kept as a salvage commit first — it is
     * evidence, not work the next block should inherit — and then the tree goes back to the
     * checkpoint the run confirmed, which is the state the journal can account for.
     */
    const reconcile = (run: RunRow, project: ProjectRow, plan: ResumePlan) =>
      Effect.gen(function* () {
        const recorded = run.worktreePath
        const shared = {
          projectId: run.projectId,
          runId: run.id,
          repoPath: project.repoPath,
          branch: run.branch ?? `cockpit/run-${run.id}`,
          targetBranch: run.targetBranch ?? undefined,
        }
        const present =
          recorded !== null && (yield* fs.exists(recorded).pipe(Effect.orElseSucceed(() => false)))
        if (!present) {
          const rebuilt = yield* workspaces.restore({
            ...shared,
            commit: plan.lastCheckpoint ?? run.baseCommit ?? "HEAD",
          })
          // A restored worktree is checked out at the checkpoint, but the run still branched off
          // the commit it recorded — and that is the one finalize compares the target branch
          // against, so keeping the checkout's commit here would refuse every landing.
          return { ...rebuilt, baseCommit: run.baseCommit ?? rebuilt.baseCommit }
        }

        const workspace: Workspace = {
          ...shared,
          path: recorded,
          baseCommit: run.baseCommit ?? "HEAD",
        }
        // The salvage commit and the reset both write into this path, so it is confirmed to be
        // this run's worktree before either of them runs. The full `reconcile` cannot come first:
        // it also refuses a dirty tree, which is the state those two are here to clear.
        const refuse = (detail: string) => new WorkspaceError({ op: "reconcile", detail })
        const toplevel = yield* workspaces.resolveRepo(workspace.path)
        // git reports a symlink-resolved path (on macOS /var vs /private/var), so compare real ones.
        const own = yield* Effect.try({
          try: () => realpathSync(toplevel) === realpathSync(workspace.path),
          catch: () => refuse(`${workspace.path} is not reachable`),
        })
        if (!own) {
          return yield* refuse(
            `${workspace.path} is no longer this run's worktree (git reports ${toplevel})`,
          )
        }
        if (plan.lastCheckpoint !== undefined) {
          const open = plan.openAttempt
          if (open !== undefined) {
            yield* checkpoints.salvage(workspace, {
              ...open,
              message: `cockpit: salvage ${open.blockId} interrupted`,
            })
          }
          yield* checkpoints.rollbackTo(workspace, plan.lastCheckpoint)
        }
        yield* workspaces.reconcile(workspace)
        return workspace
      })

    /**
     * The blocks come from the cartridge as it stands now — a project edited since the run started
     * resumes against what it has today — while the policies travel with the tree, since the
     * attempt ceilings behind a Loop's policy id were the Analyzer's to choose.
     */
    const reenter = (input: {
      readonly run: RunRow
      readonly project: ProjectRow
      readonly planned: PlannedTree
      readonly plan: ResumePlan
    }) =>
      Effect.gen(function* () {
        const { plan, planned, project, run } = input
        const workspace = yield* reconcile(run, project, plan)
        const cartridge = yield* cartridgeFor(project.repoPath)
        const registry = yield* buildRegistry(cartridge?.config)
        yield* engine.run({
          runId: run.id,
          task: { prompt: run.prompt, projectId: project.id },
          tree: planned.tree,
          workspace,
          catalog: { blocks: registry.catalog.blocks, policies: planned.policies },
          resume: plan,
        })
      })

    /** The run may still be `created`: planning fails before the engine ever opens it. */
    const closeFailed = (runId: RunId) =>
      Effect.ignore(journal.startRun(runId)).pipe(
        Effect.zipRight(Effect.ignore(journal.finishRun(runId, "failed"))),
        Effect.uninterruptible,
      )

    /**
     * The retrospective reads a run that is already over, so nothing it does may change how that
     * run ended: a failure of its own is journaled and logged, and the run keeps its status.
     * A cancelled run has nothing to learn from — it was stopped, not judged.
     */
    const retrospect = (runId: RunId) =>
      Effect.gen(function* () {
        const status = yield* journal.runStatus(runId)
        if (status !== "succeeded" && status !== "failed") return
        yield* retrospectives.analyze(runId)
      }).pipe(Effect.ignoreLogged)

    /**
     * The one closer of an interrupted run (the engine leaves it open). An external interrupt
     * unwinds past error handlers, so this runs as a finalizer inside an already-interrupted
     * fiber — every arm must stay uninterruptible to commit.
     */
    const closeInterrupted = (runId: RunId) =>
      Effect.uninterruptible(
        Effect.flatMap(Ref.get(closing), (intents) => {
          const intent = HashMap.get(intents, runId)
          if (Option.isNone(intent)) return Effect.void
          return Effect.ignore(
            intent.value === "stop" ? journal.stopRun(runId) : journal.cancelRun(runId),
          )
        }),
      )

    const supervise = (runId: RunId, body: Effect.Effect<unknown, unknown>) =>
      Effect.matchCauseEffect(body, {
        onSuccess: () => Effect.void,
        onFailure: (cause) =>
          Cause.isInterruptedOnly(cause)
            ? closeInterrupted(runId)
            : journal
                .append({
                  runId,
                  payload: {
                    _tag: "ErrorRaised",
                    class: "technical",
                    signature: "run-pipeline",
                    message: clip(Cause.pretty(cause), causeChars),
                  },
                })
                .pipe(Effect.ignore, Effect.zipRight(closeFailed(runId))),
      })

    /**
     * Registered before it runs, so a run that fails at once cannot be cleaned up before the map
     * that is supposed to hold it has heard of it. Uninterruptible as one piece: a client that
     * hangs up mid-request must not leave the fiber waiting on a latch nobody opens.
     */
    const launch = (runId: RunId, body: Effect.Effect<unknown, unknown>) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const registered = yield* Deferred.make<void>()
          // The run asks for its interruptibility back: a forked fiber inherits the flags of the
          // fiber that forked it, and a run that cannot be interrupted cannot be cancelled.
          const fiber = yield* Effect.interruptible(
            Deferred.await(registered).pipe(
              Effect.zipRight(supervise(runId, body)),
              // An external interrupt never reaches supervise's handlers — it unwinds past them —
              // so the close rides a finalizer. It reads the same marker; absent means shutdown.
              Effect.onInterrupt(() => closeInterrupted(runId)),
              // Interruption resumes past this, which is what keeps a cancelled run out of it.
              Effect.zipRight(retrospect(runId)),
            ),
          ).pipe(
            // The intent marker dies with the fiber, or a stale "stop" would win over a later
            // cancel of a run reusing this id.
            Effect.ensuring(
              Ref.update(running, HashMap.remove(runId)).pipe(
                Effect.zipRight(Ref.update(closing, HashMap.remove(runId))),
              ),
            ),
            Effect.forkIn(scope),
          )
          yield* Ref.update(running, HashMap.set(runId, fiber))
          yield* Deferred.succeed(registered, undefined)
        }),
      )

    return {
      start: (input) =>
        Effect.gen(function* () {
          const runId = RunId.make(randomUUID())
          // Kept in the request: a repository that cannot produce a worktree is the caller's error
          // to see, and the run row is only truthful once it names the worktree it will run in.
          const workspace = yield* workspaces.create({
            projectId: input.project.id,
            repoPath: input.project.repoPath,
            baseCommit: "HEAD",
            runId,
          })
          yield* journal.createRun({
            runId,
            projectId: input.project.id,
            prompt: input.prompt,
            baseCommit: workspace.baseCommit,
            worktreePath: workspace.path,
            branch: workspace.branch,
            targetBranch: workspace.targetBranch,
          })

          yield* launch(runId, execute({ ...input, runId, workspace }))
          return runId
        }),

      resume: (runId) =>
        Effect.gen(function* () {
          const fail = (detail: string) => new JournalError({ op: "resume", detail })
          const run = yield* store.run(runId)
          if (run === undefined) return yield* fail(`unknown run ${runId}`)
          const project = yield* store.project(run.projectId)
          if (project === undefined) {
            return yield* fail(`run ${runId} names unknown project ${run.projectId}`)
          }
          const artifact = yield* store.latestArtifact(runId, treeArtifactKind)
          const planned =
            artifact === undefined ? undefined : yield* plannedTree(artifact.path)
          if (planned === undefined) {
            return yield* fail(
              `run ${runId} has no workflow tree that still reads, so there is nothing to re-enter; start a new run`,
            )
          }

          const plan = yield* buildResumePlan(runId).pipe(
            Effect.provideService(Journal, journal),
            Effect.provideService(Store, store),
          )
          // The status change is the claim on the run: a second resume of the same one finds it
          // running and is refused here rather than forking a fiber against the same worktree.
          yield* journal.resumeRun(runId)
          yield* launch(runId, reenter({ run, project, planned, plan }))
        }),

      cancel: (runId) => interrupt(runId, "cancel"),

      stop: (runId) => interrupt(runId, "stop"),

      skip: (runId, nodeId) =>
        Effect.gen(function* () {
          const refused = (detail: string) => ({ _tag: "refused", detail }) as const
          const run = yield* store.run(runId)
          if (run === undefined) return { _tag: "unknown" } as const
          if (run.status === "succeeded" || run.status === "cancelled") {
            return refused(`run ${runId} is ${run.status}; there is nothing left to skip`)
          }
          const active = (yield* store.blocks(runId)).find(
            (block) => block.id.replace(/#\d+$/, "") === nodeId && block.status === "running",
          )
          if (active !== undefined) {
            return refused(`${nodeId} is running now — Stop the run, skip the block, then Resume`)
          }
          const artifact = yield* store.latestArtifact(runId, treeArtifactKind)
          const planned = artifact === undefined ? undefined : yield* plannedTree(artifact.path)
          if (planned === undefined) {
            return refused("the run has no workflow tree yet — wait for the analysis to finish")
          }
          if (!blocksIn(planned.tree.root).some((block) => block.id === nodeId)) {
            return refused(`${nodeId} names no block in this run's workflow`)
          }
          const project = yield* store.project(run.projectId)
          const cartridge =
            project === undefined
              ? undefined
              : yield* cartridgeFor(project.repoPath).pipe(Effect.orElseSucceed(() => undefined))
          const registry = yield* buildRegistry(cartridge?.config).pipe(
            Effect.orElseSucceed(() => undefined),
          )
          if (registry === undefined) return refused("the project's cartridge does not load")
          const broken = skipBreaksContract(
            planned.tree,
            { blocks: registry.catalog.blocks, policies: planned.policies },
            BlockId.make(nodeId),
          )
          const first = broken[0]
          if (first !== undefined) {
            return refused(
              `skipping ${nodeId} would break ${first.path.at(-1) ?? "the workflow"}: ${first.message}`,
            )
          }
          yield* journal.append({ runId, payload: { _tag: "BlockSkipRequested", nodeId } })
          yield* engine.requestSkip(runId, BlockId.make(nodeId))
          return { _tag: "accepted" } as const
        }),
    }

    // Marked before the interrupt, or supervise races an empty map and closes nothing.
    function interrupt(runId: RunId, intent: "stop" | "cancel") {
      return Effect.gen(function* () {
        const fiber = HashMap.get(yield* Ref.get(running), runId)
        if (Option.isNone(fiber)) return false
        yield* Ref.update(closing, HashMap.set(runId, intent))
        yield* Fiber.interrupt(fiber.value)
        return true
      })
    }
  }),
)
