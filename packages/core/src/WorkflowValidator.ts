import { escapesWorktree } from "./CommandRunner.js"
import { ValidationError } from "./errors.js"
import { BlockId } from "./ids.js"
import {
  BlockDef,
  BlockOverrides,
  ContractField,
  PluginBinding,
  Predicate,
  RetryPolicy,
  WorkflowNode,
  WorkflowTree,
} from "./workflow.js"

export interface WorkflowCatalog {
  readonly blocks: ReadonlyArray<BlockDef>
  readonly policies: ReadonlyArray<RetryPolicy>
}

type BlockNode = Extract<WorkflowNode, { _tag: "Block" }>

const fail = (rule: string, path: ReadonlyArray<string>, message: string) =>
  new ValidationError({ rule, path, message })

export const blocksIn = (node: WorkflowNode): ReadonlyArray<BlockNode> => {
  switch (node._tag) {
    case "Block":
      return [node]
    case "Sequence":
      return node.children.flatMap(blocksIn)
    case "Parallel":
      return node.branches.flatMap((branch) => blocksIn(branch.node))
    case "Condition":
      return [...blocksIn(node.onTrue), ...(node.onFalse ? blocksIn(node.onFalse) : [])]
    case "Loop":
      return blocksIn(node.body)
    case "Gate":
      return []
  }
}

/**
 * The binding a block will actually run under: the definition's, unless the Analyzer picked one
 * from the template's allowed set. Every rule that reasons about plugins reads it through here, so
 * a chosen binding is subject to the same checks as a declared one.
 */
export const bindingOf = (
  def: BlockDef,
  overrides?: BlockOverrides,
): PluginBinding | undefined => overrides?.binding ?? def.binding

const writesWorkspace = (node: WorkflowNode, defs: ReadonlyMap<string, BlockDef>) =>
  blocksIn(node).some((block) => defs.get(block.def)?.workspaceAccess === "write")

const effectiveTimeout = (block: BlockNode, def: BlockDef) =>
  block.overrides?.timeoutMs ?? def.timeoutMs

const checkProblems = (check: Predicate): string | undefined => {
  if (check.path.length === 0) return "predicate path must name at least one field"
  if (check.comparator === "exists") {
    return check.value === undefined ? undefined : "the exists comparator takes no value"
  }
  if (check.value === undefined) return `the ${check.comparator} comparator needs a value`
  return (check.comparator === "gt" || check.comparator === "lt") &&
    typeof check.value !== "number"
    ? `the ${check.comparator} comparator needs a numeric value`
    : undefined
}

const covers = (sources: ReadonlyArray<ContractField>, required: ContractField) =>
  sources.some((field) => field.name === required.name && field.type === required.type)

/** Everything a workspace block can report; finalize is the only one Core ships. */
const finalizeResult: ReadonlyArray<ContractField> = [
  { name: "commit", type: "string", required: false },
  { name: "commits", type: "number", required: false },
]

/** Everything a command block can report; the engine builds this shape and nothing else. */
const commandResult: ReadonlyArray<ContractField> = [
  { name: "exitCode", type: "number", required: false },
  { name: "timedOut", type: "boolean", required: false },
  { name: "durationMs", type: "number", required: false },
  { name: "success", type: "boolean", required: false },
]

/**
 * Walks the tree in execution order so every rule that talks about "a prior block" can be decided
 * from the set of block ids that provably ran before the node being checked.
 */
