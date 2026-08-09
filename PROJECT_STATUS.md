# Cockpit — Project Status (handoff)

Updated: 2026-08-08 (late). Phase: **v1 code complete — all 8 planned phases + re-entry + registration UX + onboarding docs. The only remaining v1 work is the owner-interactive §17 acceptance.**

## What this project is

Cockpit — local, single-user control room: user prompt → hybrid Analyzer picks/parameterizes a workflow template from the cartridge → deterministic transforms + validators → agent blocks (Claude Code / Codex CLI on the user's subscription, no API keys) and command blocks execute in an isolated git worktree with durable SQLite journaling, typed failure packets, adaptive retries, approval gates, question suspend/resume, crash recovery **and run re-entry**, terminal handoff into herdr, finalize onto the target branch, cross-run retrospective insights, three-panel web UI. Core (`packages/core`) + per-project cartridge (`<project>/.cockpit/`, multi-file layout). Effect end to end.

Docs: `docs/about/` (self-contained onboarding, 8 files — attach to new chats as context), `docs/cockpit-plan.md`, `docs/contracts.md` (all "settled in Phase N" notes), `docs/adr.md`, `docs/acceptance-plan.md` (§17 checklist).

Reference audit: `docs/about/deviations.md` — 26 rows against Klimov's `cockpit-eli5.html` (the GitLab-oriented original), each difference marked Match / Deviation / Deferred with the ADR it follows from.

## State (commits on `main`, no remote; working tree clean)

| Commit | Contents |
|---|---|
| f17b49d…ecdcea8 | Phases 1–8 (scaffold → journal/worktrees → providers → engine → analyzer/cartridge → API+UI → continuity/herdr → retrospective/finalize/PK-fix) |
| 4379916 | status handoff at 8-phases-complete |
| aa2686e, 8008833 | multi-file cartridge layout (Klimov-style) + promptFile + directory-wide hash |
| 329f249 | **run re-entry**: POST /api/runs/:id/resume, skip-completed with BlockReplayed, open-iteration rule, salvage tags by sha, finalize crash-window answer-from-record |
| e8bb52a, 4869071 | **registration UX**: `cockpit` CLI (add/projects), UI add-project form + project `<select>` switching, cursor:pointer, CLI robustness (no stack traces, 10s timeout, bin on PATH) |
| 23adb9d | `docs/about/` onboarding documentation |

Tests at close: **core 273, cockpitd 36, ui 78 (vitest) + 25 Playwright e2e** — green from clean slate. Every code unit passed the two-reviewer protocol (correctness + AI-slop, fresh contexts, scoped to the unit's diff); all valid findings fixed.

**Pilot cartridge**: `~/Desktop/ai-interview-assistant/.cockpit/` (owner gitignored it in the pilot — stays untracked). Multi-file: `cockpit.config.ts` assembly, `blocks/` file-per-block (typecheck/test/lint/format + cargo clippy+test optional-default-on + implement via `prompts/implement.md`), `templates/{guarded-fix,quick-task}.ts`, `transforms.ts` (format+lint before finalize), `validators.ts` (no-filtered-checks: shell metachars `| ; & >` under a shell argv), `policies.ts`, README, `package.json` (module), kit via relative symlink in `.cockpit/node_modules` (kit is unpublished; `file:` impossible — declares `workspace:*`).

## How to run (quick reference; full: docs/about/run.md)

`pnpm start` → daemon on `http://127.0.0.1:4177` (UI there). Register a project: `pnpm cockpit add <path>` (or `pnpm exec cockpit add`, or the UI form, or POST /api/projects). Env: COCKPIT_HOME (~/.cockpit), COCKPIT_PORT (4177), COCKPIT_KILL_GRACE_MS, COCKPIT_{CLAUDE,CODEX,HERDR,OPEN}_BIN, CLAUDE_CONFIG_DIR; test-only COCKPIT_FAKE_*.

## Current goals (in order)

1. **§17 acceptance on the pilot — owner-interactive, ~30–60 min.** Checklist: `docs/acceptance-plan.md` ([auto] vs [owner] steps, real prompts/endpoints, kill -9 placement, herdr checks, Resume press + BlockReplayed assertion). Needs real provider runs on the owner's subscription, UI gate clicks, daemon kill -9, herdr tab verification. Pilot's dirty tree: isolation half runs as-is; landing half needs `git stash -u` first. Owner said "later" — waiting on their go.
2. After acceptance: fix whatever it reveals (Phase 8's mandate), then v1 is done.

## Key technical decisions

ADR-001..008 hold. Settlements all recorded in `docs/contracts.md`; the load-bearing ones:

- Versions pinned: effect 3.22.1, @effect/platform 0.97.1, platform-node 0.108.1, @effect/sql 0.52.1, sql-sqlite-node 0.53.0, jiti 2.7.0, react 19.2.8, vite 8.2.1, tailwind 4.3.3, **typescript 5.9.3** (not 7.x — Effect types), vitest 4.1.10, xterm 6.0.0, shiki 4.4.2, virtua 0.50.1, react-markdown 10.1.0, playwright 1.62.1.
- Journal-first: row+event one tx, publish after commit, nested tx refused. Composite PK `blocks(run_id, id)`, attempts carry run_id (migration 0003 rebuilds old DBs — 0001 must never be edited in place, Migrator keys on numeric id only).
- Permission profiles incl. `read-plus-output` (Analyzer/verify blocks must write $COCKPIT_OUTPUT; plan mode cannot). Argv `--` before every prompt operand (injection). Codex: session id captured from stream, resume=`codex exec resume`, sandbox via `-c sandbox_mode=`, run-dir via `-c sandbox_workspace_write.writable_roots=` (no read-only+writable-root mode — documented gap).
- Finalize = pure git plumbing: commit-tree squash/ordered, `reset --keep` on checked-out target (no hooks fire), `update-ref` CAS otherwise; refusals: detached, moved base, dirty, rebase/merge/bisect in progress, foreign worktree, pre-tracking runs; crash window answered from its own RunFinalized record.
- Re-entry: resume plan from journal (skip-completed + output rehydration, BlockReplayed), open-iteration rule (closer vs opener counts), interrupted attempts not charged, failed-run resume re-arms one cycle, salvage tags by sha, boot scan marking-only by design.
- Cartridge: jiti in-process (ADR-007 trust), directory-wide length-prefixed hash, promptFile resolved by the loader (realpath containment), stale flag cleared before read.
- Retrospective: occurrences count runs (`last_seen_run` guard), evidence capped 40, journal text fenced `<run-journal>` as data.

## Main files

`packages/core/src/` — ids, errors, events, config, Db, Journal, EventBus, Recovery, DaemonLock, Workspace, ProcessSupervisor, Provider(+Claude/Codex), CommandRunner, ArtifactStore, workflow, blocks, templates, TemplateRegistry, WorkflowValidator, WorkflowEngine, RetryCoordinator, failure, Analyzer, TransformPipeline, PluginCatalog, CartridgeLoader, cartridge, Resume, Retrospective, Continuation, Herdr, brief, Store, text.
`apps/cockpitd/src/` — main (layers), router (Host guard + static), api (REST+WS), runs (RunSupervisor), cli (`cockpit` bin).
`apps/ui/src/` — App, Rail (projects/select/add form), Stream, Tree, Insights, render, api, store, presentation, treeModel, insightModel, model, mock (10 states).
`packages/cartridge-kit/` — defineCartridge + re-exports. `scripts/refresh-fixtures.sh`.

## Known problems / open items

1. §17 acceptance not run (owner-interactive; see goals).
2. Resume soft edge: loop body whose closing block runs under a Condition reads "open" for iterations that skipped it — costs a replay, never a repeated effect (contracts §9).
3. Codex writable-roots gap (above). 4. Cartridge imports outside `.cockpit` unhashed/unwatched; jiti timeout catches async stalls only. 5. Plugin discovery = documented subset; sha-versioned plugins fail minVersion. 6. WS JSON ping only (no protocol ping in platform 0.97); EventBus subscription unbounded during backfill (ponytail-noted). 7. UI 808KB xterm+shiki chunk (lazy-load when it hurts). 8. Machine quirks: permission classifier blocks `git add -A`/`-f` (explicit paths pass); global gitignore `.omc/` blocks `.omc/specs/` tracking (owner undecided); pnpm 11 implicit minimumReleaseAge → workspace exclude load-bearing; claude CLI drifted 2.1.224→2.1.226, fixtures still parse (`scripts/refresh-fixtures.sh` on drift). 9. One unreproduced flake window during concurrent agent edits (4+ consecutive greens since; suspect test-vs-edit interleaving).

## Tried and rejected (do not revisit without new evidence)

All ADR rejections, plus: TS 7 native (Effect risk); `--bare` recording (breaks subscription auth → `--setting-sources ""`); `-s` on `codex exec resume` (CLI rejects → `-c sandbox_mode=`); wall-clock checkpoint ordering (→ rowid); plan mode for output-writing blocks; temp-worktree finalize (git refuses checked-out branch → plumbing); update-ref+reset --keep as separate steps on checked-out target (silent no-op — reset --keep IS the move); `file:` dep for the pilot kit (workspace:* → symlink); editing migration 0001 in place; `\0`-delimited hash (NUL in content imitates boundary → length prefix); execFileSync spawning the CLI in tests (deadlocks the in-process harness daemon → async execFile); fetch to port 1 as daemon-down fixture (restricted-port blocklist → port 2); OMC-typed reviewer agents in background (final text undelivered → general-purpose + explicit SendMessage-to-main; ping idle agents to retrieve results).

## Next steps

1. Owner runs §17 acceptance per `docs/acceptance-plan.md` (assistant drives, owner clicks/kills/verifies).
2. Fix what acceptance reveals; re-run affected checks.
3. Owner decisions still parked: track `.omc/specs/` or not; commit the pilot's `.cockpit/` or keep gitignored (currently gitignored by owner's own commit in the pilot).
4. v2 candidates recorded in plan §18/contracts (provider/binding switch mid-retry, remote executor split, protocol WS ping, bounded backfill).

## Working conventions (owner-set, non-negotiable)

Conversation with owner: Russian. All code/docs/UI text: English. Ponytail (laziest working solution) + OMC delegation + Context7 for library questions (never from memory). Comments only for non-obvious why. Regression test per fix; two-reviewer pass per finished code unit; Conventional Commits; never commit/push without owner permission (phase/unit commits granted 2026-08-07).
