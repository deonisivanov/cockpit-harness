import { blockId, type TreeTransform, type WorkflowNode } from "@cockpit/cartridge-kit"
import { lint } from "./blocks/lint.js"

/** Mandatory for this project: nothing merges without the linter having run (plan §4). */
export const appendLint: TreeTransform = (tree) => ({
  ...tree,
  root: {
    _tag: "Sequence",
    children: [tree.root, { _tag: "Block", id: blockId("lint"), def: lint.id } satisfies WorkflowNode],
  },
})
