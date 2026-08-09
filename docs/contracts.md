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
class WorkspaceError    { op: "create" | "reconcile" | "resolve" | "checkpoint" | "rollback" | "finalize" | "remove"; detail: string }
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
  root: WorkflowNode
  // settled in Phase 5: analyzer/transformsApplied provenance lives in the journal
  // (TreeAnalyzed carries the decision + rationale, TreeTransformed carries diff artifact refs);
  // the UI reads events, not an in-tree copy
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
  kind: "agent" | "command" | "workspace"   // workspace: executed natively by the engine (finalize)
  title: string
  input: ContractField[]            // settled in Phase 4: {name, type, required} list — journal/UI-serializable,
  output: ContractField[]           // structurally comparable by the validator; runtime Schema derived from it.
                                    // Agent blocks: output written to $COCKPIT_OUTPUT as JSON
  provider?: "claude-code" | "codex"        // agent blocks
  binding?: PluginBinding                    // agent blocks, optional
  promptTemplate?: string                    // agent blocks; rendered with input + failure packet
  promptFile?: string                        // agent blocks; path inside .cockpit, read into promptTemplate
                                             // at load (§11) — mutually exclusive with it
  command?: { argv: string[]; env?: Record<string, string>; successRules?: OutputRule[] }  // command blocks
  skipWhenUnchanged?: boolean                // opt-in: the engine skips the block (BlockSkipped, reason
                                             // "no files changed since the run's base commit") when the
                                             // worktree holds nothing the run's base commit did not, and
                                             // never when the run recorded no base commit. For gates that
                                             // police changes; validation refuses the flag on a block a
                                             // downstream required input depends on, on a Condition's
                                             // predicate source, and on a Loop's verdict source.
  finalizeMode?: "squash" | "ordered"         // workspace blocks; default "squash"
  sessionPolicy: "fresh" | "continue"        // default "fresh" (ADR-004)
  retryPolicy: RetryPolicyRef
  timeoutMs: number
  permissionProfile: "read-only" | "read-plus-output" | "workspace-write" | "workspace-write-network"
                                    // read-plus-output: no repository writes, but $COCKPIT_OUTPUT stays writable
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
  argsTemplate?: string             // rendered with the composed block prompt (v1)
  extraInstructions?: string
  requiredCapabilities: string[]    // preflight-checked against the plugin catalog
  minVersion?: string
  managesInternalRetries: boolean   // true → validator forbids outer semantic loop attempts > 1
  stateFiles?: string[]             // globs captured as artifacts after the block (e.g. ".omc/**")
  cancellation: "kill-tree"         // v1: always kill the process group
}
```

Preflight result, recorded per run: `{ provider: { name, version }, plugin?: { name, version }, entry?: PluginEntry, capabilities: string[] }`. An entry that cannot be resolved is a preflight failure, never a recorded result.

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
  contextBudgetChars: number         // settled in Phase 4: per-block retry-context budget (plan §8)
  // settled in Phase 4: stopImmediately, policy-level successCriteria and attemptTimeoutMs dropped
  // for v1 (no detectors, duplicated block-level criteria, and BlockDef.timeoutMs already bounds an
  // attempt); technical-retry bound is an engine constant
  // v2 reserved: providerSwitch?, bindingSwitch?
}
```

## 9. Event model (journal + WS)

Every event: `{ seq: EventSeq, ts: ISO8601, runId: RunId, blockId?: BlockId, attemptId?: AttemptId, payload: EventPayload }`. Journal-first; WS streams from a client-supplied cursor.

