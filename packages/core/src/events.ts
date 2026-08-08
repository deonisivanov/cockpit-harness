import { Schema } from "effect"
import { ArtifactId, AttemptId, BlockId, CheckpointId, EventSeq, RunId, SessionId } from "./ids.js"
import { ProviderName } from "./Provider.js"

export const RunStatus = Schema.Literal(
  "created",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
)
export type RunStatus = typeof RunStatus.Type

export const BlockStatus = Schema.Literal(
  "running",
  "succeeded",
  "failed",
  "skipped",
  "interrupted",
)
export type BlockStatus = typeof BlockStatus.Type

export const BlockKind = Schema.Literal("agent", "command")
export type BlockKind = typeof BlockKind.Type

export const AttemptVerdict = Schema.Literal(
  "success",
  "semantic-failure",
  "technical-failure",
  "interrupted",
  "cancelled",
)
export type AttemptVerdict = typeof AttemptVerdict.Type

export const CheckpointKind = Schema.Literal("success", "salvage")
export type CheckpointKind = typeof CheckpointKind.Type

/** Technical failures get a backoff schedule; semantic ones get a new attempt with feedback. */
export const ErrorClass = Schema.Literal("technical", "semantic")
export type ErrorClass = typeof ErrorClass.Type

/** How a plugin is reached from a headless session. */
export const PluginEntry = Schema.Struct({
  kind: Schema.Literal("slash", "skill", "agent"),
  name: Schema.String,
})
export type PluginEntry = typeof PluginEntry.Type

/** Emitted only by Journal's guarded transitions, so the log cannot narrate a state the tables never took. */
export const LifecyclePayload = Schema.Union(
  Schema.TaggedStruct("RunCreated", { projectId: Schema.String, prompt: Schema.String }),
  Schema.TaggedStruct("RunStarted", {}),
  Schema.TaggedStruct("RunFinished", { status: Schema.Literal("succeeded", "failed") }),
  Schema.TaggedStruct("RunCancelled", {}),
  Schema.TaggedStruct("RunRecovered", { lastCheckpoint: Schema.optional(CheckpointId) }),
  Schema.TaggedStruct("BlockStarted", { defId: Schema.String, kind: BlockKind }),
  Schema.TaggedStruct("BlockFinished", {
    status: Schema.Literal("succeeded", "failed", "interrupted"),
  }),
  Schema.TaggedStruct("BlockSkipped", { reason: Schema.String }),
  Schema.TaggedStruct("AttemptStarted", {
    number: Schema.Int,
    sessionId: Schema.optional(SessionId),
  }),
  Schema.TaggedStruct("AttemptFinished", { verdict: AttemptVerdict }),
  Schema.TaggedStruct("AttemptInterrupted", {}),
  Schema.TaggedStruct("CheckpointCreated", {
    checkpointId: CheckpointId,
    kind: CheckpointKind,
  }),
  Schema.TaggedStruct("ArtifactCreated", {
    artifactId: ArtifactId,
    kind: Schema.String,
    path: Schema.String,
    bytes: Schema.Int,
  }),
)
export type LifecyclePayload = typeof LifecyclePayload.Type

export const CriterionResult = Schema.Struct({
  criterion: Schema.String,
  passed: Schema.Boolean,
  evidenceRef: Schema.optional(ArtifactId),
})
export type CriterionResult = typeof CriterionResult.Type

/** Free-form events any service may append; they never move the state machine. */
export const AncillaryPayload = Schema.Union(
  Schema.TaggedStruct("ErrorRaised", {
    class: Schema.String,
    signature: Schema.String,
    message: Schema.String,
  }),
  Schema.TaggedStruct("CommandExecuted", {
    argv: Schema.Array(Schema.String),
    /** `null` when the child was killed or lost before reporting a status; `timedOut` says which. */
    exitCode: Schema.NullOr(Schema.Int),
    timedOut: Schema.Boolean,
    durationMs: Schema.Int,
    success: Schema.Boolean,
  }),
  Schema.TaggedStruct("TreeValidated", {
    errors: Schema.Array(
      Schema.Struct({
        rule: Schema.String,
        path: Schema.Array(Schema.String),
        message: Schema.String,
      }),
    ),
  }),
  // `fallback` marks a tree built from the template's defaults because the Analyzer never produced
  // a usable decision; `warning` says what was wrong with the one it did produce.
  Schema.TaggedStruct("TreeAnalyzed", {
    templateId: Schema.String,
    rationale: Schema.String,
    decision: Schema.Unknown,
    fallback: Schema.Boolean,
    warning: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("TreeTransformed", { name: Schema.String, diffRef: ArtifactId }),
  Schema.TaggedStruct("PluginResolved", {
    provider: Schema.Struct({ name: ProviderName, version: Schema.optional(Schema.String) }),
    plugin: Schema.optional(
      Schema.Struct({ name: Schema.String, version: Schema.String }),
    ),
    entry: Schema.optional(PluginEntry),
    capabilities: Schema.Array(Schema.String),
    /** Set when the block's declared binding failed preflight and its alternative was used. */
    alternative: Schema.optional(Schema.Boolean),
  }),
  Schema.TaggedStruct("PromptComposed", { promptRef: ArtifactId }),
  Schema.TaggedStruct("SessionStarted", { sessionId: SessionId }),
  Schema.TaggedStruct("SessionResumed", { sessionId: SessionId }),
  Schema.TaggedStruct("AgentActivity", {
    activity: Schema.String,
    detail: Schema.optional(Schema.String),
  }),
  // Raw output lives in the artifact behind `ref`; the journal keeps only the excerpt.
  Schema.TaggedStruct("OutputChunk", {
    streamKind: Schema.Literal("stdout", "stderr", "assistant"),
    excerpt: Schema.String,
    ref: Schema.optional(ArtifactId),
  }),
  // The artifact holds the result in full; the inline copy is present only when it is small
  // enough that a reader of the log alone can still see what the block produced.
  Schema.TaggedStruct("ResultProduced", {
    outputRef: Schema.optional(ArtifactId),
    outputInline: Schema.optional(Schema.Unknown),
  }),
  Schema.TaggedStruct("QuestionAsked", { question: Schema.String }),
  Schema.TaggedStruct("QuestionAnswered", { answer: Schema.String }),
  Schema.TaggedStruct("ApprovalRequested", { gateId: BlockId, payloadRef: ArtifactId }),
  Schema.TaggedStruct("ApprovalDecided", {
    gateId: BlockId,
    approved: Schema.Boolean,
    note: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("RetryScheduled", {
    class: ErrorClass,
    nextAttempt: Schema.Int,
    delayMs: Schema.Int,
  }),
  Schema.TaggedStruct("VerificationReported", { criteria: Schema.Array(CriterionResult) }),
  Schema.TaggedStruct("FailureFeedbackForwarded", { packetRef: ArtifactId }),
)
export type AncillaryPayload = typeof AncillaryPayload.Type

/** Subset of contracts §9. */
export const EventPayload = Schema.Union(LifecyclePayload, AncillaryPayload)
export type EventPayload = typeof EventPayload.Type

export const JournalEvent = Schema.Struct({
  seq: EventSeq,
  ts: Schema.String,
  runId: RunId,
  blockId: Schema.optional(BlockId),
  attemptId: Schema.optional(AttemptId),
  payload: EventPayload,
})
export type JournalEvent = typeof JournalEvent.Type

export interface EventInput<P = EventPayload> {
  readonly runId: RunId
  readonly blockId?: BlockId
  readonly attemptId?: AttemptId
  readonly payload: P
}
