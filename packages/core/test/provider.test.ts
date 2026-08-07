import { Effect, Exit, Stream } from "effect"
import { expect, it } from "vitest"
import {
  ClaudeCodeProvider,
  claudeArgv,
  CodexProvider,
  codexArgv,
  Provider,
  ProviderEvent,
  ProviderRunOptions,
  runToResult,
  SessionId,
  verifyOutput,
} from "../src/index.js"
import { fixturePath, ProviderContext, runProviders, tempDir } from "./helpers.js"

const fake = fixturePath("fake-provider.mjs")

const settings = {
  COCKPIT_CLAUDE_BIN: fake,
  COCKPIT_CODEX_BIN: fake,
  COCKPIT_KILL_GRACE_MS: "200",
}

const assigned = SessionId.make("11111111-2222-4333-8444-555555555555")

const options = (overrides: Partial<ProviderRunOptions> = {}): Omit<ProviderRunOptions, "cwd"> => ({
  prompt: "do the thing",
  permissionProfile: "workspace-write",
  timeoutMs: 10_000,
  ...overrides,
})

/** The scenario rides the same env path the adapters hand to a real CLI. */
const scenario = (name: string, overrides: Partial<ProviderRunOptions> = {}) =>
  options({ ...overrides, env: { COCKPIT_FAKE_SCENARIO: name } })

const run = <A, E>(
  body: (provider: Provider, cwd: string) => Effect.Effect<A, E, ProviderContext>,
  which: "claude" | "codex" = "claude",
) =>
  runProviders(
    Effect.gen(function* () {
      const provider = yield* (which === "claude" ? ClaudeCodeProvider : CodexProvider)
      const cwd = yield* Effect.promise(() => tempDir("cockpit-prov-"))
      return yield* body(provider, cwd)
    }),
    settings,
  )

const events = (
  name: string,
  overrides: Partial<ProviderRunOptions> = {},
  which: "claude" | "codex" = "claude",
) =>
  run(
    (provider, cwd) =>
      Effect.map(
        Stream.runCollect(provider.run({ ...scenario(name, overrides), cwd })),
        (chunk) => Array.from(chunk) as ProviderEvent[],
      ),
    which,
  )

const tags = (collected: ReadonlyArray<ProviderEvent>) => collected.map((event) => event._tag)

/** Not `.at(-1)`: stderr is merged live, so a diagnostic line can arrive after the verdict. */
const verdict = (collected: ReadonlyArray<ProviderEvent>) =>
  collected.filter((event) => event._tag === "ResultProduced")

it("streams a claude session through to its result", async () => {
  const collected = await events("success", { sessionId: assigned })

  expect(collected[0]).toMatchObject({ _tag: "SessionStarted", sessionId: assigned })
  expect(tags(collected).at(-1)).toBe("ResultProduced")
  expect(collected.at(-1)).toMatchObject({
    result: { isError: false, text: "ok", sessionId: assigned },
  })
})

it("yields the provider verdict from a drained run", async () => {
  const seen: string[] = []
  const result = await run((provider, cwd) =>
    runToResult(provider.run({ ...scenario("success", { sessionId: assigned }), cwd }), (event) =>
      Effect.sync(() => {
        seen.push(event._tag)
      }),
    ),
  )

  expect(result).toMatchObject({ isError: false, text: "ok" })
  expect(seen).toContain("SessionStarted")
  expect(seen.at(-1)).toBe("ResultProduced")
})

it("reports a semantic failure as a result, not a transport error", async () => {
  const collected = await events("failure", { sessionId: assigned })

  expect(verdict(collected)).toMatchObject([{ result: { isError: true, text: "nope" } }])
  expect(collected).toContainEqual(
    expect.objectContaining({
      _tag: "OutputChunk",
      streamKind: "stderr",
      text: "fake: verification failed",
    }),
  )
})

