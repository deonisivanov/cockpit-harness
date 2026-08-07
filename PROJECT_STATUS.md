# Cockpit — Project Status (handoff)

Updated: 2026-08-08. Phase: **implementation, phases 1–5 of 8 complete and reviewed; stopped by owner before Phase 6.**

## What this project is

Cockpit — local, single-user control room that takes a user prompt, builds a workflow of AI agent blocks (Claude Code / Codex CLI on the user's subscription, no API keys) and command blocks, executes it in an isolated git worktree with durable journaling, adaptive retries, approval gates, and a dark 3-panel web UI. Reusable **Cockpit Core** + per-project **cartridge** in `<project>/.cockpit/`. Effect (TypeScript) mandatory end to end. Full requirements: `promt.md` (Russian). Pilot project for acceptance: `ai-interview-assistant`.

## Read in this order

1. This file.
2. `docs/cockpit-plan.md` — architecture, services, phases (§16), acceptance (§17).
3. `docs/adr.md` — 8 decisions with rejected alternatives.
4. `docs/contracts.md` — typed contracts, **updated with implementation settlements** (marked "settled in Phase N").
5. `docs/claude-design-prompt.md` + UI design prototype (authoritative for Phase 6):
   https://claude.ai/design/p/cfbbafca-56a2-4192-8e62-f063230ac008?file=Cockpit.dc.html
   Import via claude_design MCP; implement `Cockpit.dc.html` + `support.js`.
6. `promt.md` + `CLAUDE.md`.

## Current goals

Owner-ordered stop after Phase 5. Next: **Phase 6 (UI)** — ApiServer (REST+WS), three-panel layout per the design prototype; then Phase 7 (continuity/herdr), Phase 8 (retrospective + pilot cartridge + acceptance §17).

## Completed (commits on `main`, no remote)

| Commit | Phase | Contents |
|---|---|---|
| f17b49d | docs | design docs, plan, ADRs, contracts, interview record |
| ae4ab4c | 1 | pnpm monorepo (apps/cockpitd, apps/ui, packages/core, packages/cartridge-kit), Effect daemon, /healthz, static UI serving, CI |
| fd17d23 | 2 | SQLite journal (WAL, FKs, migrations), journal-first state machine, EventBus, WorkspaceManager (worktree per run), CheckpointService, recovery scan, daemon pidfile lock; **automated kill -9 gate green** |
| b36a44f | 3 | ProcessSupervisor (process-group kill, SIGTERM→SIGKILL), Provider interface, Claude/Codex adapters with live-recorded fixtures, FakeProvider, CommandRunner; argv `--` injection guard |
| 51a6799 | 4 | workflow Schemas, WorkflowEngine (sequence/parallel/condition/loop/gate), RetryCoordinator, FailurePacket + budgeted compaction, WorkflowValidator (11+ rules), ArtifactStore; **fake-provider E2E strategy-change gate green** |
| bba9e33 | 5 | real cartridge-kit (defineCartridge), CartridgeLoader (jiti, hash, watch), TemplateRegistry + core templates (task/quickfix/guarded-fix), hybrid Analyzer with fallback, TransformPipeline, PluginCatalog + preflight (Fail/SkipWithWarning/AlternativeBinding), binding-aware prompts, stateFiles capture |

Each phase: implemented by OMC executor (opus), reviewed by two parallel reviewers (correctness + AI-slop), all valid findings fixed and amended in. Review yield examples: Phase 3 argv injection (prompt starting `-` escalates permissions), Phase 5 critical (read-only profile could not write `$COCKPIT_OUTPUT` — every real Analyzer/verify run would have failed; masked by fake provider).

## Key technical decisions

ADR-001..008 unchanged (daemon+SPA, custom SQLite journal, hybrid analyzer, fresh-session attempts, worktree per run, v1 scope, jiti in-process cartridge, canonical continuation session). Implementation settlements (all recorded in contracts.md):

- **Versions pinned**: effect 3.22.1, @effect/platform 0.97.1, @effect/platform-node 0.108.1, @effect/sql 0.52.1, @effect/sql-sqlite-node 0.53.0, jiti 2.7.0, react 19.2.8, vite 8.2.1, tailwindcss 4.3.3, vitest 4.1.10, **typescript 5.9.3** (not 7.x/tsgo — Effect type-system risk).
- Block IO = `ContractField[]` (serializable, validator-comparable), runtime Schema derived.
- `BlockId` = per-run instance id (`implement`, `implement#2` per loop iteration); template block id in `blocks.def_id`.
- Tree provenance (analyzer decision, transform diffs) lives in journal events, not on the tree.
- Permission profiles: `read-only` (claude plan mode + disallowed write tools / codex OS sandbox — different guarantees, documented), **`read-plus-output`** (repository read-only but `$COCKPIT_OUTPUT` writable — required by Analyzer and verify blocks), `workspace-write` (+`--allowedTools Bash` for claude so headless runs execute checks), `workspace-write-network`.
- Codex: session id captured from JSONL stream (not assignable); resume = `codex exec resume <id>`; sandbox via `-c sandbox_mode=...` (works in both fresh and resume forms; `-s` does NOT work on resume); run-dir write access via `-c sandbox_workspace_write.writable_roots=[...]`.
- Retry counts attach to loops via derived policies `<policy>@<blockId>:<n>`.
- `RetryPolicy.attemptTimeoutMs`, `stopImmediately`, policy-level `successCriteria` dropped for v1; technical-retry bound is an engine constant (3).
- Salvage checkpoints tagged `cockpit/salvage/<attemptId>` so rollback cannot orphan them.
- tsBuildInfoFile lives inside `dist/` (all emitting tsconfigs) so `rm -rf dist` is a true clean slate.

## Layout / main files

```
apps/cockpitd/src/          main.ts (layer composition), router.ts (healthz + static)
apps/ui/                    Vite+React+Tailwind stub (Phase 6 replaces)
packages/core/src/          ids, errors, events, config, Db, Journal, EventBus, Recovery,
                            DaemonLock, Workspace, ProcessSupervisor, Provider,
                            ClaudeCodeProvider, CodexProvider, CommandRunner, ArtifactStore,
                            workflow, blocks, templates, TemplateRegistry, WorkflowValidator,
                            WorkflowEngine, RetryCoordinator, failure, Analyzer,
                            TransformPipeline, PluginCatalog, CartridgeLoader, cartridge, text
packages/core/test/         17 files incl. fixtures/ (live-recorded CLI streams,
                            sample-cartridge workspace package), fake-provider.mjs,
                            crash-child.mjs, engine-harness, trees
packages/cartridge-kit/     defineCartridge + re-exported cartridge-facing types
scripts/refresh-fixtures.sh clean-env fixture re-record (per CLI version bump)
```

## Testing / verification (state at stop)

- `pnpm -r test`: **214 core + 9 cockpitd + sample-cartridge typecheck**, green from clean slate (`rm -rf` all dist).
- Gates passed: automated `kill -9` recovery (Phase 2), fake-provider E2E with semantic failure → failure packet → fresh session → verbatim verifier findings in retry prompt (Phase 4).
- Real-CLI touchpoints: recorded fixtures (claude 2.1.224, codex-cli 0.146.0) via `--setting-sources "" --strict-mcp-config` / `--ignore-user-config`; one live read-only `--version` probe test.
- Mutation-checked guards: git identity flags, checkpoint onError reset, stale-output rm, loop instance ids, kill-window handshake.
- Daemon boots: migrations → recovery scan → pidfile → listen; `/healthz` 200; second daemon on same COCKPIT_HOME fails fast.

## Known problems / open items

1. **Codex cannot scope run-dir writes under read-plus-output** — `writable_roots` only works under `workspace-write`; documented gap vs claude-code (which scopes via `--add-dir`). Revisit if codex adds a mode.
2. **Cartridge hash/watch covers `.cockpit/**/*.ts` only** — imports outside `.cockpit` are unhashed/unwatched (documented limit in CartridgeLoader).
3. **jiti load timeout only catches async stalls** — synchronous IO/CPU in a cartridge blocks the event loop; ADR-007 trust model, review-governed.
4. **Plugin discovery = documented subset**: `installed_plugins.json` v2 + `settings.json` enabledPlugins + top-level commands/skills/agents dirs; nested command namespaces report `entry-missing`; sha-versioned plugins fail any `minVersion`; only first install entry read.
5. **Claude read-only ≠ codex read-only**: claude-side policy vs OS sandbox — same profile name, different guarantee (documented in ClaudeCodeProvider).
6. **Machine-local quirks**: global `~/.config/git/ignore` contains `.omc/` — `.omc/specs/deep-interview-cockpit.md` untracked (`git add -f` needed, owner undecided); pnpm 11 implicit `minimumReleaseAge` makes `minimumReleaseAgeExclude` in pnpm-workspace.yaml load-bearing; permission classifier sometimes blocks `git commit`/`git add -A`/`git add -f` (explicit-path adds + owner-approved commits pass).
7. `eventsFrom` pages via `limit` param (default 1000) — Phase 6 WS layer must paginate by cursor.
8. ReDoS in cartridge regex rules: accepted v1 risk (`ponytail:` marker), single-user trust model.
9. Provider CLI formats drift — re-run `scripts/refresh-fixtures.sh` and re-verify flags on CLI version bumps (recorded per run in the journal).

## Tried and rejected (don't revisit without new evidence)

All ADR rejections (Temporal, @effect/workflow, free-form DAGs, Electron/Tauri/TUI, resume-by-default). Session additions: TypeScript 7 native (Effect types risk); `--bare` for fixture recording (breaks subscription auth — use `--setting-sources ""`); `-s` sandbox flag on `codex exec resume` (rejected by CLI — use `-c sandbox_mode=`); `Migrator.fromRecord` sqlite CLI schema dump layer (drags CommandExecutor — use `Migrator.make({})`); wall-clock ordering for checkpoint recovery (clock steps backwards — rowid); plan-mode for output-writing blocks (cannot write); OMC-typed reviewer agents in background (final text undelivered — use general-purpose with explicit SendMessage-to-main instruction, or ping idle agents to retrieve).

## Next steps (in order)

1. **Phase 6 — UI**: ApiServer (REST queries/commands + WS event stream with cursor backfill) in cockpitd; import the Claude Design prototype (`Cockpit.dc.html` + `support.js`) via claude_design MCP and port to apps/ui (React/Vite/Tailwind; deps @xterm/xterm, shiki, virtua, react-markdown pre-approved in plan §14 — pin after Context7 check); three panels, live stream expanders, tree with `2/3` loop indicators, approval/question flows, retry controls. Wire `approveGate` + run commands over HTTP.
2. **Phase 7 — continuity**: task brief from journal, canonical session (ADR-008), HerdrClient (socket `~/.config/herdr/herdr.sock`, protocol 17 at last check), `Open session in terminal` + fallbacks (fresh session from brief; Ghostty CLI direct when herdr down).
3. **Phase 8 — retrospective + pilot**: RetrospectiveService (deduped insights, core vs cartridge), insights UI, build `ai-interview-assistant` cartridge, run full acceptance §17 (includes `kill -9` mid-run and preflight-rejection scenarios).
4. Per-phase protocol stays: executor (opus) → owner-visible verify → commit → two parallel reviewers (fresh contexts, scoped to `HEAD~1..HEAD`, explicit SendMessage report) → fix batch → amend. Conventional Commits; commits allowed per owner grant of 2026-08-07 («делай коммит и продолжаем»).

## Working conventions (owner-set, non-negotiable)

Conversation with owner: Russian. All code/docs/UI text: English. Ponytail (laziest working solution) + OMC delegation + Context7 for library questions (never from memory). Regression test with every fix; review pass after every phase; never commit/push without owner permission.
