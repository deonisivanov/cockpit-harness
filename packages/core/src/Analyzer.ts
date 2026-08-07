import { Context, Effect, Layer, Schema } from "effect"
import { mkdir, rm } from "node:fs/promises"
import * as NodePath from "node:path"
import { ArtifactStore, readAgentOutput } from "./ArtifactStore.js"
import { ClaudeCodeProvider } from "./ClaudeCodeProvider.js"
import { CodexProvider } from "./CodexProvider.js"
import { JournalError, ProviderError, ValidationError } from "./errors.js"
import { BlockId, RunId } from "./ids.js"
import { Journal } from "./Journal.js"
import { Provider, ProviderName, runToResult } from "./Provider.js"
import { WorkflowTemplate } from "./templates.js"
import { renderSlots } from "./text.js"
import {
  contractProblems,
  PluginBinding,
  RetryPolicy,
  WorkflowNode,
  WorkflowTree,
} from "./workflow.js"
import { blocksIn } from "./WorkflowValidator.js"

const analyzerTimeoutMs = 5 * 60_000

const toggles = Schema.Record({ key: Schema.String, value: Schema.Boolean })

/**
 * Every field but the template id has a default: an Analyzer that answers only "use `quickfix`"
 * has made a valid, complete decision, and demanding empty objects would turn that into a retry.
 */
export const AnalyzerDecision = Schema.Struct({
  templateId: Schema.String,
  params: Schema.optionalWith(Schema.Unknown, { default: (): unknown => ({}) }),
  optionalBlockToggles: Schema.optionalWith(toggles, { default: () => ({}) }),
  bindingChoices: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.Int }), {
    default: () => ({}),
  }),
  retryCounts: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.Int }), {
    default: () => ({}),
  }),
  rationale: Schema.optionalWith(Schema.String, { default: () => "" }),
})
export type AnalyzerDecision = typeof AnalyzerDecision.Type

const decodeDecision = Schema.decodeUnknown(Schema.parseJson(AnalyzerDecision), { errors: "all" })

export const defaultDecision = (template: WorkflowTemplate): AnalyzerDecision => ({
  templateId: template.id,
  params: {},
  optionalBlockToggles: Object.fromEntries(
    template.optionalBlocks.map((optional) => [optional.blockId, optional.default]),
  ),
  bindingChoices: {},
  retryCounts: {},
  rationale: "",
})

/**
 * What Schema alone cannot say: the decision has to fit the template it names. Out-of-range retry
 * counts are not listed — the bounds exist to be clamped to, not to be argued about.
 */
const decisionProblems = (
  template: WorkflowTemplate,
  decision: AnalyzerDecision,
): ReadonlyArray<string> => {
  const optional = new Set(template.optionalBlocks.map((entry) => entry.blockId as string))
  return [
    ...contractProblems(template.params, decision.params).map(
      (problem) => `params: ${problem}`,
    ),
    ...Object.keys(decision.optionalBlockToggles).flatMap((blockId) =>
      optional.has(blockId)
        ? []
        : [`optionalBlockToggles names ${blockId}, which template ${template.id} cannot toggle`],
    ),
    ...Object.entries(decision.bindingChoices).flatMap(([blockId, index]) => {
      const allowed = template.allowedBindings[blockId]
      if (allowed === undefined) {
        return [`bindingChoices names ${blockId}, which template ${template.id} does not bind`]
      }
      return index >= 0 && index < allowed.length
        ? []
        : [
            `bindingChoices picks ${index} for ${blockId}, which allows ${allowed.length} binding(s)`,
          ]
    }),
    ...Object.keys(decision.retryCounts).flatMap((blockId) =>
      blockId in template.retryBounds
        ? []
        : [`retryCounts names ${blockId}, which template ${template.id} does not bound`],
    ),
  ]
}

const clamp = (value: number, bound: { readonly min: number; readonly max: number }) =>
  Math.min(Math.max(value, bound.min), bound.max)

/** A loop retries one block: the one its feedback is routed to, or the first one in its body. */
const loopTarget = (node: Extract<WorkflowNode, { _tag: "Loop" }>) =>
  node.feedbackRoute?.to ?? blocksIn(node.body)[0]?.id

