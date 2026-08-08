import { HttpServer } from "@effect/platform"
import { NodeContext, NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { coreVersion, DaemonLockLive, RecoveryScanLive, RetrospectiveLive } from "@cockpit/core"
import { Config, Effect, Layer } from "effect"
import { createServer } from "node:http"
import { makeRoutesLayer, serveRoutes } from "./router.js"
import { RunSupervisorLive } from "./runs.js"

const ServerLive = NodeHttpServer.layerConfig(createServer, {
  port: Config.integer("COCKPIT_PORT").pipe(Config.withDefault(4177)),
  host: Config.succeed("127.0.0.1"),
})

const CoreVersionLog = Layer.effectDiscard(Effect.log(`cockpitd core v${coreVersion}`))

const KernelWithRecovery = RecoveryScanLive.pipe(
  Layer.provideMerge(RunSupervisorLive),
  Layer.provideMerge(RetrospectiveLive),
  // Built before anything below it, so a second daemon fails before it opens the journal.
  Layer.provide(DaemonLockLive),
  Layer.provide(NodeContext.layer),
)

const HttpLive = serveRoutes.pipe(
  Layer.provide(makeRoutesLayer()),
  Layer.provide(CoreVersionLog),
  Layer.provide(HttpServer.withLogAddress(ServerLive)),
)

// Migrations and the recovery scan finish before the first request can be served.
NodeRuntime.runMain(Layer.launch(HttpLive.pipe(Layer.provideMerge(KernelWithRecovery))))
