import { Schema } from "effect"
import { ArtifactId, AttemptId, BlockId, CheckpointId, EventSeq, RunId, SessionId } from "./ids.js"
import { ProviderName } from "./Provider.js"

export const RunStatus = Schema.Literal(
  "created",
  "awaiting-start",
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

export const BlockKind = Schema.Literal("agent", "command", "workspace")
export type BlockKind = typeof BlockKind.Type

/** How finalize replays the run's checkpoints onto the target branch (plan §9). */
export const FinalizeMode = Schema.Literal("squash", "ordered")
export type FinalizeMode = typeof FinalizeMode.Type

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
  /** Planning is done and the run holds a tree; nothing executes until a human presses Run. */
  Schema.TaggedStruct("RunAwaitingStart", {}),
  Schema.TaggedStruct("RunStarted", {}),
  Schema.TaggedStruct("RunFinished", { status: Schema.Literal("succeeded", "failed") }),
  Schema.TaggedStruct("RunCancelled", {}),
  /** A user stop: the run closes as interrupted — open, resumable — unlike a terminal cancel. */
  Schema.TaggedStruct("RunStopped", {}),
  Schema.TaggedStruct("RunRecovered", { lastCheckpoint: Schema.optional(CheckpointId) }),
  Schema.TaggedStruct("RunResumed", {}),
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
  /** A user asked to skip a node's next visit; the skip itself is the BlockSkipped that follows. */
  Schema.TaggedStruct("BlockSkipRequested", { nodeId: Schema.String }),
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
  // A re-entering run reads a finished block's result out of the journal instead of running it
  // again (plan §9); `BlockSkipped` cannot say this, since that one opens a block row of its own.
  Schema.TaggedStruct("BlockReplayed", { defId: Schema.String, reason: Schema.String }),
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
  // The one event describing a change outside the run's own worktree, which is what makes it the
  // record to check when asking what a run did to the user's repository.
  Schema.TaggedStruct("RunFinalized", {
    targetBranch: Schema.String,
    mode: FinalizeMode,
    commit: Schema.String,
    commits: Schema.Int,
    previousTip: Schema.String,
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

type OfTag<T extends EventPayload["_tag"]> = Extract<EventPayload, { readonly _tag: T }>

export const eventsOf = <T extends EventPayload["_tag"]>(
  events: ReadonlyArray<JournalEvent>,
  tag: T,
): ReadonlyArray<{ readonly event: JournalEvent; readonly payload: OfTag<T> }> =>
  events.flatMap((event) =>
    event.payload._tag === tag ? [{ event, payload: event.payload as OfTag<T> }] : [],
  )

export const lastOf = <T extends EventPayload["_tag"]>(
  events: ReadonlyArray<JournalEvent>,
  tag: T,
): OfTag<T> | undefined => eventsOf(events, tag).at(-1)?.payload

/** Which block an event hangs off, or the run itself. */
export const blockOf = (event: JournalEvent) =>
  event.blockId === undefined ? "run" : (event.blockId as string)

export interface ErrorCount {
  readonly signature: string
  readonly count: number
  /** The first message recorded under this signature, verbatim; each renderer budgets it. */
  readonly message: string
}

/** Recurring failures collapse onto their signature, which is what makes a repeat visible. */
export const errorCounts = (
  events: ReadonlyArray<JournalEvent>,
): ReadonlyArray<ErrorCount> => {
  const counts = new Map<string, { count: number; message: string }>()
  for (const { payload } of eventsOf(events, "ErrorRaised")) {
    const seen = counts.get(payload.signature)
    if (seen === undefined) counts.set(payload.signature, { count: 1, message: payload.message })
    else seen.count += 1
  }
  return [...counts].map(([signature, seen]) => ({ signature, ...seen }))
}

/** How each block's agent was actually reached: provider, plugin, entry. */
export const pluginLabels = (
  events: ReadonlyArray<JournalEvent>,
): ReadonlyMap<string, string> =>
  new Map(
    eventsOf(events, "PluginResolved").map(({ event, payload }) => [
      blockOf(event),
      [
        payload.provider.name,
        ...(payload.plugin === undefined
          ? []
          : [`${payload.plugin.name}@${payload.plugin.version}`]),
        ...(payload.entry === undefined ? [] : [`${payload.entry.kind} ${payload.entry.name}`]),
        ...(payload.alternative === true ? ["via its alternative binding"] : []),
      ].join(" · "),
    ]),
  )

export const skipReasons = (events: ReadonlyArray<JournalEvent>): ReadonlyMap<string, string> =>
  new Map(
    eventsOf(events, "BlockSkipped").map(({ event, payload }) => [blockOf(event), payload.reason]),
  )

/** Why an attempt is worth reading about, in the order the journal recorded it. */
export type AttemptReason =
  | { readonly _tag: "Error"; readonly signature: string; readonly message: string }
  | { readonly _tag: "Packet"; readonly packetRef: ArtifactId }

export interface AttemptFacts {
  readonly blockId: string
  readonly number: number
  readonly startedAt: string
  sessionId?: SessionId
  verdict?: AttemptVerdict | "interrupted"
  finishedAt?: string
  readonly reasons: AttemptReason[]
}

/** What each attempt did, folded out of the log the run left behind. */
export const attemptFacts = (
  events: ReadonlyArray<JournalEvent>,
): ReadonlyArray<AttemptFacts> => {
  const attempts = new Map<AttemptId, AttemptFacts>()
  for (const event of events) {
    const id = event.attemptId
    if (id === undefined) continue
    const payload = event.payload
    if (payload._tag === "AttemptStarted") {
      attempts.set(id, {
        blockId: blockOf(event),
        number: payload.number,
        startedAt: event.ts,
        sessionId: payload.sessionId,
        reasons: [],
      })
      continue
    }
    const facts = attempts.get(id)
    if (facts === undefined) continue
    if (payload._tag === "AttemptFinished") {
      facts.verdict = payload.verdict
      facts.finishedAt = event.ts
    } else if (payload._tag === "AttemptInterrupted") {
      facts.verdict = "interrupted"
      facts.finishedAt = event.ts
    } else if (payload._tag === "SessionStarted") {
      facts.sessionId = payload.sessionId
    } else if (payload._tag === "ErrorRaised") {
      facts.reasons.push({
        _tag: "Error",
        signature: payload.signature,
        message: payload.message,
      })
    } else if (payload._tag === "FailureFeedbackForwarded") {
      facts.reasons.push({ _tag: "Packet", packetRef: payload.packetRef })
    }
  }
  return [...attempts.values()]
}
