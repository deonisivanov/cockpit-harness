import { Effect, Either } from "effect"
import { readFile } from "node:fs/promises"
import { expect, it } from "vitest"
import {
  agentTask,
  blocksIn,
  Cartridge,
  finalize,
  Journal,
  runCommand,
  RunId,
  TransformContext,
  TransformPipeline,
  treeDiff,
  ValidationError,
  verifyOutput,
  WorkflowNode,
  WorkflowTree,
} from "../src/index.js"
import { block, catalog, id } from "./trees.js"
import { readEvents, runPlanning, tempHome } from "./helpers.js"

const context: TransformContext = {
  projectName: "sample",
  prompt: "make the thing work",
  rules: { language: "English" },
}

const seen: string[] = []

const runPipeline = async (
  cartridge: Cartridge | undefined,
  root: WorkflowNode = block("a", agentTask.id),
) => {
  const home = await tempHome()
  const runId = RunId.make(`run-${Math.random().toString(36).slice(2)}`)
  seen.length = 0

  return runPlanning(
    home,
    Effect.gen(function* () {
      const journal = yield* Journal
      const pipeline = yield* TransformPipeline
      yield* journal.createRun({ runId, projectId: "proj", prompt: context.prompt })

      const outcome = yield* Effect.either(
        pipeline.apply({
          tree: { runId, templateId: "start", root },
          cartridge,
          context,
          catalog: catalog(),
        }),
      )
      const events = yield* readEvents(runId)
      const diffs = yield* Effect.forEach(
        events.flatMap((event) =>
          event.payload._tag === "ArtifactCreated" && event.payload.kind === "tree-diff"
            ? [event.payload.path]
            : [],
        ),
        (path) => Effect.promise(() => readFile(path, "utf8")),
      )
      return { outcome, events, diffs, order: [...seen] }
    }),
  )
}

const cartridge = (patch: Partial<Cartridge>): Cartridge => ({ name: "sample", ...patch })

it("runs transforms in declared order and journals what each one changed", async () => {
  const { outcome, events, diffs, order } = await runPipeline(
    cartridge({
      transforms: [
        {
          name: "first",
          apply: (tree) => {
            seen.push("first")
            return { ...tree, templateId: "after-first" }
          },
        },
        {
          name: "second",
          apply: (tree) => {
            seen.push("second")
            return {
              ...tree,
              root: { _tag: "Sequence", children: [tree.root, block("b", agentTask.id)] },
            }
          },
        },
      ],
    }),
  )

  expect(order).toEqual(["first", "second"])
  expect(Either.getOrThrow(outcome).templateId).toBe("after-first")

  expect(
    events.flatMap((event) =>
      event.payload._tag === "TreeTransformed" ? [event.payload.name] : [],
    ),
  ).toEqual(["first", "second"])
  expect(diffs[0]).toContain("root.templateId: \"start\" -> \"after-first\"")
  expect(diffs[1]).toContain("root.root")
  expect(diffs[1]).toContain("\"b\"")
})

it("diffs a transform that edits the tree in place instead of rebuilding it", async () => {
  const { outcome, diffs } = await runPipeline(
    cartridge({
      transforms: [
        {
          name: "retitle-in-place",
          apply: (tree) => {
            ;(tree as { templateId: string }).templateId = "mutated"
            return tree
          },
        },
      ],
    }),
  )

  expect(Either.getOrThrow(outcome).templateId).toBe("mutated")
  expect(diffs[0]).toContain('root.templateId: "start" -> "mutated"')
})

const isFinalizeBlock = (node: WorkflowNode): boolean =>
  node._tag === "Block" && node.def === finalize.id

const appendBeforeFinalize = (tree: WorkflowTree): WorkflowTree => {
  const gate = block("lint", runCommand.id, {
    overrides: { command: { argv: ["bash", "-lc", "npm run lint"] } },
  })
  const root = tree.root
  if (root._tag === "Sequence" && root.children.some(isFinalizeBlock)) {
    return {
      ...tree,
      root: {
        ...root,
        children: root.children.flatMap((child) => (isFinalizeBlock(child) ? [gate, child] : [child])),
      },
    }
  }
  return { ...tree, root: { _tag: "Sequence", children: [root, gate] } }
}

