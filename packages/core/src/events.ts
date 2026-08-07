import { Schema } from "effect"
import { AttemptId, BlockId, CheckpointId, EventSeq, RunId, SessionId } from "./ids.js"

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
)
export type LifecyclePayload = typeof LifecyclePayload.Type

/** Free-form events any service may append; they never move the state machine. */
export const AncillaryPayload = Schema.Union(
  Schema.TaggedStruct("ErrorRaised", {
    class: Schema.String,
    signature: Schema.String,
    message: Schema.String,
  }),
  // Output is not carried here: contracts §9 puts it behind artifact refs, which land in Phase 4.
  Schema.TaggedStruct("CommandExecuted", {
    argv: Schema.Array(Schema.String),
    /** `null` when the child was killed or lost before reporting a status; `timedOut` says which. */
    exitCode: Schema.NullOr(Schema.Int),
    timedOut: Schema.Boolean,
    durationMs: Schema.Int,
    success: Schema.Boolean,
  }),
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
