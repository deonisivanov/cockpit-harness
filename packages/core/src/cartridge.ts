import { Schema } from "effect"
import { CommandSpec } from "./CommandRunner.js"
import { ValidationError } from "./errors.js"
import { Effort, ModelName, ProviderName } from "./Provider.js"
import { WorkflowTemplate } from "./templates.js"
import { BlockDef, PluginBinding, RetryPolicy, WorkflowTree } from "./workflow.js"

export interface TransformContext {
  readonly projectName: string
  readonly prompt: string
  readonly rules: Readonly<Record<string, unknown>>
}

/**
 * Required to be pure and synchronous (plan §4): the pipeline calls it inline, inside the run, and
 * has no way to interrupt one that does IO instead. Upheld by review, like the rest of ADR-007.
 */
export type TreeTransform = (tree: WorkflowTree, context: TransformContext) => WorkflowTree

export type TreeValidator = (
  tree: WorkflowTree,
  context: TransformContext,
) => ReadonlyArray<ValidationError>

const fn = <F>(what: string) =>
  Schema.declare((input: unknown): input is F => typeof input === "function", {
    identifier: what,
    description: `a ${what} function`,
  })

export const Cartridge = Schema.Struct({
  name: Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9-]*$/)),
  environment: Schema.optional(
    Schema.Struct({
      healthChecks: Schema.Array(
        Schema.Struct({ argv: Schema.NonEmptyArray(Schema.String), timeoutMs: Schema.Int }),
      ),
    }),
  ),
  /** The one agent no block declares: the Analyzer runs before a tree exists to configure it. */
  analyzer: Schema.optional(
    Schema.Struct({
      provider: Schema.optional(ProviderName),
      model: Schema.optional(ModelName),
      effort: Schema.optional(Effort),
    }),
  ),
  blocks: Schema.optional(Schema.Array(BlockDef)),
  templates: Schema.optional(Schema.Array(WorkflowTemplate)),
  prompts: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  commands: Schema.optional(Schema.Record({ key: Schema.String, value: CommandSpec })),
  transforms: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, apply: fn<TreeTransform>("transform") })),
  ),
  validators: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, check: fn<TreeValidator>("validator") })),
  ),
  retryPolicies: Schema.optional(Schema.Array(RetryPolicy)),
  bindings: Schema.optional(Schema.Array(PluginBinding)),
  rules: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
})
export type Cartridge = typeof Cartridge.Type
