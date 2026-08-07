import { expect, it } from "vitest"
import {
  agentTask,
  correctivePolicy,
  RunId,
  runCommand,
  singleAttemptPolicy,
  validateWorkflow,
  verifyOutput,
  WorkflowCatalog,
  WorkflowNode,
  WorkflowTree,
} from "../src/index.js"
import { block, catalog, id } from "./trees.js"

const tree = (root: WorkflowNode): WorkflowTree => ({
  runId: RunId.make("run-v"),
  templateId: "t",
  root,
})

const commandNode = block("cmd", runCommand.id, {
  overrides: { command: { argv: ["true"] } },
})

const implementThenVerify: WorkflowNode = {
  _tag: "Sequence",
  children: [
    block("implement", agentTask.id),
    block("verify", verifyOutput.id, { inputs: [id("implement")] }),
  ],
}

interface Case {
  readonly name: string
  readonly rule?: string
  readonly tree: WorkflowTree
  readonly catalog?: WorkflowCatalog
}

const cases: ReadonlyArray<Case> = [
  { name: "a wired implement/verify sequence", tree: tree(implementThenVerify) },
  { name: "a command block with an overridden argv", tree: tree(commandNode) },

  {
    name: "a block naming a definition nobody registered",
    rule: "unknown-block-def",
    tree: tree(block("ghost", "no-such-block")),
  },
  {
    name: "a definition pointing at a retry policy nobody registered",
    rule: "unknown-retry-policy",
    tree: tree(block("a", "bad-policy")),
    catalog: catalog([{ ...agentTask, id: "bad-policy", retryPolicy: "ghost" }]),
  },
  {
    name: "two nodes sharing one block id",
    rule: "duplicate-block-id",
    tree: tree({ _tag: "Sequence", children: [block("a", agentTask.id), block("a", agentTask.id)] }),
  },

  {
    name: "an agent block with no provider",
    rule: "block-kind",
    tree: tree(block("a", "no-provider")),
    catalog: catalog([{ ...agentTask, id: "no-provider", provider: undefined }]),
  },
  {
    name: "a command block with nothing to run",
    rule: "block-kind",
    tree: tree(block("cmd", runCommand.id)),
  },
  {
    name: "a block whose timeout was overridden away",
    rule: "block-timeout",
    tree: tree(block("a", agentTask.id, { overrides: { timeoutMs: 0 } })),
  },

  {
    name: "a command block promising a field no command can report",
    rule: "command-output",
    tree: tree(block("cmd", "chatty-command", { overrides: { command: { argv: ["true"] } } })),
    catalog: catalog([
      {
        ...runCommand,
        id: "chatty-command",
        output: [{ name: "summary", type: "string", required: true }],
      },
    ]),
  },
  {
    name: "a command block giving a result field the wrong type",
    rule: "command-output",
    tree: tree(block("cmd", "mistyped-command", { overrides: { command: { argv: ["true"] } } })),
    catalog: catalog([
      {
        ...runCommand,
        id: "mistyped-command",
        output: [{ name: "exitCode", type: "string", required: false }],
      },
    ]),
  },
  {
    name: "a command block declaring the whole command result",
    tree: tree(block("cmd", "thorough-command", { overrides: { command: { argv: ["true"] } } })),
    catalog: catalog([
      {
        ...runCommand,
        id: "thorough-command",
        output: [
          { name: "exitCode", type: "number", required: false },
          { name: "timedOut", type: "boolean", required: true },
          { name: "durationMs", type: "number", required: true },
          { name: "success", type: "boolean", required: true },
        ],
      },
    ]),
  },

  {
    name: "a block expecting an artifact outside the worktree",
    rule: "expected-artifact",
    tree: tree(block("a", "escaping-artifact")),
    catalog: catalog([
      {
        ...agentTask,
        id: "escaping-artifact",
        expectedArtifacts: [{ glob: "../outside/report.json", required: true }],
      },
    ]),
  },
  {
    name: "a block expecting an artifact by absolute path",
    rule: "expected-artifact",
    tree: tree(block("a", "absolute-artifact")),
    catalog: catalog([
      {
        ...agentTask,
        id: "absolute-artifact",
        expectedArtifacts: [{ glob: "/etc/passwd", required: false }],
      },
    ]),
  },

  {
    name: "a verifier wired to nothing",
    rule: "input-contract",
    tree: tree(block("verify", verifyOutput.id)),
  },
  {
    name: "a verifier reading a block that runs after it",
    rule: "input-contract",
    tree: tree({
      _tag: "Sequence",
      children: [
        block("verify", verifyOutput.id, { inputs: [id("implement")] }),
        block("implement", agentTask.id),
      ],
    }),
  },
  {
    name: "a verifier wired to a source that does not produce its field",
    rule: "input-contract",
    tree: tree({
      _tag: "Sequence",
      children: [commandNode, block("verify", verifyOutput.id, { inputs: [id("cmd")] })],
    }),
  },

  {
    name: "a condition over a block that has not run",
    rule: "condition-predicate",
    tree: tree({
      _tag: "Condition",
      predicate: { blockId: id("implement"), path: ["summary"], comparator: "exists" },
      onTrue: block("a", agentTask.id),
    }),
  },
  {
    name: "a condition with an empty path",
    rule: "condition-predicate",
    tree: tree({
      _tag: "Sequence",
      children: [
        block("implement", agentTask.id),
        {
          _tag: "Condition",
          predicate: { blockId: id("implement"), path: [], comparator: "exists" },
          onTrue: block("a", agentTask.id),
        },
      ],
    }),
  },
  {
    name: "a condition comparing against nothing",
    rule: "condition-predicate",
    tree: tree({
      _tag: "Sequence",
      children: [
        block("implement", agentTask.id),
        {
          _tag: "Condition",
          predicate: { blockId: id("implement"), path: ["summary"], comparator: "eq" },
          onTrue: block("a", agentTask.id),
        },
      ],
    }),
  },
  {
    name: "a numeric comparison against a string",
    rule: "condition-predicate",
    tree: tree({
      _tag: "Sequence",
      children: [
        block("implement", agentTask.id),
        {
          _tag: "Condition",
          predicate: { blockId: id("implement"), path: ["summary"], comparator: "gt", value: "x" },
          onTrue: block("a", agentTask.id),
        },
      ],
    }),
  },
  {
    name: "a condition reading a field the block never declares",
    rule: "condition-predicate",
    tree: tree({
      _tag: "Sequence",
      children: [
        block("implement", agentTask.id),
        {
          _tag: "Condition",
          predicate: { blockId: id("implement"), path: ["nope"], comparator: "exists" },
          onTrue: block("a", agentTask.id),
        },
      ],
    }),
  },
  {
    name: "a condition whose branches both run",
    tree: tree({
      _tag: "Sequence",
      children: [
        block("implement", agentTask.id),
        {
          _tag: "Condition",
          predicate: { blockId: id("implement"), path: ["summary"], comparator: "exists" },
          onTrue: block("a", agentTask.id),
          onFalse: block("b", agentTask.id),
        },
      ],
    }),
  },

  {
    name: "a corrective loop with a routed verify step",
    tree: tree({
      _tag: "Loop",
      body: implementThenVerify,
      policy: correctivePolicy.id,
      kind: "corrective",
      feedbackRoute: { from: id("verify"), to: id("implement") },
    }),
  },
  {
    name: "a loop that may never attempt anything",
    rule: "loop-exit",
    tree: tree({ _tag: "Loop", body: implementThenVerify, policy: "no-attempts", kind: "semantic-retry" }),
    catalog: catalog([], [{ ...correctivePolicy, id: "no-attempts", maxAttempts: 0 }]),
  },
  {
    name: "a loop with no deadline to stop it",
    rule: "loop-exit",
    tree: tree({ _tag: "Loop", body: implementThenVerify, policy: "forever", kind: "semantic-retry" }),
    catalog: catalog([], [{ ...correctivePolicy, id: "forever", loopTimeoutMs: 0 }]),
  },
  {
    name: "a corrective loop with nowhere to send its findings",
    rule: "loop-exit",
    tree: tree({ _tag: "Loop", body: implementThenVerify, policy: correctivePolicy.id, kind: "corrective" }),
  },
  {
    name: "a feedback route pointing outside the loop body",
    rule: "loop-exit",
    tree: tree({
      _tag: "Loop",
      body: implementThenVerify,
      policy: correctivePolicy.id,
      kind: "corrective",
      feedbackRoute: { from: id("verify"), to: id("elsewhere") },
    }),
  },

  {
    name: "a plugin that retries internally, wrapped in a single-attempt loop",
    tree: tree({
      _tag: "Loop",
      body: block("plan", "self-retrying"),
      policy: singleAttemptPolicy.id,
      kind: "semantic-retry",
    }),
    catalog: catalog([
      {
        ...agentTask,
        id: "self-retrying",
        binding: {
          entry: { kind: "slash", name: "plan" },
          requiredCapabilities: [],
          managesInternalRetries: true,
          cancellation: "kill-tree",
        },
      },
    ]),
  },
  {
    name: "a plugin that retries internally, wrapped in a retrying loop",
    rule: "double-retry",
    tree: tree({
      _tag: "Loop",
      body: block("plan", "self-retrying"),
      policy: correctivePolicy.id,
      kind: "semantic-retry",
    }),
    catalog: catalog([
      {
        ...agentTask,
        id: "self-retrying",
        binding: {
          entry: { kind: "slash", name: "plan" },
          requiredCapabilities: [],
          managesInternalRetries: true,
          cancellation: "kill-tree",
        },
      },
    ]),
  },

  {
    name: "a gate with something to show",
    tree: tree({
      _tag: "Gate",
      id: id("approve"),
      payload: { title: "Approve the plan", summary: "one block will write to the worktree" },
    }),
  },
  {
    name: "a gate with an empty payload",
    rule: "gate-payload",
    tree: tree({ _tag: "Gate", id: id("approve"), payload: { title: " ", summary: "" } }),
  },

  {
    name: "one writer beside readers",
    tree: tree({
      _tag: "Parallel",
      branches: [
        { node: block("implement", agentTask.id), workspaceAccess: "write" },
        { node: block("review", verifyOutput.id, { inputs: [] }), workspaceAccess: "read" },
      ],
    }),
    catalog: catalog([{ ...verifyOutput, input: [] }]),
  },
  {
    name: "two branches writing to one worktree",
    rule: "parallel-write-conflict",
    tree: tree({
      _tag: "Parallel",
      branches: [
        { node: block("a", agentTask.id), workspaceAccess: "write" },
        { node: block("b", agentTask.id), workspaceAccess: "write" },
      ],
    }),
  },
  {
    name: "a writing block inside a read-only branch",
    rule: "parallel-write-conflict",
    tree: tree({
      _tag: "Parallel",
      branches: [{ node: block("a", agentTask.id), workspaceAccess: "read" }],
    }),
  },
]

it.each(cases)("$name", ({ rule, tree: subject, catalog: given }) => {
  const errors = validateWorkflow(subject, given ?? catalog())

  if (rule === undefined) {
    expect(errors).toEqual([])
    return
  }
  expect(errors.map((error) => error.rule)).toContain(rule)
  const reported = errors.find((error) => error.rule === rule)!
  expect(reported.message).not.toBe("")
  expect(reported.path.length).toBeGreaterThan(0)
})

it("names the offending node in the path", () => {
  const errors = validateWorkflow(
    tree({ _tag: "Sequence", children: [block("first", agentTask.id), block("second", "ghost")] }),
    catalog(),
  )

  expect(errors).toHaveLength(1)
  expect(errors[0].path).toEqual(["root", "children[1]", "second"])
})
