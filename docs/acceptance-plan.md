# Acceptance plan — plan §17 on the `ai-interview-assistant` pilot

Every criterion in plan §17, mapped to the command or click that decides it. `[auto]` runs
unattended and spends nothing; `[owner]` needs a real provider run, the UI, or a terminal, and is
driven interactively.

Fixed facts used below:

| What | Value |
|---|---|
| Pilot repo | `/Users/denisivanov/Desktop/ai-interview-assistant` |
| Cartridge | `<pilot>/.cockpit/cockpit.config.ts` |
| Daemon | `http://127.0.0.1:4177` (loopback only) |
| Daemon pid | `~/.cockpit/daemon.pid` |
| Run artifacts | `~/.cockpit/runs/<runId>` |
| Run worktree | `~/.cockpit/worktrees/<projectId>/<runId>` |
| Templates | `ai-interview-assistant/guarded-fix`, `ai-interview-assistant/quick-task` |
| Cartridge blocks | `aia-implement`, `aia-typecheck`, `aia-test`, `aia-lint`, `aia-format`, `aia-cargo-clippy`, `aia-cargo-test` |

**The run branches from the pilot's pinned base commit.** The pilot's working tree is dirty and 11
commits ahead of `origin/main`; none of that dirt reaches the worktree. Every prompt below must
name code that exists in `HEAD`.

## 0. Setup

- [ ] `[auto]` `cd ~/Desktop/cockpit-harness && pnpm build`
- [ ] `[auto]` `node apps/cockpitd/dist/main.js` — leave it running; note the pid.
- [ ] `[auto]` register the pilot, keep the id as `$PROJECT`:
      `curl -s localhost:4177/api/projects -H 'content-type: application/json' -d '{"name":"ai-interview-assistant","repoPath":"/Users/denisivanov/Desktop/ai-interview-assistant"}'`
- [ ] `[auto]` `claude --version` answers, and `~/.claude/plugins` still lists `oh-my-claudecode` —
      the `quick-task` binding resolves `skill:autopilot` there.

Start a run (used throughout, keep the id as `$RUN`):

```
curl -s localhost:4177/api/runs -H 'content-type: application/json' \
  -d '{"projectId":"'$PROJECT'","prompt":"<the prompt for this step>"}'
```

Read a run: `curl -s localhost:4177/api/runs/$RUN`, its journal:
`curl -s "localhost:4177/api/runs/$RUN/events?from=0&limit=500"`, an artifact:
`curl -s localhost:4177/api/artifacts/<id>/raw`.

## 1. Prompt → Analyzer → template, transforms, validator, tree in the UI

- [ ] `[owner]` Prompt: *"Rename the `IconButton` primitive's `label` prop to `ariaLabel` in
      `packages/aia-ui` and update every consumer."*
- [ ] `[owner]` UI shows the chosen template as `ai-interview-assistant/guarded-fix` with the
      Analyzer's rationale.
- [ ] `[auto]` The journal carries `TreeTransformed{name:"append-lint"}` and `TreeValidated{errors:[]}`:
      `curl -s "localhost:4177/api/runs/$RUN/events?limit=500" | grep -E 'TreeTransformed|TreeValidated'`
- [ ] `[owner]` The tree in the UI reads `loop(implement → typecheck → test) → cargo-clippy →
      cargo-test → format → lint → finalize`: the transform put its two gate blocks in ahead of
      finalize, and the loop indicator sits on the implement/typecheck/test body.
- [ ] `[owner]` For a TypeScript-only prompt the Analyzer may toggle the two `cargo-*` blocks off;
      confirm the rationale says so rather than the blocks vanishing silently.
- [ ] `[auto]` The transform's diff artifact reads as an append, not a rewrite:
      `GET /api/artifacts/<diffRef>/raw` from the `TreeTransformed` event.

## 2. Plan approval gate blocks execution

`guarded-fix` has no gate; the core `task` template does.