const walk = (
  tree: WorkflowTree,
  catalog: WorkflowCatalog,
  /** A node to walk but never admit into `available` — the shape of it having been skipped. */
  suppressed?: BlockId,
): ReadonlyArray<ValidationError> => {
  const defs = new Map(catalog.blocks.map((def) => [def.id, def]))
  const policies = new Map(catalog.policies.map((policy) => [policy.id, policy]))
  const errors: ValidationError[] = []
  const declared = new Set<BlockId>()

  const outputsOf = (id: BlockId): ReadonlyArray<ContractField> => {
    const node = blocksIn(tree.root).find((block) => block.id === id)
    return node === undefined ? [] : (defs.get(node.def)?.output ?? [])
  }

  const visitBlock = (node: BlockNode, path: ReadonlyArray<string>, available: Set<BlockId>) => {
    const at = [...path, node.id]
    if (declared.has(node.id)) {
      errors.push(fail("duplicate-block-id", at, `block id ${node.id} is used more than once`))
    }
    declared.add(node.id)

    const def = defs.get(node.def)
    if (def === undefined) {
      errors.push(fail("unknown-block-def", at, `no block definition named ${node.def}`))
      return
    }
    if (!policies.has(def.retryPolicy)) {
      errors.push(
        fail("unknown-retry-policy", at, `no retry policy named ${def.retryPolicy}`),
      )
    }

    const command = node.overrides?.command ?? def.command
    const model = node.overrides?.model ?? def.model
    const effort = node.overrides?.effort ?? def.effort
    if (def.kind === "agent") {
      if (def.provider === undefined) {
        errors.push(fail("block-kind", at, "an agent block must name a provider"))
      }
      if (command !== undefined) {
        errors.push(fail("block-kind", at, "an agent block must not carry a command"))
      }
    } else {
      if (def.kind === "command" && command === undefined) {
        errors.push(
          fail("block-kind", at, "a command block needs a command, from its definition or overrides"),
        )
      }
      if (def.kind === "workspace" && command !== undefined) {
        errors.push(fail("block-kind", at, "a workspace block must not carry a command"))
      }
      if (
        def.provider !== undefined ||
        def.binding !== undefined ||
        model !== undefined ||
        effort !== undefined
      ) {
        errors.push(
          fail(
            "block-kind",
            at,
            `a ${def.kind} block must not name a provider, binding, model, or effort`,
          ),
        )
      }
      const produced = def.kind === "workspace" ? finalizeResult : commandResult
      for (const declared of def.output) {
        if (!covers(produced, declared)) {
          errors.push(
            fail(
              `${def.kind}-output`,
              at,
              `a ${def.kind} block cannot produce "${declared.name}" (${declared.type}); its result is ${produced
                .map((field) => `${field.name}: ${field.type}`)
                .join(", ")}`,
            ),
          )
        }
      }
    }

    if (effectiveTimeout(node, def) <= 0) {
      errors.push(fail("block-timeout", at, "block timeout must be a positive number of ms"))
    }

    for (const expected of def.expectedArtifacts ?? []) {
      if (escapesWorktree(expected.glob)) {
        errors.push(
          fail(
            "expected-artifact",
            at,
            `expected artifact glob must stay inside the worktree: ${expected.glob}`,
          ),
        )
      }
    }

    for (const glob of bindingOf(def, node.overrides)?.stateFiles ?? []) {
      if (escapesWorktree(glob)) {
        errors.push(
          fail("plugin-state-files", at, `plugin state glob must stay inside the worktree: ${glob}`),
        )
      }
    }

    const sources = node.inputs ?? []
    for (const source of sources) {
      if (!available.has(source)) {
        errors.push(
          fail("input-contract", at, `input source ${source} does not run before this block`),
        )
      }
    }
    const supplied = sources.flatMap((source) => outputsOf(source))
    for (const field of def.input) {
      if (field.required && !covers(supplied, field)) {
        errors.push(
          fail(
            "input-contract",
            at,
            `required input "${field.name}" (${field.type}) is produced by none of its sources`,
          ),
        )
      }
    }
  }

  const visit = (
    node: WorkflowNode,
    path: ReadonlyArray<string>,
    available: Set<BlockId>,
  ): Set<BlockId> => {
    switch (node._tag) {
      case "Block":
        visitBlock(node, path, available)
        return node.id === suppressed ? new Set() : new Set([node.id])

      case "Sequence": {
        const produced = new Set<BlockId>()
        node.children.forEach((child, index) => {
          const seen = visit(child, [...path, `children[${index}]`], new Set([...available, ...produced]))
          for (const id of seen) produced.add(id)
        })
        return produced
      }

      case "Parallel": {
        const writers = node.branches.filter((branch) => branch.workspaceAccess === "write")
        if (writers.length > 1) {
          errors.push(
            fail(
              "parallel-write-conflict",
              path,
              `${writers.length} branches claim write access; at most one may write to the worktree`,
            ),
          )
        }
        const produced = new Set<BlockId>()
        node.branches.forEach((branch, index) => {
          const at = [...path, `branches[${index}]`]
          if (branch.workspaceAccess === "read" && writesWorkspace(branch.node, defs)) {
            errors.push(
              fail(
                "parallel-write-conflict",
                at,
                "a read-only branch contains a block that writes to the worktree",
              ),
            )
          }
          for (const id of visit(branch.node, at, available)) produced.add(id)
        })
        return produced
      }

      case "Condition": {
        const problem = checkProblems(node.predicate)
        if (problem !== undefined) {
          errors.push(fail("condition-predicate", path, problem))
        }
        if (!available.has(node.predicate.blockId)) {
          errors.push(
            fail(
              "condition-predicate",
              path,
              `predicate reads block ${node.predicate.blockId}, which does not run before this condition`,
            ),
          )
        } else {
          const head = node.predicate.path[0]
          const fields = outputsOf(node.predicate.blockId)
          if (head !== undefined && !fields.some((field) => field.name === head)) {
            errors.push(
              fail(
                "condition-predicate",
                path,
                `block ${node.predicate.blockId} does not declare an output field "${head}"`,
              ),
            )
          }
        }
        const produced = visit(node.onTrue, [...path, "onTrue"], available)
        if (node.onFalse !== undefined) {
          for (const id of visit(node.onFalse, [...path, "onFalse"], available)) produced.add(id)
        }
        return produced
      }

      case "Loop": {
        const policy = policies.get(node.policy)
        if (policy === undefined) {
          errors.push(fail("unknown-retry-policy", path, `no retry policy named ${node.policy}`))
        } else {
          if (policy.maxAttempts < 1) {
            errors.push(fail("loop-exit", path, "a loop needs at least one attempt"))
          }
          if (policy.loopTimeoutMs <= 0) {
            errors.push(fail("loop-exit", path, "a loop needs a positive timeout to exit"))
          }
        }

        const body = blocksIn(node.body)
        const inBody = new Set(body.map((block) => block.id))

        // Whose verdict ends an iteration, read exactly as the engine reads it. A skip reports
        // success, so a closing block that may skip itself lets the loop exit having judged nothing.
        const closingId = node.feedbackRoute?.from ?? body.at(-1)?.id
        const closing = body.find((block) => block.id === closingId)
        if (closing !== undefined && defs.get(closing.def)?.skipWhenUnchanged === true) {
          errors.push(
            fail(
              "skip-when-unchanged",
              [...path, closing.id],
              `${closing.id} decides whether the loop exits, so it cannot be skipped when nothing changed`,
            ),
          )
        }

        if (node.kind === "corrective") {
          if (node.feedbackRoute === undefined) {
            errors.push(
              fail("loop-exit", path, "a corrective loop must route feedback from one block to another"),
            )
          } else {
            for (const end of [node.feedbackRoute.from, node.feedbackRoute.to]) {
              if (!inBody.has(end)) {
                errors.push(
                  fail("loop-exit", path, `feedback route endpoint ${end} is not inside the loop body`),
                )
              }
            }
          }
        }

        if (policy !== undefined && policy.maxAttempts > 1) {
          for (const block of body) {
            const def = defs.get(block.def)
            const binding = def === undefined ? undefined : bindingOf(def, block.overrides)
            if (binding?.managesInternalRetries === true) {
              errors.push(
                fail(
                  "double-retry",
                  [...path, block.id],
                  `${block.def} runs through ${binding.entry.name}, which manages its own retries, so the loop around it must allow a single attempt`,
                ),
              )
            }
          }
        }

        return visit(node.body, [...path, "body"], available)
      }

      case "Gate": {
        const at = [...path, node.id]
        if (declared.has(node.id)) {
          errors.push(fail("duplicate-block-id", at, `block id ${node.id} is used more than once`))
        }
        declared.add(node.id)
        if (node.payload.title.trim() === "" || node.payload.summary.trim() === "") {
          errors.push(
            fail("gate-payload", at, "a gate needs a payload with a title and a summary to show"),
          )
        }
        return new Set()
      }
    }
  }

  visit(tree.root, ["root"], new Set())
  return errors
}