const substitute = (value: unknown, params: Readonly<Record<string, unknown>>): unknown => {
  if (typeof value === "string") return renderSlots(value, params)
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, params))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        // A binding's own slots belong to the engine, which renders them against the composed
        // block prompt. Substituting decision params here would blank them before it ever ran.
        key === "binding" ? entry : substitute(entry, params),
      ]),
    )
  }
  return value
}

export interface Instantiated {
  readonly root: WorkflowNode
  /** Loop policies derived from the decision's retry counts; merged into the run's catalog. */
  readonly policies: ReadonlyArray<RetryPolicy>
}

export const instantiate = (
  template: WorkflowTemplate,
  decision: AnalyzerDecision,
  policies: ReadonlyArray<RetryPolicy>,
): Instantiated => {
  const known = new Map(policies.map((policy) => [policy.id, policy]))
  const derived = new Map<string, RetryPolicy>()

  const off = new Set(
    template.optionalBlocks.flatMap((optional) =>
      (decision.optionalBlockToggles[optional.blockId] ?? optional.default)
        ? []
        : [optional.blockId as string],
    ),
  )

  const bindingFor = (blockId: BlockId): PluginBinding | undefined => {
    const index = decision.bindingChoices[blockId]
    return index === undefined ? undefined : template.allowedBindings[blockId]?.[index]
  }

  const policyFor = (node: Extract<WorkflowNode, { _tag: "Loop" }>) => {
    const target = loopTarget(node)
    const bound = target === undefined ? undefined : template.retryBounds[target]
    const wanted = target === undefined ? undefined : decision.retryCounts[target]
    const base = known.get(node.policy)
    if (bound === undefined || wanted === undefined || base === undefined) return node.policy
    const maxAttempts = clamp(wanted, bound)
    const id = `${base.id}@${target}:${maxAttempts}`
    derived.set(id, { ...base, id, maxAttempts })
    return id
  }

  const walk = (node: WorkflowNode): WorkflowNode | undefined => {
    switch (node._tag) {
      case "Block": {
        if (off.has(node.id)) return undefined
        const binding = bindingFor(node.id)
        const inputs = node.inputs?.filter((source) => !off.has(source))
        return {
          ...node,
          ...(inputs === undefined ? {} : { inputs }),
          ...(binding === undefined ? {} : { overrides: { ...node.overrides, binding } }),
        }
      }
      case "Gate":
        return off.has(node.id) ? undefined : node
      case "Sequence":
        return { ...node, children: node.children.flatMap((child) => walk(child) ?? []) }
      case "Parallel":
        return {
          ...node,
          branches: node.branches.flatMap((branch) => {
            const kept = walk(branch.node)
            return kept === undefined ? [] : [{ ...branch, node: kept }]
          }),
        }
      case "Condition": {
        const onTrue = walk(node.onTrue)
        const onFalse = node.onFalse === undefined ? undefined : walk(node.onFalse)
        return onTrue === undefined
          ? onFalse
          : { ...node, onTrue, ...(onFalse === undefined ? {} : { onFalse }) }
      }
      case "Loop": {
        const body = walk(node.body)
        return body === undefined ? undefined : { ...node, body, policy: policyFor(node) }
      }
    }
  }

  const pruned = walk(template.tree) ?? { _tag: "Sequence", children: [] }
  const params =
    typeof decision.params === "object" && decision.params !== null
      ? (decision.params as Record<string, unknown>)
      : {}

  return {
    root: substitute(pruned, params) as WorkflowNode,
    policies: [...policies, ...derived.values()],
  }
}

export interface AnalyzeInput {
  readonly runId: RunId
  readonly prompt: string
  readonly project: { readonly name: string; readonly rules: Readonly<Record<string, unknown>> }
  readonly templates: ReadonlyArray<WorkflowTemplate>
  readonly policies: ReadonlyArray<RetryPolicy>
  /** Preflight lines: which providers and plugin entries this machine can actually run. */
  readonly capabilities: ReadonlyArray<string>
  readonly cwd: string
  readonly provider?: ProviderName
}

export interface Analyzed {
  readonly tree: WorkflowTree
  readonly decision: AnalyzerDecision
  readonly policies: ReadonlyArray<RetryPolicy>
  readonly fallback: boolean
}

