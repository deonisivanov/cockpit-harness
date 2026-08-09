import { HttpClient, HttpClientRequest, HttpServer } from "@effect/platform"
import { NodeContext, NodeHttpServer } from "@effect/platform-node"
import { createServer } from "node:http"
import { JournalEvent, RetrospectiveLive } from "@cockpit/core"
import { ConfigProvider, Effect, Layer, Schedule } from "effect"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { afterAll } from "vitest"
import { makeRoutesLayer, serveRoutes } from "../src/router.js"
import { RunSupervisorLive } from "../src/runs.js"

// The scripted stand-in for the provider CLIs lives with the core tests that record against the
// real ones; the daemon drives the same binary rather than keeping a second copy of it.
const coreFixture = (name: string) =>
  NodePath.resolve(import.meta.dirname, "../../../packages/core/test", name)

const fakeProvider = coreFixture("fake-provider.mjs")
/** Wired in by default so no daemon under test can reach the real herdr socket or a real window. */
const fakeHerdr = coreFixture("fake-herdr.mjs")
const fakeOpen = coreFixture("fake-open.mjs")

const created: string[] = []
afterAll(() => created.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

export const tempDir = (prefix: string) => {
  const dir = mkdtempSync(NodePath.join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

export const uiDist = (() => {
  const dir = tempDir("cockpitd-ui-")
  writeFileSync(NodePath.join(dir, "index.html"), "<html>spa shell</html>")
  mkdirSync(NodePath.join(dir, "assets"))
  writeFileSync(NodePath.join(dir, "assets", "app.js"), "export const x = 1")
  return dir
})()

export const makeRepo = () => {
  const repoPath = tempDir("cockpitd-repo-")
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" })
  git("init", "-b", "main")
  git("config", "user.email", "fixture@example.com")
  git("config", "user.name", "Fixture")
  writeFileSync(NodePath.join(repoPath, "app.txt"), "base\n")
  git("add", "-A")
  git("commit", "-m", "base")
  return repoPath
}

/** Drops a cartridge config into a repo's `.cockpit`, for tests exercising the cartridge wire. */
export const writeCartridge = (repoPath: string, source: string) => {
  const dir = NodePath.join(repoPath, ".cockpit")
  mkdirSync(dir, { recursive: true })
  writeFileSync(NodePath.join(dir, "cockpit.config.ts"), source)
}

/** The argv the stand-in was last spawned with for a block; mirrors packages/core/test/engine-harness.ts. */
export const spawnedArgv = (block: string): ReadonlyArray<string> =>
  JSON.parse(readFileSync(`${process.env.COCKPIT_FAKE_SCRIPT}.${block}.argv`, "utf8"))

/** The stand-in reads its script from the environment it is spawned with, not from Effect config. */
export const writeScript = (script: Readonly<Record<string, unknown>>) => {
  const path = NodePath.join(tempDir("cockpitd-script-"), "script.json")
  writeFileSync(path, JSON.stringify(script))
  process.env.COCKPIT_FAKE_SCRIPT = path
  /** What the stand-in counted for a block; it keeps the tally on disk, next to the script. */
  return (block: string) => {
    try {
      return Number(readFileSync(`${path}.${block}.count`, "utf8"))
    } catch {
      return 0
    }
  }
}

export type Settings = Readonly<Record<string, string>>

export const daemonLayer = (settings: Settings = {}) =>
  RunSupervisorLive.pipe(
    Layer.provideMerge(RetrospectiveLive),
    Layer.provide(NodeContext.layer),
    Layer.provide(
      Layer.setConfigProvider(
        ConfigProvider.fromMap(
          new Map(
            Object.entries({
              COCKPIT_HOME: tempDir("cockpitd-home-"),
              COCKPIT_CLAUDE_BIN: fakeProvider,
              COCKPIT_CODEX_BIN: fakeProvider,
              COCKPIT_HERDR_BIN: fakeHerdr,
              COCKPIT_OPEN_BIN: fakeOpen,
              COCKPIT_KILL_GRACE_MS: "200",
              CLAUDE_CONFIG_DIR: tempDir("cockpitd-claude-"),
              ...settings,
            }),
          ),
        ),
      ),
    ),
  )

export interface Response {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export interface Api {
  readonly get: (path: string) => Effect.Effect<Response, unknown, HttpClient.HttpClient>
  readonly post: (
    path: string,
    body?: unknown,
  ) => Effect.Effect<Response, unknown, HttpClient.HttpClient>
}

const send = (method: "GET" | "POST", path: string, body?: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const base = HttpClientRequest.make(method)(path)
    const request = body === undefined ? base : yield* HttpClientRequest.bodyJson(base, body)
    const response = yield* client.execute(request)
    return {
      status: response.status,
      headers: response.headers,
      body: yield* response.text,
    } satisfies Response
  })

export const api: Api = {
  get: (path) => send("GET", path),
  post: (path, body) => send("POST", path, body),
}

export const json = <T = unknown>(response: Response): T => JSON.parse(response.body) as T

export const events = (runId: string) =>
  Effect.map(api.get(`/api/runs/${runId}/events?limit=5000`), (response) =>
    json<ReadonlyArray<JournalEvent>>(response),
  )

/** Polls the run's own event log rather than the clock, so a slow machine waits instead of flaking. */
export const waitFor = (
  runId: string,
  ready: (events: ReadonlyArray<JournalEvent>) => boolean,
) =>
  Effect.retry(
    Effect.filterOrFail(events(runId), ready, () => "not yet" as const),
    Schedule.spaced("50 millis").pipe(Schedule.intersect(Schedule.recurs(600))),
  )

export const tagged = (found: ReadonlyArray<JournalEvent>, tag: string) =>
  found.filter((event) => event.payload._tag === tag)

/** `POST /api/runs` only plans, so a test that wants execution presses Run as a user would. */
export const startRun = (client: Api, projectId: string, prompt: string) =>
  Effect.gen(function* () {
    const { runId } = yield* Effect.map(
      client.post("/api/runs", { projectId, prompt }),
      json<{ readonly runId: string }>,
    )
    yield* waitFor(runId, (found) => tagged(found, "RunAwaitingStart").length > 0)
    yield* client.post(`/api/runs/${runId}/start`)
    return { runId }
  })

/**
 * One server and one daemon for the whole body: a run outlives the request that starts it, so a
 * layer rebuilt per request would take its fiber down with it.
 */
export const withApi = <A, E>(
  body: (api: Api) => Effect.Effect<A, E, HttpClient.HttpClient>,
  settings: Settings = {},
) =>
  Effect.runPromise(
    body(api).pipe(
      Effect.provide(
        serveRoutes.pipe(
          Layer.provide(makeRoutesLayer(uiDist)),
          Layer.provide(daemonLayer(settings)),
        ),
      ),
      Effect.provide(NodeHttpServer.layerTest),
      Effect.scoped,
    ),
  )

/** A real port, not the test client: a websocket upgrade needs a socket a client can dial. */
export const served = serveRoutes.pipe(
  Layer.provide(makeRoutesLayer(uiDist)),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
  Layer.provideMerge(daemonLayer()),
)

export const address = Effect.map(HttpServer.HttpServer, (server) =>
  server.address._tag === "TcpAddress" ? server.address.port : 0,
)
