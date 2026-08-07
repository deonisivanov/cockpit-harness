import { Effect, Exit } from "effect"
import { writeFile } from "node:fs/promises"
import * as NodePath from "node:path"
import { expect, it } from "vitest"
import { CommandResult, CommandRunner, CommandSpec, Journal, RunId } from "../src/index.js"
import {
  KernelContext,
  node,
  payloads,
  readEvents,
  runKernel,
  tempDir,
  tempHome,
} from "./helpers.js"

const runId = RunId.make("run-cmd")

const withRunner = async <A, E>(
  body: (
    execute: (
      command: CommandSpec,
      cwd: string,
      timeoutMs?: number,
    ) => Effect.Effect<CommandResult, unknown, KernelContext>,
    cwd: string,
  ) => Effect.Effect<A, E, KernelContext>,
) => {
  const home = await tempHome()
  const cwd = await tempDir("cockpit-cmd-")
  return runKernel(
    home,
    Effect.gen(function* () {
      const journal = yield* Journal
      yield* journal.createRun({ runId, projectId: "proj", prompt: "x" })
      const runner = yield* CommandRunner
      const execute = (command: CommandSpec, at: string, timeoutMs = 10_000) =>
        runner.execute({ runId, cwd: at, command, timeoutMs })
      return yield* body(execute, cwd)
    }),
    { COCKPIT_KILL_GRACE_MS: "200" },
  )
}

it("captures output and reports a clean exit as success", async () => {
  const result = await withRunner((execute, cwd) =>
    execute(
      { argv: node("process.stdout.write('built\\n'); process.stderr.write('warned\\n')") },
      cwd,
    ),
  )

  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "built\n",
    stderr: "warned\n",
    stdoutTruncated: false,
    stderrTruncated: false,
    success: true,
    ruleResults: [],
  })
  expect(result.durationMs).toBeGreaterThanOrEqual(0)
})

it("reports a non-zero exit as a failure with its output intact", async () => {
  const result = await withRunner((execute, cwd) =>
    execute({ argv: node("process.stderr.write('2 tests failed'); process.exit(1)") }, cwd),
  )

  expect(result).toMatchObject({ exitCode: 1, success: false, stderr: "2 tests failed" })
})

it("passes only the rules whose pattern matches the right stream", async () => {
  const result = await withRunner((execute, cwd) =>
    execute(
      {
        argv: node("process.stdout.write('12 passing'); process.stderr.write('0 warnings')"),
        successRules: [
          { _tag: "StdoutMatches", pattern: "\\d+ passing", required: true },
          { _tag: "StderrMatches", pattern: "0 warnings", required: true },
          { _tag: "StdoutMatches", pattern: "0 warnings", required: true },
        ],
      },
      cwd,
    ),
  )

  expect(result.ruleResults.map(({ passed }) => passed)).toEqual([true, true, false])
  expect(result.success).toBe(false)
})

it("lets an optional rule fail without sinking the block", async () => {
  const result = await withRunner((execute, cwd) =>
    execute(
      {
        argv: node("process.stdout.write('done')"),
        successRules: [{ _tag: "StdoutMatches", pattern: "never", required: false }],
      },
      cwd,
    ),
  )

  expect(result.ruleResults).toMatchObject([{ passed: false }])
  expect(result.success).toBe(true)
})

it("resolves an artifact rule against the worktree", async () => {
  const results = await withRunner((execute, cwd) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeFile(NodePath.join(cwd, "report.xml"), "<testsuite/>"),
      )
      const found = yield* execute(
        {
          argv: node("process.stdout.write('done')"),
          successRules: [{ _tag: "ArtifactExists", glob: "*.xml", required: true }],
        },
        cwd,
      )
      const missing = yield* execute(
        {
          argv: node("process.stdout.write('done')"),
          successRules: [{ _tag: "ArtifactExists", glob: "coverage/**/*.json", required: true }],
        },
        cwd,
      )
      return { found, missing }
    }),
  )

  expect(results.found.success).toBe(true)
  expect(results.missing.ruleResults).toMatchObject([{ passed: false }])
  expect(results.missing.success).toBe(false)
})