export type AnalyzerError = ProviderError | JournalError | ValidationError

export class Analyzer extends Context.Tag("cockpit/Analyzer")<
  Analyzer,
  { readonly analyze: (input: AnalyzeInput) => Effect.Effect<Analyzed, AnalyzerError> }
>() {}

const describe = (template: WorkflowTemplate) =>
  [
    `### ${template.id}`,
    template.description,
    ...(template.params.length === 0
      ? []
      : [
          `params: ${template.params
            .map((param) => `${param.name}: ${param.type}${param.required ? " (required)" : ""}`)
            .join(", ")}`,
        ]),
    ...template.optionalBlocks.map(
      (optional) =>
        `optional block ${optional.blockId} (default ${optional.default}): ${optional.hint}`,
    ),
    ...Object.entries(template.allowedBindings).map(
      ([blockId, bindings]) =>
        `bindings for ${blockId}: ${bindings
          .map(
            (binding, index) =>
              `${index}) ${binding.plugin === undefined ? "" : `${binding.plugin} `}${binding.entry.kind} ${binding.entry.name}`,
          )
          .join(", ")}`,
    ),
    ...Object.entries(template.retryBounds).map(
      ([blockId, bound]) => `retry bounds for ${blockId}: ${bound.min}..${bound.max}`,
    ),
  ].join("\n")

const analyzerPrompt = (input: AnalyzeInput, outputPath: string, problem?: string) =>
  [
    "# Workflow analysis",
    "",
    "Choose the workflow template that fits the task below and parameterize it. You are not writing",
    "a workflow: you pick one of the templates verbatim and fill in what it declares.",
    "",
    "## Task",
    input.prompt,
    "",
    "## Project",
    `name: ${input.project.name}`,
    ...(Object.keys(input.project.rules).length === 0
      ? []
      : ["rules:", "```json", JSON.stringify(input.project.rules, null, 2), "```"]),
    "",
    "## Available capabilities",
    ...(input.capabilities.length === 0
      ? ["(none reported)"]
      : input.capabilities.map((capability) => `- ${capability}`)),
    "",
    "## Templates",
    ...input.templates.map(describe),
    "",
    "## Output contract",
    `Write your decision as a single JSON object to the file at $COCKPIT_OUTPUT (${outputPath}).`,
    "It must contain:",
    "- templateId: string — the id of one template above, exactly as written",
    "- params: object — a value for every param the chosen template declares",
    "- optionalBlockToggles: object — block id to boolean, only for that template's optional blocks",
    "- bindingChoices: object — block id to the index of the chosen binding, only where it allows one",
    "- retryCounts: object — block id to attempt count, only within that template's retry bounds",
    "- rationale: string — one short paragraph on why this template and these choices",
    "Do not modify the repository. Nothing else counts as your answer.",
    ...(problem === undefined
      ? []
      : [
          "",
          "## Your previous answer was rejected",
          problem,
          "Answer again, fixing exactly that.",
        ]),
  ].join("\n")

/** The rejection the next call is told about, in the words the Analyzer has to act on. */
const describeProblems = (
  byId: ReadonlyMap<string, WorkflowTemplate>,
  decision: AnalyzerDecision,
) => {
  const template = byId.get(decision.templateId)
  if (template === undefined) {
    return `templateId "${decision.templateId}" is not one of: ${[...byId.keys()].join(", ")}`
  }
  const problems = decisionProblems(template, decision)
  return problems.length === 0 ? undefined : problems.join("; ")
}

interface Answer {
  readonly decision?: AnalyzerDecision
  readonly problem?: string
}

