import { Effect } from "effect"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import * as NodePath from "node:path"
import { expect, it } from "vitest"
import {
  agentTask,
  atLeastVersion,
  BlockDef,
  correctivePolicy,
  PluginBinding,
  RunId,
  singleAttemptPolicy,
  PluginCatalog,
  validateWorkflow,
  verifyOutput,
} from "../src/index.js"
import { block, catalog, fakeProviders, id, of, startedIds, withEngine } from "./engine-harness.js"
import { readEvents, runCatalog, tempDir } from "./helpers.js"

interface FakePlugin {
  readonly name: string
  readonly version: string
  readonly enabled?: boolean
  readonly commands?: ReadonlyArray<string>
  readonly skills?: ReadonlyArray<string>
  readonly agents?: ReadonlyArray<string>
}

/** The layout Claude Code 2.x keeps on disk, reduced to what the catalog reads. */
const pluginHome = async (plugins: ReadonlyArray<FakePlugin>) => {
  const home = await tempDir("cockpit-claude-")
  const installed: Record<string, unknown> = {}
  const enabled: Record<string, boolean> = {}

  for (const plugin of plugins) {
    const installPath = NodePath.join(home, "cache", "market", plugin.name, plugin.version)
    for (const [dir, names] of [
      ["commands", plugin.commands ?? []],
      ["agents", plugin.agents ?? []],
    ] as const) {
      await mkdir(NodePath.join(installPath, dir), { recursive: true })
      for (const name of names) {
        await writeFile(NodePath.join(installPath, dir, `${name}.md`), `# ${name}\n`)
      }
    }
    for (const name of plugin.skills ?? []) {
      await mkdir(NodePath.join(installPath, "skills", name), { recursive: true })
    }
    installed[`${plugin.name}@market`] = [{ scope: "user", installPath, version: plugin.version }]
    enabled[`${plugin.name}@market`] = plugin.enabled ?? true
  }

  await mkdir(NodePath.join(home, "plugins"), { recursive: true })
  await writeFile(
    NodePath.join(home, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: installed }),
  )
  await writeFile(NodePath.join(home, "settings.json"), JSON.stringify({ enabledPlugins: enabled }))
  return home
}

const demo: FakePlugin = {
  name: "demo",
  version: "4.15.6",
  commands: ["review", "plan"],
  skills: ["autopilot"],
  agents: ["verifier"],
}

const binding = (patch: Partial<PluginBinding> = {}): PluginBinding => ({
  plugin: "demo",
  entry: { kind: "slash", name: "review" },
  requiredCapabilities: [],
  managesInternalRetries: false,
  cancellation: "kill-tree",
  ...patch,
})

const bound = (patch: Partial<BlockDef> = {}): BlockDef => ({
  ...agentTask,
  id: "bound-task",
  binding: binding(),
  ...patch,
})

const preflight = async (plugins: ReadonlyArray<FakePlugin>, given?: PluginBinding) =>
  runCatalog(
    Effect.flatMap(PluginCatalog, (catalog) =>
      Effect.either(catalog.preflight({ provider: "claude-code", binding: given })),
    ),
    { CLAUDE_CONFIG_DIR: await pluginHome(plugins), ...fakeProviders },
  )

it("compares plugin versions by their numeric segments and refuses ones it cannot order", () => {
  expect(atLeastVersion("4.15.6", "4.15.6")).toBe(true)
  expect(atLeastVersion("4.15.6", "4.2.0")).toBe(true)
  expect(atLeastVersion("4.2.0", "4.15.6")).toBe(false)
  expect(atLeastVersion("1.0", "1.0.0")).toBe(true)
  expect(atLeastVersion("0d95a81d35a9", "1.0.0")).toBe(false)

  // A prerelease is under the release it leads to, and over the one before it.
  expect(atLeastVersion("1.0.0-beta.1", "1.0.0")).toBe(false)
  expect(atLeastVersion("1.0.0", "1.0.0-beta.1")).toBe(true)
  expect(atLeastVersion("1.0.0-beta.1", "0.9.9")).toBe(true)
  expect(atLeastVersion("1.0.0-beta.1", "1.0.0-beta.1")).toBe(true)
})

it("reads the installed plugins and the entries each one provides", async () => {
  const found = await runCatalog(
    Effect.flatMap(PluginCatalog, (catalog) => catalog.plugins),
    {
      CLAUDE_CONFIG_DIR: await pluginHome([demo, { name: "off", version: "1.0.0", enabled: false }]),
      ...fakeProviders,
    },
  )

  expect(found.map((plugin) => [plugin.name, plugin.version, plugin.enabled])).toEqual([
    ["demo", "4.15.6", true],
    ["off", "1.0.0", false],
  ])
  expect([...found[0].capabilities].sort()).toEqual([
    "agent:verifier",
    "skill:autopilot",
    "slash:plan",
    "slash:review",
  ])
})