- [ ] `[owner]` Prompt something exploratory enough for the Analyzer to pick core `task`:
      *"Work out how answer-language selection should flow from the assistant workspace to the
      overlay, then implement it."*
- [ ] `[owner]` The run stops at `approve-plan`; the UI shows the gate with the plan artifact.
- [ ] `[auto]` No `BlockStarted` for `implement` exists while the gate is pending.
- [ ] `[owner]` Approve in the UI (or
      `curl -s localhost:4177/api/runs/$RUN/gates/approve-plan -H 'content-type: application/json' -d '{"approved":true}'`),
      and execution proceeds.
- [ ] `[owner]` Repeat with `{"approved":false}` on a second run: the run ends without implementing.

## 3. Implement/verify loop with ≥1 failed attempt, visible packet, fresh session, changed strategy

The cross-package rename in step 1 is the reliable failure: `pnpm run typecheck` covers eight
projects, and the first pass rarely catches every consumer. If attempt 1 passes, widen the rename
(add `packages/aia-ai` consumers) and re-run.

- [ ] `[owner]` Run the step-1 prompt to completion.
- [ ] `[auto]` At least one attempt failed:
      `curl -s localhost:4177/api/runs/$RUN/blocks/implement/attempts` shows a `semantic-failure`.
- [ ] `[owner]` The UI shows the failure packet for that attempt: what failed, do-not-repeat,
      remaining directions.
- [ ] `[auto]` The next attempt ran in a **fresh session** — its `SessionStarted` carries a different
      session id, `aia-implement` declares `sessionPolicy: "fresh"`.
- [ ] `[auto]` The next attempt's prompt artifact contains the rendered retry context and the line
      *"Change strategy based on the evidence above"*; read it via the attempt's `promptRef`.
- [ ] `[owner]` Judge that attempt 2 actually changed approach rather than repeating attempt 1.
- [ ] `[owner]` After two failures the `corrective` policy raises its human gate
      (`humanGateAfterFailures: 2`) — the UI asks whether to keep retrying. Approve once, deny once.

## 4. Finalize onto the target branch

The `finalize` block replays the run's **success** checkpoints onto `runs.target_branch` — the
branch the checkout was on when the run started. Salvage commits stay behind. Nothing is checked
out to do it: each commit reuses a checkpoint's tree via `git commit-tree`, and the branch is moved
by `merge --ff-only` when it is the checked-out one, `update-ref` with a compare-and-swap otherwise.

**Finalize refuses, by design, when the target branch's checkout is dirty.** The pilot's tree is
dirty and 11 commits ahead, so a run against it as-is stops at the refusal with the branch and the
working copy untouched — that is the pass condition for the isolation half of this criterion. To
see finalize actually land, use a clean checkout (below).

- [ ] `[auto]` Regression-covered: `pnpm --filter @cockpit/core exec vitest run test/workspace.test.ts
      test/workflow-e2e.test.ts` covers squash, ordered, the dirty refusal, the second-finalize refusal, the
      detached-checkout refusal, and the engine wiring.
- [ ] `[auto]` **Isolation, on the dirty pilot.** Run any `guarded-fix` prompt to completion. Before
      and after, `cd <pilot> && git status --porcelain` is byte-identical apart from `?? .cockpit/`,
      and `git rev-parse main` has not moved. The work lives only in
      `~/.cockpit/worktrees/$PROJECT/$RUN` on `cockpit/run-$RUN`.
- [ ] `[auto]` The finalize block failed with the reason, rather than the run dying: the UI shows
      `finalize` failed and its failure packet reads
      `main is checked out with uncommitted changes; commit or stash them before finalizing`.
- [ ] `[auto]` The other refusals are reachable too, each with its own message: a repository left
      mid-rebase (`operation in progress`), the branch checked out in a second worktree
      (`another worktree`), and a run predating the column (`predates target-branch tracking`).