// Appending unconditionally would land the gate after finalize on any tree that already has one.
it("appends the gate after a finalize-less tree, and before finalize on one that has it", async () => {
  const withoutFinalize = await runPipeline(
    cartridge({ transforms: [{ name: "append-lint", apply: appendBeforeFinalize }] }),
    {
      _tag: "Sequence",
      children: [
        block("implement", agentTask.id),
        block("verify", verifyOutput.id, { inputs: [id("implement")] }),
      ],
    },
  )
  expect(blocksIn(Either.getOrThrow(withoutFinalize.outcome).root).map((node) => node.id)).toEqual([
    "implement",
    "verify",
    "lint",
  ])

  const withFinalize = await runPipeline(
    cartridge({ transforms: [{ name: "append-lint", apply: appendBeforeFinalize }] }),
    {
      _tag: "Sequence",
      children: [
        block("implement", agentTask.id),
        block("verify", verifyOutput.id, { inputs: [id("implement")] }),
        block("finalize", finalize.id),
      ],
    },
  )
  expect(blocksIn(Either.getOrThrow(withFinalize.outcome).root).map((node) => node.id)).toEqual([
    "implement",
    "verify",
    "lint",
    "finalize",
  ])
})

it("hands every transform the project context", async () => {
  const captured: TransformContext[] = []
  const { outcome } = await runPipeline(
    cartridge({
      transforms: [
        {
          name: "record-context",
          apply: (tree, ctx) => {
            captured.push(ctx)
            return tree
          },
        },
      ],
    }),
  )

  expect(Either.isRight(outcome)).toBe(true)
  expect(captured).toEqual([context])
})

it("surfaces a thrown rejection as a transform-stage cartridge error", async () => {
  const { outcome } = await runPipeline(
    cartridge({
      transforms: [
        {
          name: "forbid-bare-agent",
          apply: () => {
            throw new Error("every agent block needs a verifier after it")
          },
        },
      ],
    }),
  )

  const failure = Either.getOrThrow(Either.flip(outcome))
  expect(failure).toMatchObject({ _tag: "CartridgeError", stage: "transform" })
  expect(failure.message).toContain("forbid-bare-agent")
  expect(failure.message).toContain("every agent block needs a verifier after it")
})

it("surfaces a returned error the same way as a thrown one", async () => {
  const { outcome } = await runPipeline(
    cartridge({
      transforms: [
        {
          name: "returns-an-error",
          apply: () => new Error("this tree writes outside the worktree") as unknown as WorkflowTree,
        },
      ],
    }),
  )

  expect(Either.getOrThrow(Either.flip(outcome))).toMatchObject({
    _tag: "CartridgeError",
    stage: "transform",
  })
})

it("rejects the run when a transform leaves the tree invalid", async () => {
  const { outcome, events } = await runPipeline(
    cartridge({
      transforms: [
        {
          name: "insert-unknown-block",
          apply: (tree) => ({
            ...tree,
            root: { _tag: "Sequence", children: [tree.root, block("ghost", "no-such-block")] },
          }),
        },
      ],
    }),
  )

  const failure = Either.getOrThrow(Either.flip(outcome))
  expect(failure).toMatchObject({ _tag: "ValidationError", rule: "unknown-block-def" })
  expect(
    events.flatMap((event) =>
      event.payload._tag === "TreeValidated" ? event.payload.errors.map((e) => e.rule) : [],
    ),
  ).toEqual(["unknown-block-def"])
})

it("rejects the run when a cartridge validator refuses the transformed tree", async () => {
  const { outcome } = await runPipeline(
    cartridge({
      validators: [
        {
          name: "needs-a-gate",
          check: (tree) => [
            new ValidationError({
              rule: "gate-required",
              path: [tree.templateId],
              message: "this project approves every plan before it runs",
            }),
          ],
        },
      ],
    }),
  )

  const failure = Either.getOrThrow(Either.flip(outcome))
  expect(failure).toMatchObject({
    _tag: "ValidationError",
    rule: "sample/needs-a-gate:gate-required",
  })
})

it("passes a tree with no cartridge straight through the core validator", async () => {
  const { outcome, order } = await runPipeline(undefined, block("a", agentTask.id, {
    inputs: [id("nowhere")],
  }))

  expect(order).toEqual([])
  expect(Either.getOrThrow(Either.flip(outcome))).toMatchObject({ rule: "input-contract" })
})

it("reports a change by its path in the tree", () => {
  expect(treeDiff({ a: 1, b: { c: "x" } }, { a: 1, b: { c: "y" } })).toEqual([
    'root.b.c: "x" -> "y"',
  ])
  expect(treeDiff({ list: [1] }, { list: [1, 2] })).toEqual(["root.list[1]: undefined -> 2"])
  expect(treeDiff({ a: 1 }, { a: 1 })).toEqual([])
})
