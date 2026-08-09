import { Schema } from "effect"
import {
  agentTask,
  answerQuestion,
  correctivePolicy,
  finalize,
  runCommand,
  verifyOutput,
} from "./blocks.js"
import { BlockId } from "./ids.js"
import { ContractField, PluginBinding, WorkflowNode } from "./workflow.js"

const NodeId = Schema.typeSchema(BlockId)

export const RetryBound = Schema.Struct({ min: Schema.Int, max: Schema.Int })
export type RetryBound = typeof RetryBound.Type

/**
 * The unit the Analyzer chooses among: a fixed tree it may only parameterize, prune at declared
 * points, bind to one of the plugins the template allows, and retry within declared bounds
 * (ADR-003). `description` is what the Analyzer reads to decide, so it says when to pick this one.
 */
export const WorkflowTemplate = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  tree: WorkflowNode,
  /** Same settlement as BlockDef IO: serializable fields, not a runtime-only Schema. */
  params: Schema.Array(ContractField),
  optionalBlocks: Schema.Array(
    Schema.Struct({ blockId: NodeId, default: Schema.Boolean, hint: Schema.String }),
  ),
  allowedBindings: Schema.Record({ key: Schema.String, value: Schema.Array(PluginBinding) }),
  /** Keyed by the block a loop retries — its feedback target, or its first block. */
  retryBounds: Schema.Record({ key: Schema.String, value: RetryBound }),
})
export type WorkflowTemplate = typeof WorkflowTemplate.Type

const id = (value: string) => BlockId.make(value)

const focusParam: ContractField = { name: "focus", type: "string", required: true }

const implementVerify: WorkflowNode = {
  _tag: "Loop",
  body: {
    _tag: "Sequence",
    children: [
      {
        _tag: "Block",
        id: id("implement"),
        def: agentTask.id,
        inputs: [id("plan")],
        overrides: {
          promptTemplate:
            "Implement the task in the worktree. Stay within {{focus}}. Follow the approved plan where one is given.",
        },
      },
      {
        _tag: "Block",
        id: id("verify"),
        def: verifyOutput.id,
        inputs: [id("implement")],
        overrides: {
          promptTemplate:
            "Independently check the implementation against the task, concentrating on {{focus}}. Report concrete findings, not impressions.",
        },
      },
    ],
  },
  policy: correctivePolicy.id,
  kind: "corrective",
  feedbackRoute: { from: id("verify"), to: id("implement") },
}

const task: WorkflowTemplate = {
  id: "task",
  description:
    "Full treatment for a task that needs understanding before code: explore the repository, write a plan, get it approved, then implement and verify in a corrective loop. Choose this when the change is non-trivial, spans several files, or the right approach is not obvious from the prompt.",
  tree: {
    _tag: "Sequence",
    children: [
      {
        _tag: "Block",
        id: id("explore"),
        def: agentTask.id,
        overrides: {
          promptTemplate:
            "Explore the repository and report what a change to {{focus}} would have to touch. Do not change anything.",
        },
      },
      {
        _tag: "Block",
        id: id("plan"),
        def: agentTask.id,
        inputs: [id("explore")],
        overrides: {
          promptTemplate: "Write the plan for this task, informed by the exploration.",
        },
      },
      {
        _tag: "Gate",
        id: id("approve-plan"),
        payload: {
          title: "Approve the plan",
          summary: "The plan block has produced its approach. Approve it to start implementing.",
        },
      },
      implementVerify,
      { _tag: "Block", id: id("finalize"), def: finalize.id },
    ],
  },
  params: [focusParam],
  optionalBlocks: [
    {
      blockId: id("explore"),
      default: true,
      hint: "Drop when the prompt already names the files and the change is local.",
    },
    {
      blockId: id("approve-plan"),
      default: true,
      hint: "Drop when the user asked for the work to run unattended.",
    },
    {
      blockId: id("finalize"),
      default: true,
      hint: "Drop when the user wants to read the worktree themselves before anything reaches their branch.",
    },
  ],
  allowedBindings: {},
  retryBounds: { implement: { min: 1, max: 5 } },
}

const quickfix: WorkflowTemplate = {
  id: "quickfix",
  description:
    "Implement and verify, nothing else. Choose this for a small, well-specified change where exploration and a plan would be ceremony — a typo, a one-line fix, a rename the prompt spells out.",
  tree: {
    ...implementVerify,
    body: {
      _tag: "Sequence",
      children: [
        { _tag: "Block", id: id("implement"), def: agentTask.id },
        { _tag: "Block", id: id("verify"), def: verifyOutput.id, inputs: [id("implement")] },
      ],
    },
  },
  params: [],
  optionalBlocks: [],
  allowedBindings: {},
  retryBounds: { implement: { min: 1, max: 3 } },
}

const guardedFix: WorkflowTemplate = {
  id: "guarded-fix",
  description:
    "Implement, then let the project's own check command be the judge, looping until it passes. Choose this when the prompt names a command that decides success — a test suite, a linter, a type check.",
  tree: {
    _tag: "Loop",
    body: {
      _tag: "Sequence",
      children: [
        { _tag: "Block", id: id("implement"), def: agentTask.id },
        {
          _tag: "Block",
          id: id("check"),
          def: runCommand.id,
          overrides: { command: { argv: ["bash", "-lc", "{{checkCommand}}"] } },
        },
      ],
    },
    policy: correctivePolicy.id,
    kind: "corrective",
    feedbackRoute: { from: id("check"), to: id("implement") },
  },
  params: [{ name: "checkCommand", type: "string", required: true }],
  optionalBlocks: [],
  allowedBindings: {},
  retryBounds: { implement: { min: 1, max: 4 } },
}

const answer: WorkflowTemplate = {
  id: "answer",
  description:
    "Answer a question about the repository without changing it — explanations, investigations, 'how does X work', 'what is this project'. Choose this whenever the prompt asks for understanding rather than a change. Nothing is written and nothing is landed.",
  tree: {
    _tag: "Sequence",
    children: [{ _tag: "Block", id: id("answer"), def: answerQuestion.id }],
  },
  params: [],
  optionalBlocks: [],
  allowedBindings: {},
  retryBounds: {},
}

/**
 * Core templates bind no plugins: a plugin a template demanded would fail preflight on any machine
 * without it, and plan §7 puts mandatory bindings in the cartridge. Cartridges add templates whose
 * `allowedBindings` give the Analyzer something to choose from.
 */
export const coreTemplates: ReadonlyArray<WorkflowTemplate> = [task, quickfix, guardedFix, answer]