it("injects the command's environment", async () => {
  const result = await withRunner((execute, cwd) =>
    execute(
      {
        argv: node("process.stdout.write(`${process.env.COCKPIT_TEST_TARGET}`)"),
        env: { COCKPIT_TEST_TARGET: "integration" },
      },
      cwd,
    ),
  )

  expect(result.stdout).toBe("integration")
})

it("caps captured output at the in-memory budget and says it truncated", async () => {
  const result = await withRunner((execute, cwd) =>
    execute({ argv: node("process.stdout.write('x'.repeat(1_400_000))") }, cwd),
  )

  expect(result.stdout).toHaveLength(1_048_576)
  expect(result.stdoutTruncated).toBe(true)
  expect(result.stderrTruncated).toBe(false)
  expect(result.success).toBe(true)
}, 20_000)

it("keeps a lone surrogate out of truncated output", async () => {
  // The budget lands mid-pair, so a naive slice would end the capture on half a character.
  const result = await withRunner((execute, cwd) =>
    execute(
      { argv: node("process.stdout.write('x'.repeat(1_048_575) + '\\u{1F600}'.repeat(10))") },
      cwd,
    ),
  )

  expect(result.stdout).toHaveLength(1_048_575)
  expect(result.stdout.endsWith("x")).toBe(true)
  expect(result.stdoutTruncated).toBe(true)
}, 20_000)

// A deadline shorter than node's startup would kill the child before it printed anything, which
// is the one thing this test is here to prove survives.
it("reports a timeout as a failed result that still carries what the command printed", async () => {
  const result = await withRunner((execute, cwd) =>
    execute(
      { argv: node("process.stdout.write('phase 1 done\\n'); setInterval(() => {}, 1000)") },
      cwd,
      1_000,
    ),
  )

  expect(result).toMatchObject({
    exitCode: null,
    timedOut: true,
    stdout: "phase 1 done\n",
    success: false,
  })
}, 20_000)

it("rejects an artifact glob that reaches outside the worktree", async () => {
  const exits = await withRunner((execute, cwd) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeFile(NodePath.join(cwd, "report.txt"), "in-tree"))
      return yield* Effect.all(
        ["../*.txt", "/etc/hos*", "nested/../../*.txt"].map((pattern) =>
          Effect.exit(
            execute(
              {
                argv: node("process.stdout.write('done')"),
                successRules: [{ _tag: "ArtifactExists", glob: pattern, required: true }],
              },
              cwd,
            ),
          ),
        ),
      )
    }),
  )

  for (const exit of exits) {
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(exit)).toContain("must stay inside the worktree")
  }
}, 20_000)

it("fails a rule whose pattern is not a valid regular expression", async () => {
  const exit = await withRunner((execute, cwd) =>
    Effect.exit(
      execute(
        {
          argv: node("process.stdout.write('done')"),
          successRules: [{ _tag: "StdoutMatches", pattern: "(unclosed", required: true }],
        },
        cwd,
      ),
    ),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("invalid rule pattern")
})

it("journals what it ran", async () => {
  const events = await withRunner((execute, cwd) =>
    Effect.gen(function* () {
      yield* execute({ argv: node("process.exit(2)") }, cwd)
      return yield* readEvents(runId)
    }),
  )

  expect(payloads(events)).toEqual(["RunCreated", "CommandExecuted"])
  expect(events[1].payload).toMatchObject({
    _tag: "CommandExecuted",
    argv: [process.execPath, "-e", "process.exit(2)"],
    exitCode: 2,
    timedOut: false,
    success: false,
  })
})

it("journals a timed-out command with no status and the timeout marker", async () => {
  const events = await withRunner((execute, cwd) =>
    Effect.gen(function* () {
      yield* execute({ argv: node("setInterval(() => {}, 1000)") }, cwd, 150)
      return yield* readEvents(runId)
    }),
  )

  expect(events[1].payload).toMatchObject({
    _tag: "CommandExecuted",
    exitCode: null,
    timedOut: true,
    success: false,
  })
}, 20_000)
