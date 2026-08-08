# Cockpit — Product, Architecture and Implementation Plan

Status: **pending owner approval** — implementation must not start until this plan is explicitly approved.
Source of truth for requirements: `promt.md`. Agreed decisions: `.omc/specs/deep-interview-cockpit.md` (interview, ambiguity 15.8%).
Companion documents: `docs/adr.md` (decisions with rejected alternatives), `docs/contracts.md` (typed contracts), `docs/claude-design-prompt.md` (UI design prompt, draft until `refs/` screenshots land).

## 1. Product summary

Cockpit is a fully local, single-user control room for AI-assisted development. The user types a prompt for a task in a registered project. An Analyzer (running on the user's own Claude Code or Codex subscription) selects and parameterizes a workflow template; deterministic project transforms and a validator harden the tree; the workflow executes agent and command blocks in an isolated git worktree with durable journaling, typed context handoff, adaptive retries fed by structured failure feedback, and human approval gates. Everything is observable live in a dark control-room web UI, and at any moment the task can be continued as a real provider-native terminal session inside the user's herdr workspace.

Two-part architecture:

- **Cockpit Core** — reusable, project-agnostic engine: workflows, blocks, plugin execution, persistence, retries, recovery, isolation, observability, UI. Core never contains knowledge about a specific project.
- **Project cartridge** — TypeScript configuration in `<project>/.cockpit/` describing blocks, prompts, commands, plugins, workflow templates and transforms, retry policies, validators, environment setup, project rules.

Pilot project: `ai-interview-assistant` receives the first cartridge and serves as the real end-to-end validation of v1. No pilot-specific logic may enter Core.

### Hard constraints

- Local, single-user. No multi-tenancy, no remote executor in v1 (the engine/worktree design must not preclude a future coordinator/executor split; nothing in v1 may assume shared memory between UI and execution other than the daemon boundary).
- AI only through installed, authorized `claude` and `codex` CLIs on the user's subscription. No API keys, no direct model APIs, no billing proxies.
- Effect is the mandatory architectural foundation (see §3). Not negotiable.
- Work safety is non-negotiable: durable journal, isolation, correct recovery, no duplicate side effects, comprehensible state.
- All code, UI text, docs, comments, filenames, entity names: English.
- New dependencies require owner approval before adding (see §14).

### Non-goals (v1)

- Jira/GitLab/task sources; PR/MR creation.
- Provider or plugin switching between attempts (v2; v1 attempts change strategy only via the failure packet).
- Remote executor, enterprise infra, multi-user anything.
- Pixel-perfect cloning of the reference UI.

## 2. Repository and process layout

pnpm monorepo:

```
cockpit/
  apps/
    cockpitd/          # daemon: Effect runtime, engine, HTTP+WS, static UI hosting
    ui/                # React SPA (Vite)
  packages/
    core/              # engine: workflow, blocks, journal, providers, retries, recovery
    cartridge-kit/     # published surface imported by project cartridges:
                       # defineCartridge(), Schema contracts, block/template/transform types
  docs/
```

Process model: one long-lived daemon `cockpitd` (Effect on Node) + browser UI at `http://localhost:<port>`. The daemon owns all state and child processes; closing the browser tab never affects runs. Global state home: `~/.cockpit/` (SQLite DB, run artifact directories, worktrees). Projects are registered in the DB by absolute repo path.

## 3. Effect architecture

Effect-native throughout: the daemon entry point builds a `ManagedRuntime` from a single composed Layer; all logic is `Effect`, all resources are `Scope`d, all boundaries are `Schema`-validated. `Effect.runPromise` appears only at the process entry point and the WS/HTTP adapter edge.

### Services and Layers (composition order top-down)

| Service | Responsibility | Key Effect features |
|---|---|---|
| `Config` | ports, paths, limits | `Config`, `ConfigProvider` |
| `Db` | SQLite access | `@effect/sql-sqlite-node`, migrations on boot |
| `Journal` | append events, read/replay, run/block/attempt state machine | `Schema` codecs, transactions |
| `EventBus` | in-process fan-out of journal events | `PubSub`, `Stream` |
| `WorkspaceManager` | worktree create/reconcile/remove, base commit pinning, health checks | `Scope`, `Command` |
| `CheckpointService` | commits in run worktree, salvage checkpoints, rollback | git via `Command` |
| `ProviderRegistry` | `ClaudeCodeProvider`, `CodexProvider` behind one interface | `Layer` per provider |
| `ProcessSupervisor` | spawn CLI children in own process groups, stream stdout/stderr, kill trees on interrupt | `Command`, `Scope` finalizers, `Stream` |
| `PluginCatalog` | discover installed plugins/skills/agents + versions, preflight checks | cached scans |
| `CartridgeLoader` | load and validate `.cockpit/` TS config, watch for changes | `Schema` at the boundary |
| `TemplateRegistry` | core + cartridge workflow templates | |
| `Analyzer` | LLM template selection/parameterization via provider headless call | |
| `TransformPipeline` | run deterministic cartridge transforms | pure functions |
| `WorkflowValidator` | structural + semantic validation before run | |
| `WorkflowEngine` | interpret the tree: sequencing, parallelism, conditions, loops, gates | structured concurrency, `Fiber`, `Deferred` |
| `RetryCoordinator` | attempt lifecycle, retry policies, failure packets, no-progress detection | `Schedule` for technical retries + custom semantic loop |
| `ContinuationService` | task brief assembly, canonical session lifecycle | |
| `HerdrClient` | herdr socket API: tab create, agent start/prompt | socket, JSON |
| `RetrospectiveService` | post-run analysis, insight dedup and storage | |
| `ApiServer` | HTTP (REST queries, commands) + WS (event stream), serves UI | `@effect/platform` HttpServer |

### Lifecycle, cancellation, cleanup

- Every run, block, and attempt executes inside its own `Scope`. Child CLI processes are acquired as scoped resources whose finalizer kills the whole process group (SIGTERM, grace, SIGKILL) — plugin subagents and shells die with their parent.
- Cancellation is Effect interruption: cancel run → interrupt run fiber → scopes unwind bottom-up → journal records `run.cancelled` with per-block outcomes. The journal write of a *completed* side effect always happens before the effect is reported outward, and side-effecting steps are made idempotent or guarded by journal state (§9).
- Observability: Effect `Logger` + spans per run/block/attempt; log records also become journal events at meaningful levels.

### Effect usage map (from requirements)

Workflow orchestration, plugin execution, process management, typed errors (tagged error hierarchy in `contracts.md`), services/DI, Layer/Config, Schema validation and serialization, structured concurrency, cancellation, Scope resource lifecycle, Schedule retries (technical class), Streams (CLI output, WS), PubSub (event bus), persistence ops, logging/tracing, filesystem/terminal integration, sandbox (worktree) management, typed block IO, context handoff, attempt feedback, retry policies, recovery — each maps to a service above; contracts in `docs/contracts.md`.

## 4. Workflow model

### Tree

A workflow is a tree of typed nodes (full Schema in `contracts.md`):

- `block` — agent block or command block instance with bound contract.
- `sequence` / `parallel` — ordering; parallel declares per-branch workspace access to prevent write conflicts (v1 rule: at most one branch with write access to the worktree; validator enforces).
- `condition` — deterministic predicate over prior block outputs.
- `loop` — retry/corrective loop around a subtree with a `RetryPolicy` and exit criteria.
- `gate` — human approval gate with a payload to display.

### Analyzer (hybrid model — agreed R4)

The Analyzer never generates arbitrary DAGs. It receives: the user prompt, project metadata from the cartridge, the template library (core + cartridge), and available capabilities (from preflight). It returns a typed `AnalyzerDecision`: chosen template id, parameter values, optional-block toggles, per-block plugin/provider choices from the allowed set, retry-count suggestions within template bounds, and a rationale string (shown in UI). Invalid decisions fail Schema validation and are retried once with the validation error appended; then the run falls back to the template's defaults with a visible warning.

### Transforms

Deterministic cartridge functions `(tree, context) => tree` run after the Analyzer in declared order. They add mandatory project blocks, force settings, and may reject the tree. Pure TypeScript, no IO, executed synchronously; the pre/post tree diff is journaled and visible in the UI.

### Validator

Runs before start; rejects with precise, human-readable errors: unknown blocks/templates; broken edges; input/output contract mismatches between connected blocks; malformed conditions; loops without exit criteria or retry limits; missing resource limits; gates without payloads; unavailable plugins/capabilities (from preflight); illegal cycles; missing termination conditions; parallel write conflicts; double-retry hazards (block-level retries around a plugin that manages internal retries — see §7).

## 5. Blocks

Two kinds in v1:

- **Agent block** — one provider-native CLI session (Claude Code or Codex) with tools, scoped workspace access, its own prompt assembled from: block goal, block input envelope, contract expectations, and (on retry) the failure packet. Headless execution with streamed JSON events.
- **Command block** — a shell command without AI; success judged by exit code plus optional cartridge rules (output matchers, artifact expectations). Timeout and output capture mandatory.

Block definitions are data (Schema-typed), owned by Core (generic ones) or the cartridge. A definition declares: id/kind, provider, optional `PluginBinding` (§7), prompt/command template, input schema, output schema, session policy (`fresh` default / `continue` opt-in — agreed R5), retry policy reference, timeout, permission profile, workspace access (read-only / read-write), expected artifacts, success criteria, fallback behavior (`fail` | `skip-with-warning` | alternative binding — never silent substitution).

The example blocks in `promt.md` (explore, reproduce, plan, implement, verify, review, finalize, retrospective, …) are seeded as core template building blocks, not a fixed enum; cartridges add their own.

### Block output contract

An agent block must produce a JSON result at a well-known path inside the run directory (`$COCKPIT_OUTPUT` env var injected into the session; the prompt states the obligation and schema). Core validates it with the block's output Schema. Missing/invalid output = semantic failure with a specific failure packet entry. Command blocks produce `{ exitCode, stdoutRef, stderrRef, durationMs }` plus rule evaluations.

### Context handoff

Typed envelopes, journaled: original task, plan, decisions, artifact references, changed files, checkpoint/commit ids, command results, verification evidence, errors, prior-attempt summaries. Envelopes carry references (artifact ids, checkpoint shas) instead of payloads wherever the data is large; each block sees only the fields its input schema declares. See `contracts.md`.

## 6. Providers

One `Provider` interface; two implementations. Versions of CLI, plugins, and cartridge are recorded on every run for reproducibility.

- **Claude Code**: `claude -p <prompt> --output-format stream-json --verbose` in the worktree cwd; `--session-id` assigned by Cockpit (UUID) so the session is resumable later; `--resume <id>` for `continue` policy and continuation sessions; permission mode per block profile. Stream-json events (system/assistant/tool_use/result) are parsed into Cockpit events; subagent and plugin activity arrives as tool events and is mapped with best-effort granularity (see §7 caveat).
- **Codex**: `codex exec --json <prompt>` (JSONL events) with sandbox/approval flags per block profile; `codex exec resume <sessionId>` for continuation. Event mapping analogous.

Preflight per block (agreed contract, §7): provider binary present and authorized (cheap probe, cached per daemon uptime), plugin installed, command/skill/agent exists, version compatible, permissions available, workspace safe (clean worktree state expected by the block). Failure → clear error in UI or declared fallback; never a silent swap. Exact CLI flags will be re-verified against current docs (Context7) at implementation time per repo rules.

## 7. Plugin-aware execution and OMC

Integration is **data-driven** through one minimal typed contract — `PluginBinding` (full Schema in `contracts.md`):

```
{ plugin: "oh-my-claudecode", entry: { kind: "skill" | "slash" | "agent", name: "plan" },
  argsTemplate, extraInstructions?, requiredCapabilities: [...],
  managesInternalRetries: boolean, cancellation: "kill-tree", stateFiles?: [".omc/**"] }
```

- Invocation: for Claude Code, the entry is rendered into the headless prompt (`/oh-my-claudecode:plan <args>` or a Skill invocation instruction); for Codex, into the exec prompt. Core knows nothing about specific OMC commands; cartridges and core templates supply bindings as data.
- Preflight resolves the binding against the installed plugin catalog (enabled plugins + versions from the Claude Code config/plugin cache; OMC currently 4.15.6 on this machine) and records the resolved version with the run.
- Plugin realities are absorbed by contract fields: internal retries (`managesInternalRetries: true` → validator forbids/warns on an outer semantic retry loop with attempts > 1, so Cockpit-level and plugin-level retries never stack — Cockpit then treats the whole plugin run as one attempt); own state files (declared globs are captured as artifacts after the block); partial completion and unstructured transcripts (the block output contract, not the transcript, is the source of truth; transcript is stored for inspection); human input (§8); cancellation (kill process tree; plugin state files remain as artifacts).
- Responsibility boundary: Cockpit owns the outer workflow, task state, checkpoints, attempt history, cancellation, recovery. The plugin owns whatever happens inside its session. Cockpit never re-implements what a plugin does well; it wraps it in a block with a contract.
- Analyzer vs cartridge: the cartridge fixes mandatory bindings (via template definitions and transforms); the Analyzer may choose among the alternatives a template explicitly allows per block. Transforms can force-replace a binding deterministically.
- UI: each block shows its plugin, entry, resolved version; plugin/subagent activity appears as nested events under the block with expandable raw transcript.
- Caveat (known risk): headless stream-json exposes plugin/subagent detail unevenly; v1 promises faithful capture of what the stream provides plus full raw transcript, not a perfect structured model of plugin internals.

## 8. Attempts, retries, within-run learning

### Attempt lifecycle

Every block execution attempt is journaled: input envelope, session id, timeline of events, result (`AttemptResult`: verdict, evidence, errors, artifacts, changed files, checkpoint), and — on failure — a `FailurePacket` distilled for the next attempt.

Failure classes (drive different machinery):

- **technical** — process died, CLI crashed, transient infra error → `Schedule`-based retry with backoff, same strategy, does not consume a semantic attempt (bounded separately).
- **semantic** — agent finished but verification criteria unmet → semantic retry with failure packet, fresh session (agreed R5).
- **corrective loop** — verifier emits concrete findings routed to the implementer block (loop node in the tree); may use `sessionPolicy: continue` when the template declares it.
- **plugin-internal** — owned by the plugin; Cockpit sees one attempt (§7).
- **human-directed** — user adds clarification/review feedback via UI or the continuation session; recorded as a distinguished attempt input.

### FailurePacket (within-run learning)

Typed, compact, journaled (Schema in `contracts.md`): hypothesis of the failed attempt, strategy/plugin used, actions taken, commands run, what exactly failed (tests/validators/errors, deduplicated), diagnostics excerpts (references into artifacts for long output), why it was judged failed, what must not be repeated, remaining plausible directions. The next attempt's prompt = block goal + current workspace state + contract + verification criteria + failure feedback + an explicit instruction to change strategy based on the evidence.

### Retry context compaction (hard rules)

Last attempt: detailed packet. Older attempts: one-paragraph structured summaries. Repeated identical errors deduplicated with a count. Long stdout/stderr stored as artifacts, passed by reference + relevant excerpt. Diffs passed via workspace state + checkpoint refs, never inline. Reasoning noise dropped. Per-block context budget (chars) enforced by the packet builder; over-budget content is summarized, never silently truncated mid-structure.

### RetryPolicy (per block/loop; cartridge can override)

max attempts; timeout per attempt; overall loop timeout; retryable vs non-retryable error classes; backoff (technical class); success criteria; immediate-stop conditions; human approval gate after N failures; no-progress detection (same failure signature twice → stop early and gate); provider/plugin switching is out of scope in v1 (v2 hook reserved in the schema); checkpoint each meaningful attempt (salvage checkpoints for failed-but-useful changes); rollback vs continue-from-workspace declared per loop type.

Within-run learning (failure packets) is strictly separated from cross-run retrospective learning (§12).

## 9. Isolation, checkpoints, recovery

- **Worktree per run** (agreed R7): created from a pinned base commit on its own branch (`cockpit/run-<id>`), under `~/.cockpit/worktrees/<project>/<runId>`. Reconcile before start: repo reachable, base commit resolvable, worktree clean, env health checks from the cartridge (e.g. install/build probes) pass.
- **Checkpoints**: commit after every successfully completed meaningful block; salvage commits for failed attempts that produced useful changes (marked as such). Every checkpoint is journaled with block/attempt linkage. Rollback of an attempt = `git reset --hard` to the previous checkpoint (only for loop types that declare rollback semantics; corrective loops continue from current state).
- **Recovery**: on daemon start, the journal is scanned for runs in non-terminal states: orphaned attempts (no terminal event) are marked `interrupted`; their child processes are gone with the daemon (process groups). The scan marks only — a run that restarts itself on boot is a worse surprise than a button — and `POST /api/runs/:id/resume` re-enters an interrupted or failed run from the last confirmed checkpoint: a block the journal already completed is replayed from its recorded output rather than re-executed, so no completed side effect fires twice (settled in `contracts.md` §9).
- **Finalize**: a core block that turns the run's checkpoint chain into a clean result on the target branch (squash or ordered commits — per cartridge policy), leaving the user's working copy untouched until finalize. App/worker crash, force-kill, and laptop-close survive via journal + worktree durability (acceptance-tested with `kill -9`).

## 10. Session model and terminal continuation

- **Block/attempt sessions**: fresh isolated provider sessions by default; `continue` only as an explicit, typed, UI-visible opt-in (R5). Every session id is journaled. Independent verification blocks never share sessions with implementers.
- **Questions from headless sessions**: if a session asks a question / requests input (detected from the event stream or a declared plugin question protocol), the attempt suspends, the UI shows a Question event with an answer box, and the answer resumes the same session (`--resume` with the same id). This is not a violation of `fresh` — same attempt, same session.
- **Canonical continuation session** (agreed R9): per task, created lazily on first `Open session in terminal`: Cockpit assembles a **task brief** from the journal — original prompt, analyzed context, approved plan, executed blocks with outcomes, plugins/agents used, meaningful attempts and failure reasons, decisions, changed files, checkpoints/commits, test/verification results, errors and retries, artifacts, review feedback, final result — and starts a new provider-native session in the run worktree seeded with the brief, with a Cockpit-assigned session id persisted in the journal. Subsequent presses `--resume` that same session. The user always gets one obvious task-level session; block/plugin/attempt sessions are never offered for manual selection.
- **Button availability**: during execution (opens alongside the run, read-your-own-risk note shown while a block holds write access), after success/error/cancel/retries-exhausted, on new questions, on review feedback.
- **If resume is impossible** (session GC'd, CLI updated, worktree removed): the button falls back to creating a fresh session from the stored task brief and says so explicitly; the old session id is archived. If the worktree is gone, the session opens in a fresh worktree checkout of the last checkpoint.
- **Herdr integration** (agreed R2): the button calls the herdr socket API — create tab in the persistent session (title = task title), start the agent in the pane with cwd = run worktree and the resume/seed command. Ghostty focus is herdr's job; direct Ghostty CLI (`/Applications/Ghostty.app/Contents/MacOS/ghostty`) is the fallback when the herdr server is not running (also surfaced as a preflight warning).

## 11. Event model, API, observability

- **Journal-first**: every event is appended to SQLite, then published to the in-process bus, then streamed to WS clients with a monotonic cursor. UI reconnect = backfill from cursor, then live. No event exists only in memory.
- **Event types** (full Schema in `contracts.md`): run/block/attempt lifecycle; Session, Agent, Plugin, Prompt, Command, Result, Question, Error, Artifact, Checkpoint, Approval, Retry, Verification, FailureFeedback; raw output chunks are stored as artifacts with excerpt events, keeping the journal compact.
- **API**: REST for queries (projects, runs, trees, attempts, artifacts) and commands (start run, approve gate, answer question, cancel, retry block, open terminal); WS for the event stream. All payloads Schema-validated.

## 12. Retrospective (cross-run learning)

After each run, `RetrospectiveService` executes a core agent block over a journal-derived run summary (not raw transcripts by default; transcripts referenced) analyzing: attempts, retries, failures, dead ends, no-progress loops, slow blocks, useless actions, recurring problems, weak context handoff, oversized retry context, lost feedback, ineffective prompts, poor plugin choice, Core vs cartridge problems. Output: typed `RetrospectiveInsight` records split into **Core improvements** and **cartridge improvements**, deduplicated by a normalized key; recurring insights gain evidence links and a counter instead of duplicates. Stored in SQLite, browsable in the UI (list + detail with evidence). No external issue creation. Strictly separated from within-run learning.

## 13. UI architecture

React 19 + Vite + TypeScript + Tailwind SPA served by the daemon (agreed R1/R10). Visual direction and full component spec: `docs/claude-design-prompt.md` (finalized after `refs/` screenshots).

- **Left rail**: projects → tasks with status (running/waiting/successful/cancelled/failed), short names, quick history navigation.
- **Center**: structured live execution stream of the selected task/block/attempt — compact meaningful events (Session, Agent, Plugin, Prompt, Command, Result, Question, Error, Artifact, Checkpoint, Approval, Attempt, Retry, Verification, Failure feedback) with expanders for full prompt, full transcript, raw stdout/stderr (xterm.js), command/plugin/subagent details, stack traces, metadata, artifacts, attempt input/result, failure summary, forwarded feedback. Virtualized list; ANSI, code (shiki), diffs, Markdown, streaming text.
- **Right panel**: workflow tree — blocks, types, plugin/agent badges, loops with `2/3`-style attempt indicators, conditions, retries, skipped blocks, current block, durations, statuses, dependencies, gates, per-attempt results.
- Selecting any block/attempt shows its session, plugin, events, inputs, outputs, artifacts, transcript, verification result, failure reason, retry context.
- Approval screens, question-answer flow, retry/recovery controls, loading states, keyboard navigation (j/k stream, tree focus, expand, approve).

## 14. Technology stack and dependencies

Runtime: Node LTS + pnpm. **All new dependencies require owner approval; this list is the request** (versions pinned at implementation start after a Context7 docs check):

- Backend: `effect`, `@effect/platform`, `@effect/platform-node`, `@effect/sql`, `@effect/sql-sqlite-node`.
- Cartridge loading: `jiti` (runtime TS import of `.cockpit/cockpit.config.ts` inside the daemon; Schema validation at the boundary; file-watch reload). Single-user local tool — running the user's own cartridge code in-process is accepted; recorded in ADR-007.
- Frontend: `react`, `react-dom`, `vite`, `tailwindcss`, `@xterm/xterm`, `shiki`, `virtua` (virtualized list), `react-markdown`.
- Tooling: `typescript`, `vitest`, `@playwright/test`, `eslint` + config.

## 15. Testing strategy

- **Journal & recovery**: in-memory/on-disk SQLite tests; crash simulation — kill the engine mid-block, restart, assert interrupted-marking, checkpoint resume, no duplicate side effects (acceptance `kill -9` scenario automated).
- **Engine**: a **fake provider** — a scripted stub binary emitting recorded stream-json/JSONL fixtures (success, semantic failure, question, crash, hang) — lets the full engine, retries, packets, and gates run in CI without tokens. Recorded-fixture tests pin the CLI output parsers; fixture refresh script per CLI version bump.
- **Retry logic**: Effect `TestClock` for backoff/timeouts; property tests for no-progress detection and packet compaction budgets.
- **Validator/transforms**: table-driven cases for every rejection rule; transform purity enforced by type + test.
- **Cartridge kit**: the pilot cartridge compiles against `cartridge-kit` types in CI; loader tests with broken configs.
- **UI**: Playwright smoke over mocked WS streams (stream rendering, tree states, approval flow); manual one real-provider smoke per release.
- Per repo rules: every fix lands with a regression test; every new behavior with a test.

## 16. Implementation phases

Each phase is a reviewable unit (commit + parallel code review per CLAUDE.md protocol). No phase starts before plan approval.

1. **Scaffold** — monorepo, toolchain, CI basics, empty daemon boots with Effect runtime and serves a stub UI.
2. **Journal + workspace kernel** — SQLite schema/migrations, event log, run/block/attempt state machine, WorkspaceManager (worktrees, base commit pinning, reconcile), CheckpointService, crash recovery. *Gate: automated kill -9 test green.*
3. **Providers + command blocks** — ProcessSupervisor, Claude/Codex adapters with stream parsing and session ids, fake provider for tests, command block execution and evaluation.
4. **Workflow engine** — tree Schema, interpreter (sequence/parallel/condition/loop/gate), RetryCoordinator with policies, failure packets, compaction; validator. *Gate: fake-provider E2E with a failing attempt and strategy change.*
5. **Analyzer + cartridge** — TemplateRegistry, Analyzer decision flow, TransformPipeline, CartridgeLoader + `cartridge-kit`, preflight/PluginCatalog, PluginBinding execution.
6. **UI** — ApiServer (REST+WS), three-panel layout, live stream with expanders, tree with loop indicators, approvals, question flow, retry controls. *Design pass follows `claude-design-prompt.md` once screenshots land.*
7. **Continuity** — task brief assembly, canonical session lifecycle, HerdrClient, `Open session in terminal` incl. fallbacks.
8. **Retrospective + pilot** — RetrospectiveService with dedup, insights UI; build the `ai-interview-assistant` cartridge; run the full acceptance scenario end to end; fix what it reveals.

## 17. Acceptance criteria (definition of done for v1 — agreed R11)

On the real `ai-interview-assistant` project with its `.cockpit/` cartridge:

- [ ] Prompt → Analyzer builds a workflow from a template; transforms + validator pass; tree visible in UI with rationale.
- [ ] Plan approval gate blocks execution until approved in the UI.
- [ ] Implement/verify loop runs with ≥1 failed attempt; the failure packet is visible in the UI; the next attempt runs in a fresh session and demonstrably changes strategy.
- [ ] Finalize produces a clean result on the target branch from worktree checkpoints; user working copy untouched before finalize.
- [ ] `Open session in terminal` opens a herdr tab with the canonical session that correctly answers a follow-up question about the run; a second press resumes the same session.
- [ ] `kill -9` of the daemon mid-run: after restart the run recovers from the last confirmed checkpoint, the orphaned attempt is marked interrupted, no completed side effect re-executes.
- [ ] A failing command block surfaces exit code + output evidence; retry policy honors max attempts and non-retryable classes.
- [ ] Preflight rejects a block with a missing plugin/capability with a clear error; no silent substitution.
- [ ] Every attempt, failure packet, artifact, checkpoint is durable and inspectable after the run.
- [ ] Zero pilot-specific logic in Core (checked by review).
- [ ] Retrospective yields deduplicated Core-vs-cartridge suggestions, browsable locally.

## 18. Risks and unknowns

| Risk | Mitigation |
|---|---|
| CLI output format drift (`claude`/`codex` updates) | Recorded-fixture parser tests; version pinned per run; adapter isolation |
| Headless visibility into plugin/subagent internals is uneven | Contract-over-transcript design (§7); raw transcript always stored; expectation set in UI |
| Question/human-input handling in headless sessions | Suspend-and-resume protocol (§10); acceptance-tested with a scripted fixture |
| Double retries (Cockpit × plugin) | `managesInternalRetries` + validator rule (§7) |
| Context budget tuning (packets too fat/thin) | Budgeted builder + retrospective feedback loop; budgets are cartridge-tunable |
| herdr API surface changes | Protocol version checked at preflight (currently 17); Ghostty CLI fallback |
| Effect v3→v4 transition in the ecosystem | Pin Effect 3.x stable at start; own journal avoids the experimental workflow packages (ADR-002) |
| jiti in-process cartridge execution | Accepted for single-user local (ADR-007); Schema boundary validation |
| UI reference fidelity | Blocked item: screenshots in `refs/` required before design finalization |

## 19. Open items

1. **`refs/` screenshots** — owner adds reference screenshots; `docs/claude-design-prompt.md` is a draft until then.
2. Exact CLI flag set for both providers re-verified against current docs at Phase 3 start.
3. Dependency list (§14) — owner approval required.