```ts
type EventPayload =
  | RunCreated | RunAwaitingStart | RunStarted | RunFinished | RunCancelled | RunStopped
  | RunRecovered | RunResumed
      // RunAwaitingStart: planning settled on a tree and the run waits there — `POST /runs/:id/start`
      // executes it, `POST /runs/:id/regenerate` replaces the tree, cancel discards it. The wait is a
      // run status rather than a parked fiber, so it outlives the daemon. Statuses run
      // created → awaiting-start → running → succeeded | failed; cancelled closes any of the open
      // ones, and interrupted closes a run that was executing.
  | TreeAnalyzed | TreeTransformed | TreeValidated
  | BlockStarted | BlockFinished | BlockSkipped
  | BlockSkipRequested { nodeId }            // ancillary: honoured at the next visit; consumed by its BlockSkipped
  | BlockReplayed { defId; reason }          // re-entry read this block's result from the journal
  | AttemptStarted | AttemptFinished | AttemptInterrupted
  | SessionStarted | SessionResumed          // provider session lifecycles
  | AgentActivity                            // subagent/tool activity mapped from provider stream
  | PluginResolved                           // binding + resolved versions (preflight)
  | PromptComposed { promptRef: ArtifactId }
  | CommandExecuted { argv; exitCode; stdoutRef; stderrRef; durationMs }
  | ResultProduced { outputRef | outputInline }
  | QuestionAsked { question; options? } | QuestionAnswered { answer }
      // settled in Phase 6: "waiting" is DERIVED, never stored — a block waits when
      // QuestionAsked (or ApprovalRequested) has no matching answer/decision event yet;
      // answering before the attempt parks returns 409 (client retries), never buffers.
      // The executed tree persists as an artifact of kind "workflow-tree" (no runs column).
  | ErrorRaised { class; signature; message; ref? }
  | ArtifactCreated
  | CheckpointCreated { kind: "success" | "salvage" }
  | RunFinalized { targetBranch; mode: "squash" | "ordered"; commit; commits; previousTip }
      // the only event describing a write outside the run's own worktree
  | ApprovalRequested { payloadRef } | ApprovalDecided { approved; note? }
  | RetryScheduled { class: "technical" | "semantic"; nextAttempt: number }
  | VerificationReported { criteria: { criterion; passed; evidenceRef }[] }
  | FailureFeedbackForwarded { packetRef: ArtifactId }   // the exact packet the next attempt sees
  | OutputChunk { streamKind: "stdout" | "stderr" | "assistant"; excerpt; ref }  // raw output lives in artifacts
```

### Run re-entry (settled in Phase 9)

`POST /api/runs/:id/resume` takes an `interrupted` or `failed` run and carries it on; anything else
is 409, an unknown run 404, and a cancelled run stays cancelled — it was stopped on purpose. It
answers `202 {runId}` and reports through the normal event stream. `retry` is gone rather than
aliased: re-entry has one verb. The boot scan stays marking-only (plan §9); a run that restarts
itself on boot is a worse surprise than a button.

- **The plan is read once, before execution** (`buildResumePlan`), and the walk consults it instead
  of the journal, so nothing it decides depends on rows the resumed run is itself writing. Its
  records are keyed by *node* id and spent on the first visit, which is what makes a loop's later
  iterations real work.
- **A block whose newest instance is `succeeded` or `skipped` is never executed again** (§17.6). Its
  result is rehydrated — `ResultProduced.outputInline`, or the `outputRef` artifact read back — into
  `priorOutputs` under the same node id, and a `BlockReplayed` records that the journal answered for
  it. `BlockSkipped` could not: that one opens a block row, and the row already exists.
- **Instance numbering continues.** `executions` is seeded from the recorded instances, so the next
  execution of `implement` after `implement#2` is `implement#3`; the interrupted instance keeps its
  own record and its `AttemptInterrupted`.
