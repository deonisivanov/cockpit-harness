import { HttpRouter, HttpServer } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { coreVersion } from "@cockpit/core"
import { Config, Effect, Layer } from "effect"
import { createServer } from "node:http"
import { makeRoutesLayer } from "./router.js"

const ServerLive = NodeHttpServer.layerConfig(createServer, {
  port: Config.integer("COCKPIT_PORT").pipe(Config.withDefault(4177)),
  host: Config.succeed("127.0.0.1"),
})

const CoreVersionLog = Layer.effectDiscard(Effect.log(`cockpitd core v${coreVersion}`))

const HttpLive = HttpRouter.Default.serve().pipe(
  Layer.provide(makeRoutesLayer()),
  Layer.provide(CoreVersionLog),
  Layer.provide(HttpServer.withLogAddress(ServerLive)),
)

NodeRuntime.runMain(Layer.launch(HttpLive))
