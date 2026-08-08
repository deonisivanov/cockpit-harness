/**
 * Mirrored by hand from packages/core/src/{events,workflow}.ts. The daemon's schemas are Effect
 * Schema definitions; pulling them in would drag `effect` into the browser bundle for types alone.
 * Keep the unions in step with that file when the contract changes.
 */

export type RunStatus =
  | "created"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"

export type BlockStatus = "running" | "succeeded" | "failed" | "skipped" | "interrupted"

export type BlockKind = "agent" | "command"

export type AttemptVerdict =
  | "success"
  | "semantic-failure"
  | "technical-failure"
  | "interrupted"
  | "cancelled"

export type CheckpointKind = "success" | "salvage"

export type ErrorClass = "technical" | "semantic"

export interface CriterionResult {
  readonly criterion: string
  readonly passed: boolean
  readonly evidenceRef?: string
}

export interface PluginEntry {
  readonly kind: "slash" | "skill" | "agent"
  readonly name: string
}

export type EventPayload =
  | { readonly _tag: "RunCreated"; readonly projectId: string; readonly prompt: string }
  | { readonly _tag: "RunStarted" }
  | { readonly _tag: "RunFinished"; readonly status: "succeeded" | "failed" }
  | { readonly _tag: "RunCancelled" }
  | { readonly _tag: "RunRecovered"; readonly lastCheckpoint?: string }
  | { readonly _tag: "BlockStarted"; readonly defId: string; readonly kind: BlockKind }
  | { readonly _tag: "BlockFinished"; readonly status: "succeeded" | "failed" | "interrupted" }
  | { readonly _tag: "BlockSkipped"; readonly reason: string }
  | { readonly _tag: "AttemptStarted"; readonly number: number; readonly sessionId?: string }
  | { readonly _tag: "AttemptFinished"; readonly verdict: AttemptVerdict }
  | { readonly _tag: "AttemptInterrupted" }
  | {
      readonly _tag: "CheckpointCreated"
      readonly checkpointId: string
      readonly kind: CheckpointKind
    }
  | {
      readonly _tag: "ArtifactCreated"
      readonly artifactId: string
      readonly kind: string
      readonly path: string
      readonly bytes: number
    }
  | {
      readonly _tag: "ErrorRaised"
      readonly class: string
      readonly signature: string
      readonly message: string
    }
  | {
      readonly _tag: "CommandExecuted"
      readonly argv: ReadonlyArray<string>
      readonly exitCode: number | null
      readonly timedOut: boolean
      readonly durationMs: number
      readonly success: boolean
    }
  | {
      readonly _tag: "TreeValidated"
      readonly errors: ReadonlyArray<{
        readonly rule: string
        readonly path: ReadonlyArray<string>
        readonly message: string
      }>
    }
  | {
      readonly _tag: "TreeAnalyzed"
      readonly templateId: string
      readonly rationale: string
      readonly decision: unknown
      readonly fallback: boolean
      readonly warning?: string
    }
  | { readonly _tag: "TreeTransformed"; readonly name: string; readonly diffRef: string }
  | {
      readonly _tag: "PluginResolved"
      readonly provider: { readonly name: string; readonly version?: string }
      readonly plugin?: { readonly name: string; readonly version: string }
      readonly entry?: PluginEntry
      readonly capabilities: ReadonlyArray<string>
      readonly alternative?: boolean
    }
  | { readonly _tag: "PromptComposed"; readonly promptRef: string }
  | { readonly _tag: "SessionStarted"; readonly sessionId: string }
  | { readonly _tag: "SessionResumed"; readonly sessionId: string }
  | { readonly _tag: "AgentActivity"; readonly activity: string; readonly detail?: string }
  | {
      readonly _tag: "OutputChunk"
      readonly streamKind: "stdout" | "stderr" | "assistant"
      readonly excerpt: string
      readonly ref?: string
    }
  | {
      readonly _tag: "ResultProduced"
      readonly outputRef?: string
      readonly outputInline?: unknown
    }
  | { readonly _tag: "QuestionAsked"; readonly question: string }
  | { readonly _tag: "QuestionAnswered"; readonly answer: string }
  | { readonly _tag: "ApprovalRequested"; readonly gateId: string; readonly payloadRef: string }
  | {
      readonly _tag: "ApprovalDecided"
      readonly gateId: string
      readonly approved: boolean
      readonly note?: string
    }
  | {
      readonly _tag: "RetryScheduled"
      readonly class: ErrorClass
      readonly nextAttempt: number
      readonly delayMs: number
    }
  | {
      readonly _tag: "VerificationReported"
      readonly criteria: ReadonlyArray<CriterionResult>
    }
  | { readonly _tag: "FailureFeedbackForwarded"; readonly packetRef: string }

export type EventTag = EventPayload["_tag"]

export interface JournalEvent {
  readonly seq: number
  readonly ts: string
  readonly runId: string
  readonly blockId?: string
  readonly attemptId?: string
  readonly payload: EventPayload
}

export interface Project {
  readonly id: string
  readonly name: string
  readonly repoPath: string
}

/** `runs` has no start column (contracts §10); the run's start is the `RunStarted` event's ts. */
export interface Run {
  readonly id: string
  readonly projectId: string
  readonly prompt: string
  readonly status: RunStatus
  readonly createdAt: string
  readonly finishedAt?: string | null
}

export interface GatePayload {
  readonly title: string
  readonly summary: string
  readonly artifacts?: ReadonlyArray<string>
}

export type WorkflowNode =
  | { readonly _tag: "Block"; readonly id: string; readonly def: string; readonly inputs?: ReadonlyArray<string> }
  | { readonly _tag: "Sequence"; readonly children: ReadonlyArray<WorkflowNode> }
  | {
      readonly _tag: "Parallel"
      readonly branches: ReadonlyArray<{ readonly node: WorkflowNode; readonly workspaceAccess: string }>
    }
  | {
      readonly _tag: "Condition"
      readonly predicate: unknown
      readonly onTrue: WorkflowNode
      readonly onFalse?: WorkflowNode
    }
  | {
      readonly _tag: "Loop"
      readonly body: WorkflowNode
      readonly policy: string
      readonly kind: "semantic-retry" | "corrective"
      readonly feedbackRoute?: { readonly from: string; readonly to: string }
    }
  | { readonly _tag: "Gate"; readonly id: string; readonly payload: GatePayload }

export interface WorkflowTree {
  readonly runId: string
  readonly templateId: string
  readonly root: WorkflowNode
}

/** `tree` and `retryPolicies` arrive together, once the analyzer has settled on a plan. */
export interface RunDetail {
  readonly run: Run
  readonly tree?: WorkflowTree
  /** Keyed by a Loop's `policy` verbatim — the Analyzer derives ids like `corrective@implement:5`. */
  readonly retryPolicies?: Readonly<Record<string, { readonly maxAttempts: number }>>
}

/** Assembled client-side: the row from `/artifacts/:id`, the body from `/artifacts/:id/raw`. */
export interface ArtifactBody {
  readonly id: string
  readonly kind: string
  readonly path: string
  readonly bytes: number
  readonly text: string
}