- [ ] `[owner]` **Landing, on a clean checkout.** In the pilot, `git stash -u` (or commit the work),
      confirm `git status --porcelain` is empty, then run a `quick-task` prompt naming a one-line
      change. Restore with `git stash pop` afterwards.
- [ ] `[auto]` One new commit on `main`, its parent the base the run pinned:
      `git log --oneline -1 main` reads `cockpit: run <runId>`, and
      `git rev-parse main^` equals the run's `base_commit`.
- [ ] `[auto]` The change is in the working copy — the checkout was fast-forwarded, not left with
      the new files showing as deleted: `git status --porcelain` is empty and the edited file
      carries the change.
- [ ] `[auto]` No salvage commit landed: `git log --oneline $BASE..main` is exactly one line, and
      `git tag -l 'cockpit/salvage/*'` names commits reachable only from `cockpit/run-$RUN`.
- [ ] `[auto]` The journal records it once: one `RunFinalized` event carrying `targetBranch`,
      `mode`, `commit`, `commits` and `previousTip`.
- [ ] `[auto]` A run that changed no file lands nothing and does not fail for it: `RunFinalized`
      carries `commits: 0` and the branch is where it was.
- [ ] `[auto]` Idempotent: a second finalize of the same run refuses with
      `main is at <sha>, not the <base> this run branched from`, and `main` does not move again.

## 5. `Open session in terminal`

- [ ] `[owner]` On a finished run, press **Open session in terminal**. A herdr tab opens at
      `~/.cockpit/worktrees/$PROJECT/$RUN` with the canonical session seeded.
- [ ] `[owner]` Ask it a follow-up that only the run knows — *"why did the first attempt fail?"* — and
      check the answer against the failure packet from step 3.
- [ ] `[owner]` Press the button a second time: the same session resumes (`SessionResumed`), no new
      tab, no new session id.
- [ ] `[auto]` `curl -s -XPOST localhost:4177/api/runs/$RUN/terminal` returns the same
      `canonicalSessionId` on both presses, and `warning`/`fallback` are absent when herdr is up.
- [ ] `[owner]` Fallback check: quit herdr, press again — Ghostty opens and the response carries
      `fallback: "fresh-session"` or a `warning` naming the herdr failure.

## 6. `kill -9` mid-run

Regression-covered by `packages/core/test/recovery.test.ts` (truthful marking) and
`packages/core/test/resume.test.ts` (re-entry after a real SIGKILL); this is the real-daemon repeat.

- [ ] `[auto]` `pnpm --filter @cockpit/core exec vitest run test/recovery.test.ts test/resume.test.ts`
      is green.
- [ ] `[owner]` Start the step-1 prompt again. Wait for `aia-test` to start (the longest block, 15 min
      budget), then `kill -9 $(cat ~/.cockpit/daemon.pid)`.
- [ ] `[auto]` Restart `node apps/cockpitd/dist/main.js`. The boot scan marks only — the log says
      `none resumed` — and the run shows as `interrupted` with a Resume button.
- [ ] `[owner]` Press Resume (or `curl -XPOST localhost:4177/api/runs/$RUN/resume` → `202`).
- [ ] `[auto]` The orphaned attempt is `interrupted`, the run continued from the last confirmed
      checkpoint, and no completed block re-ran:
      `curl -s "localhost:4177/api/runs/$RUN/events?limit=500"` — one `AttemptFinished{verdict:"interrupted"}`,
      a `BlockReplayed` for each block that had already succeeded, and no second `BlockStarted` for
      any of them.
- [ ] `[auto]` `git -C ~/.cockpit/worktrees/$PROJECT/$RUN log --oneline` ends at that checkpoint.
- [ ] `[auto]` No orphaned child processes: `pgrep -f "claude|vitest|tsc"` is clean.

## 7. A failing command block surfaces evidence, and the policy is honoured

