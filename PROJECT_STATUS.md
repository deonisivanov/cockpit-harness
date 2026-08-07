# Cockpit — Project Status (handoff)

Updated: 2026-08-07. Phase: **design complete, implementation NOT started and NOT approved.**

## What this project is

Cockpit — local, single-user control room that takes a user prompt, builds a workflow of AI agent blocks (Claude Code / Codex CLI on the user's subscription, no API keys) and command blocks, executes it in an isolated git worktree with durable journaling, adaptive retries, approval gates, and a dark 3-panel web UI. Split into reusable **Cockpit Core** and per-project **cartridge** in `<project>/.cockpit/`. Effect (TypeScript) is mandatory end to end. Full requirements: `promt.md` (Russian, ~700 lines).

## Read in this order (a new session needs nothing else)

1. `PROJECT_STATUS.md` — this file.
2. `docs/cockpit-plan.md` — the agreed plan: architecture, Effect services/Layers, workflow model, providers, plugin execution, retries/failure packets, isolation/recovery, session continuity, UI, **implementation phases (§16)**, acceptance criteria (§17), risks.
3. `docs/adr.md` — 8 decisions with rejected alternatives.
4. `docs/contracts.md` — typed contracts (workflow tree/template, BlockDef, PluginBinding, AttemptResult, FailurePacket, RetryPolicy, event model, SQLite schema, cartridge API).
5. `docs/claude-design-prompt.md` — UI design prompt that produced the prototype below.
6. **UI design prototype (authoritative visual reference for Phase 6):**
   https://claude.ai/design/p/cfbbafca-56a2-4192-8e62-f063230ac008?file=Cockpit.dc.html
   Import via the claude_design MCP (`https://api.anthropic.com/v1/design/mcp`, auth via `/design-login`); implement `Cockpit.dc.html`, also read `support.js` which the selection imports. The prototype is a full simulation (streaming, timers, pulse) of one app with a state switcher covering 8 states (retrospective excluded), close to the Klimov reference; priority-rendered parts: ANSI terminal output, unified diff, inter-attempt failure packet.
7. `promt.md` + `CLAUDE.md` — source requirements and repo working rules.
8. `.omc/specs/deep-interview-cockpit.md` — interview record (11 rounds, ambiguity 15.8%); consult only for decision provenance.

## Current goals

- Get explicit owner approval of `docs/cockpit-plan.md` (and its dependency list §14).
- Then execute plan phases 1–8 (§16), starting with Phase 1 (monorepo scaffold).

## Completed

- OMC Deep Interview (11 rounds, threshold 20%, final ambiguity 15.8%) — all major unknowns resolved with the owner.
- Environment verified on this machine: Claude Code 2.1.224, Codex CLI 0.146.0, OMC plugin 4.15.6, herdr 0.7.5 (running, socket `~/.config/herdr/herdr.sock`, protocol 17), Ghostty.app (CLI inside app bundle, not on PATH).
- Effect ecosystem checked via Context7: `@effect/workflow` experimental + cluster-coupled → rejected for the core (ADR-002).
- All four design docs written.

## Key decisions (detail + alternatives in docs/adr.md)

| # | Decision |
|---|----------|
| ADR-001 | Local daemon `cockpitd` (Effect on Node) + React SPA in browser on localhost |
| ADR-002 | Custom SQLite journal (runs/blocks/attempts + append-only events); no Temporal, no @effect/workflow |
| ADR-003 | Hybrid Analyzer: selects/parameterizes workflow templates; never generates free-form DAGs |
| ADR-004 | Fresh provider session per attempt + typed FailurePacket; `sessionPolicy: "continue"` only as explicit opt-in |
| ADR-005 | Git worktree per run from pinned base commit; checkpoints = commits; finalize to target branch |
| ADR-006 | v1 = both providers + approval gates + retrospective; provider/plugin switch mid-retry deferred to v2 |
| ADR-007 | Cartridge (`.cockpit/cockpit.config.ts`) loaded in-process via jiti behind Schema validation |
| ADR-008 | One canonical task-level continuation session, opened as herdr tab (`Open session in terminal`), resumed by stored session id |

Pilot project for the first cartridge and end-to-end acceptance: **`ai-interview-assistant`**. No pilot-specific logic may enter Core.

## Files changed (this stage)

Created: `docs/cockpit-plan.md`, `docs/adr.md`, `docs/contracts.md`, `docs/claude-design-prompt.md`, `PROJECT_STATUS.md`, `.omc/specs/deep-interview-cockpit.md`. Nothing else exists — **no code, no package.json, no git repo yet** (repo must be `git init`-ed at Phase 1; commits require owner permission per CLAUDE.md).

## Testing / verification

None — docs-only stage, nothing executable exists. Testing strategy for implementation is defined in plan §15 (fake-provider fixtures, kill -9 recovery test, TestClock, Playwright smoke).

## Known problems / open items (blockers first)

1. **Implementation is blocked on explicit owner plan approval.** Owner's hard rule: no code before approval; never agree silently — challenge and recommend.
2. **`refs/` screenshots still not in the repo.** The Klimov reference screenshots were used to produce the Claude Design prototype (link above), which now serves as the authoritative visual reference; `docs/claude-design-prompt.md` keeps ⚠ marks on typography/exact color values — resolve them from the prototype's CSS, not from guesswork. Adding the screenshots to `refs/` is still useful for design review but no longer blocks Phase 6.
3. **Dependencies unapproved.** Plan §14 list (effect, @effect/platform, @effect/sql-sqlite-node, jiti, react, vite, tailwindcss, @xterm/xterm, shiki, virtua, react-markdown, vitest, playwright) needs owner approval; pin versions after a Context7 docs check at implementation start.
4. Provider CLI flags (claude `-p/--session-id/--resume/stream-json`, `codex exec --json/resume`) must be re-verified against current docs at Phase 3 — CLI formats drift.
5. Known risk register: plan §18 (headless plugin visibility, double retries, context budgets, herdr protocol drift, Effect v3/v4).

## Approaches tried and rejected (don't revisit without new evidence)

All recorded with reasoning in `docs/adr.md`: Temporal and @effect/workflow for durability; free-form LLM DAG generation; resume-by-default retry sessions; Electron/Tauri/TUI form factors; in-place or full-copy isolation; per-press fresh continuation sessions. Also: "Herd" is **herdr** (terminal workspace manager), not Laravel Herd — verified on disk.

## Next steps (in order)

1. Owner: add screenshots to `refs/`; approve plan + dependencies (or request changes → update docs).
2. On approval: Phase 1 — `git init`, pnpm monorepo scaffold (`apps/cockpitd`, `apps/ui`, `packages/core`, `packages/cartridge-kit`), Effect runtime boots, stub UI served. Each phase = one reviewable unit (commit + review per CLAUDE.md).
3. Phases 2–8 per plan §16, gates: automated `kill -9` recovery test (Phase 2), fake-provider E2E with strategy-changing retry (Phase 4), full acceptance scenario on `ai-interview-assistant` (Phase 8, criteria in plan §17).
4. Phase 6 (UI) starts by importing the Claude Design prototype (link in the reading list) via the claude_design MCP and porting `Cockpit.dc.html` + `support.js` to the React/Vite app — layout, tokens, and component states come from the prototype; live data comes from the daemon's WS event stream.

## Working conventions (owner-set, non-negotiable)

Conversation with owner: Russian. All code/docs/UI text/names: English. Ponytail (laziest working solution) + OMC delegation + Context7 for any library question. Conventional Commits; never commit/push without permission. Regression test with every fix; review pass after every finished unit.
