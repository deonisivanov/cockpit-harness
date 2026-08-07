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
