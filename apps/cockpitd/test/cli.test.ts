import { ProjectRow } from "@cockpit/core"
import { execFile } from "node:child_process"
import { realpathSync } from "node:fs"
import { createServer } from "node:net"
import * as NodePath from "node:path"
import { promisify } from "node:util"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { address, makeRepo, served } from "./harness.js"

const execFileAsync = promisify(execFile)

const cliPath = NodePath.resolve(import.meta.dirname, "../dist/cli.js")

interface Run {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Must be the async form: the daemon under test runs in this same process (the `served` layer),
 * so a synchronous spawn would freeze the very event loop the daemon needs to answer the child.
 */
const cli = (args: ReadonlyArray<string>, port: number): Promise<Run> =>
  execFileAsync("node", [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, COCKPIT_PORT: String(port) },
  }).then(
    ({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
    (error: { code: number | null; stdout: string; stderr: string }) => ({
      status: error.code ?? 1,
      stdout: error.stdout,
      stderr: error.stderr,
    }),
  )

/** A port nothing is listening on: opened, then immediately released. */
const unusedPort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number }
      probe.close((closeError) => (closeError ? reject(closeError) : resolve(port)))
    })
  })

it("add registers a project the daemon can list back, respecting --name", async () => {
  // git canonicalizes the path (rev-parse --show-toplevel), which on macOS resolves
  // the tmpdir's /var symlink to /private/var — match that before comparing.
  const repoPath = realpathSync(makeRepo())

  await Effect.runPromise(
    Effect.gen(function* () {
      const port = yield* address

      const added = yield* Effect.promise(() => cli(["add", repoPath], port))
      expect(added.status).toBe(0)
      expect(added.stdout).toContain(NodePath.basename(repoPath))
      expect(added.stdout).toContain(repoPath)

      const named = yield* Effect.promise(() => cli(["add", repoPath, "--name", "custom-name"], port))
      expect(named.status).toBe(0)
      expect(named.stdout).toContain("custom-name")

      const listed = yield* Effect.promise(() => cli(["projects"], port))
      expect(listed.status).toBe(0)
      expect(listed.stdout).toContain(repoPath)
      expect(listed.stdout).toContain("custom-name")

      const rows = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/projects`).then((r) => r.json() as Promise<ReadonlyArray<ProjectRow>>),
      )
      expect(rows.some((row) => row.repoPath === repoPath && row.name === "custom-name")).toBe(true)
    }).pipe(Effect.provide(served), Effect.scoped),
  )
})

it("add on a non-repository path fails with a clear one-line error", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const port = yield* address
      const result = yield* Effect.promise(() => cli(["add", "/definitely/not/a/repo"], port))
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("not a git repository")
    }).pipe(Effect.provide(served), Effect.scoped),
  )
})

it("fails with a friendly message when the daemon is not running", async () => {
  const port = await unusedPort()
  const result = await cli(["add", makeRepo()], port)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("daemon is not running")
  expect(result.stderr).toContain("pnpm start")
})

it("prints usage with no arguments or --help", async () => {
  const noArgs = await cli([], 1)
  expect(noArgs.status).toBe(1)
  expect(noArgs.stdout).toContain("Usage:")

  const help = await cli(["--help"], 1)
  expect(help.status).toBe(0)
  expect(help.stdout).toContain("Usage:")
})
