import { ValidationError, type TreeValidator, type WorkflowNode } from "@cockpit/cartridge-kit"

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
export const noNestedLoops: TreeValidator = (tree) =>
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
