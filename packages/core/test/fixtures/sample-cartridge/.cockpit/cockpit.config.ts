import {
  blockId,
  defineCartridge,
  ValidationError,
  type BlockDef,
  type PluginBinding,
  type TreeTransform,
  type TreeValidator,
  type WorkflowNode,
} from "@cockpit/cartridge-kit"

const houseStyle: PluginBinding = {
  entry: { kind: "slash", name: "review" },
  requiredCapabilities: [],
  managesInternalRetries: false,
  cancellation: "kill-tree",
}

const lint: BlockDef = {
  id: "sample-lint",
  kind: "command",
  title: "Run the project linter",
  input: [],
  output: [{ name: "success", type: "boolean", required: true }],
  command: { argv: ["node", "--version"] },
  sessionPolicy: "fresh",
  retryPolicy: "single-attempt",
  timeoutMs: 60_000,
  permissionProfile: "workspace-write",
  workspaceAccess: "write",
  successCriteria: [],
  fallback: { _tag: "Fail" },
}

/** Mandatory for this project: nothing merges without the linter having run (plan §4). */
const appendLint: TreeTransform = (tree) => ({
  ...tree,
  root: {
    _tag: "Sequence",
    children: [tree.root, { _tag: "Block", id: blockId("lint"), def: lint.id } satisfies WorkflowNode],
  },
})

type Loop = Extract<WorkflowNode, { _tag: "Loop" }>

const loopsIn = (node: WorkflowNode): ReadonlyArray<Loop> => {
  switch (node._tag) {
    case "Loop":
      return [node, ...loopsIn(node.body)]
    case "Sequence":
      return node.children.flatMap(loopsIn)
    case "Parallel":
      return node.branches.flatMap((branch) => loopsIn(branch.node))
    case "Condition":
      return [...loopsIn(node.onTrue), ...(node.onFalse === undefined ? [] : loopsIn(node.onFalse))]
    default:
      return []
  }
}

/** Nested loops multiply their attempt budgets, so this project allows only one level of retry. */
const noNestedLoops: TreeValidator = (tree) =>
  loopsIn(tree.root).flatMap((loop) =>
    loopsIn(loop.body).length === 0
      ? []
      : [
          new ValidationError({
            rule: "nested-loop",
            path: [tree.templateId],
            message: "a retry loop inside another one makes the attempt budget the product of both",
          }),
        ],
  )

export default defineCartridge({
  name: "sample",
  environment: {
    healthChecks: [{ argv: ["node", "--version"], timeoutMs: 30_000 }],
  },
  blocks: [lint],
  templates: [
    {
      id: "lint-fix",
      description: "Fix the lint failures the project's linter reports, then run it again.",
      tree: {
        _tag: "Loop",
        body: {
          _tag: "Sequence",
          children: [
            { _tag: "Block", id: blockId("implement"), def: "agent-task" },
            { _tag: "Block", id: blockId("lint-check"), def: lint.id },
          ],
        },
        policy: "corrective",
        kind: "corrective",
        feedbackRoute: { from: blockId("lint-check"), to: blockId("implement") },
      },
      params: [],
      optionalBlocks: [],
      allowedBindings: { implement: [houseStyle] },
      retryBounds: { implement: { min: 1, max: 3 } },
    },
  ],
  prompts: { house: "Match the surrounding code; comments only where a why is not obvious." },
  commands: { lint: { argv: ["node", "--version"] } },
  transforms: [{ name: "append-lint", apply: appendLint }],
  validators: [{ name: "no-nested-loops", check: noNestedLoops }],
  bindings: [houseStyle],
  rules: { comments: "as few as possible", language: "English" },
})
