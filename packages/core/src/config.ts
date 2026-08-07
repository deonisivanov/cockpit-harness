import { Config, Effect } from "effect"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import * as NodePath from "node:path"
import { DaemonError } from "./errors.js"

export const cockpitHome = Config.string("COCKPIT_HOME").pipe(
  Config.withDefault(NodePath.join(homedir(), ".cockpit")),
)

export const ensureCockpitHome = Effect.flatMap(cockpitHome, (home) =>
  Effect.try({
    try: () => {
      mkdirSync(home, { recursive: true })
      return home
    },
    catch: (cause) => new DaemonError({ op: "home", detail: `${home}: ${String(cause)}` }),
  }),
)
