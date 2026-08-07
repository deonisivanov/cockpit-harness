import { Command, CommandExecutor } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Context, Effect, Layer, Stream } from "effect"
import { realpathSync } from "node:fs"
import * as NodePath from "node:path"
import { cockpitHome } from "./config.js"
import { JournalError, WorkspaceError } from "./errors.js"
import type { CheckpointKind } from "./events.js"
import { AttemptId, BlockId, CheckpointId, RunId } from "./ids.js"
import { Journal } from "./Journal.js"

export interface Workspace {
  readonly projectId: string
  readonly runId: RunId
  readonly repoPath: string
  readonly path: string
  readonly branch: string
  readonly baseCommit: string
}

export interface CheckpointInput {
  readonly kind: CheckpointKind
  readonly message: string
  readonly blockId?: BlockId
  readonly attemptId?: AttemptId
}

type WorkspaceOp = typeof WorkspaceError.Type.op

const gitTimeoutMillis = 120_000

const gitEffect = (op: WorkspaceOp, cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const process = yield* Command.start(
      Command.make("git", ...args).pipe(
        Command.workingDirectory(cwd),
        // Without this git can block forever on a credential prompt with no terminal to answer it.
        Command.env({ GIT_TERMINAL_PROMPT: "0" }),
      ),
    )
    // stdout/stderr must drain concurrently with the exit wait, or a chatty git fills the pipe and hangs.
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(process.stdout)),
        Stream.mkString(Stream.decodeText(process.stderr)),
        process.exitCode,
      ],
      { concurrency: 3 },
    )
    return { stdout, stderr, exitCode }
  }).pipe(
    Effect.scoped,
    Effect.mapError(
      (cause) =>
        new WorkspaceError({ op, detail: `git ${args.join(" ")} in ${cwd}: ${cause.message}` }),
    ),
    Effect.flatMap(({ exitCode, stderr, stdout }) =>
      exitCode === 0
        ? Effect.succeed(stdout.trim())
        : Effect.fail(
            new WorkspaceError({
              op,
              detail: `git ${args.join(" ")} in ${cwd} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`,
            }),
          ),
    ),
    // Interrupting the scoped effect closes its scope, and the executor's release kills the
    // child's process group — so a wedged git cannot outlive the request that started it.
    Effect.timeoutFail({
      duration: gitTimeoutMillis,
      onTimeout: () =>
        new WorkspaceError({
          op,
          detail: `git ${args.join(" ")} in ${cwd} timed out after ${gitTimeoutMillis}ms`,
        }),
    }),
  )

/** Binds git to the layer's executor so service methods have no residual requirements. */
const boundGit = Effect.map(
  CommandExecutor.CommandExecutor,
  (executor) =>
    (op: WorkspaceOp, cwd: string, ...args: ReadonlyArray<string>) =>
      Effect.provideService(
        gitEffect(op, cwd, args),
        CommandExecutor.CommandExecutor,
        executor,
      ),
)

export class WorkspaceManager extends Context.Tag("cockpit/WorkspaceManager")<
  WorkspaceManager,
  {
    readonly create: (input: {
      readonly projectId: string
      readonly repoPath: string
      readonly baseCommit: string
      readonly runId: RunId
    }) => Effect.Effect<Workspace, WorkspaceError>
    readonly reconcile: (workspace: Workspace) => Effect.Effect<void, WorkspaceError>
    readonly remove: (workspace: Workspace) => Effect.Effect<void, WorkspaceError>
  }
>() {}

export const WorkspaceManagerLive = Layer.effect(
  WorkspaceManager,
  Effect.gen(function* () {
    const home = yield* cockpitHome
    const git = yield* boundGit
    const root = NodePath.join(home, "worktrees")

    const resolveCommit = (op: WorkspaceOp, repoPath: string, commit: string) =>
      git(op, repoPath, "rev-parse", "--verify", `${commit}^{commit}`)

    /** `remove` force-deletes this path, so one escaping the worktree root must never reach git. */
    const requireInsideRoot = (op: WorkspaceOp, path: string) =>
      path.startsWith(root + NodePath.sep)
        ? Effect.void
        : Effect.fail(
            new WorkspaceError({ op, detail: `worktree path ${path} escapes ${root}` }),
          )

    return {
      create: (input) =>
        Effect.gen(function* () {
          const baseCommit = yield* resolveCommit("create", input.repoPath, input.baseCommit)
          const path = NodePath.resolve(root, input.projectId, input.runId)
          yield* requireInsideRoot("create", path)
          const branch = `cockpit/run-${input.runId}`
          yield* git("create", input.repoPath, "worktree", "add", "-b", branch, path, baseCommit)
          return { ...input, baseCommit, path, branch }
        }),

      reconcile: (workspace) =>
        Effect.gen(function* () {
          yield* resolveCommit("reconcile", workspace.repoPath, workspace.baseCommit)
          // --show-toplevel rather than --git-dir: git walks upward, so a plain directory nested in
          // another repo would otherwise pass as this run's worktree and report that repo's status.
          const toplevel = yield* git("reconcile", workspace.path, "rev-parse", "--show-toplevel")
          // git reports a symlink-resolved path (on macOS /var vs /private/var), so compare real paths.
          const matches = yield* Effect.try({
            try: () => realpathSync(toplevel) === realpathSync(workspace.path),
            catch: () =>
              new WorkspaceError({
                op: "reconcile",
                detail: `worktree ${workspace.path} is not reachable`,
              }),
          })
          if (!matches) {
            return yield* new WorkspaceError({
              op: "reconcile",
              detail: `${workspace.path} is not a worktree root (git reports ${toplevel})`,
            })
          }
          const dirty = yield* git("reconcile", workspace.path, "status", "--porcelain")
          if (dirty !== "") {
            return yield* new WorkspaceError({
              op: "reconcile",
              detail: `worktree ${workspace.path} is dirty: ${dirty.split("\n").join("; ")}`,
            })
          }
        }),

      remove: (workspace) =>
        requireInsideRoot("remove", workspace.path).pipe(
          Effect.zipRight(
            git("remove", workspace.repoPath, "worktree", "remove", "--force", workspace.path),
          ),
          Effect.asVoid,
        ),
    }
  }),
)

