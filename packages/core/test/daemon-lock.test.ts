import { Effect, Exit, Layer } from "effect"
import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import * as NodePath from "node:path"
import { expect, it } from "vitest"
import { lockLayer, tempHome } from "./helpers.js"

const pidfile = (home: string) => NodePath.join(home, "daemon.pid")

const readWhileHeld = (home: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.sync(() => readFileSync(pidfile(home), "utf8")),
        lockLayer(home),
      ),
    ),
  )

const exitedPid = () =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
    child.once("error", reject)
    child.once("exit", () =>
      child.pid === undefined ? reject(new Error("child never got a pid")) : resolve(child.pid),
    )
  })

it("holds a pidfile for as long as the daemon runs and clears it on shutdown", async () => {
  const home = await tempHome()
  expect(await readWhileHeld(home)).toBe(`${process.pid}`)
  expect(existsSync(pidfile(home))).toBe(false)
})

it("refuses a second daemon while a live process holds the lock", async () => {
  const home = await tempHome()
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.zipRight(Layer.build(lockLayer(home)), Effect.scoped(Layer.build(lockLayer(home)))),
    ),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain(`already running as pid ${process.pid}`)
})

it("reclaims a pidfile left behind by a process that is gone", async () => {
  const home = await tempHome()
  writeFileSync(pidfile(home), `${await exitedPid()}`)

  expect(await readWhileHeld(home)).toBe(`${process.pid}`)
})
