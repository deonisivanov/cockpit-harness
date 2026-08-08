import { SqlClient } from "@effect/sql"
import { Effect, Exit } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import * as NodePath from "node:path"
import { expect, it } from "vitest"
import {
  CheckpointId,
  CheckpointService,
  Journal,
  RunId,
  Workspace,
  WorkspaceManager,
} from "../src/index.js"
import { KernelContext, payloads, readEvents, runKernel, tempDir, tempHome } from "./helpers.js"

// Cockpit spawns git with the parent environment, so blanking these here is what makes every
// repo in this file identity-less: a checkpoint commit has to carry a name and email of its own.
process.env.GIT_CONFIG_GLOBAL = "/dev/null"
process.env.GIT_CONFIG_SYSTEM = "/dev/null"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

const makeRepo = async () => {
  const repoPath = await tempDir("cockpit-repo-")
  git(repoPath, "init", "-b", "main")
  // Without this git invents an identity from username@hostname and every commit passes anyway.
  git(repoPath, "config", "user.useConfigOnly", "true")
  await writeFile(NodePath.join(repoPath, "app.txt"), "base\n")
  git(repoPath, "add", "-A")
  git(
    repoPath,
    "-c",
    "user.email=fixture@example.com",
    "-c",
    "user.name=Fixture",
    "commit",
    "-m",
    "base",
  )
  const baseCommit = git(repoPath, "rev-parse", "HEAD")

  // Only now, so the fixture's own commit stays simple: a checkpoint must survive a repo that
  // signs commits (gpg would block on a GUI prompt) and rejects them in a pre-commit hook.
  git(repoPath, "config", "commit.gpgsign", "true")
  git(repoPath, "config", "gpg.program", "/usr/bin/false")
  const hook = NodePath.join(repoPath, ".git", "hooks", "pre-commit")
  await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 })

  return { repoPath, baseCommit }
}

const runId = RunId.make("run-ws")

type Repo = { repoPath: string; baseCommit: string }

const withRepo = async <A, E>(
  body: (repo: Repo) => Effect.Effect<A, E, KernelContext>,
) => {
  const home = await tempHome()
  return runKernel(home, body(await makeRepo()))
}

/** Mirrors the engine's order: the run is live in the journal before its worktree exists. */
const createWorkspace = (repo: Repo) =>
  Effect.gen(function* () {
    const journal = yield* Journal
    yield* journal.createRun({ runId, projectId: "proj", prompt: "x" })
    yield* journal.startRun(runId)
    const manager = yield* WorkspaceManager
    return yield* manager.create({
      projectId: "proj",
      repoPath: repo.repoPath,
      baseCommit: repo.baseCommit,
      runId,
    })
  })

it("creates a worktree on its own branch pinned to the base commit", async () => {
  const workspace = await withRepo(createWorkspace)

  expect(workspace.branch).toBe(`cockpit/run-${runId}`)
  expect(workspace.path).toContain(NodePath.join("worktrees", "proj", runId))
  expect(existsSync(workspace.path)).toBe(true)
  expect(git(workspace.path, "rev-parse", "HEAD")).toBe(workspace.baseCommit)
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(workspace.branch)
  expect(await readFile(NodePath.join(workspace.path, "app.txt"), "utf8")).toBe("base\n")
})

it("resolves a symbolic base commit to a concrete sha", async () => {
  await withRepo((repo) =>
    Effect.flatMap(WorkspaceManager, (manager) =>
      manager.create({ projectId: "proj", repoPath: repo.repoPath, baseCommit: "main", runId }),
    ).pipe(Effect.map((created) => expect(created.baseCommit).toBe(repo.baseCommit))),
  )
})

