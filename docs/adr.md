# Cockpit — Architecture Decision Records

Decisions agreed during the deep interview (2026-08-07, `.omc/specs/deep-interview-cockpit.md`). Format: context → decision → alternatives → consequences. Status of all: **accepted, pending plan approval**.

## ADR-001: Local daemon + browser UI (form factor)

**Context.** Cockpit needs a control-room UI, long-running background execution that survives UI closure, and terminal integration.
**Decision.** One long-lived local daemon (`cockpitd`, Effect on Node) owning all state and child processes; UI is a React SPA served on localhost and rendered in the user's browser.
**Alternatives.** Tauri (native shell; adds a Rust layer and a sidecar boundary between UI and the Node/Effect backend), Electron (heavy runtime, packaging/update burden for a single-user tool), TUI (cannot deliver the reference control-room density and rendering).
**Consequences.** Best web-stack DX and hot reload; runs continue when the tab closes; no packaging. The daemon boundary doubles as the future coordinator/executor seam.

## ADR-002: Custom SQLite journal for durable execution

**Context.** Runs must survive daemon crashes and force-kill; recovery points are coarse (block/attempt boundaries around long CLI processes). Options: Temporal, `@effect/workflow` + `@effect/cluster`, own journal.
**Decision.** Custom durable journal in SQLite: `runs`/`blocks`/`attempts` state tables + append-only event log; Effect Schema codecs; recovery = scan journal → mark orphaned attempts interrupted → resume from last confirmed checkpoint.
**Alternatives.** Temporal — industrial-grade but requires a separate server, DB, and worker runtime: prohibited infra overhead for a local single-user tool. `@effect/workflow` — experimental, rides on `@effect/cluster` machinery (MessageStorage, runners); v4-beta was still fixing replay bugs at decision time (verified via Context7); an unstable foundation for the system's core.
**Consequences.** Full control over schema and UI queries; trivially testable; a small module we own. We forgo generic replay semantics — acceptable because Cockpit's recovery granularity is block/attempt, not micro-step.

## ADR-003: Hybrid Analyzer (templates + parameterization, no free-form DAGs)

**Context.** The original spec had the Analyzer building a workflow tree per task. Arbitrary LLM-generated DAGs are the most fragile design point: invalid trees, unpredictable structures, a validator that must anticipate anything.
**Decision.** Core + cartridge define a library of workflow templates and blocks. The Analyzer selects a template, fills parameters, and makes bounded modifications (toggle optional blocks, pick plugin/provider from the allowed set per block, set retry counts within bounds). Deterministic transforms + validator enforce invariants. Analyzer output is a typed `AnalyzerDecision`, Schema-validated, with a rationale shown in the UI.
**Alternatives.** Free-form DAG generation (max flexibility, max fragility); pure template pick with no modifications (loses per-task adaptation, the product's key idea).
**Consequences.** Predictable trees, a small validator, an explainable Analyzer. New workflow shapes require template work in the cartridge — accepted cost.

## ADR-004: Fresh session per attempt + typed failure packet; `continue` as opt-in

**Context.** A failed attempt must inform the next one without contaminating it. Options: resume the previous attempt's provider session, or start clean with structured feedback.
**Decision.** Default: every attempt runs in a fresh isolated provider session and receives a compact typed `FailurePacket` (hypothesis, actions, deduplicated errors, do-not-repeat list, remaining directions). Specific loop types (e.g. corrective review-fixes) may declare `sessionPolicy: "continue"` explicitly; the policy is typed and visible in the UI.
**Alternatives.** Resume-by-default (agent remembers its work but anchors on failed strategies, accumulates noise, bloats context — contradicts the structured within-run-learning design); fresh-always (loses genuinely useful live context in corrective loops).
**Consequences.** Reproducible attempts, controllable context size, honest independent verification. Packet quality becomes a first-class engineering artifact (budgeted builder, retrospective feedback).

## ADR-005: Git worktree per run; checkpoints as commits

**Context.** Isolation, parallel runs, cheap rollback, reproducible base state, and a clean finalize are all required; the user's working copy must stay untouched.
**Decision.** Each run gets a fresh git worktree from a pinned base commit on branch `cockpit/run-<id>` under `~/.cockpit/worktrees/`. Checkpoint = commit (success and salvage kinds); rollback = `git reset` to a checkpoint; finalize turns the checkpoint chain into a clean result on the target branch.
**Alternatives.** In-place execution (no isolation, one run at a time, risky rollback — violates the spec); full copy or container/VM per run (slow on large repos, loses local caches, infra overkill).
**Consequences.** Parallel runs are safe; git is the rollback/diff engine; synergy with `herdr worktree` helpers. Requires the project to be a git repo — acceptable for the product's audience.

## ADR-006: v1 scope

**Context.** The spec lists more capability than a first version needs; boundaries were agreed explicitly.
**Decision.** v1 includes both providers (Claude Code + Codex), human approval gates, and retrospective learning. Provider/plugin switching between attempts is deferred to v2 (schema hook reserved); remote executor deferred indefinitely (seam preserved at the daemon boundary).
**Consequences.** v1 is testable end-to-end on the pilot; the retry model stays simple (strategy changes only via failure packet).

## ADR-007: Cartridge loading via in-process TS import (jiti) behind a Schema boundary

**Context.** Cartridges are TypeScript in `<project>/.cockpit/`; the daemon must load them with types intact and reload on change.
**Decision.** Load `cockpit.config.ts` with `jiti` inside the daemon process; validate the exported value against `cartridge-kit` Schemas at the boundary; watch and hot-reload. `defineCartridge()` provides the typed authoring surface.
**Alternatives.** Subprocess isolation with an RPC bridge (safer in theory, but heavy: serializing transform functions across a process boundary defeats the deterministic-TS-transform design); esbuild bundling to a temp file (extra moving part, same trust model).
**Consequences.** Cartridge code runs with daemon privileges — accepted: single-user local tool executing the user's own project code (same trust as running the project's npm scripts). Transforms stay plain synchronous functions.

## ADR-008: Canonical task-level continuation session

**Context.** Blocks and attempts execute across many isolated sessions, but `Open session in terminal` must present one full task-level session; a real provider-native session must be resumed rather than simulated.
**Decision.** Per task, lazily on first press: assemble a task brief from the journal (prompt, plan, blocks, attempts, failure reasons, decisions, files, checkpoints, results, feedback), start a new provider-native session in the run worktree seeded with the brief, persist its Cockpit-assigned session id; every subsequent press resumes that same session via the herdr socket API (tab create + agent start), Ghostty CLI as fallback. If resume is impossible, create a fresh session from the stored brief and say so.
**Alternatives.** Resume the last block session (real history but partial context — it doesn't know sibling blocks/verifications); fresh session with brief every time (loses the user's own follow-up dialogue between presses).
**Consequences.** One living task session forever; the brief builder is a reusable consumer of the journal; user follow-ups accumulate in provider-native history where they belong.