export class CheckpointService extends Context.Tag("cockpit/CheckpointService")<
  CheckpointService,
  {
    readonly checkpoint: (
      workspace: Workspace,
      input: CheckpointInput,
    ) => Effect.Effect<CheckpointId, WorkspaceError | JournalError>
    readonly rollbackTo: (
      workspace: Workspace,
      checkpointId: CheckpointId,
    ) => Effect.Effect<void, WorkspaceError>
    /** Paths a block or attempt has touched since the last checkpoint; empty means it changed nothing. */
    readonly changedFiles: (
      workspace: Workspace,
    ) => Effect.Effect<ReadonlyArray<string>, WorkspaceError>
    /**
     * Keeps whatever a failed attempt left behind, or nothing when it changed nothing. Inspection
     * and commit share one lock so no other checkpoint can land between them, and the commit is
     * tagged: a rollback right after it would otherwise leave the work unreachable.
     */
    readonly salvage: (
      workspace: Workspace,
      input: {
        readonly message: string
        readonly blockId: BlockId
        readonly attemptId: AttemptId
      },
    ) => Effect.Effect<CheckpointId | undefined, WorkspaceError | JournalError>
  }
>() {}

export const CheckpointServiceLive = Layer.effect(
  CheckpointService,
  Effect.gen(function* () {
    const journal = yield* Journal
    const sql = yield* SqlClient.SqlClient
    const git = yield* boundGit

    // ponytail: one lock across every worktree. Parallel branches of a run share one worktree and
    // git serializes on .git/index.lock regardless; make it per-worktree if runs ever overlap.
    const gitLock = yield* Effect.makeSemaphore(1)

    // -z: a path containing a space or a newline still arrives as one record.
    const changed = (workspace: Workspace) =>
      Effect.map(git("checkpoint", workspace.path, "status", "--porcelain", "-z"), (out) => {
        const records = out.split("\0")
        const paths: string[] = []
        for (let index = 0; index < records.length; index += 1) {
          const record = records[index]
          if (record === "") continue
          paths.push(record.slice(3))
          // A rename or copy spends two records: the new path, then the one it came from.
          if (record[0] === "R" || record[0] === "C") index += 1
        }
        return paths
      })

    /** Unlocked on purpose: `salvage` composes this with an inspection under one critical section. */
    const commitAll = (workspace: Workspace, input: CheckpointInput) =>
      Effect.gen(function* () {
        const previousHead = yield* git("checkpoint", workspace.path, "rev-parse", "HEAD")
        yield* git("checkpoint", workspace.path, "add", "-A")
        // Checkpoints are engine bookkeeping, not user commits: signing would block on a GUI
        // pinentry, the project's hooks would run on every attempt, and the machine need not
        // have a git identity. --allow-empty keeps the chain unbroken when a block changed nothing.
        yield* git(
          "checkpoint",
          workspace.path,
          "-c",
          "commit.gpgsign=false",
          "-c",
          "user.name=Cockpit",
          "-c",
          "user.email=cockpit@localhost",
          "commit",
          "--no-verify",
          "--allow-empty",
          "-m",
          input.message,
        )
        const sha = CheckpointId.make(yield* git("checkpoint", workspace.path, "rev-parse", "HEAD"))
        yield* journal
          .recordCheckpoint({
            checkpointId: sha,
            runId: workspace.runId,
            blockId: input.blockId,
            attemptId: input.attemptId,
            kind: input.kind,
          })
          // A commit the journal never accepted would leave the branch ahead of the record
          // that is supposed to explain it.
          .pipe(
            Effect.onError(() =>
              Effect.ignore(git("checkpoint", workspace.path, "reset", "--hard", previousHead)),
            ),
          )
        return sha
      })

    return {
      checkpoint: (workspace, input) => commitAll(workspace, input).pipe(gitLock.withPermits(1)),

      salvage: (workspace, input) =>
        Effect.gen(function* () {
          const paths = yield* changed(workspace)
          if (paths.length === 0) return undefined
          const sha = yield* commitAll(workspace, { ...input, kind: "salvage" })
          yield* git("checkpoint", workspace.path, "tag", `cockpit/salvage/${input.attemptId}`, sha)
          return sha
        }).pipe(gitLock.withPermits(1)),

      rollbackTo: (workspace, checkpointId) =>
        Effect.gen(function* () {
          const rows = yield* sql<{ found: number }>`
            SELECT 1 AS found FROM checkpoints
            WHERE id = ${checkpointId} AND run_id = ${workspace.runId}`.pipe(
            Effect.mapError(
              (cause) =>
                new WorkspaceError({
                  op: "rollback",
                  detail: `looking up checkpoint ${checkpointId}: ${cause.message}`,
                }),
            ),
          )
          if (rows.length === 0) {
            return yield* new WorkspaceError({
              op: "rollback",
              detail: `checkpoint ${checkpointId} does not belong to run ${workspace.runId}`,
            })
          }
          // ^{commit} so a tag or tree sharing the id can never be reset onto.
          yield* git("rollback", workspace.path, "reset", "--hard", `${checkpointId}^{commit}`)
        }).pipe(gitLock.withPermits(1)),

      changedFiles: (workspace) => changed(workspace).pipe(gitLock.withPermits(1)),
    }
  }),
)
