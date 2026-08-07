import { Schema } from "effect"
import { CommandSpec } from "./CommandRunner.js"
import { BlockKind, ErrorClass } from "./events.js"
import { ArtifactId, BlockId, CheckpointId, RunId } from "./ids.js"
import { PermissionProfile, ProviderName } from "./Provider.js"

/**
 * Brands are erased at runtime, so a type schema over an already-branded id keeps Type and
 * Encoded identical — which is what lets the recursive node schema below need one interface
 * instead of a mirrored encoded twin.
 */
const NodeId = Schema.typeSchema(BlockId)

export const WorkspaceAccess = Schema.Literal("read", "write")
export type WorkspaceAccess = typeof WorkspaceAccess.Type

export const Comparator = Schema.Literal("eq", "neq", "gt", "lt", "contains", "exists")
export type Comparator = typeof Comparator.Type

export const CheckValue = Schema.Union(Schema.String, Schema.Number, Schema.Boolean)
export type CheckValue = typeof CheckValue.Type

/** Declarative and total: conditions and success criteria are decided by data, never by eval. */
export interface Check {
  readonly path: ReadonlyArray<string>
  readonly comparator: Comparator
  readonly value?: CheckValue
}

const checkFields = {
  path: Schema.Array(Schema.String),
  comparator: Comparator,
  value: Schema.optional(CheckValue),
}

export const Predicate = Schema.Struct({ blockId: NodeId, ...checkFields })
export type Predicate = typeof Predicate.Type

export const SuccessCriterion = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  ...checkFields,
})
export type SuccessCriterion = typeof SuccessCriterion.Type

export const ContractType = Schema.Literal("string", "number", "boolean", "object", "array")
export type ContractType = typeof ContractType.Type

/**
 * Block IO is declared as fields rather than an Effect Schema so a block definition stays data:
 * serializable into the journal and the UI, and comparable across two connected blocks by the
 * validator. The output Schema is derived from it at validation time.
 */
export const ContractField = Schema.Struct({
  name: Schema.String,
  type: ContractType,
  required: Schema.Boolean,
})
export type ContractField = typeof ContractField.Type

export const PluginBinding = Schema.Struct({
  plugin: Schema.optional(Schema.String),
  entry: Schema.Struct({
    kind: Schema.Literal("slash", "skill", "agent"),
    name: Schema.String,
  }),
  argsTemplate: Schema.optional(Schema.String),
  extraInstructions: Schema.optional(Schema.String),
  requiredCapabilities: Schema.Array(Schema.String),
  minVersion: Schema.optional(Schema.String),
  managesInternalRetries: Schema.Boolean,
  stateFiles: Schema.optional(Schema.Array(Schema.String)),
  cancellation: Schema.Literal("kill-tree"),
})
export type PluginBinding = typeof PluginBinding.Type

export const Fallback = Schema.Union(
  Schema.TaggedStruct("Fail", {}),
  Schema.TaggedStruct("SkipWithWarning", {}),
  Schema.TaggedStruct("AlternativeBinding", { binding: PluginBinding }),
)
export type Fallback = typeof Fallback.Type

export const BlockDef = Schema.Struct({
  id: Schema.String,
  kind: BlockKind,
  title: Schema.String,
  input: Schema.Array(ContractField),
  output: Schema.Array(ContractField),
  provider: Schema.optional(ProviderName),
  binding: Schema.optional(PluginBinding),
  promptTemplate: Schema.optional(Schema.String),
  command: Schema.optional(CommandSpec),
  sessionPolicy: Schema.Literal("fresh", "continue"),
  retryPolicy: Schema.String,
  timeoutMs: Schema.Int,
  permissionProfile: PermissionProfile,
  workspaceAccess: WorkspaceAccess,
  expectedArtifacts: Schema.optional(
    Schema.Array(Schema.Struct({ glob: Schema.String, required: Schema.Boolean })),
  ),
  successCriteria: Schema.Array(SuccessCriterion),
  fallback: Fallback,
})
export type BlockDef = typeof BlockDef.Type

export const RetryPolicy = Schema.Struct({
  id: Schema.String,
  maxAttempts: Schema.Int,
  loopTimeoutMs: Schema.Int,
  retryable: Schema.Array(ErrorClass),
  nonRetryable: Schema.Array(ErrorClass),
  backoff: Schema.Struct({
    initialMs: Schema.Int,
    factor: Schema.Number,
    maxMs: Schema.Int,
  }),
  humanGateAfterFailures: Schema.optional(Schema.Int),
  noProgress: Schema.Struct({ sameFailureSignatureLimit: Schema.Int }),
  checkpointEachAttempt: Schema.Boolean,
  onRetry: Schema.Literal("rollback", "continue"),
  contextBudgetChars: Schema.Int,
})
export type RetryPolicy = typeof RetryPolicy.Type

export const GatePayload = Schema.Struct({
  title: Schema.String,
  summary: Schema.String,
  artifacts: Schema.optional(Schema.Array(Schema.typeSchema(ArtifactId))),
})
export type GatePayload = typeof GatePayload.Type

/** The two fields a reusable definition cannot know: what to run and how long it may take. */
export const BlockOverrides = Schema.Struct({
  command: Schema.optional(CommandSpec),
  timeoutMs: Schema.optional(Schema.Int),
})
export type BlockOverrides = typeof BlockOverrides.Type

