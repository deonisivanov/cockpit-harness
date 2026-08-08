# Cockpit — usage-fixes stage status (handoff)

Updated: 2026-08-09. Scope: the owner-feedback fixes plan, stages S1–S3 **complete and reviewed**;
S4–S9, S11 pending owner go. Base doc: `PROJECT_STATUS.md` (v1 handoff, still accurate for
everything predating this stage). Plan of record: `.omc/plans/cockpit-usage-fixes.md` (revision 4,
ralplan consensus: Planner → Architect ×2 → Critic, all findings applied). Ralph state:
`.omc/state/sessions/174fe81b-2bfc-450d-8b90-fb0b7933d714/{prd.json,progress.txt}`.

## Current goals

1. **Done this stage:** the three usage blockers — terminal handoff (#7), Stop/Skip (#3), plus the
   missing-input crash class the skip work exposed.
2. **Next (owner paused work after S3):** S4 `awaiting-start` (run only by human decision), S5
   `skipWhenUnchanged` (empty diff → no quality gates), S6 `answer` template (question ≠ code
   change), S7 stream essential mode, S8 per-block model/effort, S9 tree height + cursor verify,
   S11 acceptance run. S10 (reference audit vs `cockpit-eli5.html`) parked: the file is not on
   disk; owner must supply it.
3. §17 v1 acceptance (from the base handoff) still parked behind all of this.

## Completed (commits on `main`, `7d23b7f..e8de8eb`, working tree clean)

| Commit | Contents |
|---|---|
| 791caa2 | S1 first cut: POSIX-quote the herdr pane-run line + `agent wait` verification (superseded) |
| 7f47c93 | S1 rework: handoff via `herdr agent start --kind claude\|codex --pane <id> --timeout 30000 -- <args>` — argv with no shell anywhere, herdr's own readiness = success; `verified` flag removed (success IS verification, failure is a loud HerdrError) |
| 920c644 | S2 Stop: engine's interrupt→cancelRun branch deleted; supervisor three-case intent marker (`stop`/`cancel`/absent); `Journal.stopRun` → `interrupted` + new `RunStopped` lifecycle payload; `POST /api/runs/:id/stop`; UI Stop button |
| d0a5b53 | S1 fix from re-review: agent name lowercased (`invalid_agent_name` on real uppercase pane ids); fake-herdr validates names like the real CLI |
| 3cae32a | S2 review follow-ups: stop-while-planning 409, marker removed right after interrupt, handler dedupe (`endRun(intent)`), `ignoreLogged`, docs rows |
| ad32aa5 | S3 Skip: `BlockSkipRequested` ancillary event; `engine.requestSkip` + `ResumePlan.skips` + `RunRequest.skips` fed by one `recordedSkips` fold; `skipBreaksContract` = validator walk run twice with the node suppressed; missing-input reclassified to semantic attempt failure with packet; `POST /api/runs/:id/blocks/:blockId/skip`; UI skip affordance |
| b2980e6 | S3 review fixes: fold consumes only on `BlockSkipped` (converges with the live Ref); cartridge-load failure refuses the skip; finished non-loop node refused; skipped loop iteration clears prior output; 32-char agent-name clamp; `focus-visible` on the skip button; unused `reason` field dropped |
| dd584a9, e8de8eb | refreshed Playwright screenshots (Stop button changed the frames) |

## Key technical decisions (all review-verified)

- **Terminal handoff never touches a shell.** `herdr pane run` types an unquoted line into the
  pane's interactive shell (no socket API behind it), and no single quoting is correct for both
  POSIX shells and fish (the owner's login shell). `agent start` passes argv verbatim, waits for
  the CLI to be detected, and its exit code is the verification. Caveats, documented at the call
  site (`Herdr.ts`): `--kind` runs the canonical executable, so `COCKPIT_{CLAUDE,CODEX}_BIN`
  overrides reach only the Ghostty fallback; agent names must match `^[a-z][a-z0-9_-]{0,31}$`
  (lowercased + clamped from the pane id).
- **The engine never closes an interrupted run — the caller owns the close.** Effect fact that
  drove the design: an external `Fiber.interrupt` unwinds past `matchCauseEffect` handlers and
  lands only in `onInterrupt`/`onExit` finalizers. The supervisor's finalizer closes per a
  three-case marker: `"stop"` → `stopRun` (`interrupted`, resumable), `"cancel"` → `cancelRun`
  (terminal), **absent → closes nothing** — the row stays `running` for the boot scan, which is
  what stops graceful shutdown from stranding runs as `cancelled`. Marker set before the
  interrupt, removed right after it and in the fiber's `ensuring`.
- **Stop reuses `interrupted` + `RunStopped`; no new run status.** `POST /resume` and the whole
  re-entry path are inherited untouched. Stop 409s while the run is still planning (an interrupted
  run with no tree can be neither resumed nor cancelled) — cancel is the verb there.
- **Skip is a journal event honoured at the node's next visit and consumed only by its
  `BlockSkipped`.** That single consumption rule is what makes the journal fold
  (`recordedSkips`, feeding both fresh starts and `ResumePlan.skips`) and the engine's live Ref
  converge under every interleaving; any visit-based rule diverges mid-race. Requests reach the
  engine three ways (live `requestSkip`, `RunRequest.skips`, `ResumePlan.skips`), all one fold.
- **Skip legality = the validator's own walk run twice** (`skipBreaksContract`): once as-is, once
  with the node suppressed from `available`; any new error refuses with the downstream block
  named. Covers required inputs and Condition predicate sources with zero duplicated rules.
  Refused: running node ("Stop the run, skip the block, then Resume"), finished node outside any
  loop, no tree yet, unknown node, cartridge that fails to load (silent downgrade to core-only
  blocks would blind the check).
- **Missing required input is a semantic attempt failure with a failure packet**, not an escaping
  `EngineError` that killed the run packet-less. Reachable via: Condition branch that never ran,
  plugin Skip resolution, resume over a skipped block, user skip. A skipped loop iteration also
  clears the previous iteration's output so dependents starve instead of reading stale data.

## Main files changed

- `packages/core/src/`: `Herdr.ts` (agent start, name rules, per-call exec timeout),
  `Continuation.ts` (agentKind passthrough), `events.ts` (`RunStopped`, `BlockSkipRequested`),
  `Journal.ts` (`stopRun`), `WorkflowEngine.ts` (no close-on-interrupt; skip Ref + consumption;
  envelope reclassification; `RunRequest.skips`), `WorkflowValidator.ts` (`suppressed` param,
  `skipBreaksContract`), `Resume.ts` (`recordedSkips`, `ResumePlan.skips`, `nodeOf` exported).
- `apps/cockpitd/src/`: `runs.ts` (intent marker, `closeInterrupted`, `stop`, `skip` with all
  refusals, `loopBodyIds`), `api.ts` (`endRun(intent)` with planning guard, skip route).
- `apps/ui/src/`: `App.tsx` (Stop button, skip wiring), `Tree.tsx` (skip affordance),
  `api.ts`/`model.ts`/`store.ts`/`presentation.ts`/`mock.ts` (stop + skip surface).
- Tests: `herdr` coverage inside `continuation.test.ts` (incl. uppercase pane id),
  `fake-herdr.mjs` (validates agent names, `COCKPIT_FAKE_HERDR_{START_FAIL,PANE}`),
  `journal.test.ts` (stopRun, recordedSkips), `workflow-engine.test.ts` (5 skip/starve cases, two
  rewritten interrupt tests), `workflow-validator.test.ts` (skipBreaksContract ×3),
  `api.test.ts` (stop/skip/shutdown/planning-409), `question.test.ts` (rewritten), UI unit + e2e.
- Docs: `docs/contracts.md` (event union), `docs/about/architecture.md` (interruption story, HTTP
  table: `/stop`, `/blocks/:blockId/skip`).

## Testing and verification

- Suites at close, from clean tree: **core 285 / cockpitd 41 / ui 81 (vitest) + 26 Playwright** —
  all green, lint clean. (Baseline before the stage: 273/36/78/25.)
- Every stage passed the two-reviewer protocol (correctness + AI-slop, fresh contexts, scoped to
  the stage's commits); every valid finding fixed and committed. S1 additionally re-verified
  empirically against the installed herdr 0.7.5 (throwaway tabs, real `claude`): `agent start`
  detects readiness in ~3 s; the argv reaches the process verbatim.
- NOT yet exercised: a real end-to-end handoff pressed by the owner (S11 checklist), and any real
  provider run — all provider behavior in tests rides the recorded fixtures.

## Known problems / open items

1. All items in the base `PROJECT_STATUS.md` §Known problems still stand (incl. §17 acceptance).
2. Skipping a corrective loop's `feedbackRoute` endpoint (`from`/`to`) is accepted and silently
   drops feedback for that iteration — suppression does not check route endpoints. Low impact;
   fix would be one more rule in `skipBreaksContract`'s diff.
3. `engine.requestSkip` against a run that never executes again leaves a Ref entry for the layer's
   lifetime (bounded, harmless; noted by review).
4. herdr-path handoff ignores `COCKPIT_{CLAUDE,CODEX}_BIN` (canonical executable per `--kind`);
   a herdr environment that cannot resolve bare `claude`/`codex` fails without a Ghostty fallback.
   Traded knowingly, comment at the call site.
5. The continuation semaphore (one lock across runs) is now held up to ~35 s on a *failing*
   handoff (agent-start timeout); happy path ~3 s. Ponytail ceiling, upgrade to per-run locks if
   it ever bites.

## Tried and rejected this stage (do not revisit without new evidence)

- **POSIX single-quoting for `pane run`** — fish honours `\'`/`\\` inside single quotes; a word
  ending in `\` hangs the shell, `a\\b` corrupts silently; no one encoding fits both families.
- **`herdr agent wait` as post-hoc verification** — it resolves *agent* targets, not panes:
  fails `agent_not_found` in ~11 ms on any pane without an already-detected agent; the timeout is
  never consumed.
- **A `verified: boolean` on the handoff** — with `agent start`, success is the verification;
  the flag degenerated to constant-true and was removed end to end.
- **Closing interrupted runs in `supervise`'s `matchCauseEffect` branch** — unreachable for
  external interrupts (they bypass handlers); the close must live in an `onInterrupt` finalizer.
- **A `HashSet` of stop-requested ids** — two cases cannot express "absent = shutdown, close
  nothing"; graceful shutdown kept stranding runs until the marker became three-case.
- **Consuming a skip request on any visit (`BlockStarted`/`BlockReplayed`) in the fold** — the
  replay branch and the request/start race make the fold and the live Ref disagree; only
  consume-on-`BlockSkipped` converges.
- **`Effect.orElseSucceed(undefined)` around cartridge load in skip legality** — a cartridge that
  fails to load downgraded the check to core-only blocks, where every cartridge block is unknown
  and the contract diff is blind; must refuse instead.
- **`changedFiles(workspace)` (no `since`) for anything gate-related** — porcelain status is clean
  right after every checkpoint; the two-argument `changedSince` form is the only correct one
  (matters for S5).

## Next steps (in order, each = one conventional commit + regression tests + two-reviewer pass)

1. **S4 `awaiting-start`** — plan §S4. `POST /api/runs` plans then stops; `POST /:id/start`
   re-reads the tree artifact (same read resume does); `POST /:id/regenerate` re-runs
   analyzer+transforms+validators, newest artifact wins, only from `awaiting-start`. New
   `RunAwaitingStart` lifecycle payload (never reuse `TreeValidated` — journal-first).
   **`Recovery.ts` needs NO edit** (its scan is an allowlist) — keep the regression test only.
   The breakable detail: `RunSupervisor.cancel` is fiber-map-only — add the fiber-less branch
   (no fiber + cancellable status → `journal.cancelRun`), which also fixes cancel on recovered
   interrupted runs. Skip guard accepts `awaiting-start`; Stop 409s there. Rollback caveat:
   reverting the commit strands `awaiting-start` rows (delete them or fresh DB; no migration).
2. **S5 `skipWhenUnchanged`** — engine-level, `changedFiles(workspace, since = baseCommit)`;
   validation-time `skipBreaksContract` over every flagged block; flag goes on the pilot's
   format/lint blocks; the acceptance-path test (agent block writing only `$COCKPIT_OUTPUT` →
   gate skipped) pins the owner's question-run shape in core.
3. **S6 `answer` template** — core only (block + template + analyzer-prompt classification);
   **no pilot `appendLint` edit** (it would strip lint from `quickfix`/`guarded-fix`).
4. **S7** stream essential default + full toggle (seam: `presentation.ts` `HIDDEN`/`buildRows`).
5. **S8** per-block `model`/`effort` + cartridge-level `analyzer` config; re-check CLI flags with
   `--help` at implementation time.
6. **S9** tree `self-start` + max-height/scroll; cursor audit is verify-only (rule already global).
7. **S11** acceptance: the real question-task in `ai-interview-assistant` + the owner checklist in
   plan §3 (terminal press, kill -9, Stop/Resume, skip, regenerate).