it("resolves a binding against the installed catalog", async () => {
  const result = await preflight([demo], binding({ minVersion: "4.2.0" }))

  expect(result).toMatchObject({
    _tag: "Right",
    right: {
      provider: { name: "claude-code", version: "9.9.9 (fake provider)" },
      plugin: { name: "demo", version: "4.15.6" },
      entry: { kind: "slash", name: "review" },
    },
  })
})

it("prefers the exact install when a binding names the marketplace it came from", async () => {
  const elsewhere = await pluginHome([demo])
  const both = await runCatalog(
    Effect.flatMap(PluginCatalog, (catalog) =>
      Effect.all([
        catalog.preflight({ provider: "claude-code", binding: binding({ plugin: "demo@market" }) }),
        Effect.either(
          catalog.preflight({
            provider: "claude-code",
            binding: binding({ plugin: "demo@other-market" }),
          }),
        ),
      ]),
    ),
    { CLAUDE_CONFIG_DIR: elsewhere, ...fakeProviders },
  )

  expect(both[0]).toMatchObject({ plugin: { name: "demo", version: "4.15.6" } })
  expect(both[1]).toMatchObject({ _tag: "Left", left: { reason: "plugin-missing" } })
})

it("names the reason a binding cannot run", async () => {
  const reasons = await Promise.all([
    preflight([], binding()),
    preflight([demo], binding({ minVersion: "9.0.0" })),
    preflight([demo], binding({ entry: { kind: "slash", name: "nonexistent" } })),
    preflight([demo], binding({ requiredCapabilities: ["skill:nothing-like-it"] })),
    preflight([{ ...demo, enabled: false }], binding()),
  ])

  expect(
    reasons.map((result) => (result._tag === "Left" ? result.left.reason : "resolved")),
  ).toEqual([
    "plugin-missing",
    "version-incompatible",
    "entry-missing",
    "permission-missing",
    "plugin-missing",
  ])
})

it("reports the provider unavailable when its binary answers nothing", async () => {
  const result = await runCatalog(
    Effect.flatMap(PluginCatalog, (catalog) =>
      Effect.either(catalog.preflight({ provider: "claude-code" })),
    ),
    { CLAUDE_CONFIG_DIR: await pluginHome([]), COCKPIT_CLAUDE_BIN: "cockpit-no-such-binary" },
  )

  expect(result).toMatchObject({ _tag: "Left", left: { reason: "provider-unavailable" } })
})

it("probes the real CLIs that are installed on this machine", async () => {
  const versions = await runCatalog(
    Effect.flatMap(PluginCatalog, (catalog) =>
      Effect.all([catalog.providerVersion("claude-code"), catalog.providerVersion("codex")]),
    ),
  )

  for (const version of versions) expect(version).toMatch(/\d+\.\d+/)
}, 30_000)

/** Only the block that survives preflight ever runs in the tests below. */
const script = { "agent-task": { output: { summary: "did the work" }, text: "done" } }

it("renders the bound entry into the prompt and captures the state the plugin left", async () => {
  const stateful = bound({
    binding: binding({
      argsTemplate: "{{prompt}}",
      extraInstructions: "Report findings in the block result, not in prose.",
      stateFiles: [".demo/**"],
    }),
  })

  const { prompts, artifacts } = await withEngine(
    {
      "bound-task": {
        output: { summary: "did the work" },
        text: "done",
        writes: { ".demo/state.md": "plugin notes\n" },
      },
    },
    ({ runId, start }) =>
      Effect.gen(function* () {
        yield* start(block("work", stateful.id), catalog([stateful]))
        const events = yield* readEvents(runId)
        const created = of(events, "ArtifactCreated")
        const prompts = yield* Effect.forEach(
          created.filter((event) => event.payload.kind === "prompt"),
          (event) => Effect.promise(() => readFile(event.payload.path, "utf8")),
        )
        return {
          prompts,
          artifacts: created.map((event) => [event.payload.kind, event.payload.path] as const),
        }
      }),
    { CLAUDE_CONFIG_DIR: await pluginHome([demo]) },
  )

  // The slash invocation leads, because that is the only position Claude expands one from.
  expect(prompts[0].split("\n")[0]).toBe("/demo:review make the thing work")
  expect(prompts[0]).toContain("Report findings in the block result")
  expect(prompts[0]).toContain("## Output contract")

  const state = artifacts.find(([kind]) => kind === "plugin-state")
  expect(state?.[1]).toContain("demo-state.md")
  expect(await readFile(state![1], "utf8")).toBe("plugin notes\n")
}, 60_000)

it("keeps a multi-line prompt on the slash line instead of letting it end the invocation", async () => {
  const stateful = bound({ binding: binding({ argsTemplate: "{{prompt}}" }) })

  const prompt = await withEngine(
    { "bound-task": { output: { summary: "did the work" }, text: "done" } },
    ({ runId, start }) =>
      Effect.gen(function* () {
        yield* start(block("work", stateful.id), catalog([stateful]))
        const composed = of(yield* readEvents(runId), "ArtifactCreated").find(
          (event) => event.payload.kind === "prompt",
        )!
        return yield* Effect.promise(() => readFile(composed.payload.path, "utf8"))
      }),
    { CLAUDE_CONFIG_DIR: await pluginHome([demo]) },
    "fix the parser\n\nit drops the last field\nand nobody noticed",
  )

  expect(prompt.split("\n")[0]).toBe(
    "/demo:review fix the parser it drops the last field and nobody noticed",
  )
}, 60_000)

