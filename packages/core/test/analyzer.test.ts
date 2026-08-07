import { Effect, Either } from "effect"
import { readFile } from "node:fs/promises"
import { expect, it } from "vitest"
import {
  Analyzer,
  AnalyzerDecision,
  blocksIn,
  coreBlocks,
  coreRetryPolicies,
  coreTemplates,
  correctivePolicy,
  defaultDecision,
  instantiate,
  Journal,
  PluginBinding,
  RunId,
  validateWorkflow,
  WorkflowNode,
  WorkflowTemplate,
} from "../src/index.js"
import { fakeProviders, writeScript } from "./engine-harness.js"
import { fixturePath, payloads, readEvents, runPlanning, tempHome } from "./helpers.js"

/** A string answer is one the Analyzer talked through without writing the file it was asked for. */
type Answer = Partial<AnalyzerDecision> | string

const analyze = async (
  script: Readonly<Record<string, Answer>>,
  prompt = "rename the parser field everywhere it is read",
) => {
  const home = await tempHome()
  const runId = await writeScript(
    Object.fromEntries(
      Object.entries(script).map(([key, value]) => [
        key,
        typeof value === "string" ? { text: value } : { output: value },
      ]),
    ),
  )
  return runPlanning(
    home,
    Effect.gen(function* () {
      const journal = yield* Journal
      const analyzer = yield* Analyzer
      yield* journal.createRun({ runId, projectId: "proj", prompt })

      const outcome = yield* Effect.either(
        analyzer.analyze({
          runId,
          prompt,
          project: { name: "sample", rules: { language: "English" } },
          templates: coreTemplates,
          policies: coreRetryPolicies,
          capabilities: ["claude-code 9.9.9"],
          cwd: fixturePath("."),
        }),
      )

      const events = yield* readEvents(runId)
      const prompts = yield* Effect.forEach(
        events.flatMap((event) =>
          event.payload._tag === "ArtifactCreated" && event.payload.kind === "analyzer-prompt"
            ? [event.payload.path]
            : [],
        ),
        (path) => Effect.promise(() => readFile(path, "utf8")),
      )
      return { outcome, events, prompts }
    }),
    fakeProviders,
  )
}

const valid = {
  templateId: "task",
  params: { focus: "the parser field and its readers" },
  optionalBlockToggles: { explore: false },
  bindingChoices: {},
  retryCounts: { implement: 99 },
  rationale: "the change spans callers, so it needs a plan and a corrective loop",
}

const ids = (root: WorkflowNode) => blocksIn(root).map((block) => block.id)

it("ships core templates that pass the validator however their optional blocks are set", () => {
  for (const template of coreTemplates) {
    const settings: ReadonlyArray<Readonly<Record<string, boolean>>> = [
      {},
      Object.fromEntries(template.optionalBlocks.map((optional) => [optional.blockId, false])),
      Object.fromEntries(template.optionalBlocks.map((optional) => [optional.blockId, true])),
    ]
    for (const optionalBlockToggles of settings) {
      const decision = { ...defaultDecision(template), optionalBlockToggles }
      const { root, policies } = instantiate(template, decision, coreRetryPolicies)
      const errors = validateWorkflow(
        { runId: RunId.make("seed"), templateId: template.id, root },
        { blocks: coreBlocks, policies },
      )
      expect(`${template.id}: ${errors.map((error) => error.message).join("; ")}`).toBe(
        `${template.id}: `,
      )
    }
  }
})

it("leaves a chosen binding's own slots for the engine to render later", () => {
  const quickfix = coreTemplates.find((template) => template.id === "quickfix")!
  const houseStyle: PluginBinding = {
    plugin: "demo",
    entry: { kind: "slash", name: "review" },
    argsTemplate: "{{prompt}}",
    requiredCapabilities: [],
    managesInternalRetries: false,
    cancellation: "kill-tree",
  }
  const template: WorkflowTemplate = {
    ...quickfix,
    allowedBindings: { implement: [houseStyle] },
  }

  const { root } = instantiate(
    template,
    {
      ...defaultDecision(template),
      // A param named like the binding's own slot, which is exactly what would overwrite it.
      params: { prompt: "the analyzer's idea of the task" },
      bindingChoices: { implement: 0 },
    },
    coreRetryPolicies,
  )

  const implement = blocksIn(root).find((block) => block.id === "implement")
  expect(implement?.overrides?.binding).toEqual(houseStyle)
})