- [ ] `[owner]` Prompt: *"Delete the `success` field from the relay protocol schema in
      `packages/aia-shared`."* — the suite fails and the loop bites.
- [ ] `[owner]` The UI shows the `aia-typecheck` (or `aia-test`) block with its exit code and the
      captured output, expandable.
- [ ] `[auto]` `CommandExecuted` in the journal carries `argv`, `exitCode`, `timedOut` and the
      truncation flags.
- [ ] `[auto]` The loop stops at three attempts — `corrective` is overridden to `maxAttempts: 3`,
      `loopTimeoutMs: 90 min` — and `nonRetryable` classes are never retried.
- [ ] `[auto]` `aia-test`'s output rule bites on a green-but-empty suite: run the block against a
      vitest invocation that collects nothing and confirm `success: false` with
      `StdoutMatches /Test Files\s+\d+ passed/` failing while the exit code is 0.

## 8. Preflight rejects a missing plugin or capability

The cartridge binds `skill:autopilot`, which resolves on this machine. Force the failure, then put
it back:

- [ ] `[auto]` In `.cockpit/cockpit.config.ts`, change `omcAutopilot.entry` to
      `{ kind: "slash", name: "autopilot" }` (OMC ships autopilot as a skill, not a command).
- [ ] `[owner]` Run a `quick-task` prompt and let the Analyzer pick the binding.
- [ ] `[auto]` The run fails preflight with
      `plugin oh-my-claudecode 4.15.6 provides no slash named autopilot`, and no session is spawned —
      no silent substitution.
- [ ] `[auto]` Revert the entry to `{ kind: "skill", name: "autopilot" }`; the loader picks the edit
      up on the next run (the watcher marks it stale) and the hash changes.

## 9. Everything durable and inspectable after the run

- [ ] `[auto]` `curl -s "localhost:4177/api/runs/$RUN/events?from=0&limit=1000"` replays the whole run
      after a daemon restart.
- [ ] `[auto]` Every attempt is readable: `GET /api/runs/$RUN/blocks/<blockId>/attempts` → `GET /api/attempts/<id>`.
- [ ] `[auto]` Every artifact referenced by an event resolves: prompts, failure packets, tree diffs,
      command output, task brief. Walk the ids out of the journal and `GET /api/artifacts/<id>` each.
- [ ] `[auto]` `ls ~/.cockpit/runs/$RUN` and `git -C ~/.cockpit/worktrees/$PROJECT/$RUN log` survive
      the daemon being stopped and started.

## 10. Zero pilot-specific logic in Core

- [ ] `[auto]` `grep -rniE "aia|interview|oxlint|oxfmt|vitest" packages/core/src` returns nothing.
      (`packages/core/test/fixtures/` and this document are exempt.)
- [ ] `[owner]` Review pass over the Phase 8 diff confirms every pilot fact lives in
      `<pilot>/.cockpit/cockpit.config.ts`.

## 11. Retrospective yields deduplicated Core-vs-cartridge suggestions

- [ ] `[auto]` `curl -s -XPOST localhost:4177/api/runs/$RUN/retrospective` on a **finished** run
      returns insights; on a live one it returns 409.
- [ ] `[auto]` `curl -s "localhost:4177/api/insights?target=core"` and `?target=cartridge` split the
      suggestions.
- [ ] `[auto]` Run it twice on the same run: the second call adds no duplicate insight.
- [ ] `[owner]` The insights are browsable in the UI and readable — a suggestion names what to change
      and where.

## Order to run it in

1. Setup (§0), then §1 and §3 from one `guarded-fix` run — they share it.
2. §7 from a second run, §2 from a `task` run, §5 and §11 on either of them once finished.
3. §6 last among the live runs: it kills the daemon.
4. §8 in its own run, and revert the cartridge edit immediately after.
5. §4's landing half last of all, since it is the only step that wants the pilot's tree stashed.
   §10 is a grep and a review.
