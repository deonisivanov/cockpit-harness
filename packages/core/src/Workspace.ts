import { Command, CommandExecutor } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Context, Effect, Layer, Stream } from "effect"
import { existsSync, realpathSync } from "node:fs"
import * as NodePath from "node:path"
import { cockpitHome } from "./config.js"
import { JournalError, WorkspaceError } from "./errors.js"
import { CheckpointKind, FinalizeMode, lastOf } from "./events.js"
import { AttemptId, BlockId, CheckpointId, RunId } from "./ids.js"
import { allEvents, Journal } from "./Journal.js"

export interface Workspace {
  readonly projectId: string
  readonly runId: RunId
  readonly repoPath: string
  readonly path: string
  readonly branch: string
  readonly baseCommit: string
  /**
   * The branch the user's checkout was on: `HEAD` when it was detached, and undefined for a run
   * recorded before the column existed. Finalize refuses each with its own reason.
   */
  readonly targetBranch: string | undefined
}

export interface FinalizeInput {
  readonly targetBranch: string | undefined
  readonly mode: FinalizeMode
}

export interface FinalizeResult {
  readonly commit: string
  readonly commits: number
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
    /**
     * Puts a run's worktree back at the path it was recorded under, for a terminal handoff that
     * finds it gone (plan §10). Detached, not on the run's branch: the branch may carry salvage
     * tags a reset would strand (plan §9), and nothing about reading the work needs to be on it.
     */
    readonly restore: (input: {
      readonly projectId: string
      readonly repoPath: string
      readonly runId: RunId
      readonly branch: string
      readonly targetBranch: string | undefined
      readonly commit: string
    }) => Effect.Effect<Workspace, WorkspaceError>
    readonly reconcile: (workspace: Workspace) => Effect.Effect<void, WorkspaceError>
    readonly remove: (workspace: Workspace) => Effect.Effect<void, WorkspaceError>
    /** The repository root a path belongs to; fails when it is not one, which registration needs. */
    readonly resolveRepo: (repoPath: string) => Effect.Effect<string, WorkspaceError>
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

    /** `HEAD` when the checkout is detached, which finalize refuses rather than guessing at. */
    const currentBranch = (op: WorkspaceOp, repoPath: string) =>
      git(op, repoPath, "rev-parse", "--abbrev-ref", "HEAD")