it("fails to create a worktree when the path is not a git repository", async () => {
  const notARepo = await tempDir("cockpit-plain-")
  const exit = await withRepo(() =>
    Effect.flatMap(WorkspaceManager, (manager) =>
      Effect.exit(
        manager.create({
          projectId: "proj",
          repoPath: notARepo,
          baseCommit: "HEAD",
          runId,
        }),
      ),
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("WorkspaceError")
})

it("fails to create a worktree when the base commit does not resolve", async () => {
  const exit = await withRepo((repo) =>
    Effect.flatMap(WorkspaceManager, (manager) =>
      Effect.exit(
        manager.create({
          projectId: "proj",
          repoPath: repo.repoPath,
          baseCommit: "0000000000000000000000000000000000000000",
          runId,
        }),
      ),
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
})

it("refuses an identifier whose worktree path escapes the worktree root", async () => {
  const exit = await withRepo((repo) =>
    Effect.flatMap(WorkspaceManager, (manager) =>
      Effect.exit(
        manager.create({
          projectId: "../../escaped",
          repoPath: repo.repoPath,
          baseCommit: repo.baseCommit,
          runId,
        }),
      ),
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("escapes")
})

it("reconciles a freshly created worktree", async () => {
  const exit = await withRepo((repo) =>
    Effect.gen(function* () {
      const manager = yield* WorkspaceManager
      const workspace = yield* createWorkspace(repo)
      return yield* Effect.exit(manager.reconcile(workspace))
    }),
  )
  expect(Exit.isSuccess(exit)).toBe(true)
})

it("reconcile fails when the worktree has uncommitted changes", async () => {
  const exit = await withRepo((repo) =>
    Effect.gen(function* () {
      const manager = yield* WorkspaceManager
      const workspace = yield* createWorkspace(repo)
      yield* Effect.promise(() =>
        writeFile(NodePath.join(workspace.path, "app.txt"), "dirty\n"),
      )
      return yield* Effect.exit(manager.reconcile(workspace))
    }),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("is dirty")
})

it("reconcile fails when the worktree directory is gone", async () => {
  const exit = await withRepo((repo) =>
    Effect.gen(function* () {
      const manager = yield* WorkspaceManager
      const workspace = yield* createWorkspace(repo)
      yield* Effect.promise(() => rm(workspace.path, { recursive: true, force: true }))
      return yield* Effect.exit(manager.reconcile(workspace))
    }),
  )
  expect(Exit.isFailure(exit)).toBe(true)
})

it("reconcile fails when the base commit is no longer resolvable", async () => {
  const exit = await withRepo((repo) =>
    Effect.gen(function* () {
      const manager = yield* WorkspaceManager
      const workspace = yield* createWorkspace(repo)
      const orphaned: Workspace = { ...workspace, baseCommit: "f".repeat(40) }
      return yield* Effect.exit(manager.reconcile(orphaned))
    }),
  )
  expect(Exit.isFailure(exit)).toBe(true)
})

it("removes a worktree", async () => {
  const path = await withRepo((repo) =>
    Effect.gen(function* () {
      const manager = yield* WorkspaceManager
      const workspace = yield* createWorkspace(repo)
      yield* manager.remove(workspace)
      return workspace.path
    }),
  )
  expect(existsSync(path)).toBe(false)
})

it("commits a checkpoint, journals it, and leaves the worktree clean", async () => {
  const result = await withRepo((repo) =>
    Effect.gen(function* () {
      const checkpoints = yield* CheckpointService
      const sql = yield* SqlClient.SqlClient
      const workspace = yield* createWorkspace(repo)
      yield* Effect.promise(() =>
        writeFile(NodePath.join(workspace.path, "app.txt"), "changed\n"),
      )
      const sha = yield* checkpoints.checkpoint(workspace, {
        kind: "success",
        message: "block one done",
      })

      const rows = yield* sql<{ id: string; kind: string }>`
        SELECT id, kind FROM checkpoints WHERE run_id = ${runId}`
      return { events: yield* readEvents(runId), rows, sha, workspace }
    }),
  )

  expect(result.sha).toBe(git(result.workspace.path, "rev-parse", "HEAD"))
  expect(git(result.workspace.path, "status", "--porcelain")).toBe("")
  expect(result.rows).toEqual([{ id: result.sha, kind: "success" }])
  expect(payloads(result.events)).toEqual([
    "RunCreated",
    "RunStarted",
    "CheckpointCreated",
  ])
  expect(result.events[2].payload).toMatchObject({ checkpointId: result.sha, kind: "success" })
})

it("checkpoints an unchanged worktree so the chain stays unbroken", async () => {
  const shas = await withRepo((repo) =>
    Effect.gen(function* () {
      const checkpoints = yield* CheckpointService
      const workspace = yield* createWorkspace(repo)
      const first = yield* checkpoints.checkpoint(workspace, { kind: "salvage", message: "empty" })
      const second = yield* checkpoints.checkpoint(workspace, {
        kind: "salvage",
        message: "still empty",
      })
      return { first, second, base: workspace.baseCommit }
    }),
  )

  expect(shas.first).not.toBe(shas.base)
  expect(shas.second).not.toBe(shas.first)
})

it("rolls the worktree back to an earlier checkpoint", async () => {
  const result = await withRepo((repo) =>
    Effect.gen(function* () {
      const checkpoints = yield* CheckpointService
      const workspace = yield* createWorkspace(repo)
      const file = NodePath.join(workspace.path, "app.txt")

      yield* Effect.promise(() => writeFile(file, "first\n"))
      const first = yield* checkpoints.checkpoint(workspace, { kind: "success", message: "first" })
      yield* Effect.promise(() => writeFile(file, "second\n"))
      yield* checkpoints.checkpoint(workspace, { kind: "success", message: "second" })

      yield* checkpoints.rollbackTo(workspace, first)
      return { content: yield* Effect.promise(() => readFile(file, "utf8")), first, workspace }
    }),
  )

  expect(result.content).toBe("first\n")
  expect(git(result.workspace.path, "rev-parse", "HEAD")).toBe(result.first)
})

it("fails to roll back to an unknown checkpoint", async () => {
  const exit = await withRepo((repo) =>
    Effect.gen(function* () {
      const checkpoints = yield* CheckpointService
      const workspace = yield* createWorkspace(repo)
      return yield* Effect.exit(
        checkpoints.rollbackTo(workspace, CheckpointId.make("f".repeat(40))),
      )
    }),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("WorkspaceError")
})

it("refuses to roll back onto another run's checkpoint", async () => {
  const exit = await withRepo((repo) =>
    Effect.gen(function* () {
      const journal = yield* Journal
      const checkpoints = yield* CheckpointService
      const workspace = yield* createWorkspace(repo)
      const stranger = RunId.make("run-other")
      yield* journal.createRun({ runId: stranger, projectId: "proj", prompt: "x" })
      yield* journal.startRun(stranger)
      // A real commit in this worktree, but journalled under a run that does not own it.
      const theirs = yield* checkpoints.checkpoint(
        { ...workspace, runId: stranger },
        { kind: "success", message: "theirs" },
      )
      return yield* Effect.exit(checkpoints.rollbackTo(workspace, theirs))
    }),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("does not belong to run")
})

it("undoes the checkpoint commit when the journal refuses to record it", async () => {
  const result = await withRepo((repo) =>
    Effect.gen(function* () {
      const journal = yield* Journal
      const checkpoints = yield* CheckpointService
      const manager = yield* WorkspaceManager
      // Created but never started, which is the one state recordCheckpoint rejects.
      yield* journal.createRun({ runId, projectId: "proj", prompt: "x" })
      const workspace = yield* manager.create({
        projectId: "proj",
        repoPath: repo.repoPath,
        baseCommit: repo.baseCommit,
        runId,
      })
      yield* Effect.promise(() =>
        writeFile(NodePath.join(workspace.path, "app.txt"), "changed\n"),
      )
      const exit = yield* Effect.exit(
        checkpoints.checkpoint(workspace, { kind: "success", message: "doomed" }),
      )
      return { exit, workspace }
    }),
  )

  expect(Exit.isFailure(result.exit)).toBe(true)
  expect(git(result.workspace.path, "rev-parse", "HEAD")).toBe(result.workspace.baseCommit)
  expect(git(result.workspace.path, "status", "--porcelain")).toBe("")
})

it("resolves a repository root and labels a non-repository as a resolve failure", async () => {
  const repo = await makeRepo()
  const outside = await tempDir("cockpit-plain-")

  const result = await runKernel(
    await tempHome(),
    Effect.gen(function* () {
      const manager = yield* WorkspaceManager
      return {
        // A path inside the repo still answers with the root a worktree can branch from.
        nested: yield* Effect.either(manager.resolveRepo(repo.repoPath)),
        plain: yield* Effect.either(manager.resolveRepo(outside)),
      }
    }),
  )

  expect(result.nested).toMatchObject({ _tag: "Right" })
  expect(result.plain).toMatchObject({ _tag: "Left", left: { op: "resolve" } })
})

/** Two blocks' worth of successful work, plus what a failed attempt left behind. */
const withCheckpoints = (repo: Repo) =>
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointService
    const workspace = yield* createWorkspace(repo)
    const write = (name: string, body: string) =>
      Effect.promise(() => writeFile(NodePath.join(workspace.path, name), body))

    // The engine opens every run with one of these, and blocks that touch no file add more.
    yield* checkpoints.checkpoint(workspace, { kind: "success", message: "cockpit: baseline" })
    yield* write("one.txt", "one\n")
    yield* checkpoints.checkpoint(workspace, { kind: "success", message: "cockpit: one" })
    yield* write("two.txt", "two\n")
    yield* checkpoints.checkpoint(workspace, { kind: "success", message: "cockpit: two" })
    yield* write("scratch.txt", "abandoned\n")
    yield* checkpoints.checkpoint(workspace, { kind: "salvage", message: "cockpit: salvage" })
    return workspace
  })

const has = (repoPath: string, name: string) => existsSync(NodePath.join(repoPath, name))

it("squashes the run's successful checkpoints onto the target branch, leaving the salvage behind", async () => {
  const result = await withRepo((repo) =>
    Effect.gen(function* () {
      const checkpoints = yield* CheckpointService
      const workspace = yield* withCheckpoints(repo)
      // Plan §17: nothing reaches the user's checkout while the run is still working.
      const before = {
        head: git(repo.repoPath, "rev-parse", "HEAD"),
        carriesWork: has(repo.repoPath, "one.txt"),
      }
      const landed = yield* checkpoints.finalize(workspace, {
        targetBranch: workspace.targetBranch,
        mode: "squash",
      })
      return { ...landed, before, events: payloads(yield* readEvents(runId)), repo, workspace }
    }),
  )

  const { repoPath } = result.repo
  expect(result.workspace.targetBranch).toBe("main")
  expect(result.before).toEqual({ head: result.repo.baseCommit, carriesWork: false })

  expect(result.commits).toBe(1)
  expect(git(repoPath, "rev-parse", "main")).toBe(result.commit)
  expect(git(repoPath, "rev-parse", "main^")).toBe(result.repo.baseCommit)
  expect(git(repoPath, "log", "--format=%s", `${result.repo.baseCommit}..main`)).toBe(
    `cockpit: run ${runId}`,
  )

  // Both successes' content arrived; the salvage did not, and the checkout was fast-forwarded to
  // match rather than left showing the new files as deleted.
  expect(has(repoPath, "one.txt")).toBe(true)
  expect(has(repoPath, "two.txt")).toBe(true)
  expect(has(repoPath, "scratch.txt")).toBe(false)
  expect(git(repoPath, "status", "--porcelain")).toBe("")
  expect(result.events).toContain("RunFinalized")
})

it("replays each successful checkpoint in order when the mode is ordered", async () => {
  const result = await withRepo((repo) =>
    Effect.gen(function* () {
      const checkpoints = yield* CheckpointService
      const workspace = yield* withCheckpoints(repo)
      const landed = yield* checkpoints.finalize(workspace, {
        targetBranch: workspace.targetBranch,
        mode: "ordered",
      })
      return { ...landed, repo }
    }),
  )

  const { repoPath, baseCommit } = result.repo
  // Three success checkpoints in, two commits out: the empty one changed no tree to replay.
  expect(result.commits).toBe(2)
  expect(git(repoPath, "rev-parse", "main^^")).toBe(baseCommit)
  // Newest first, and each keeps the message its checkpoint was made under.
  expect(git(repoPath, "log", "--format=%s", `${baseCommit}..main`).split("\n")).toEqual([
    "cockpit: two",
    "cockpit: one",
  ])
  expect(has(repoPath, "scratch.txt")).toBe(false)
})

it("refuses to finalize onto a branch whose checkout has uncommitted changes", async () => {
  const result = await withRepo((repo) =>
    Effect.gen(function* () {
      const checkpoints = yield* CheckpointService
      const workspace = yield* withCheckpoints(repo)
      yield* Effect.promise(() =>
        writeFile(NodePath.join(repo.repoPath, "app.txt"), "the user was mid-edit\n"),
      )
      const refused = yield* Effect.either(
        checkpoints.finalize(workspace, { targetBranch: workspace.targetBranch, mode: "squash" }),
      )
      return { refused, repo }
    }),
  )

  const { repoPath, baseCommit } = result.repo
  expect(result.refused).toMatchObject({ _tag: "Left", left: { op: "finalize" } })
  expect(String(result.refused)).toContain("uncommitted changes")
  // The branch never moved and the edit is exactly where the user left it.
  expect(git(repoPath, "rev-parse", "main")).toBe(baseCommit)
  expect(await readFile(NodePath.join(repoPath, "app.txt"), "utf8")).toBe("the user was mid-edit\n")
  expect(has(repoPath, "one.txt")).toBe(false)
})

it("refuses a second finalize of the same run rather than replaying it onto its own result", async () => {
  const result = await withRepo((repo) =>
    Effect.gen(function* () {
      const checkpoints = yield* CheckpointService
      const workspace = yield* withCheckpoints(repo)
      const target = { targetBranch: workspace.targetBranch, mode: "squash" } as const
      const first = yield* checkpoints.finalize(workspace, target)
      const second = yield* Effect.either(checkpoints.finalize(workspace, target))
      return { first, second, repo }
    }),
  )

  const { repoPath, baseCommit } = result.repo
  expect(result.second).toMatchObject({ _tag: "Left", left: { op: "finalize" } })
  expect(git(repoPath, "rev-parse", "main")).toBe(result.first.commit)
  expect(git(repoPath, "rev-list", "--count", `${baseCommit}..main`)).toBe("1")
})

it("refuses to finalize a run that started from a detached checkout", async () => {
  const refused = await withRepo((repo) =>
    Effect.gen(function* () {
      const checkpoints = yield* CheckpointService
      const workspace = yield* withCheckpoints(repo)
      return yield* Effect.either(
        checkpoints.finalize(workspace, { targetBranch: "HEAD", mode: "squash" }),
      )
    }),
  )

  expect(refused).toMatchObject({ _tag: "Left", left: { op: "finalize" } })
  expect(String(refused)).toContain("detached")
})

it("leaves the branch alone when the run changed no file, without calling it a failure", async () => {
  const result = await withRepo((repo) =>
    Effect.gen(function* () {
      const checkpoints = yield* CheckpointService
      const workspace = yield* createWorkspace(repo)
      yield* checkpoints.checkpoint(workspace, { kind: "success", message: "cockpit: baseline" })
      const landed = yield* checkpoints.finalize(workspace, {
        targetBranch: workspace.targetBranch,
        mode: "squash",
      })
      return { landed, repo, events: yield* readEvents(runId) }
    }),
  )

  expect(result.landed).toEqual({ commit: result.repo.baseCommit, commits: 0 })
  expect(git(result.repo.repoPath, "rev-parse", "main")).toBe(result.repo.baseCommit)
  // Recorded even though nothing moved: "finalize ran and found nothing" is the answer.
  expect(result.events.filter((event) => event.payload._tag === "RunFinalized")).toMatchObject([
    { payload: { commits: 0 } },
  ])
})

/** Commits in the fixture repo have to dodge its signing config and its failing pre-commit hook. */
const commit = (repoPath: string, message: string) =>
  git(repoPath, "-c", "commit.gpgsign=false", "-c", "user.email=f@example.com", "-c", "user.name=F",
      "commit", "--no-verify", "-a", "-m", message)

it("refuses to finalize while the repository has an operation in progress", async () => {
  const result = await withRepo((repo) =>
    Effect.gen(function* () {
      const checkpoints = yield* CheckpointService
      const workspace = yield* withCheckpoints(repo)
      // A conflicting rebase between two side branches: main never moves, so the only thing
      // wrong with the repository is the sequencer left mid-flight.
      yield* Effect.promise(async () => {
        git(repo.repoPath, "checkout", "-q", "-b", "a", repo.baseCommit)
        await writeFile(NodePath.join(repo.repoPath, "app.txt"), "a\n")
        commit(repo.repoPath, "a")
        git(repo.repoPath, "checkout", "-q", "-b", "b", repo.baseCommit)
        await writeFile(NodePath.join(repo.repoPath, "app.txt"), "b\n")
        commit(repo.repoPath, "b")
        try {
          git(repo.repoPath, "-c", "commit.gpgsign=false", "rebase", "a", "b")
        } catch {
          // The conflict is the point; git exits non-zero and leaves the rebase state behind.
        }
      })
      const refused = yield* Effect.either(
        checkpoints.finalize(workspace, { targetBranch: workspace.targetBranch, mode: "squash" }),
      )
      return { refused, repo }
    }),
  )

  expect(result.refused).toMatchObject({ _tag: "Left", left: { op: "finalize" } })
  expect(String(result.refused)).toContain("operation in progress")
  expect(String(result.refused)).toMatch(/rebase-(merge|apply)/)
  expect(git(result.repo.repoPath, "rev-parse", "main")).toBe(result.repo.baseCommit)
})

it("refuses to finalize onto a branch another worktree has checked out", async () => {
  const elsewhere = await tempDir("cockpit-other-")
  const result = await withRepo((repo) =>
    Effect.gen(function* () {
      const checkpoints = yield* CheckpointService
      const workspace = yield* withCheckpoints(repo)
      // main is freed here and taken there, so finalize would move it under a checkout it
      // knows nothing about.
      const held = NodePath.join(elsewhere, "wt")
      git(repo.repoPath, "checkout", "-q", "-b", "parking")
      git(repo.repoPath, "worktree", "add", "-q", held, "main")
      const refused = yield* Effect.either(
        checkpoints.finalize(workspace, { targetBranch: workspace.targetBranch, mode: "squash" }),
      )
      return { refused, repo, held }
    }),
  )

  expect(result.refused).toMatchObject({ _tag: "Left", left: { op: "finalize" } })
  expect(String(result.refused)).toContain("another worktree")
  expect(git(result.repo.repoPath, "rev-parse", "main")).toBe(result.repo.baseCommit)
})

it("refuses to finalize a run recorded before the target branch was tracked", async () => {
  const refused = await withRepo((repo) =>
    Effect.gen(function* () {
      const checkpoints = yield* CheckpointService
      const workspace = yield* withCheckpoints(repo)
      return yield* Effect.either(
        checkpoints.finalize(workspace, { targetBranch: undefined, mode: "squash" }),
      )
    }),
  )

  expect(refused).toMatchObject({ _tag: "Left", left: { op: "finalize" } })
  expect(String(refused)).toContain("predates target-branch tracking")
})
