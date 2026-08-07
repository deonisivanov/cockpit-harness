import { NodeContext } from "@effect/platform-node"
import { SqlClient } from "@effect/sql"
import { ConfigProvider, Effect, Layer, Scope, Stream } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { afterAll } from "vitest"
import {
  CheckpointService,
  DaemonLockLive,
  EventBus,
  EventPayload,
  EventSeq,
  Journal,
  KernelLive,
  RunId,
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

const configuredHome = (home: string) =>
  Layer.setConfigProvider(ConfigProvider.fromMap(new Map([["COCKPIT_HOME", home]])))

export const kernelLayer = (home: string) =>
  KernelLive.pipe(Layer.provide(NodeContext.layer), Layer.provide(configuredHome(home)))

export const lockLayer = (home: string) =>
  DaemonLockLive.pipe(Layer.provide(configuredHome(home)))

export type KernelContext =
  | Journal
  | SqlClient.SqlClient
  | EventBus
  | WorkspaceManager
  | CheckpointService
  | Scope.Scope

export const runKernel = <A, E>(home: string, body: Effect.Effect<A, E, KernelContext>) =>
  Effect.runPromise(Effect.scoped(Effect.provide(body, kernelLayer(home))))

export const withKernel = async <A, E>(body: Effect.Effect<A, E, KernelContext>) =>
  runKernel(await tempHome(), body)

export const readEvents = (runId: RunId, limit?: number) =>
  Effect.flatMap(Journal, (journal) =>
    Stream.runCollect(journal.eventsFrom(runId, EventSeq.make(0), limit)),
  ).pipe(Effect.map((chunk) => Array.from(chunk)))

export const payloads = (events: ReadonlyArray<{ payload: EventPayload }>) =>
  events.map((event) => event.payload._tag)
