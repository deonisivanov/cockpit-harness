import { Effect, Either, Fiber, Schedule } from "effect"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import * as NodePath from "node:path"
import { expect, it } from "vitest"
import {
  buildRegistry,
  Cartridge,
  CartridgeError,
  CartridgeLoader,
  coreBlocks,
  coreRetryPolicies,
  coreTemplates,
  RunId,
  singleAttemptPolicy,
  WorkflowNode,
  WorkflowTree,
} from "../src/index.js"
import { fixturePath, runPlanning, tempDir, tempHome } from "./helpers.js"

const validConfig = (name: string) => `export default {
  name: ${JSON.stringify(name)},
  rules: { language: "English" },
}
`

const promptBlock = (patch: Readonly<Record<string, string>>) => `export default {
  name: "prompt-file",
  blocks: [
    {
      id: "prompt-block",
      kind: "agent",
      title: "Read the prompt from the file it names",
      input: [],
      output: [],
      sessionPolicy: "fresh",
      retryPolicy: "single-attempt",
      timeoutMs: 1000,
      permissionProfile: "workspace-write",
      workspaceAccess: "write",
      successCriteria: [],
      fallback: { _tag: "Fail" },
      ...${JSON.stringify(patch)},
    },
  ],
}
`

const writeCartridge = async (source: string) => {
  const repoPath = await tempDir("cockpit-cartridge-")
  const dir = NodePath.join(repoPath, ".cockpit")
  await mkdir(dir, { recursive: true })
  const path = NodePath.join(dir, "cockpit.config.ts")
  await writeFile(path, source)
  return { repoPath, path }
}

const load = async (repoPath: string) =>
  runPlanning(
    await tempHome(),
    Effect.flatMap(CartridgeLoader, (loader) => Effect.either(loader.load(repoPath))),
  )

// The watcher only marks the path stale, so a reload lands on the next access — polled rather than
// slept on, so a slow file-system event waits instead of failing.
const until = <A>(load: Effect.Effect<A, CartridgeError>, ready: (entry: A) => boolean) =>
  Effect.retry(
    Effect.filterOrFail(load, ready, () => "not yet" as const),
    Schedule.spaced("50 millis").pipe(Schedule.intersect(Schedule.recurs(100))),
  )

const errorOf = <A>(result: Either.Either<A, CartridgeError>) => {
  if (Either.isRight(result)) throw new Error("expected a CartridgeError")
  return result.left
}

const valueOf = <A>(result: Either.Either<A, CartridgeError>) => {
  if (Either.isLeft(result)) throw new Error(`unexpected ${result.left.stage}: ${result.left.detail}`)
  return result.right
}

it("loads a cartridge and records the hash of the file it loaded", async () => {
  const { repoPath, path } = await writeCartridge(validConfig("temp-project"))
  const loaded = valueOf(await load(repoPath))

  expect(loaded.config.name).toBe("temp-project")
  expect(loaded.path).toBe(path)
  expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/)
})

it("rejects a cartridge that does not compile", async () => {
  const { repoPath } = await writeCartridge("export default { name: 'broken',,, }\n")
  const failure = errorOf(await load(repoPath))

  expect(failure._tag).toBe("CartridgeError")
  expect(failure.stage).toBe("load")
})

it("rejects a cartridge that compiles but breaks the contract", async () => {
  const { repoPath } = await writeCartridge(`export default { name: "Not A Slug", blocks: 7 }\n`)
  const failure = errorOf(await load(repoPath))

  expect(failure.stage).toBe("validate")
  expect(failure.detail).toContain("name")
})

it("takes an analyzer model but not an empty one", async () => {
  const configured = await writeCartridge(
    `export default { name: "tuned", analyzer: { model: "opus", effort: "max" } }\n`,
  )
  expect(valueOf(await load(configured.repoPath)).config.analyzer).toEqual({
    model: "opus",
    effort: "max",
  })

  const blank = await writeCartridge(`export default { name: "blank", analyzer: { model: "" } }\n`)
  const failure = errorOf(await load(blank.repoPath))

  expect(failure.stage).toBe("validate")
  expect(failure.detail).toContain("model")
})

it("rejects a project with no cartridge file", async () => {
  const repoPath = await tempDir("cockpit-bare-")
  const failure = errorOf(await load(repoPath))

  expect(failure.stage).toBe("load")
  expect(failure.detail).toContain("cockpit.config.ts")
})

it("serves the cached cartridge until the file changes, then reloads it", async () => {
  const { repoPath, path } = await writeCartridge(validConfig("before"))
  const home = await tempHome()

  const names = await runPlanning(
    home,
    Effect.gen(function* () {
      const loader = yield* CartridgeLoader
      const first = yield* loader.load(repoPath)
      const cached = yield* loader.load(repoPath)

      yield* Effect.promise(() => writeFile(path, validConfig("after")))
      const reloaded = yield* until(loader.load(repoPath), (entry) => entry.config.name === "after")

      return [first.config.name, cached.config.name, reloaded.config.name, first.hash, reloaded.hash]
    }),
  )

  expect(names.slice(0, 3)).toEqual(["before", "before", "after"])
  expect(names[3]).not.toBe(names[4])
}, 30_000)

