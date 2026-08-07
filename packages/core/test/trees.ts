import {
  BlockDef,
  BlockId,
  coreBlocks,
  coreRetryPolicies,
  RetryPolicy,
  WorkflowCatalog,
  WorkflowNode,
} from "../src/index.js"

// Kept apart from helpers.ts, which sets git environment variables on import: a validator test
// builds trees without ever touching a repo.

export const id = (value: string) => BlockId.make(value)

type BlockNode = Extract<WorkflowNode, { _tag: "Block" }>

export const block = (
  nodeId: string,
  def: string,
  rest: Omit<BlockNode, "_tag" | "id" | "def"> = {},
): BlockNode => ({ _tag: "Block", id: id(nodeId), def, ...rest })

export const catalog = (
  blocks: ReadonlyArray<BlockDef> = [],
  policies: ReadonlyArray<RetryPolicy> = [],
): WorkflowCatalog => ({
  blocks: [...coreBlocks, ...blocks],
  policies: [...coreRetryPolicies, ...policies],
})
