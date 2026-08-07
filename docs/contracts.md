# Cockpit — Typed Contracts

Effect Schema sketches for the core contracts. Illustrative, not final code: field names and shapes are the agreement; exact Schema combinators get settled in Phase 2–5 against the pinned Effect version. All contracts live in `packages/core` (engine-internal) or `packages/cartridge-kit` (cartridge-facing surface).

## 1. Identifiers and errors

```ts
type RunId = string & Brand<"RunId">        // uuid
type BlockId = string & Brand<"BlockId">    // per-run block instance id; the template's block id lives in blocks.def_id (settled in Phase 2)
type AttemptId = string & Brand<"AttemptId">
type SessionId = string & Brand<"SessionId">  // Cockpit-assigned, passed to the provider CLI
type CheckpointId = string & Brand<"CheckpointId">  // git sha
type ArtifactId = string & Brand<"ArtifactId">
type EventSeq = number                       // monotonic journal cursor
```

Tagged error hierarchy (every service failure is one of these; no untyped throws):

```ts
class PreflightError    { reason: "provider-unavailable" | "plugin-missing" | "entry-missing"
                          | "version-incompatible" | "permission-missing" | "workspace-unsafe"; detail: string }
class ValidationError   { rule: string; path: string[]; message: string }
class ProviderError     { kind: "spawn" | "crash" | "parse" | "timeout"; sessionId?: SessionId }
class WorkspaceError    { op: "create" | "reconcile" | "checkpoint" | "rollback" | "finalize" | "remove"; detail: string }
class JournalError      { op: string; detail: string }
class CartridgeError    { stage: "load" | "validate" | "transform"; detail: string }
class HerdrError        { op: "connect" | "tab" | "agent"; detail: string }
```

## 2. Workflow tree

```ts
type WorkflowNode =
  | { _tag: "Block";     id: BlockId; def: BlockDefRef; overrides?: BlockOverrides }
  | { _tag: "Sequence";  children: WorkflowNode[] }
  | { _tag: "Parallel";  branches: { node: WorkflowNode; workspaceAccess: "read" | "write" }[] }
      // validator: at most one "write" branch
  | { _tag: "Condition"; predicate: PredicateRef; onTrue: WorkflowNode; onFalse?: WorkflowNode }
      // predicate: deterministic, declared over prior block outputs by JSON path + comparator
  | { _tag: "Loop";      body: WorkflowNode; policy: RetryPolicy; kind: "semantic-retry" | "corrective";
                         feedbackRoute?: { from: BlockId; to: BlockId } }  // verifier → implementer
  | { _tag: "Gate";      id: BlockId; payload: GatePayload }  // human approval

interface WorkflowTree {
  runId: RunId
  templateId: string
  nodes: WorkflowNode           // root
  analyzer: AnalyzerDecision    // provenance, shown in UI
  transformsApplied: { name: string; diffRef: ArtifactId }[]
}
```

## 3. Workflow template (core + cartridge)

```ts
interface WorkflowTemplate {
  id: string                        // e.g. "bugfix", "feature", cartridge-scoped: "aia/interview-flow"
  description: string               // Analyzer-facing: when to choose this template
  tree: WorkflowNode                // with optional blocks + parameter slots
  params: Schema.Struct<...>        // typed parameters the Analyzer must fill
  optionalBlocks: { blockId: BlockId; default: boolean; hint: string }[]
  allowedBindings: Record<BlockId, PluginBinding[]>   // Analyzer picks from these only
  retryBounds: Record<BlockId, { min: number; max: number }>
}

interface AnalyzerDecision {
  templateId: string
  params: unknown                   // validated against template.params
  optionalBlockToggles: Record<BlockId, boolean>
  bindingChoices: Record<BlockId, number>   // index into allowedBindings
  retryCounts: Record<BlockId, number>      // clamped to retryBounds
  rationale: string
}
```

## 4. Block definition

```ts
interface BlockDef<I, O> {
  id: string
  kind: "agent" | "command"
  title: string
  input: Schema<I>                  // envelope fields this block sees — nothing more
  output: Schema<O>                 // agent blocks: written to $COCKPIT_OUTPUT as JSON
  provider?: "claude-code" | "codex"        // agent blocks
  binding?: PluginBinding                    // agent blocks, optional
  promptTemplate?: string                    // agent blocks; rendered with input + failure packet
  command?: { argv: string[]; env?: Record<string, string>; successRules?: OutputRule[] }  // command blocks
  sessionPolicy: "fresh" | "continue"        // default "fresh" (ADR-004)
  retryPolicy: RetryPolicyRef
  timeoutMs: number
  permissionProfile: "read-only" | "workspace-write" | "workspace-write-network"
  workspaceAccess: "read" | "write"
  expectedArtifacts?: { glob: string; required: boolean }[]
  successCriteria: SuccessCriterion[]        // machine-checkable; verifier blocks emit evidence for these
  fallback: { _tag: "Fail" } | { _tag: "SkipWithWarning" } | { _tag: "AlternativeBinding"; binding: PluginBinding }
}
```

