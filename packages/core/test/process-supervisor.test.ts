import { Effect, Exit, Stream } from "effect"
import { expect, it } from "vitest"
import { Child, ProcessError, ProcessSupervisor } from "../src/index.js"
import { fixturePath, node, runProviders, tempDir } from "./helpers.js"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const settled = async (pid: number) => {
  for (let attempt = 0; attempt < 200 && alive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return alive(pid)
}

const lines = (stream: Stream.Stream<Uint8Array, ProcessError>) =>
  stream.pipe(Stream.decodeText(), Stream.splitLines)

const withChild = <A, E>(
  argv: readonly [string, ...ReadonlyArray<string>],
  body: (child: Child) => Effect.Effect<A, E>,
  options: { readonly env?: Record<string, string>; readonly timeoutMs?: number } = {},
) =>
  Effect.gen(function* () {
    const supervisor = yield* ProcessSupervisor
    const cwd = yield* Effect.promise(() => tempDir("cockpit-proc-"))
    return yield* Effect.scoped(
      Effect.flatMap(supervisor.spawn({ argv, cwd, ...options }), body),
    )
  })

it("kills the whole process group, grandchildren included", async () => {
  const reported = await runProviders(
    withChild([fixturePath("spawn-tree.mjs")], (child) =>
      Effect.map(Stream.runHead(lines(child.stdout)), (head) => ({
        pid: child.pid,
        announced: String(head).match(/\d+/g)!.map(Number),
      })),
    ),
    { COCKPIT_KILL_GRACE_MS: "200" },
  )

  const [parent, grandchild] = reported.announced
  expect(parent).toBe(reported.pid)
  expect(await settled(parent)).toBe(false)
  expect(await settled(grandchild)).toBe(false)
})

// The deadline has to outlast node's own startup: the child can only ignore SIGTERM once it has
// booted far enough to install the handler, and a tighter one would sometimes kill it outright.
it("escalates to SIGKILL when a timed-out child ignores SIGTERM", async () => {
  const startedAt = Date.now()
  const exit = await runProviders(
    withChild(
      [fixturePath("fake-provider.mjs"), "--output-format", "stream-json"],
      (child) =>
        Effect.exit(
          Effect.all([Stream.runDrain(child.stdout), child.exitCode], { concurrency: 2 }),
        ),
      { env: { COCKPIT_FAKE_SCENARIO: "hang" }, timeoutMs: 1_000 },
    ),
    { COCKPIT_KILL_GRACE_MS: "200" },
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("timeout")
  // Nothing but the SIGKILL could have ended it, and only after the grace elapsed.
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_200)
}, 20_000)

it("delivers each stream's lines in the order the child wrote them", async () => {
  const collected = await runProviders(
    withChild(
      node(
        "for (const i of [1, 2, 3]) { process.stdout.write(`out${i}\\n`); process.stderr.write(`err${i}\\n`) }",
      ),
      (child) =>
        Effect.all(
          [
            Stream.runCollect(lines(child.stdout)),
            Stream.runCollect(lines(child.stderr)),
            child.exitCode,
          ],
          { concurrency: 3 },
        ),
    ),
  )

  expect(Array.from(collected[0])).toEqual(["out1", "out2", "out3"])
  expect(Array.from(collected[1])).toEqual(["err1", "err2", "err3"])
  expect(collected[2]).toBe(0)
})

it("reports the child's exit code", async () => {
  const code = await runProviders(
    withChild(node("process.exit(7)"), (child) =>
      Effect.zipRight(Stream.runDrain(child.stdout), child.exitCode),
    ),
  )
  expect(code).toBe(7)
})

it("fails with a spawn error when the executable does not exist", async () => {
  const exit = await runProviders(
    Effect.exit(withChild(["cockpit-no-such-binary"], (child) => child.exitCode)),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("spawn")
})

it("closes the child's stdin so a CLI that reads it still terminates", async () => {
  const output = await runProviders(
    withChild(
      node("process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'))"),
      (child) => Effect.zip(Stream.mkString(lines(child.stdout)), child.exitCode),
    ),
  )
  expect(output).toEqual(["eof", 0])
}, 20_000)
