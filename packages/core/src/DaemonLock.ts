import { Effect, Layer } from "effect"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import * as NodePath from "node:path"
import { ensureCockpitHome } from "./config.js"
import { DaemonError } from "./errors.js"

const running = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    // EPERM: the pid is taken by a process this user simply may not signal.
    return (cause as NodeJS.ErrnoException).code === "EPERM"
  }
}

const claim = (path: string) => {
  try {
    writeFileSync(path, `${process.pid}`, { flag: "wx" })
    return
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause
  }
  const owner = Number(readFileSync(path, "utf8").trim())
  if (Number.isInteger(owner) && owner > 0 && running(owner)) {
    throw new Error(`cockpitd is already running as pid ${owner}`)
  }
  rmSync(path, { force: true })
  // Still exclusive: if a rival reclaimed the same stale file first, this throws instead of sharing.
  writeFileSync(path, `${process.pid}`, { flag: "wx" })
}

/** One daemon per COCKPIT_HOME — a second would race the first over the journal and worktrees. */
export const DaemonLockLive = Layer.scopedDiscard(
  Effect.flatMap(ensureCockpitHome, (home) => {
    const path = NodePath.join(home, "daemon.pid")
    return Effect.acquireRelease(
      Effect.try({
        try: () => claim(path),
        catch: (cause) =>
          new DaemonError({
            op: "lock",
            detail: `${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      }),
      () => Effect.sync(() => rmSync(path, { force: true })),
    )
  }),
)