it("instantiates the chosen template from a valid decision", async () => {
  const { outcome, events } = await analyze({ "analyzer:1": valid })

  const analyzed = Either.getOrThrow(outcome)
  expect(analyzed.fallback).toBe(false)
  expect(analyzed.tree.templateId).toBe("task")

  // The toggled-off block is gone, and the block that read it no longer names it as a source.
  expect(ids(analyzed.tree.root)).toEqual(["plan", "implement", "verify"])
  const plan = blocksIn(analyzed.tree.root).find((block) => block.id === "plan")
  expect(plan?.inputs ?? []).toEqual([])

  // Parameters reach the prompt slots the template declared.
  const verify = blocksIn(analyzed.tree.root).find((block) => block.id === "verify")
  expect(verify?.overrides?.promptTemplate).toContain("the parser field and its readers")
  expect(verify?.overrides?.promptTemplate).not.toContain("{{")

  // 99 attempts is clamped to what the template allows, as a policy the run's catalog now carries.
  const loop = (analyzed.tree.root as Extract<WorkflowNode, { _tag: "Sequence" }>).children.find(
    (child) => child._tag === "Loop",
  )
  expect(loop?._tag === "Loop" && loop.policy).toBe(`${correctivePolicy.id}@implement:5`)
  expect(analyzed.policies.find((policy) => policy.id === `${correctivePolicy.id}@implement:5`))
    .toMatchObject({ maxAttempts: 5 })

  const journaled = events.flatMap((event) =>
    event.payload._tag === "TreeAnalyzed" ? [event.payload] : [],
  )
  expect(journaled).toMatchObject([
    { templateId: "task", fallback: false, rationale: valid.rationale },
  ])
  expect(journaled[0].decision).toMatchObject({ retryCounts: { implement: 99 } })
})

it("retries once with the validation error appended to the prompt", async () => {
  const { outcome, prompts } = await analyze(
    {
      "analyzer:1": { ...valid, params: { focus: 42 }, bindingChoices: { implement: 3 } },
      "analyzer:2": valid,
    },
  )

  expect(Either.getOrThrow(outcome).fallback).toBe(false)
  expect(prompts).toHaveLength(2)
  expect(prompts[0]).not.toContain("Your previous answer was rejected")
  expect(prompts[1]).toContain("Your previous answer was rejected")
  expect(prompts[1]).toContain('params: field "focus" must be string, got number')
  expect(prompts[1]).toContain("bindingChoices names implement, which template task does not bind")
})

it("falls back to the defaults of a template that declares no parameters", async () => {
  // quickfix has nothing to toggle, so naming a toggle is what makes both answers invalid.
  const stubborn = { ...valid, templateId: "quickfix" }
  const { outcome, events } = await analyze({ "analyzer:1": stubborn, "analyzer:2": stubborn })

  const analyzed = Either.getOrThrow(outcome)
  expect(analyzed.fallback).toBe(true)
  expect(analyzed.tree.templateId).toBe("quickfix")
  expect(ids(analyzed.tree.root)).toEqual(["implement", "verify"])

  const analyzedEvent = events.flatMap((event) =>
    event.payload._tag === "TreeAnalyzed" ? [event.payload] : [],
  )
  expect(analyzedEvent[0]).toMatchObject({ fallback: true })
  expect(analyzedEvent[0].warning).toContain("using quickfix defaults")
  expect(analyzedEvent[0].warning).toContain("optionalBlockToggles names explore")
})

it("fails the run rather than falling back to a template whose parameters stay empty", async () => {
  const stubborn = { ...valid, templateId: "guarded-fix" }
  const { outcome, events } = await analyze({ "analyzer:1": stubborn, "analyzer:2": stubborn })

  const failure = Either.getOrThrow(Either.flip(outcome))
  expect(failure).toMatchObject({ _tag: "ValidationError", rule: "analyzer-decision" })
  expect(failure.message).toContain("guarded-fix")
  expect(failure.message).toContain('missing required field "checkCommand"')
  // No tree was built, so nothing downstream can mistake the hollow one for a decision.
  expect(payloads(events)).not.toContain("TreeAnalyzed")
})

it("fails the run when the chosen template does not exist", async () => {
  const { outcome, events } = await analyze(
    {
      "analyzer:1": { ...valid, templateId: "invent-something" },
      "analyzer:2": { ...valid, templateId: "invent-something" },
    },
  )

  const failure = Either.getOrThrow(Either.flip(outcome))
  expect(failure._tag).toBe("ValidationError")
  expect(failure.message).toContain("invent-something")
  expect(failure.message).toContain("quickfix")
  expect(payloads(events)).not.toContain("TreeAnalyzed")
})

it("fails the run when the Analyzer writes no decision at all", async () => {
  const { outcome } = await analyze({ "analyzer:1": "I would rather not" })

  const failure = Either.getOrThrow(Either.flip(outcome))
  expect(failure.message).toContain("no JSON result was written")
})