it("fails the run when a required plugin is missing and the block says so", async () => {
  const outcome = await withEngine(
    script,
    ({ start }) =>
      Effect.either(start(block("work", bound().id), catalog([bound()]))),
    { CLAUDE_CONFIG_DIR: await pluginHome([]) },
  )

  expect(outcome).toMatchObject({
    _tag: "Left",
    left: { _tag: "PreflightError", reason: "plugin-missing" },
  })
}, 60_000)

it("skips a block whose plugin is missing when that is its declared fallback", async () => {
  const skippable = bound({ id: "skippable", fallback: { _tag: "SkipWithWarning" } })

  const { outcome, events } = await withEngine(
    script,
    ({ runId, start }) =>
      Effect.gen(function* () {
        const outcome = yield* start(
          { _tag: "Sequence", children: [block("work", skippable.id), block("after", agentTask.id)] },
          catalog([skippable]),
        )
        return { outcome, events: yield* readEvents(runId) }
      }),
    { CLAUDE_CONFIG_DIR: await pluginHome([]) },
  )

  expect(outcome.status).toBe("succeeded")
  expect(of(events, "BlockSkipped").map((event) => [event.blockId, event.payload.reason])).toEqual([
    ["work", expect.stringContaining("plugin-missing")],
  ])
  // The rest of the workflow still runs; nothing was substituted for the skipped block.
  expect(startedIds(events)).toEqual(["after"])
}, 60_000)

it("swaps to the declared alternative binding and records which one ran", async () => {
  const alternative = binding({ plugin: "demo", entry: { kind: "agent", name: "verifier" } })
  const swapping = bound({
    id: "swapping",
    binding: binding({ plugin: "absent" }),
    fallback: { _tag: "AlternativeBinding", binding: alternative },
  })

  const { events, prompt } = await withEngine(
    { swapping: { output: { summary: "did the work" }, text: "done" } },
    ({ runId, start }) =>
      Effect.gen(function* () {
        yield* start(block("work", swapping.id), catalog([swapping]))
        const events = yield* readEvents(runId)
        const composed = of(events, "ArtifactCreated").find(
          (event) => event.payload.kind === "prompt",
        )!
        return { events, prompt: yield* Effect.promise(() => readFile(composed.payload.path, "utf8")) }
      }),
    { CLAUDE_CONFIG_DIR: await pluginHome([demo]) },
  )

  expect(of(events, "PluginResolved").map((event) => event.payload)).toMatchObject([
    {
      plugin: { name: "demo", version: "4.15.6" },
      entry: { kind: "agent", name: "verifier" },
      alternative: true,
    },
  ])
  expect(prompt.split("\n")[0]).toContain("demo:verifier agent")
  // The failure that forced the swap stays in the log; the substitution is never silent.
  expect(
    of(events, "ErrorRaised").map((event) => event.payload.signature),
  ).toContain("plugin-missing")
}, 60_000)

it("refuses a plugin whose state files reach outside the worktree", () => {
  const escaping = bound({
    id: "escaping",
    binding: binding({ stateFiles: ["../../elsewhere/**"] }),
  })

  const errors = validateWorkflow(
    { runId: RunId.make("r"), templateId: "t", root: block("work", escaping.id) },
    catalog([escaping]),
  )

  expect(errors.map((error) => error.rule)).toEqual(["plugin-state-files"])
})

it("refuses an outer retry loop around a plugin that manages its own retries", () => {
  const self = bound({ id: "self-retrying", binding: binding({ managesInternalRetries: true }) })
  const loop = (node: ReturnType<typeof block>) => ({
    _tag: "Loop" as const,
    body: { _tag: "Sequence" as const, children: [node, block("verify", verifyOutput.id)] },
    policy: correctivePolicy.id,
    kind: "corrective" as const,
    feedbackRoute: { from: id("verify"), to: node.id },
  })

  const declared = validateWorkflow(
    { runId: RunId.make("r"), templateId: "t", root: loop(block("work", self.id)) },
    catalog([self]),
  )
  expect(declared.map((error) => error.rule)).toContain("double-retry")

  // The same rule has to fire on a binding the Analyzer chose, not only on a declared one.
  const chosen = validateWorkflow(
    {
      runId: RunId.make("r"),
      templateId: "t",
      root: loop(
        block("work", agentTask.id, {
          overrides: { binding: binding({ managesInternalRetries: true }) },
        }),
      ),
    },
    catalog(),
  )
  expect(chosen.map((error) => error.rule)).toContain("double-retry")

  const single = validateWorkflow(
    {
      runId: RunId.make("r"),
      templateId: "t",
      root: { ...loop(block("work", self.id)), policy: singleAttemptPolicy.id },
    },
    catalog([self]),
  )
  expect(single.map((error) => error.rule)).not.toContain("double-retry")
})
