import { BlockId, Cartridge } from "@cockpit/core"
import { Schema } from "effect"

export type {
  BlockDef,
  Cartridge,
  CommandSpec,
  ContractField,
  Effort,
  OutputRule,
  PluginBinding,
  RetryPolicy,
  SuccessCriterion,
  TransformContext,
  TreeTransform,
  TreeValidator,
  WorkflowNode,
  WorkflowTemplate,
  WorkflowTree,
} from "@cockpit/core"
/** Walking the tree is what a validator does; there is no reason for every cartridge to rewrite it. */
export { blocksIn, ValidationError } from "@cockpit/core"
export type { BlockId } from "@cockpit/core"

/** Block ids are branded in Core so two of them cannot be confused; a cartridge mints them here. */
export const blockId = (id: string) => BlockId.make(id)

const validate = Schema.validateSync(Cartridge, { errors: "all" })

/**
 * Validated where the author can see it — `tsc` catches the shape, this catches what types cannot
 * say (a name that is not a slug, a malformed regex in a success rule). The loader validates again
 * at the daemon boundary, because a cartridge on disk is not required to have been built with the
 * kit it claims (ADR-007).
 */
export const defineCartridge = (config: Cartridge): Cartridge => validate(config)