export const AnalyzerLive = Layer.effect(
  Analyzer,
  Effect.gen(function* () {
    const journal = yield* Journal
    const artifacts = yield* ArtifactStore
    const claude = yield* ClaudeCodeProvider
    const codex = yield* CodexProvider

    const ask = (input: AnalyzeInput, outputPath: string, problem?: string) =>
      Effect.gen(function* () {
        const provider: Provider = input.provider === "codex" ? codex : claude
        const prompt = analyzerPrompt(input, outputPath, problem)
        const promptRef = yield* artifacts.write({
          runId: input.runId,
          kind: "analyzer-prompt",
          name: "analyzer.md",
          content: prompt,
        })
        yield* journal.append({
          runId: input.runId,
          payload: { _tag: "PromptComposed", promptRef: promptRef.id },
        })

        yield* Effect.promise(() => rm(outputPath, { force: true }))
        yield* runToResult(
          provider.run({
            prompt,
            cwd: input.cwd,
            permissionProfile: "read-plus-output",
            outputDir: NodePath.dirname(outputPath),
            timeoutMs: analyzerTimeoutMs,
            env: { COCKPIT_OUTPUT: outputPath, COCKPIT_BLOCK: "analyzer" },
          }),
          () => Effect.void,
        )

        const written = yield* readAgentOutput(outputPath)
        if (written.text === undefined) {
          return { problem: written.problem ?? "no decision was written" } satisfies Answer
        }
        const decoded = yield* Effect.either(decodeDecision(written.text))
        return (
          decoded._tag === "Left"
            ? { problem: decoded.left.message }
            : { decision: decoded.right }
        ) satisfies Answer
      })

    const analyze = (input: AnalyzeInput) =>
      Effect.gen(function* () {
        const dir = yield* artifacts.runDir(input.runId)
        yield* Effect.tryPromise({
          try: () => mkdir(dir, { recursive: true }),
          catch: (cause) =>
            new JournalError({ op: "analyzerDir", detail: `${dir}: ${String(cause)}` }),
        })
        const outputPath = NodePath.join(dir, "analyzer.output.json")
        const byId = new Map(input.templates.map((template) => [template.id, template]))

        // One retry, with the exact rejection appended (plan §4). A second failure is not a third
        // call: the template's own defaults are a workflow the user can still watch run.
        let attempt = yield* ask(input, outputPath)
        let problem =
          attempt.decision === undefined
            ? attempt.problem
            : describeProblems(byId, attempt.decision)
        if (problem !== undefined) {
          attempt = yield* ask(input, outputPath, problem)
          problem =
            attempt.decision === undefined
              ? attempt.problem
              : describeProblems(byId, attempt.decision)
        }

        const chosen = attempt.decision
        const template = chosen === undefined ? undefined : byId.get(chosen.templateId)
        if (chosen === undefined || template === undefined) {
          const detail =
            chosen === undefined
              ? `the Analyzer produced no usable decision: ${problem}`
              : `the Analyzer chose template "${chosen.templateId}", which does not exist; known templates: ${[...byId.keys()].join(", ")}`
          yield* journal.append({
            runId: input.runId,
            payload: {
              _tag: "ErrorRaised",
              class: "semantic",
              signature: "analyzer-template",
              message: detail,
            },
          })
          return yield* new ValidationError({
            rule: "analyzer-template",
            path: ["templateId"],
            message: detail,
          })
        }

        const fallback = problem !== undefined
        // Defaults fill in the toggles and the bounds, never the params: a template whose slots
        // stay empty renders prompts with holes in them, which is a worse run than no run at all.
        const unfilled = fallback ? contractProblems(template.params, {}) : []
        if (unfilled.length > 0) {
          const detail = `the Analyzer produced no usable decision (${problem}), and template "${template.id}" cannot fall back to its defaults: ${unfilled.join("; ")}`
          yield* journal.append({
            runId: input.runId,
            payload: {
              _tag: "ErrorRaised",
              class: "semantic",
              signature: "analyzer-decision",
              message: detail,
            },
          })
          return yield* new ValidationError({
            rule: "analyzer-decision",
            path: ["params"],
            message: detail,
          })
        }

        const decision = fallback ? defaultDecision(template) : chosen
        const instantiated = instantiate(template, decision, input.policies)

        yield* journal.append({
          runId: input.runId,
          payload: {
            _tag: "TreeAnalyzed",
            templateId: template.id,
            rationale: decision.rationale,
            decision,
            fallback,
            ...(fallback ? { warning: `using ${template.id} defaults: ${problem}` } : {}),
          },
        })

        return {
          tree: { runId: input.runId, templateId: template.id, root: instantiated.root },
          decision,
          policies: instantiated.policies,
          fallback,
        } satisfies Analyzed
      })

    return { analyze }
  }),
)