export type WorkflowNode =
  | {
      readonly _tag: "Block"
      readonly id: BlockId
      readonly def: string
      readonly inputs?: ReadonlyArray<BlockId>
      readonly overrides?: BlockOverrides
    }
  | { readonly _tag: "Sequence"; readonly children: ReadonlyArray<WorkflowNode> }
  | {
      readonly _tag: "Parallel"
      readonly branches: ReadonlyArray<{
        readonly node: WorkflowNode
        readonly workspaceAccess: WorkspaceAccess
      }>
    }
  | {
      readonly _tag: "Condition"
      readonly predicate: Predicate
      readonly onTrue: WorkflowNode
      readonly onFalse?: WorkflowNode
    }
  | {
      readonly _tag: "Loop"
      readonly body: WorkflowNode
      readonly policy: string
      readonly kind: "semantic-retry" | "corrective"
      readonly feedbackRoute?: { readonly from: BlockId; readonly to: BlockId }
    }
  | { readonly _tag: "Gate"; readonly id: BlockId; readonly payload: GatePayload }

export const WorkflowNode: Schema.Schema<WorkflowNode> = Schema.Union(
  Schema.TaggedStruct("Block", {
    id: NodeId,
    def: Schema.String,
    inputs: Schema.optional(Schema.Array(NodeId)),
    overrides: Schema.optional(BlockOverrides),
  }),
  Schema.TaggedStruct("Sequence", {
    children: Schema.Array(Schema.suspend(() => WorkflowNode)),
  }),
  Schema.TaggedStruct("Parallel", {
    branches: Schema.Array(
      Schema.Struct({
        node: Schema.suspend(() => WorkflowNode),
        workspaceAccess: WorkspaceAccess,
      }),
    ),
  }),
  Schema.TaggedStruct("Condition", {
    predicate: Predicate,
    onTrue: Schema.suspend(() => WorkflowNode),
    onFalse: Schema.optional(Schema.suspend(() => WorkflowNode)),
  }),
  Schema.TaggedStruct("Loop", {
    body: Schema.suspend(() => WorkflowNode),
    policy: Schema.String,
    kind: Schema.Literal("semantic-retry", "corrective"),
    feedbackRoute: Schema.optional(Schema.Struct({ from: NodeId, to: NodeId })),
  }),
  Schema.TaggedStruct("Gate", { id: NodeId, payload: GatePayload }),
)

export interface WorkflowTree {
  readonly runId: RunId
  readonly templateId: string
  readonly root: WorkflowNode
}

export interface ArtifactRef {
  readonly id: ArtifactId
  readonly path: string
  readonly kind: string
  readonly bytes: number
  readonly excerpt?: string
}

export interface BlockInputEnvelope {
  readonly task: { readonly prompt: string; readonly projectId: string }
  readonly workspace: {
    readonly worktreePath: string
    readonly headCheckpoint: CheckpointId
    readonly changedFiles: ReadonlyArray<string>
  }
  readonly priorOutputs: Readonly<Record<string, unknown>>
  /** The rendered `RetryContext`, which is exactly the text the attempt is asked to read. */
  readonly attemptContext?: string
}

export interface FailurePacket {
  readonly attemptNumber: number
  readonly hypothesis: string
  readonly strategy: { readonly binding?: string; readonly approach: string }
  readonly actionsTaken: ReadonlyArray<string>
  readonly commandsRun: ReadonlyArray<string>
  readonly whatFailed: string
  readonly diagnostics: ReadonlyArray<{ readonly excerpt: string; readonly ref?: ArtifactId }>
  readonly failureReason: string
  readonly doNotRepeat: ReadonlyArray<string>
  readonly remainingDirections: ReadonlyArray<string>
}

export interface RetryContext {
  readonly lastAttempt: FailurePacket
  readonly olderAttempts: ReadonlyArray<{
    readonly attemptNumber: number
    readonly summary: string
  }>
  readonly repeatedErrors: ReadonlyArray<{ readonly signature: string; readonly count: number }>
  readonly budget: { readonly maxChars: number }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readPath = (subject: unknown, path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), subject)

export const evaluateCheck = (check: Check, subject: unknown): boolean => {
  const actual = readPath(subject, check.path)
  switch (check.comparator) {
    case "exists":
      return actual !== undefined && actual !== null
    case "eq":
      return actual === check.value
    case "neq":
      return actual !== check.value
    case "gt":
      return typeof actual === "number" && typeof check.value === "number" && actual > check.value
    case "lt":
      return typeof actual === "number" && typeof check.value === "number" && actual < check.value
    case "contains":
      return typeof actual === "string" && typeof check.value === "string"
        ? actual.includes(check.value)
        : Array.isArray(actual) && actual.includes(check.value)
  }
}

const typeOf = (value: unknown): ContractType | "null" | "undefined" => {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return "array"
  const kind = typeof value
  return kind === "string" || kind === "number" || kind === "boolean" ? kind : "object"
}

/** The block output contract: what the agent wrote to `$COCKPIT_OUTPUT` has to satisfy this. */
export const contractProblems = (
  fields: ReadonlyArray<ContractField>,
  value: unknown,
): ReadonlyArray<string> => {
  if (!isRecord(value)) return [`output must be a JSON object, got ${typeOf(value)}`]
  return fields.flatMap((field) => {
    const actual = value[field.name]
    if (actual === undefined || actual === null) {
      return field.required ? [`missing required field "${field.name}"`] : []
    }
    const kind = typeOf(actual)
    return kind === field.type
      ? []
      : [`field "${field.name}" must be ${field.type}, got ${kind}`]
  })
}

export const pickFields = (
  fields: ReadonlyArray<ContractField>,
  value: unknown,
): Record<string, unknown> => {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    fields.flatMap((field) => (field.name in value ? [[field.name, value[field.name]]] : [])),
  )
}