/**
 * What skipping a node would break: the existing walk run twice, once as the tree stands and once
 * with the node suppressed, keeping only the errors the suppression introduced. Nothing is
 * re-derived, so the skip rule inherits every rule the validator has — required inputs and
 * Condition predicate sources alike (a missing predicate source silently takes the false branch
 * at runtime, which is a reroute the user never asked for).
 */
export const skipBreaksContract = (
  tree: WorkflowTree,
  catalog: WorkflowCatalog,
  nodeId: BlockId,
): ReadonlyArray<ValidationError> => {
  const keyOf = (error: ValidationError) =>
    `${error.rule}|${error.path.join("/")}|${error.message}`
  const baseline = new Set(walk(tree, catalog).map(keyOf))
  return walk(tree, catalog, nodeId).filter((error) => !baseline.has(keyOf(error)))
}

/**
 * The walk, plus the same legality check over every block the engine may skip on its own: a
 * `skipWhenUnchanged` flag that would starve a downstream block is refused where the tree is built
 * rather than discovered mid-run. One block at a time is enough to cover a set of them skipping
 * together: a suppressed node is refused by every downstream input list that names it, so two
 * sources of one field are each refused on their own before the pair can starve anything.
 */
export const validateWorkflow = (
  tree: WorkflowTree,
  catalog: WorkflowCatalog,
): ReadonlyArray<ValidationError> => {
  const errors = walk(tree, catalog)
  const defs = new Map(catalog.blocks.map((def) => [def.id, def]))
  const flagged = blocksIn(tree.root).filter(
    (node) => defs.get(node.def)?.skipWhenUnchanged === true,
  )
  return [
    ...errors,
    ...flagged.flatMap((node) =>
      skipBreaksContract(tree, catalog, node.id).map((broken) =>
        fail(
          "skip-when-unchanged",
          broken.path,
          `${node.id} may be skipped when nothing changed, but skipping it breaks ${broken.rule}: ${broken.message}`,
        ),
      ),
    ),
  ]
}
