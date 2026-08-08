# Cockpit — Project Status (handoff)

Updated: 2026-08-08. Phase: **all 8 implementation phases complete and reviewed; §17 acceptance on the pilot is the only remaining v1 work.**

## What this project is

Cockpit — local, single-user control room: user prompt → Analyzer picks/parameterizes a workflow template → deterministic cartridge transforms + validator → agent blocks (Claude Code / Codex CLI on the user's subscription) and command blocks execute in an isolated git worktree with durable journaling, typed failure packets, adaptive retries, approval gates, question suspend/resume, terminal handoff into herdr, finalize onto the target branch, and cross-run retrospective insights. Core (`packages/core`) + cartridge (`<project>/.cockpit/`). Effect end to end. Requirements: `promt.md`; plan: `docs/cockpit-plan.md`; contracts with all settlements: `docs/contracts.md`.

## State (commits on `main`, no remote)

| Commit | Phase |
|---|---|
| f17b49d | docs: design docs, ADRs, contracts, interview record |
| ae4ab4c | 1: monorepo scaffold, Effect daemon, CI |
| fd17d23 | 2: SQLite journal, worktrees, checkpoints, recovery, kill -9 gate |
| b36a44f | 3: providers, process supervision, command blocks, recorded fixtures |
| 51a6799 | 4: workflow engine, retries, failure packets, validator, E2E gate |
| bba9e33 | 5: analyzer, cartridge loading, plugin preflight |
| 77d699a | 6: REST+WS ApiServer, question flow, three-panel UI |
| e1c3f62 | 7: task brief, canonical session, herdr terminal handoff |
| ecdcea8 | 8: retrospective insights, finalize block, blocks PK fix, pilot support |

Tests at close: **core 260, cockpitd 24, ui 69 (vitest) + 20 Playwright e2e**; all green from clean slate. Every phase went through the two-reviewer pass (correctness + AI-slop), all valid findings fixed and amended in.

**Pilot cartridge** lives in `~/Desktop/ai-interview-assistant/.cockpit/` (owner gitignored it there — stays untracked): **multi-file layout** (aa2686e, Klimov-style): `cockpit.config.ts` assembly + `blocks/` file-per-block (typecheck/test/lint/format + cargo clippy/test optional-default-on + implement via `prompts/implement.md`), `templates/{guarded-fix,quick-task}.ts`, `transforms.ts` (append-lint before finalize), `validators.ts` (no-filtered-checks shell-metachar guard), `policies.ts`, README. Core supports `promptFile` (loader-side IO + realpath containment) and hashes every non-node_modules file under `.cockpit` (length-prefixed digest). Kit resolves via relative symlink in `.cockpit/node_modules` (file:-dep impossible: kit declares workspace:*).

## What remains for v1 (in order)

1. **§17 acceptance on the pilot — owner-interactive.** Runnable checklist: `docs/acceptance-plan.md` (auto vs owner steps, real endpoints/prompts, kill -9 placement, herdr checks). Needs: real provider runs on the owner's subscription, UI gate clicks, daemon kill -9, herdr tab verification. Pilot's dirty tree: isolation half runs as-is; landing half needs `git stash -u` first.
2. **Known §17 gap, decided not silently skipped:** run RESUME after crash/interrupt is not implemented — recovery marks truthful interrupted state (Phase 2) but the engine cannot re-enter a tree skipping completed blocks; `POST /api/runs/:id/retry` and `/resume` return 501. Flagged in Phase 6, not built in Phase 8 (needs block-instance identity across re-entry + output rehydration). §17 item 6's "resumes from the last confirmed checkpoint" fails as written; the truthful-state half passes. Owner call: accept marking-only for v1 or build re-entry.
3. Fixture refresh on CLI bumps: recordings pin claude 2.1.224 / codex 0.146.0; machine now has claude 2.1.226 — parsers still pass; re-record via `scripts/refresh-fixtures.sh` if drift appears.

## Key decisions and settlements

ADR-001..008 hold. All implementation settlements are recorded inline in `docs/contracts.md` ("settled in Phase N" notes): ContractField IO, per-run BlockId + composite (run_id, id) PK (migration 0003 rebuilds old DBs; attempts carry run_id), provenance in journal, derived waiting state, workflow-tree artifact, read-plus-output profile, codex sandbox via `-c` overrides (writable_roots gap vs claude documented), finalize = pure plumbing (commit-tree squash/ordered; reset --keep on checked-out target — no hooks fire; update-ref CAS otherwise; refusals: detached, moved base, dirty, rebase/merge/bisect in progress, foreign worktree, pre-tracking runs), retrospective occurrences count runs (ponytail: last_seen_run only), evidence capped at 40, insight prompt fenced as `<run-journal>` data.

Versions pinned: effect 3.22.1, @effect/platform 0.97.1, platform-node 0.108.1, @effect/sql 0.52.1, sql-sqlite-node 0.53.0, jiti 2.7.0, react 19.2.8, vite 8.2.1, tailwind 4.3.3, typescript 5.9.3 (not 7.x), vitest 4.1.10, @xterm/xterm 6.0.0, shiki 4.4.2, virtua 0.50.1, react-markdown 10.1.0, @playwright/test 1.62.1.

## Known problems / open items

1. §17 acceptance not yet run (owner-interactive; see above).
2. Run re-entry/resume 501 (see above).
3. Codex cannot scope run-dir writes outside workspace-write (documented gap).
4. Cartridge hash/watch covers `.cockpit/**/*.ts` only; jiti timeout catches async stalls only (ADR-007 trust).
5. Plugin discovery = documented subset (installed_plugins.json v2, top-level commands/skills/agents; sha-versioned plugins fail minVersion).
6. WS: JSON ping only (platform 0.97 exposes no protocol ping) — half-open sockets reap on send-buffer fill; EventBus subscription unbounded during backfill (ponytail: noted).
7. UI: xterm+shiki in one 808KB chunk (lazy-load when it hurts); insights UI resolves detail from list (route exists for external consumers).
8. Machine quirks: permission classifier blocks `git add -A`/`-f` and some commits (explicit paths + owner-approved commits pass); global gitignore `.omc/` blocks tracking `.omc/specs/` (owner undecided); pnpm 11 implicit minimumReleaseAge — workspace exclude is load-bearing.
9. One unreproduced flake window during concurrent agent edits (journal migration + finalize tests, different each time, 4+ consecutive greens since) — if it resurfaces, suspect test-vs-edit interleaving, not finalize logic.

## Tried and rejected (do not revisit without new evidence)

All ADR rejections + session additions: TS 7 native (Effect risk); `--bare` recording (breaks subscription auth → `--setting-sources ""`); `-s` on `codex exec resume` (rejected → `-c sandbox_mode=`); wall-clock checkpoint ordering (→ rowid); plan-mode for output-writing blocks (cannot write); temp-worktree finalize (git refuses checked-out branch → plumbing); update-ref+reset --keep on checked-out target (silent no-op — reset --keep IS the move); file:-dep for pilot kit (workspace:* unresolvable → symlink); editing migration 0001 in place (Migrator ignores content → 0003 rebuild); OMC-typed reviewer agents in background (final text undelivered → general-purpose + explicit SendMessage, ping idle agents to retrieve).

## Working conventions (owner-set, non-negotiable)

Conversation with owner: Russian. Code/docs/UI: English. Ponytail + OMC delegation + Context7 for library questions. Regression test per fix; two-reviewer pass per phase; Conventional Commits; never commit/push without owner permission (phase commits granted 2026-08-07).
