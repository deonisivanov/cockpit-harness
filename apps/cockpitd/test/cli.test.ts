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

// A low port needs root to bind, so a connection there is refused deterministically — no ephemeral
// port to free and re-probe, which would race other test files picking the same "free" port.
// Not port 1: undici's fetch() enforces the Fetch spec's restricted-port list and refuses to even
// attempt that connection (a "bad port" TypeError, no ECONNREFUSED) — port 2 isn't on that list.
const noDaemonPort = 2

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
    (error: { code: unknown; stdout: string; stderr: string }) => ({
      status: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout,
      stderr: error.stderr,
    }),
  )

it("add registers a project the daemon can list back, respecting --name", async () => {
  // git canonicalizes the path (rev-parse --show-toplevel), which on macOS resolves
  // the tmpdir's /var symlink to /private/var — match that before comparing.
  const repoPath = realpathSync(makeRepo())

  await Effect.runPromise(
    Effect.gen(function* () {
      const port = yield* address

      const added = yield* Effect.promise(() => cli(["add", repoPath], port))
      expect(added.status).toBe(0)
      // Pins the default-name behaviour: name defaults to the resolved path's basename.
      expect(added.stdout).toContain(`added ${NodePath.basename(repoPath)} (`)
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

// These all fail during argument parsing, before any network call — no daemon needed.
it("add rejects more than one path", async () => {
  const result = await cli(["add", "/tmp", "/tmp"], noDaemonPort)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("expected at most one path, got 2")
})

it("add rejects a malformed flag without a stack trace, and shows usage", async () => {
  // A V8 stack frame is "\n    at ..."; the parseArgs error text itself can legitimately
  // contain the word "at" (e.g. "place it at the end"), so match the frame shape, not the word.
  const stackFrame = /\n\s*at /

  const missingValue = await cli(["add", "--name"], noDaemonPort)
  expect(missingValue.status).toBe(1)
  expect(missingValue.stderr).not.toMatch(stackFrame)
  expect(missingValue.stderr).toContain("Usage:")

  const unknownFlag = await cli(["add", "--foo"], noDaemonPort)
  expect(unknownFlag.status).toBe(1)
  expect(unknownFlag.stderr).not.toMatch(stackFrame)
  expect(unknownFlag.stderr).toContain("Usage:")

  const unknownShort = await cli(["add", "-rf"], noDaemonPort)
  expect(unknownShort.status).toBe(1)
  expect(unknownShort.stderr).not.toMatch(stackFrame)
  expect(unknownShort.stderr).toContain("Usage:")
})

it("rejects a non-numeric COCKPIT_PORT before touching the network", async () => {
  const result = await execFileAsync("node", [cliPath, "add", "/tmp"], {
    encoding: "utf8",
    env: { ...process.env, COCKPIT_PORT: "not-a-port" },
  }).then(
    ({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
    (error: { code: unknown; stderr: string }) => ({
      status: typeof error.code === "number" ? error.code : 1,
      stderr: error.stderr,
    }),
  )
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("invalid COCKPIT_PORT")
})

it("fails with a friendly message when the daemon is not running", async () => {
  const result = await cli(["add", "/tmp"], noDaemonPort)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("daemon is not running")
  expect(result.stderr).toContain("pnpm start")
})

it("times out cleanly when the daemon accepts a connection but never answers", async () => {
  const stall = createServer(() => {})
  await new Promise<void>((resolve) => stall.listen(0, "127.0.0.1", resolve))
  const port = (stall.address() as { port: number }).port

  try {
    const result = await cli(["add", "/tmp"], port)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("did not respond within")
  } finally {
    stall.close()
  }
}, 15_000)

it("prints usage on stderr for a missing command, stdout for explicit --help", async () => {
  const noArgs = await cli([], noDaemonPort)
  expect(noArgs.status).toBe(1)
  expect(noArgs.stdout).toBe("")
  expect(noArgs.stderr).toContain("Usage:")

  const help = await cli(["--help"], noDaemonPort)
  expect(help.status).toBe(0)
  expect(help.stdout).toContain("Usage:")
})
