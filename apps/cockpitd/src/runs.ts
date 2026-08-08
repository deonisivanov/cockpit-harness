import { FileSystem } from "@effect/platform"
import {
  Analyzer,
  ArtifactStore,
  buildRegistry,
  CartridgeLoader,
  clip,
  Journal,
  JournalError,
  PluginCatalog,
  ProjectRow,
  RunId,
  TransformPipeline,
  WorkflowEngine,
  Workspace,
  WorkspaceError,
  WorkspaceManager,
} from "@cockpit/core"
import { Cause, Context, Deferred, Effect, Fiber, HashMap, Layer, Option, Ref } from "effect"
import { randomUUID } from "node:crypto"
import * as NodePath from "node:path"

/** Where a run's executed tree is kept, so a client can read it back without replaying the log. */
export const treeArtifactKind = "workflow-tree"

const causeChars = 4_000

export class RunSupervisor extends Context.Tag("cockpitd/RunSupervisor")<
  RunSupervisor,
  {
    readonly start: (input: {
      readonly project: ProjectRow
      readonly prompt: string
    }) => Effect.Effect<RunId, WorkspaceError | JournalError>
    /** False when this daemon process does not own the run — a recovered one never does. */
    readonly cancel: (runId: RunId) => Effect.Effect<boolean>
  }
>() {}

export const RunSupervisorLive = Layer.scoped(
  RunSupervisor,
  Effect.gen(function* () {
    // Runs outlive the request that starts them, so they are forked into the daemon's own scope.
    const scope = yield* Effect.scope
    const fs = yield* FileSystem.FileSystem
    const journal = yield* Journal
    const artifacts = yield* ArtifactStore
    const workspaces = yield* WorkspaceManager
    const analyzer = yield* Analyzer
    const transforms = yield* TransformPipeline
    const loader = yield* CartridgeLoader
    const plugins = yield* PluginCatalog
    const engine = yield* WorkflowEngine

    const running = yield* Ref.make(HashMap.empty<RunId, Fiber.RuntimeFiber<void>>())

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
        })
      })

    /** The run may still be `created`: planning fails before the engine ever opens it. */
    const closeFailed = (runId: RunId) =>
      Effect.ignore(journal.startRun(runId)).pipe(
        Effect.zipRight(Effect.ignore(journal.finishRun(runId, "failed"))),
        Effect.uninterruptible,
      )

    const supervise = (runId: RunId, body: Effect.Effect<unknown, unknown>) =>
      Effect.matchCauseEffect(body, {
        onSuccess: () => Effect.void,
        onFailure: (cause) =>
          Cause.isInterruptedOnly(cause)
            ? // The engine cancels the run it opened; this is the same close for a cancel that
              // landed while the run was still being planned.
              Effect.uninterruptible(Effect.ignore(journal.cancelRun(runId)))
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
          })

          // Registered before it runs, so a run that fails at once cannot be cleaned up before the
          // map that is supposed to hold it has heard of it. Uninterruptible as one piece: a client
          // that hangs up mid-request must not leave the fiber waiting on a latch nobody opens.
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const registered = yield* Deferred.make<void>()
              // The run asks for its interruptibility back: a forked fiber inherits the flags of
              // the fiber that forked it, and a run that cannot be interrupted cannot be cancelled.
              const fiber = yield* Effect.interruptible(
                Deferred.await(registered).pipe(
                  Effect.zipRight(supervise(runId, execute({ ...input, runId, workspace }))),
                ),
              ).pipe(
                Effect.ensuring(Ref.update(running, HashMap.remove(runId))),
                Effect.forkIn(scope),
              )
              yield* Ref.update(running, HashMap.set(runId, fiber))
              yield* Deferred.succeed(registered, undefined)
            }),
          )

          return runId
        }),

      cancel: (runId) =>
        Effect.gen(function* () {
          const fiber = HashMap.get(yield* Ref.get(running), runId)
          if (Option.isNone(fiber)) return false
          yield* Fiber.interrupt(fiber.value)
          return true
        }),
    }
  }),
)
