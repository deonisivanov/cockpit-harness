import { NodeContext } from "@effect/platform-node"
import { SqlClient } from "@effect/sql"
import { ConfigProvider, Effect, Layer, Scope, Stream } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { afterAll } from "vitest"
import {
  ArtifactStore,
  CheckpointService,
  ClaudeCodeProvider,
  ClaudeCodeProviderLive,
  CodexProvider,
  CodexProviderLive,
  CommandRunner,
  DaemonLockLive,
  EngineLive,
  EventBus,
  EventPayload,
  EventSeq,
  Journal,
  KernelLive,
  ProcessSupervisor,
  ProcessSupervisorLive,
  RetryCoordinator,
  RunId,
  WorkflowEngine,
  WorkspaceManager,
} from "../src/index.js"

const created: string[] = []
afterAll(() => Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true }))))

export const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(NodePath.join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

export const tempHome = () => tempDir("cockpit-home-")

export type Settings = Readonly<Record<string, string>>

const settingsLayer = (settings: Settings) =>
  Layer.setConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(settings))))

const configuredHome = (home: string, settings: Settings = {}) =>
  settingsLayer({ COCKPIT_HOME: home, ...settings })

export const kernelLayer = (home: string, settings: Settings = {}) =>
  KernelLive.pipe(Layer.provide(NodeContext.layer), Layer.provide(configuredHome(home, settings)))

export const lockLayer = (home: string) =>
  DaemonLockLive.pipe(Layer.provide(configuredHome(home)))

/** Providers and the supervisor need no journal, so their tests skip the database entirely. */
export const providerLayer = (settings: Settings = {}) =>
  Layer.mergeAll(ClaudeCodeProviderLive, CodexProviderLive).pipe(
    Layer.provideMerge(ProcessSupervisorLive),
    Layer.provide(NodeContext.layer),
    Layer.provide(settingsLayer(settings)),
  )

export type KernelContext =
  | Journal
  | SqlClient.SqlClient
  | EventBus
  | WorkspaceManager
  | CheckpointService
  | CommandRunner
  | Scope.Scope

export type ProviderContext = ProcessSupervisor | ClaudeCodeProvider | CodexProvider | Scope.Scope

export const runKernel = <A, E>(
  home: string,
  body: Effect.Effect<A, E, KernelContext>,
  settings: Settings = {},
) => Effect.runPromise(Effect.scoped(Effect.provide(body, kernelLayer(home, settings))))

export const runProviders = <A, E>(
  body: Effect.Effect<A, E, ProviderContext>,
  settings: Settings = {},
) => Effect.runPromise(Effect.scoped(Effect.provide(body, providerLayer(settings))))

export const fixturePath = (name: string) => NodePath.join(import.meta.dirname, name)

export const node = (script: string) =>
  [process.execPath, "-e", script] as const satisfies readonly [string, ...ReadonlyArray<string>]

export const withKernel = async <A, E>(body: Effect.Effect<A, E, KernelContext>) =>
  runKernel(await tempHome(), body)

export type EngineContext =
  | KernelContext
  | ArtifactStore
  | RetryCoordinator
  | WorkflowEngine

export const engineLayer = (home: string, settings: Settings = {}) =>
  EngineLive.pipe(Layer.provide(NodeContext.layer), Layer.provide(configuredHome(home, settings)))

export const runEngine = <A, E>(
  home: string,
  body: Effect.Effect<A, E, EngineContext>,
  settings: Settings = {},
) => Effect.runPromise(Effect.scoped(Effect.provide(body, engineLayer(home, settings))))

// Cockpit spawns git with the parent environment, so blanking these is what keeps a developer's
// own git config out of the fixtures.
process.env.GIT_CONFIG_GLOBAL = "/dev/null"
process.env.GIT_CONFIG_SYSTEM = "/dev/null"

export const makeRepo = async () => {
  const repoPath = await tempDir("cockpit-repo-")
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" })
  git("init", "-b", "main")
  git("config", "user.email", "fixture@example.com")
  git("config", "user.name", "Fixture")
  await writeFile(NodePath.join(repoPath, "app.txt"), "base\n")
  git("add", "-A")
  git("commit", "-m", "base")
  return { repoPath, baseCommit: git("rev-parse", "HEAD").trim() }
}

export const readEvents = (runId: RunId, limit?: number) =>
  Effect.flatMap(Journal, (journal) =>
    Stream.runCollect(journal.eventsFrom(runId, EventSeq.make(0), limit)),
  ).pipe(Effect.map((chunk) => Array.from(chunk)))

export const payloads = (events: ReadonlyArray<{ payload: EventPayload }>) =>
  events.map((event) => event.payload._tag)