it("fails with a crash error when the CLI dies before producing a result", async () => {
  const exit = await run((provider, cwd) =>
    Effect.exit(
      Stream.runDrain(provider.run({ ...scenario("crash", { sessionId: assigned }), cwd })),
    ),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain('"kind": "crash"')
  expect(String(exit)).toContain("exited with code 3")
  // The session is still named, so a crashed attempt stays traceable to its transcript.
  expect(String(exit)).toContain(assigned)
})

it("fails with a timeout error and kills a CLI that never finishes", async () => {
  const exit = await run((provider, cwd) =>
    Effect.exit(Stream.runDrain(provider.run({ ...scenario("hang", { timeoutMs: 150 }), cwd }))),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain('"kind": "timeout"')
}, 20_000)

it("surfaces a question asked from inside a headless claude session", async () => {
  const collected = await events("question", { sessionId: assigned })

  expect(collected).toContainEqual(
    expect.objectContaining({ _tag: "QuestionAsked", question: "Which database?" }),
  )
  expect(tags(collected).at(-1)).toBe("ResultProduced")
})

it("takes the session id codex generates for itself", async () => {
  const collected = await events("success", {}, "codex")

  expect(collected[0]).toMatchObject({
    _tag: "SessionStarted",
    sessionId: "019fddd5-0000-7000-8000-000000000001",
  })
  expect(collected.at(-1)).toMatchObject({ result: { isError: false, text: "ok" } })
})

it("reports a failed codex turn as an errored result", async () => {
  const collected = await events("failure", {}, "codex")
  expect(verdict(collected)).toMatchObject([{ result: { isError: true, text: "nope" } }])
})

it("asks claude for a session id it can resume later, and resumes with it", () => {
  expect(claudeArgv("claude", { ...options({ sessionId: assigned }), cwd: "/w" })).toEqual([
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--session-id",
    assigned,
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash",
    "--",
    "do the thing",
  ])

  const resumed = claudeArgv("claude", {
    ...options({ sessionId: assigned, resumeSessionId: assigned }),
    cwd: "/w",
  })
  expect(resumed).toContain("--resume")
  expect(resumed).not.toContain("--session-id")
})

it("withholds the write and exec tools from a read-only claude block", () => {
  const argv = claudeArgv("claude", {
    ...options({ permissionProfile: "read-only" }),
    cwd: "/w",
  })
  expect(argv.slice(-6, -2)).toEqual([
    "--permission-mode",
    "plan",
    "--disallowedTools",
    "Write,Edit,NotebookEdit,Bash",
  ])
})

it("lets a read-plus-output block write its result without opening the repository to it", () => {
  // The profile the verifier ships with: it judges the worktree, but its verdict is a file.
  expect(verifyOutput.permissionProfile).toBe("read-plus-output")

  const claude = claudeArgv("claude", {
    ...options({ permissionProfile: "read-plus-output", outputDir: "/runs/r1" }),
    cwd: "/w",
  })
  // Plan mode would withhold Write, which is the one tool this profile exists to grant.
  expect(claude).not.toContain("plan")
  expect(claude.join(" ")).toContain(
    "--permission-mode acceptEdits --disallowedTools Edit,NotebookEdit,Bash --allowedTools Write --add-dir /runs/r1",
  )

  const codex = codexArgv("codex", {
    ...options({ permissionProfile: "read-plus-output", outputDir: "/runs/r1" }),
    cwd: "/w",
  })
  expect(codex).toContain("sandbox_mode=workspace-write")
  expect(codex).toContain('sandbox_workspace_write.writable_roots=["/runs/r1"]')

  // A writing block keeps the profile it always had, plus the reach to its own result file.
  const writing = claudeArgv("claude", {
    ...options({ permissionProfile: "workspace-write", outputDir: "/runs/r1" }),
    cwd: "/w",
  })
  expect(writing.join(" ")).toContain(
    "--permission-mode acceptEdits --allowedTools Bash --add-dir /runs/r1",
  )
  expect(writing).not.toContain("--disallowedTools")
})

it("maps permission profiles onto the codex sandbox", () => {
  const readOnly = codexArgv("codex", { ...options({ permissionProfile: "read-only" }), cwd: "/w" })
  expect(readOnly).toEqual([
    "codex",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-c",
    "sandbox_mode=read-only",
    "--",
    "do the thing",
  ])

  const networked = codexArgv("codex", {
    ...options({ permissionProfile: "workspace-write-network" }),
    cwd: "/w",
  })
  expect(networked).toContain("sandbox_mode=workspace-write")
  expect(networked).toContain("sandbox_workspace_write.network_access=true")

  // `codex exec resume` accepts neither -s nor -C, so only flags it declares may follow it.
  const resumed = codexArgv("codex", { ...options({ resumeSessionId: assigned }), cwd: "/w" })
  expect(resumed.slice(0, 4)).toEqual(["codex", "exec", "resume", assigned])
  expect(resumed).not.toContain("-s")
  expect(resumed).not.toContain("-C")
})

// A prompt is data. Without the `--` operand marker one that opens with a dash would be read as
// a flag, and "--dangerously-skip-permissions" is the one that costs the most to get wrong.
it.each([
  ["claude", claudeArgv] as const,
  ["codex", codexArgv] as const,
])("keeps a %s prompt that looks like a flag behind the operand marker", (_name, build) => {
  const hostile = "--dangerously-skip-permissions"

  for (const overrides of [{ sessionId: assigned }, { resumeSessionId: assigned }]) {
    const argv = build("bin", { ...options({ ...overrides, prompt: hostile }), cwd: "/w" })
    expect(argv.at(-1)).toBe(hostile)
    expect(argv.at(-2)).toBe("--")
    expect(argv.indexOf(hostile)).toBeGreaterThan(argv.indexOf("--"))
  }
})

it("fails rather than buffering forever when a CLI never emits a newline", async () => {
  const exit = await run((provider, cwd) =>
    Effect.exit(Stream.runDrain(provider.run({ ...scenario("flood"), cwd }))),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("exceeded")
}, 30_000)

it("reassembles a multi-byte character split across two reads", async () => {
  const collected = await events("chunked", { sessionId: assigned })

  expect(collected).toContainEqual(
    expect.objectContaining({ _tag: "OutputChunk", streamKind: "assistant", text: "héllo ✓" }),
  )
})

it("reassembles a JSON line split across two reads", async () => {
  const collected = await events("chunked", { sessionId: assigned })

  expect(verdict(collected)).toMatchObject([{ result: { isError: false, text: "héllo ✓" } }])
})