- **A loop resumes at the iteration it stopped in.** The iteration is *open* when the block whose
  verdict closes it (`feedbackRoute.from`, else the body's last block) has closed fewer iterations
  than the block that opens it has started. Open → the pass continues that iteration and replays
  what it finished; closed → the pass is the next iteration and the whole body runs again. The
  ceiling is checked after the body, so a loop that had exhausted its attempts gets exactly one
  fresh cycle — which is what the user asked for by resuming a failed run — while an interrupted one
  keeps only what was left. Attempts already *judged* stay spent; an interrupted attempt is not
  charged, since it was never judged. A body whose closing block runs only under a Condition reads
  as open, which costs a replay rather than a re-execution.
- **Failure packets rehydrate as the rendered context**, not as structures: the artifact behind the
  last `FailureFeedbackForwarded` for that node is exactly what the interrupted attempt was given,
  so its successor reads the same text and the event is journaled again under the new instance. The
  structured packet history that feeds no-progress detection does not survive the crash; a resumed
  loop starts counting repeats afresh.
- **Gates**: a decision already in the journal is replayed and the gate is not raised again; an
  undecided one raises a fresh `ApprovalRequested`, since the `Deferred` the old one parked on died
  with the daemon. An unanswered question re-raises the same way — the attempt is re-run fresh, and
  only a `sessionPolicy: "continue"` block resumes the session id its interrupted instance recorded.
- **Workspace**: present → the path is confirmed to still be this run's worktree, whatever it holds
  uncommitted is kept as a salvage commit under the attempt the interruption left open, then
  `reset --hard` to the last confirmed success checkpoint and `reconcile`; gone →
  `WorkspaceManager.restore` detached at that checkpoint with the recorded `targetBranch`, keeping
  the run's original `baseCommit` — the checkout's commit would otherwise stand in for the base
  finalize compares the branch against, and refuse every landing. This runs *inside* the resumed
  run, so a repository that has moved on fails the run with the reason in the journal instead of
  failing the request. Every re-entry that finds work salvages again, so salvage tags are named
  after the commit rather than the attempt; the attempt they belong to is on the checkpoint row.
- **Finalize is not re-landed.** A daemon killed between the branch move and the block's own record
  of finishing comes back to a target branch that is already at this run's commit. Finalize answers
  with the result its journaled `RunFinalized` recorded instead of refusing, moving nothing and
  adding no second record; a branch that anyone *else* moved is still refused.
- **A session that will not resume is not fatal.** A `continue` block re-entering with the id its
  interrupted instance recorded falls back to a fresh session when the CLI cannot resume it —
  `ErrorRaised{signature:"session-unresumable"}`, the seeded id dropped, the same prompt run again.
- **Re-entry refuses rather than guesses**: a completed block whose output artifact cannot be read
  back stops the resume (the blocks wired to it would otherwise run against an empty envelope), and
  the `workflow-tree` artifact is Schema-decoded, so a truncated one reads as no tree at all.
- **Planning is not redone**: the tree and the Analyzer's derived policies come from the run's
  `workflow-tree` artifact. Block definitions come from the cartridge as it stands now, so a project
  edited since the run started resumes against what it has today. A run interrupted before it had a
  tree cannot be re-entered, and says so.

## 10. Persistence schema (SQLite, v1)

```sql
projects  (id, name, repo_path, cartridge_hash, created_at)
runs      (id, project_id, prompt, status, base_commit, worktree_path, branch, target_branch,
           provider_versions_json, plugin_versions_json, cartridge_hash,
           canonical_session_id, created_at, finished_at)
           -- target_branch: the branch the user's checkout was on at run creation; finalize's target
blocks    (id, run_id, def_id, kind, status, started_at, finished_at,
           PRIMARY KEY (run_id, id))
attempts  (id, run_id, block_id, number, session_id, verdict, result_json, started_at,
           finished_at, FOREIGN KEY (run_id, block_id) REFERENCES blocks (run_id, id))
events    (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id, block_id, attempt_id, ts, payload_json)
artifacts (id, run_id, kind, path, bytes, created_at)
checkpoints (id /* sha */, run_id, block_id, attempt_id, kind, created_at)
insights  (id, dedup_key UNIQUE, target /* core|cartridge */, title, body, evidence_json,
           occurrences, first_seen_run, last_seen_run)
```

**Settled in Phase 8:** a `BlockId` is a per-run instance id (`implement`, `implement#2`), so it
keys a block only together with its run — a global `blocks.id` primary key made the second run of any
template fail at its first block. `attempts` carries `run_id` for the composite parent key, which
also drops the join every attempt read previously needed to learn which run it belonged to. Attempts
are addressed under their run: `GET /api/runs/:id/blocks/:blockId/attempts`.

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

`defineCartridge` returns the config Schema-validated at load; all types are exported so the cartridge compiles under the project's own `tsc`. Everything is data + pure functions; cartridge code performs no IO at load time. That rule is upheld by review, not by the runtime — cartridge code runs with the daemon's own privileges (ADR-007), and the loader timeout only catches a load that stalls asynchronously, not synchronous IO or CPU.

**A cartridge is a directory, not a file.** `cockpit.config.ts` is assembly — imports and the `defineCartridge` call — and everything it names lives in its own module:

```
.cockpit/
  cockpit.config.ts     # assembly only
  README.md             # what this cartridge does, how to run a task against this repo
  blocks/               # one file per block
  prompts/              # agent prompts as Markdown, referenced by promptFile
  templates/            # one file per workflow template
  transforms.ts  validators.ts  policies.ts
  tsconfig.json
```

The layout is a convention, not a schema: the loader evaluates `cockpit.config.ts` and follows its imports wherever they lead.

- **The hash covers the directory**, not the entry file: every file under `.cockpit`, sorted, `node_modules` excluded (the kit is linked in there, and an installed tree would put a package manifest in every run's digest). Not an extension allowlist — a prompt is as often `.md` as `.txt`, and a helper as often `.mjs` as `.ts`. An edited prompt therefore moves the hash and invalidates the cached cartridge exactly like an edited block. Each entry is digested with its path and its byte length, so no arrangement of names and contents lets two different cartridges hash alike. Anything imported from outside `.cockpit` is still neither hashed nor watched, and the cached cartridge is marked current only for a directory nothing wrote to while it was being read.
- **`BlockDef.promptFile`** names a path relative to `.cockpit`; the loader reads it into `promptTemplate` after Schema validation and drops the reference, so the engine sees an ordinary block. Core does the IO, not the cartridge — the no-IO rule above holds. A path that names a missing file, or that escapes `.cockpit` either literally or through a symlink, fails the load as `CartridgeError{stage:"validate"}`; declaring both `promptFile` and `promptTemplate` is refused by the Schema, in the kit and at the daemon boundary alike.

## 12. Task brief (canonical continuation session seed)

Assembled from the journal, rendered as Markdown, stored as an artifact, injected as the first prompt of the canonical session (ADR-008): original prompt; project + run metadata; approved plan; block-by-block outcomes with plugins used; meaningful attempts with failure reasons; key decisions; changed files; checkpoints/commits; verification results; errors and retries; artifacts index; review feedback; final result; current worktree path and how to run the project's checks. Budgeted like retry context; long material referenced by path.

**Settled in Phase 7.**

- **Artifact kind `task-brief`**, budget 40 000 chars. Each section declares a floor; the budget takes entries from whichever section is furthest above its floor and replaces them with a `… N more, see the artifact index` line, so a section is summarized rather than cut in half. `renderTaskBrief` is pure — journal events in, Markdown out.
- **A brief is assembled only when a session is seeded**, not on a resume: the session already read it. `Journal.recordArtifact` therefore accepts any run status, since the handoff happens long after the run closed.
- **The session is seeded with a short pointer, not the brief itself.** An interactive CLI takes its first prompt as argv, and a 40 KB operand is hostile; the brief is written to the run directory and the prompt says `Read <path> …, then wait for my instructions`. `--` separates it, the same argv guard the headless providers use.
- **Interactive session commands** (verified against claude 2.1.224 / codex-cli 0.146.0): seed `claude --session-id <uuid> -- <pointer>`, resume `claude --resume <uuid>`; seed `codex -- <pointer>`, resume `codex resume --last`.
- **codex has no assignable session id** and only reveals its own inside the TUI, so `runs.canonical_session_id` stores the sentinel `codex:resume-last`: the handle for a codex run is the command, whose cwd filter and interactive-only default name the one canonical session in that worktree.
- **Resume probe**: claude keeps a session at `$CLAUDE_CONFIG_DIR/projects/<cwd with every non-alphanumeric replaced by `-`>/<id>.jsonl` (cwd resolved through symlinks). A missing file means the session is gone; a missing `projects/` directory means the layout moved, and the resume stays optimistic rather than discarding a live session. codex is always optimistic.
- **Fallbacks** are reported to the UI as `fallback: "fresh-session" | "fresh-worktree"`. A vanished worktree is put back by `WorkspaceManager.restore` at the same path, `git worktree prune` first to clear a stale registration, then `git worktree add --detach <path> <last confirmed checkpoint>`. Detached, not on the run's branch: the branch may carry salvage tags a reset would strand (plan §9).
- **The canonical session is persisted only after a terminal takes it.** The brief is assembled and an id minted, then `openTab`, and only then the archive event and `Journal.openCanonicalSession`. A press that opened nothing leaves the run exactly as it found it, so the next one seeds rather than resuming a session that never existed. `open` is serialized by a semaphore, so two presses cannot mint two ids for one run.
- **An existing handle pins the provider**, not the run's latest `PluginResolved`: claude cannot resume a codex thread. The journal is therefore read only when seeding or when the worktree has to be rebuilt.
- Only a herdr that never got as far as a tab falls through to Ghostty. A failed `pane run` does not — the tab is already on screen, and a second window would leave one session with two terminals; the `HerdrError` names the empty tab instead.
- **herdr is driven through its CLI**, not raw socket JSON: `herdr status server --json` (preflight, protocol 17 recorded with the handoff), `herdr tab create --cwd <worktree> --label <title> --focus` → `result.root_pane.pane_id`, then `herdr pane run <pane> <argv…>`. A protocol other than 17 is recorded, not refused — the CLI tracks its own server.
- **Ghostty fallback** runs `open -na Ghostty.app --args --working-directory=<cwd> -e <argv…>`. Ghostty's own binary refuses to launch the emulator from the CLI on macOS ("only actions are supported"), so plan §10's `/Applications/Ghostty.app/Contents/MacOS/ghostty` does not work and `open` is the documented way in. Any herdr failure falls through to Ghostty with the reason carried as `warning`; if both fail the `HerdrError` names both.
- **Journaled**: `SessionStarted` / `SessionResumed` for the canonical session, `AgentActivity{activity:"canonical-session-archived"}` when an unresumable id is replaced, and `AgentActivity{activity:"terminal:herdr"|"terminal:ghostty"}` for the handoff itself.
- Binaries are overridable for tests: `COCKPIT_HERDR_BIN`, `COCKPIT_OPEN_BIN` alongside the existing `COCKPIT_CLAUDE_BIN` / `COCKPIT_CODEX_BIN`.