it("hashes every source in the cartridge directory and reloads when a sibling changes", async () => {
  const { repoPath, path } = await writeCartridge(
    `import { name } from "./blocks.js"\nexport default { name }\n`,
  )
  const sibling = NodePath.join(NodePath.dirname(path), "blocks.ts")
  await writeFile(sibling, `export const name = "before"\n`)
  const home = await tempHome()

  const [first, reloaded] = await runPlanning(
    home,
    Effect.gen(function* () {
      const loader = yield* CartridgeLoader
      const first = yield* loader.load(repoPath)

      yield* Effect.promise(() => writeFile(sibling, `export const name = "after"\n`))
      const reloaded = yield* until(loader.load(repoPath), (entry) => entry.config.name === "after")
      return [first, reloaded]
    }),
  )

  expect(first.config.name).toBe("before")
  expect(first.hash).not.toBe(reloaded.hash)
}, 30_000)

it("reloads after an edit that lands while the cartridge is still loading", async () => {
  // The window is between reading the directory and recording that the cartridge is current; a
  // cartridge that takes its time widens it enough to write into.
  const { repoPath, path } = await writeCartridge(
    `await new Promise((resolve) => setTimeout(resolve, 300))\n${validConfig("before")}`,
  )

  const [first, next] = await runPlanning(
    await tempHome(),
    Effect.gen(function* () {
      const loader = yield* CartridgeLoader
      const loading = yield* Effect.fork(loader.load(repoPath))
      yield* Effect.sleep("100 millis")
      yield* Effect.promise(() => writeFile(path, validConfig("after")))
      const first = yield* Fiber.join(loading)

      const next = yield* until(loader.load(repoPath), (entry) => entry.config.name === "after")
      return [first, next]
    }),
  )

  expect(first.config.name).toBe("before")
  expect(next.config.name).toBe("after")
}, 30_000)

it("refuses a prompt file that leaves the cartridge through a symlink", async () => {
  const { repoPath, path } = await writeCartridge(promptBlock({ promptFile: "./prompts/task.md" }))
  const outside = NodePath.join(repoPath, "elsewhere.md")
  await writeFile(outside, "Read from somewhere the hash never covers.\n")
  await mkdir(NodePath.join(NodePath.dirname(path), "prompts"), { recursive: true })
  await symlink(outside, NodePath.join(NodePath.dirname(path), "prompts", "task.md"))

  const failure = errorOf(await load(repoPath))

  expect(failure.stage).toBe("validate")
  expect(failure.detail).toContain("escapes .cockpit")
})

it("cannot be made to hash two different cartridges the same", async () => {
  // Unmeasured, path and content run together: an `a.ts` holding "b.tsX" digests the same bytes as
  // an empty `a.ts` beside a `b.ts` holding "X".
  const [run, split] = await Promise.all([0, 1].map(() => writeCartridge(validConfig("collide"))))
  await writeFile(NodePath.join(NodePath.dirname(run.path), "a.ts"), "b.tsX")
  await writeFile(NodePath.join(NodePath.dirname(split.path), "a.ts"), "")
  await writeFile(NodePath.join(NodePath.dirname(split.path), "b.ts"), "X")

  const hashes = await Promise.all(
    [run, split].map(async (entry) => valueOf(await load(entry.repoPath)).hash),
  )

  expect(hashes[0]).not.toBe(hashes[1])
})

it("leaves the cartridge's own node_modules out of the hash", async () => {
  const bare = await writeCartridge(validConfig("linked"))
  const installed = await writeCartridge(validConfig("linked"))
  const kit = NodePath.join(NodePath.dirname(installed.path), "node_modules", "kit")
  await mkdir(kit, { recursive: true })
  await writeFile(NodePath.join(kit, "index.ts"), `export const version = "1"\n`)

  expect(valueOf(await load(installed.repoPath)).hash).toBe(valueOf(await load(bare.repoPath)).hash)
})

it("reads a block's prompt from the file it names, and reloads when that file changes", async () => {
  const { repoPath, path } = await writeCartridge(promptBlock({ promptFile: "./prompts/task.md" }))
  const prompt = NodePath.join(NodePath.dirname(path), "prompts", "task.md")
  await mkdir(NodePath.dirname(prompt), { recursive: true })
  await writeFile(prompt, "Do the work.\n")

  const [first, rewritten] = await runPlanning(
    await tempHome(),
    Effect.gen(function* () {
      const loader = yield* CartridgeLoader
      const first = yield* loader.load(repoPath)

      yield* Effect.promise(() => writeFile(prompt, "Do it differently.\n"))
      const rewritten = yield* until(
        loader.load(repoPath),
        (entry) => entry.config.blocks?.[0]?.promptTemplate === "Do it differently.\n",
      )
      return [first, rewritten]
    }),
  )

  expect(first.config.blocks?.[0]?.promptTemplate).toBe("Do the work.\n")
  expect(first.config.blocks?.[0]?.promptFile).toBeUndefined()
  expect(first.hash).not.toBe(rewritten.hash)
}, 30_000)