    return {
      create: (input) =>
        Effect.gen(function* () {
          const baseCommit = yield* resolveCommit("create", input.repoPath, input.baseCommit)
          const path = NodePath.resolve(root, input.projectId, input.runId)
          yield* requireInsideRoot("create", path)
          const branch = `cockpit/run-${input.runId}`
          // Read before the worktree exists: `worktree add` does not move the checkout, but the
          // branch finalize lands on is the one the run started from, not the one it ends on.
          const targetBranch = yield* currentBranch("create", input.repoPath)
          yield* git("create", input.repoPath, "worktree", "add", "-b", branch, path, baseCommit)
          return { ...input, baseCommit, path, branch, targetBranch }
        }),

      restore: (input) =>
        Effect.gen(function* () {
          const baseCommit = yield* resolveCommit("create", input.repoPath, input.commit)
          const path = NodePath.resolve(root, input.projectId, input.runId)
          yield* requireInsideRoot("create", path)
          // A directory deleted rather than removed leaves its registration behind, and git
          // refuses to add a path it still believes is checked out.
          yield* git("create", input.repoPath, "worktree", "prune")
          yield* git("create", input.repoPath, "worktree", "add", "--detach", path, baseCommit)
          return {
            projectId: input.projectId,
            runId: input.runId,
            repoPath: input.repoPath,
            path,
            branch: input.branch,
            targetBranch: input.targetBranch,
            baseCommit,
          }
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

      resolveRepo: (repoPath) => git("resolve", repoPath, "rev-parse", "--show-toplevel"),

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
    /**
     * Paths a block or attempt has touched since the last checkpoint; empty means it changed
     * nothing. With `since`, the whole run's work instead: everything the worktree holds that the
     * given commit did not, committed checkpoints included.
     */
    readonly changedFiles: (
      workspace: Workspace,
      since?: string,
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
    /**
     * Turns the run's success checkpoints into a clean result on the target branch (plan §9).
     * Salvage commits are left behind: they record what a failed attempt was holding, which is
     * evidence for the run, not something the branch should carry.
     *
     * Each new commit reuses a checkpoint's tree wholesale, so nothing is ever checked out to
     * build one and no merge can conflict. The branch then moves by compare-and-swap; when it is
     * the checked-out one, the working tree is carried to it as well — plan §9 keeps the user's
     * copy untouched *until* finalize, not through it. The cost of taking trees wholesale is that
     * the branch must not have moved since the run pinned its base, and finalize refuses rather
     * than reverting whoever moved it. It also refuses a repository mid-operation, a branch held
     * by another worktree, and a checkout with uncommitted work.
     */
    readonly finalize: (
      workspace: Workspace,
      input: FinalizeInput,
    ) => Effect.Effect<FinalizeResult, WorkspaceError | JournalError>
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

    /**
     * Everything the worktree holds that `since` did not. The diff covers tracked work, committed
     * or not; the second list adds files git has never seen, which is all a run that died before
     * its first checkpoint has to show for itself.
     */
    const changedSince = (workspace: Workspace, since: string) =>
      Effect.map(
        Effect.all([
          git("checkpoint", workspace.path, "diff", "--name-only", "-z", since, "--"),
          git("checkpoint", workspace.path, "ls-files", "--others", "--exclude-standard", "-z"),
        ]),
        (outputs) =>
          [...new Set(outputs.flatMap((out) => out.split("\0")))].filter((path) => path !== ""),
      )

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
          // Named after the commit, not the attempt: re-entry salvages whatever the worktree
          // holds under the attempt the interruption left open, which can happen more than once
          // for the same attempt, and a tag that already exists would fail the whole re-entry.
          // The attempt it belonged to is on the checkpoint row, which is where that link lives.
          yield* git("checkpoint", workspace.path, "tag", `cockpit/salvage/${sha}`, sha)
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

      changedFiles: (workspace, since) =>
        (since === undefined ? changed(workspace) : changedSince(workspace, since)).pipe(
          gitLock.withPermits(1),
        ),

      finalize: (workspace, input) =>
        Effect.gen(function* () {
          const refuse = (detail: string) => new WorkspaceError({ op: "finalize", detail })
          const repo = workspace.repoPath
          const target = input.targetBranch
          if (target === undefined) {
            return yield* refuse(
              `run ${workspace.runId} predates target-branch tracking, so the branch it started from is unknown; finalize it by hand from ${workspace.branch}`,
            )
          }
          if (target === "HEAD") {
            return yield* refuse(
              `run ${workspace.runId} started from a detached checkout, so there is no branch to finalize onto`,
            )
          }

          // A repository mid-rebase, mid-merge, mid-cherry-pick or mid-bisect has a sequencer
          // holding state about where HEAD is going; moving a branch under it corrupts the
          // operation the user is halfway through.
          const markers = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "BISECT_LOG"]
          const paths = yield* git(
            "finalize",
            repo,
            "rev-parse",
            ...markers.flatMap((marker) => ["--git-path", marker]),
          )
          const inProgress = paths
            .split("\n")
            .flatMap((path, at) =>
              existsSync(NodePath.resolve(repo, path.trim())) ? [markers[at]] : [],
            )
          if (inProgress.length > 0) {
            return yield* refuse(
              `${repo} has an operation in progress (${inProgress.join(", ")}); finish or abort it before finalizing`,
            )
          }

          const ref = `refs/heads/${target}`
          const tip = yield* git("finalize", repo, "rev-parse", "--verify", `${ref}^{commit}`)
          // Each finalized commit carries a checkpoint's whole tree, so a branch that moved on
          // since the run pinned its base would have that newer work reverted by the replay.
          if (tip !== workspace.baseCommit) {
            // Unless this run is what moved it: a daemon killed between the branch move and the
            // block's own record of it re-enters here, and the tip is the commit it already
            // landed. The RunFinalized that says so is durable, so the answer is that result
            // rather than a refusal — and the branch is not moved a second time.
            const landed = lastOf(yield* allEvents(journal, workspace.runId), "RunFinalized")
            if (landed?.commit === tip) return { commit: landed.commit, commits: landed.commits }
            return yield* refuse(
              `${target} is at ${tip}, not the ${workspace.baseCommit} this run branched from; rebase the run or start a new one rather than overwrite it`,
            )
          }

          // The main checkout is the one finalize knows how to carry along. Any other worktree
          // holding the branch would be left pointing at a commit its files never saw.
          const held = (yield* git("finalize", repo, "worktree", "list", "--porcelain"))
            .split("\n\n")
            .flatMap((record) => {
              const path = /^worktree (.+)$/m.exec(record)?.[1]
              return path !== undefined && record.includes(`\nbranch ${ref}`) ? [path] : []
            })
            .filter((path) => realpathSync(path) !== realpathSync(repo))
          if (held.length > 0) {
            return yield* refuse(
              `${target} is checked out in another worktree (${held.join(", ")}); finalize would move it out from under that checkout`,
            )
          }

          // A checked-out target is carried along rather than having its ref moved underneath it,
          // so ref, index and working tree arrive together. That needs a clean tree: git would
          // refuse to overwrite uncommitted work, and this says so before any commit is built.
          const head = yield* git("finalize", repo, "rev-parse", "--abbrev-ref", "HEAD")
          const checkedOut = head === target
          if (checkedOut) {
            const dirty = yield* git("finalize", repo, "status", "--porcelain")
            if (dirty !== "") {
              return yield* refuse(
                `${target} is checked out with uncommitted changes; commit or stash them before finalizing`,
              )
            }
          }

          const rows = yield* sql<{ id: string }>`
            SELECT id FROM checkpoints
            WHERE run_id = ${workspace.runId} AND kind = ${"success"}
            ORDER BY rowid`.pipe(
            Effect.mapError((cause) =>
              refuse(`reading the checkpoints of run ${workspace.runId}: ${cause.message}`),
            ),
          )
          const chain = input.mode === "squash" ? rows.slice(-1) : rows
          let parent = tip
          let landed = 0
          for (const row of chain) {
            const tree = yield* git("finalize", repo, "rev-parse", `${row.id}^{tree}`)
            // Checkpoints are taken with --allow-empty, and every run opens with a baseline one.
            // Replaying those would put commits that change nothing on the user's branch.
            if (tree === (yield* git("finalize", repo, "rev-parse", `${parent}^{tree}`))) continue
            const message =
              input.mode === "squash"
                ? `cockpit: run ${workspace.runId}`
                : yield* git("finalize", repo, "log", "-1", "--format=%B", row.id)
            parent = yield* git(
              "finalize",
              repo,
              "-c",
              "commit.gpgsign=false",
              "-c",
              "user.name=Cockpit",
              "-c",
              "user.email=cockpit@localhost",
              "commit-tree",
              tree,
              "-p",
              parent,
              "-m",
              message,
            )
            landed += 1
          }
          // On the checked-out branch `reset` is what moves ref, index and working tree together —
          // moving the ref first would leave reset with nothing to do, since HEAD follows the
          // branch. `--keep` makes git refuse rather than clobber an edit that landed in the
          // window, and it is chosen over `merge --ff-only` because that fires the repository's
          // post-merge hook for a merge the user never asked for.
          // ponytail: no compare-and-swap on that path; the tip was read under this same git lock.
          // Swap in a plumbing sequence if runs ever share a repository with another writer.
          const moveTo = (to: string, from: string) =>
            checkedOut
              ? git("finalize", repo, "reset", "--keep", to)
              : git("finalize", repo, "update-ref", ref, to, from)

          // A run that changed no file lands nothing, which is an outcome rather than a failure:
          // the branch stays where it is and the journal still records that finalize ran.
          if (landed > 0) yield* moveTo(parent, tip)
          yield* journal
            .append({
              runId: workspace.runId,
              payload: {
                _tag: "RunFinalized",
                targetBranch: target,
                mode: input.mode,
                commit: parent,
                commits: landed,
                previousTip: tip,
              },
            })
            // A branch moved without the record explaining why is the one outcome worse than not
            // finalizing at all.
            .pipe(
              Effect.onError(() =>
                landed === 0 ? Effect.void : Effect.ignore(moveTo(tip, parent)),
              ),
            )
          return { commit: parent, commits: landed }
        }).pipe(gitLock.withPermits(1)),
    }
  }),
)
