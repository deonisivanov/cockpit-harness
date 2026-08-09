# Cockpit — usage-fixes stage status (handoff)

Updated: 2026-08-09. Scope: the owner-feedback fixes plan, stages S1–S9 **complete and reviewed**;
S10 parked (owner-blocked); S11 owner acceptance **pending — the only remaining work**. Base doc:
`PROJECT_STATUS.md` (v1 handoff, still accurate for everything predating this stage). Plan of
record: `.omc/plans/cockpit-usage-fixes.md` (revision 4). Ralph state:
`.omc/state/sessions/9bc4007f-9f1f-45d7-9168-802944eb68f1/{prd.json,progress.txt}` (S4–S9),
`174fe81b-…` (S1–S3).

## Current goals

1. **Done:** all eight owner items with code behind them — terminal handoff (#7), Stop (#3a),
   Skip (#3b), run-by-human-decision (#2), empty-diff gates (#1b), answer template (#1a),
   stream noise (#4), per-block model/effort (#5), tree height + cursors (#6).
2. **Next (owner):** S11 acceptance — the checklist below. Nothing else blocks it.
3. S10 (reference audit vs `cockpit-eli5.html`) still parked: the file is not on disk; owner must
   supply it. §17 v1 acceptance from the base handoff still parked behind S11.

## Completed (commits on `main`, working tree clean)

S1–S3: `791caa2..e8de8eb` — see the previous revision of this doc (git history) for the table.

| Commit | Contents |
|---|---|
| 180fbb9 | S4: `awaiting-start` — `POST /api/runs` plans then parks; `/start` re-reads the tree artifact and claims via `journal.startRun`; `/regenerate` re-plans, newest tree wins; new `RunAwaitingStart` lifecycle payload; fiber-less cancel (also fixes cancel on recovered interrupted runs); Stop 409s on the wait state |
| 215155e | S4 review follow-ups: supervisor semaphore around start/regenerate/resume (regenerate had no atomic claim — the High of the stage); fiber-map cleanup releases only its own entry; `RunRequest.claimed`; failed regenerate stays `awaiting-start` (no fabricated `RunStarted`); regenerate reconciles a vanished worktree; skip requests die at a replan boundary (fold resets on `TreeAnalyzed` + `engine.forgetSkips`); cancel surfaces the journal's own refusal |
| 882fca5 | S5: `BlockDef.skipWhenUnchanged` — engine skips the block when `changedFiles(workspace, baseCommit)` (two-arg `changedSince` form) is empty, journaled with the reason; validation refuses the flag where the skip would starve a downstream contract; pilot format/lint flagged |
| 4961a92 | S5 review follow-ups: flag refused on a Loop's verdict source (judge auto-skipping to success); auto-skip only when the run recorded a real base commit (`"HEAD"` fails open); one `skipNode` helper for all three no-run visit endings; `BlockSkipped.requested` so the fold consumes only the user's own skip |
| 522b522 | S6: `answerQuestion` block + `answer` template (one read-only block, no finalize); analyzer intent-classification instruction; stream row surfaces the first line of an inline string output |
| 3784764 | S6 review follow-ups: two-branch transform guard (insert-before-finalize vs append); row reads `answer ?? summary` by name (finalize's commit SHA keeps the fixed label); docs template lists |
| 98aa8b1 | S7: stream essential default + full-log toggle; closed hidden set (unclassified events default visible); row cache untouched by mode |
| 0889608 | S7 review follow-ups: **plan deviation** — `OutputChunk` stays visible (journal carries 1–2 per block; it is a failed command's only diagnostic; the provider firehose never reaches the journal); `AttemptInterrupted` reads as prose; fixed-label toggle; focus clamp on mode switch |
| 29c1421 | S8: per-block `model`/`effort` (+ node overrides), cartridge-level `analyzer` config; claude `--model/--effort`, codex `-c model="…"` / `-c model_reasoning_effort="…"` (TOML-quoted); unset argv byte-identical, pinned |
| e4383de | S8 review follow-ups: validator refuses model/effort on non-agent blocks; the analyzer-config wire tested in cockpitd (the dead-wire class that birthed the stage); explicit assignments over the spread |
| bc0088d | S9: tree aside sizes to content (`self-start` + `max-h-full`; floating variant `max-h-[calc(100%-1.5rem)]`), inner region scrolls; 2-block and 40-block structural e2e proofs; cursor audit clean — nothing was missing, no CSS added |
| fcb02b4 | S9 review follow-ups: narrow-viewport e2e covers the floating variant; cap tightened to the row's content box; honest fixture template ids |

Also on `main`, not from this stage: `b004c2c`, `46c461e` — a workspace-mode problem brief for
sportsbook-projects, committed by a parallel session mid-flight. Docs-only, unrelated.

## Key technical decisions (all review-verified; adds to the S1–S3 list in git history)

- **`awaiting-start` is a row, not a fiber.** Waiting survives restart because `start` re-reads the
  tree artifact the way resume always has. Recovery needed no edit — its scan is an allowlist.
  The stage's real hazard was `RunSupervisor.cancel` (fiber-map-only) and, found in review,
  regenerate launching with no atomic claim: one supervisor semaphore makes check-and-launch a
  critical section, and `launch`'s cleanup releases only its own fiber-map entry.
- **The engine claims the run unless the caller already has.** `RunRequest.claimed` is set only by
  the supervisor's start (which pre-claims so its 202 is truthful and a double-Run loser 409s
  without touching the winner). A resume plan is an implicit exemption: it presumes the caller
  re-opened the run via `resumeRun`. A future caller passing a plan without re-opening executes on
  a stale status — documented, unreachable today.
- **Skip requests are scoped to the tree they named.** `recordedSkips` resets on `TreeAnalyzed`;
  `engine.forgetSkips` drops the live Ref at the same boundary; the fold consumes only on
  `BlockSkipped.requested === true`, mirroring the engine's Ref consumption — the two converge
  under every interleaving.
- **`skipWhenUnchanged` fails safe.** Two-arg `changedSince` only; no auto-skip when the run
  recorded no real base commit; validation runs the double validator walk over every flagged block
  and additionally refuses the flag on any Loop's verdict source — the judge role no input
  contract can see.
- **The answer template changes nothing but the tree.** One read-only block; finalize-less runs
  were already the normal case (quickfix/guarded-fix); S5, not a cartridge edit, is what keeps
  format/lint off the question run.
- **Essential mode is a closed hidden list.** Unclassified events default to visible, so a new
  event type appears until someone decides otherwise. `OutputChunk` deliberately deviates from the
  plan (see 0889608 above).
- **model/effort ride the same argv path every re-entry takes.** One spawn site composes from the
  persisted tree, so retries and resumes repeat the flags. Effort validates against claude's
  literal set (a strict subset of codex's own closed enum); model names are not validated by
  design. Non-agent blocks refuse both fields — the validator's silent-no-op rule.

## Testing and verification

- Suites at close, clean tree, single-runner: **core 313 / cockpitd 52 / ui 90 (vitest) +
  32 Playwright** — all green, eslint clean. (Baseline at S3 close: 285/41/81/26.)
- Every stage passed the two-reviewer protocol (correctness + AI-slop, fresh contexts, scoped to
  the stage's commits); every valid finding fixed and committed; declined findings carry recorded
  probe evidence (S5's combined-suppression walk, S6's bare-Block root).
- **Flake discipline learned this stage:** three cockpitd tests ("lets one verb at a time claim a
  waiting run", "refuses to stop a run that is still planning", cli.test.ts daemon timeout) fail
  ONLY when two test runners overlap on this machine; solo and single-runner runs are always
  green. A red from an overlapping window proves nothing — rerun quiet before believing it.
- NOT yet exercised: everything in the S11 checklist below — real terminal press, real daemon
  kills, any real provider run (tests ride recorded fixtures), the pilot against a REBUILT core.

## Known problems / open items

1. All items in the base `PROJECT_STATUS.md` §Known problems still stand (incl. §17 acceptance).
2. Feedback-route skip gap and the bounded `requestSkip` Ref leak — carried from S3, unchanged.
3. herdr-path handoff ignores `COCKPIT_{CLAUDE,CODEX}_BIN`; continuation semaphore up to ~35 s on
   a failing handoff — carried from S1, unchanged.
4. `runs.ts` substitutes the last checkpoint's sha as `baseCommit` when a worktree vanished AND no
   base was recorded — a flagged gate then measures "since last checkpoint". Deliberate (keeps
   landings possible); revisit if it bites.
5. Analyzer `provider` has no preflight: a cartridge naming codex on a codex-less machine fails
   the run at planning spawn. Loud; capabilities gating is the named upgrade path.
6. Terminal handoff opens the interactive session with no `--model` — a pinned run drops the human
   onto their default model. Consistent with S1's design; owner should know.
7. A `created` run whose client vanished mid-planning is uncancellable until the next boot scan
   (fiber-less cancel excludes `created` so one daemon cannot close another's run).

## Tried and rejected this stage (adds to the S1–S3 list; do not revisit without new evidence)

- **Hiding `OutputChunk` in essential mode** — the plan's "firehose" premise is false at the
  journal level (provider chunks never reach it); hiding it blanks a failed command block.
- **Consuming a pending user skip on ANY `BlockSkipped` in the fold** — auto-skips and plugin
  Skips would eat the user's request; only `requested: true` converges with the live Ref.
- **A combined all-flagged suppression walk in the validator** — probed and reverted: coverage
  checks fire per source, so the individual walks already refuse everything the combined one
  would; it was dead machinery.
- **`inFlight` guard on resume** — a failed run's fiber outlives the run through the
  retrospective; the guard 409'd every human-speed resume. The real fix was the fiber-map
  ownership check.
- **The engine claiming via a status read (`status !== "running"`)** — lets a direct second
  `engine.run` double-execute; the explicit `claimed` flag restores the refusal.

## S11 — owner acceptance checklist (the remaining work)

Precondition: `pnpm -r build` first — the pilot's `.cockpit` rides `Schema` structs that IGNORE
excess properties on an old core build, so `skipWhenUnchanged` and `model`/`effort` silently
vanish against stale `dist/`.

**The headline run.** In `ai-interview-assistant`, daemon on `:4177`:
1. Create a task: «Объясни вкратце о чём этот проект?» — run reaches `awaiting-start`, tree
   visible, nothing executed (S4).
2. Tree is the `answer` template (S6); the pilot's format/lint appear in it and journal-skip with
   `no files changed…` — the pass condition is `pnpm run format:check` never executes (S5).
3. Press Run — finishes fast and successfully; the answer is readable (S6; note: the row shows the
   first line, the full text sits behind the artifact click — judge whether that is "readable").

**Per-stage checks** (full detail in plan §3):
- [ ] Terminal press on a finished run: herdr tab with `claude` actually up; second press resumes,
      no second tab (S1). Note: session opens on your default model even if blocks were pinned.
- [ ] Stop mid-run → `interrupted`, Resume replays finished blocks as `BlockReplayed` (S2).
- [ ] Graceful daemon restart mid-run → run comes back resumable, not `cancelled` (S2).
- [ ] Skip a pending block; unsafe skip refused naming the downstream block; loop-body skip skips
      one iteration (S3). Skip → Regenerate → Run: the new tree is NOT pruned (S4 follow-up).
- [ ] From `awaiting-start`: Regenerate replaces the tree, Cancel works, `kill -9` + boot leaves it
      still startable (S4).
- [ ] A code-change run (quickfix/guarded-fix) still carries format/lint and executes them when
      files changed (S5/S6 interplay).
- [ ] Stream: default reads as a run; "full log" restores everything (S7). Open question for you:
      `AgentActivity` is hidden, so a live agent block shows no per-step progress between the
      attempt header and the block's end — decide if that is acceptable.
- [ ] Pin `model`/`effort` on a pilot block: the composed argv proves it (S8); resume that run
      mid-block once — the reviewer did not live-verify `--resume` + `--model` together.
- [ ] Tree panel: content-sized on the 1-block answer run, scrolls on a long one; floating variant
      (narrow window) keeps its bottom gutter (S9).
- [ ] All suites green from a clean slate — already verified at close, re-run if anything above
      changed code.

Failures land under the owning stage with their own regression test and review pass — not patched
at the acceptance step.