## 5. PluginBinding (data-driven plugin execution)

```ts
interface PluginBinding {
  plugin?: string                   // e.g. "oh-my-claudecode"; absent = bare provider session
  entry: { kind: "slash" | "skill" | "agent"; name: string }   // e.g. slash "oh-my-claudecode:plan"
  argsTemplate?: string             // rendered with block input
  extraInstructions?: string
  requiredCapabilities: string[]    // preflight-checked against the plugin catalog
  minVersion?: string
  managesInternalRetries: boolean   // true → validator forbids outer semantic loop attempts > 1
  stateFiles?: string[]             // globs captured as artifacts after the block (e.g. ".omc/**")
  cancellation: "kill-tree"         // v1: always kill the process group
}
```

Preflight result, recorded per run: `{ provider: { name, version }, plugin?: { name, version }, entryResolved: boolean, capabilities: string[] }`.

## 6. Context handoff envelope

```ts
interface BlockInputEnvelope {
  task: { prompt: string; projectId: string }
  plan?: ArtifactRef                 // approved plan artifact
  decisions: Decision[]              // typed key decisions so far
  workspace: { worktreePath: string; headCheckpoint: CheckpointId; changedFiles: string[] }
  priorOutputs: Record<BlockId, unknown>   // only blocks listed in this block's input schema
  commandResults?: CommandResultRef[]
  verificationEvidence?: EvidenceRef[]
  errors?: ErrorSummary[]
  attemptContext?: RetryContext      // §8, present on retries
}
```

Large payloads always travel as `ArtifactRef { id, path, kind, bytes, excerpt? }` or `CheckpointId` — never inline.

## 7. Attempt result and failure packet

```ts
interface AttemptResult {
  attemptId: AttemptId
  blockId: BlockId
  attemptNumber: number
  sessionId: SessionId
  verdict: "success" | "semantic-failure" | "technical-failure" | "interrupted" | "cancelled"
  output?: unknown                   // validated block output (verdict success)
  evidence: EvidenceRef[]            // test runs, verifier findings, command outputs
  errors: ErrorSummary[]             // deduplicated { signature, message, count, artifactRef? }
  artifacts: ArtifactRef[]
  changedFiles: string[]
  checkpoint?: { id: CheckpointId; kind: "success" | "salvage" }
  durationMs: number
}

interface FailurePacket {            // distilled from AttemptResult for the NEXT attempt
  attemptNumber: number
  hypothesis: string                 // what the attempt believed and tried
  strategy: { binding?: string; approach: string }
  actionsTaken: string[]
  commandsRun: string[]
  whatFailed: string                 // precise: failing tests/validators/criteria
  diagnostics: { excerpt: string; ref?: ArtifactId }[]
  failureReason: string              // why it was judged unsuccessful
  doNotRepeat: string[]
  remainingDirections: string[]
}

interface RetryContext {             // what a retrying attempt actually receives
  lastAttempt: FailurePacket                       // detailed
  olderAttempts: { attemptNumber: number; summary: string }[]   // one paragraph each
  repeatedErrors: { signature: string; count: number }[]
  budget: { maxChars: number }       // builder enforces; summarizes, never truncates mid-structure
}
```

## 8. Retry policy

```ts
interface RetryPolicy {
  id: string
  maxAttempts: number
  attemptTimeoutMs: number
  loopTimeoutMs: number
  retryable: ErrorClass[]            // "technical" subclasses get Schedule backoff, don't consume semantic attempts
  nonRetryable: ErrorClass[]         // immediate stop
  backoff: { initialMs: number; factor: number; maxMs: number }   // technical only
  successCriteria: SuccessCriterion[]
  stopImmediately: StopCondition[]   // e.g. destructive-change detected, budget exceeded
  humanGateAfterFailures?: number    // insert approval gate after N failed attempts
  noProgress: { sameFailureSignatureLimit: number }   // identical signature twice by default → stop + gate
  checkpointEachAttempt: boolean     // salvage checkpoints for useful failed attempts
  onRetry: "rollback" | "continue"   // rollback → git reset to pre-attempt checkpoint
  // v2 reserved: providerSwitch?, bindingSwitch?
}
```