it("rejects a prompt file that is missing, escapes the cartridge, or doubles an inline one", async () => {
  const cartridges = await Promise.all(
    [
      promptBlock({ promptFile: "./prompts/gone.md" }),
      promptBlock({ promptFile: "../outside.md" }),
      promptBlock({ promptFile: "/etc/hosts" }),
      promptBlock({ promptFile: "./prompts/task.md", promptTemplate: "inline" }),
    ].map(writeCartridge),
  )
  const [missing, escaping, absolute, both] = await Promise.all(
    cartridges.map(async ({ repoPath }) => errorOf(await load(repoPath))),
  )

  expect(missing.stage).toBe("validate")
  expect(missing.detail).toContain("prompts/gone.md")
  expect(escaping.stage).toBe("validate")
  expect(escaping.detail).toContain("escapes .cockpit")
  expect(absolute.detail).toContain("escapes .cockpit")
  expect(both.stage).toBe("validate")
  expect(both.detail).toContain("not both")
})

it("loads the sample cartridge a project author would write against the kit", async () => {
  const { config } = valueOf(await load(fixturePath("fixtures/sample-cartridge")))

  expect(config.name).toBe("sample")
  expect(config.transforms?.[0]?.name).toBe("append-lint")
  expect(typeof config.transforms?.[0]?.apply).toBe("function")
  expect(config.templates?.[0]?.id).toBe("lint-fix")
  expect(config.rules).toMatchObject({ language: "English" })

  expect(config.blocks?.map((block) => block.id)).toEqual(["sample-lint", "sample-implement"])
  expect(config.blocks?.[1]?.promptTemplate).toContain("Fix every lint failure")

  // The validator crosses the load boundary as a working function, not just a name: it passes the
  // cartridge's own single-loop template and refuses the same tree wrapped in a second loop.
  const check = config.validators?.[0]?.check
  const context = { projectName: "sample", prompt: "make it pass", rules: {} }
  const tree: WorkflowTree = {
    runId: RunId.make("r"),
    templateId: "lint-fix",
    root: config.templates![0].tree,
  }
  expect(check?.(tree, context)).toEqual([])
  expect(
    check?.({ ...tree, root: { ...tree.root, body: tree.root } as WorkflowNode }, context),
  ).toHaveLength(1)
})

const cartridge = (patch: Partial<Cartridge> = {}): Cartridge => ({ name: "sample", ...patch })

it("namespaces cartridge templates and leaves the core library reachable", async () => {
  const registry = await Effect.runPromise(
    buildRegistry(
      cartridge({
        templates: [{ ...coreTemplates[0], id: "task" }],
        blocks: [{ ...coreBlocks[0], id: "sample-build" }],
      }),
    ),
  )

  expect(registry.templates.map((template) => template.id)).toEqual([
    ...coreTemplates.map((template) => template.id),
    "sample/task",
  ])
  expect(registry.catalog.blocks.map((block) => block.id)).toContain("sample-build")
})

it("lets a cartridge replace a core retry policy by id but not a core block", async () => {
  const replaced = await Effect.runPromise(
    buildRegistry(
      cartridge({ retryPolicies: [{ ...singleAttemptPolicy, maxAttempts: 9 }] }),
    ),
  )
  expect(replaced.catalog.policies).toHaveLength(coreRetryPolicies.length)
  expect(
    replaced.catalog.policies.find((policy) => policy.id === singleAttemptPolicy.id)?.maxAttempts,
  ).toBe(9)

  const clash = await Effect.runPromise(
    Effect.either(buildRegistry(cartridge({ blocks: [coreBlocks[0]] }))),
  )
  expect(errorOf(clash).detail).toContain(coreBlocks[0].id)
})

it("rejects a cartridge that declares the same template twice", async () => {
  const clash = await Effect.runPromise(
    Effect.either(
      buildRegistry(
        cartridge({ templates: [coreTemplates[1], { ...coreTemplates[1], description: "other" }] }),
      ),
    ),
  )

  expect(errorOf(clash).detail).toContain(coreTemplates[1].id)
})

it("rejects a cartridge that names two transforms or two validators the same", async () => {
  const [transforms, validators] = await Promise.all(
    [
      cartridge({
        transforms: [
          { name: "tidy", apply: (tree) => tree },
          { name: "tidy", apply: (tree) => tree },
        ],
      }),
      cartridge({
        validators: [
          { name: "strict", check: () => [] },
          { name: "strict", check: () => [] },
        ],
      }),
    ].map((declared) => Effect.runPromise(Effect.either(buildRegistry(declared)))),
  )

  expect(errorOf(transforms).detail).toContain("transform names more than once: tidy")
  expect(errorOf(validators).detail).toContain("validator names more than once: strict")
})