## 9. Event model (journal + WS)

Every event: `{ seq: EventSeq, ts: ISO8601, runId: RunId, blockId?: BlockId, attemptId?: AttemptId, payload: EventPayload }`. Journal-first; WS streams from a client-supplied cursor.

```ts
type EventPayload =
  | RunCreated | RunStarted | RunFinished | RunCancelled | RunRecovered
  | TreeAnalyzed | TreeTransformed | TreeValidated
  | BlockStarted | BlockFinished | BlockSkipped
  | AttemptStarted | AttemptFinished | AttemptInterrupted
  | SessionStarted | SessionResumed          // provider session lifecycles
  | AgentActivity                            // subagent/tool activity mapped from provider stream
  | PluginResolved                           // binding + resolved versions (preflight)
  | PromptComposed { promptRef: ArtifactId }
  | CommandExecuted { argv; exitCode; stdoutRef; stderrRef; durationMs }
  | ResultProduced { outputRef | outputInline }
  | QuestionAsked { question; options? } | QuestionAnswered
  | ErrorRaised { class; signature; message; ref? }
  | ArtifactCreated
  | CheckpointCreated { kind: "success" | "salvage" }
  | ApprovalRequested { payloadRef } | ApprovalDecided { approved; note? }
  | RetryScheduled { class: "technical" | "semantic"; nextAttempt: number }
  | VerificationReported { criteria: { criterion; passed; evidenceRef }[] }
  | FailureFeedbackForwarded { packetRef: ArtifactId }   // the exact packet the next attempt sees
  | OutputChunk { streamKind: "stdout" | "stderr" | "assistant"; excerpt; ref }  // raw output lives in artifacts
```

## 10. Persistence schema (SQLite, v1)

```sql
projects  (id, name, repo_path, cartridge_hash, created_at)
runs      (id, project_id, prompt, status, base_commit, worktree_path, branch,
           provider_versions_json, plugin_versions_json, cartridge_hash,
           canonical_session_id, created_at, finished_at)
blocks    (id, run_id, def_id, kind, status, started_at, finished_at)
attempts  (id, block_id, number, session_id, verdict, result_json, started_at, finished_at)
events    (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id, block_id, attempt_id, ts, payload_json)
artifacts (id, run_id, kind, path, bytes, created_at)
checkpoints (id /* sha */, run_id, block_id, attempt_id, kind, created_at)
insights  (id, dedup_key UNIQUE, target /* core|cartridge */, title, body, evidence_json,
           occurrences, first_seen_run, last_seen_run)
```

Run artifacts (prompts, transcripts, long output, packets, briefs) are files under `~/.cockpit/runs/<runId>/`, addressed by `artifacts` rows. The DB stores references and compact JSON only.

## 11. Cartridge API surface (`packages/cartridge-kit`)

```ts
// <project>/.cockpit/cockpit.config.ts
export default defineCartridge({
  name: "ai-interview-assistant",
  environment: { healthChecks: [ { argv: ["pnpm", "install", "--frozen-lockfile"], timeoutMs } ] },
  blocks:    [ /* BlockDef[] — project-specific blocks */ ],
  templates: [ /* WorkflowTemplate[] */ ],
  prompts:   { /* named prompt fragments referenced by templates */ },
  commands:  { /* named argv presets for command blocks */ },
  transforms: [
    { name: "enforce-comment-lint", apply: (tree, ctx) => tree /* pure, sync */ },
  ],
  validators: [ /* extra tree rules: (tree, ctx) => ValidationError[] */ ],
  retryPolicies: [ /* RetryPolicy[] overriding core defaults by id */ ],
  bindings:  [ /* PluginBinding presets */ ],
  rules:     { /* project rules injected into agent prompts */ },
})
```

`defineCartridge` returns the config Schema-validated at load; all types are exported so the cartridge compiles under the project's own `tsc`. Everything is data + pure functions; cartridge code performs no IO at load time (enforced by review + loader timeout).

## 12. Task brief (canonical continuation session seed)

Assembled from the journal, rendered as Markdown, stored as an artifact, injected as the first prompt of the canonical session (ADR-008): original prompt; project + run metadata; approved plan; block-by-block outcomes with plugins used; meaningful attempts with failure reasons; key decisions; changed files; checkpoints/commits; verification results; errors and retries; artifacts index; review feedback; final result; current worktree path and how to run the project's checks. Budgeted like retry context; long material referenced by path.
