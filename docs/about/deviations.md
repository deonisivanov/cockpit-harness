# Deviations from the reference

Cockpit began as a reading of someone else's cockpit: Ilya Klimov's (`xanf`) GitLab-oriented system,
described in `cockpit-eli5.html` — "a little factory that turns GitLab issues into merge requests
while you watch from the control room". That document is the reference. This one records, line by
line, where Cockpit v1 does the same thing, where it does something else on purpose, and which
decision each difference follows from.

Every difference here is settled. The reasoning lives in `docs/adr.md` (ADR-001..008) and in
`PROJECT_STATUS.md` § "Tried and rejected"; this document cites those decisions and does not reopen
them. A row that reads **Deviation** is not a gap someone forgot — it is a decision with a paper
trail.

**Verdicts.** **Match** — Cockpit does the same thing, possibly by other means. **Deviation** — a
different answer, on purpose, permanently. **Deferred** — the same answer, later; the seam exists.

## The engine and the cartridge

| The reference | Cockpit v1 | Verdict |
|---|---|---|
| Two halves in different repos: the engine knows *how to run work* and nothing about the project; the cartridge knows *everything about one repo*. Called the most important idea in the system. | The same split. `packages/core` ships no knowledge of any project; `<project>/.cockpit/` owns that project's blocks, prompts, templates, transforms and rules. | **Match** — the same foundation, stated in `overview.md` as "two halves, kept strictly apart". |
| The cartridge is its own repository (`xanf/cockpit-gitlab-org-gitlab`), cloned *into* the target checkout as `.cockpit/`. | The cartridge is a directory in the project's own tree at `<project>/.cockpit/`, loaded by path and hashed directory-wide. | **Deviation** — one user, one machine: a second repo buys distribution there is no one to distribute to. Nothing forbids a cloned-in cartridge; the loader only ever sees a path (ADR-007). |
| The cartridge's `task-source.ts` says where tasks come from — GitLab issues. | A prompt typed on the idle screen or posted to `POST /api/runs`. | **Deviation** — no task sources in v1 (ADR-006); listed as a non-goal in `overview.md`. |

## The workflow

| The reference | Cockpit v1 | Verdict |
|---|---|---|
| An AI planner (the *analyzer*) **assembles** the workflow tree per task: which steps, in what order, with which loops and gates. | The Analyzer **picks and parameterizes**: a template id, parameter values, optional-block toggles, plugin bindings from the template's allowed set, retry counts within declared bounds, and a rationale. It never invents a graph. | **Deviation** — ADR-003. Free-form LLM DAGs were the rejected alternative by name: the tree is the most fragile point in the design, and a validator that must anticipate anything cannot be small. |
| The `plan` block is `ralplan` — three agents argue until they agree. | One Analyzer call, retried exactly once with the precise rejection, then the template's defaults with a visible warning. | **Deviation** — follows from ADR-003. Cockpit's plan is a bounded typed decision, not a document, so there is nothing for three agents to converge on. A cartridge is free to ship an agent block that plans in prose. |
| Deterministic cartridge *transforms* edit the analyzer's tree, adding the steps the project always insists on (the review loop, the CI stage). | `TransformPipeline` runs the cartridge's transforms in declared order and journals a field-level diff per transform as an artifact. | **Match** — the pilot's transform appends format and lint exactly this way. |
| A validator proves the tree is well-formed *before* anything runs. "An LLM plans; plain code guarantees." | `WorkflowValidator` walks the tree in execution order, and the cartridge's own validators run alongside it; `TreeValidated` is journaled before the engine is entered. | **Match**. |

## The blocks

| The reference | Cockpit v1 | Verdict |
|---|---|---|
| Two species of block: *agent* (a full AI with tools) and *command* (one shell command, judged by its exit code). | The same two, plus *workspace* blocks the engine executes natively — `finalize` is the only one Core ships. | **Match**. |
| Every robot's full transcript is captured and streams live to the UI, shell output included. | The same: provider streams fold into journal events, prompts and transcripts are artifacts, and the WebSocket replays them from a monotonic cursor. | **Match**. |
| All AI calls route through one **LiteLLM** proxy, so every step carries a price badge — "the plan cost $1.54, the fix cost $0.80". | No metering of any kind. Steps carry a duration; nothing carries a cost. | **Deviation** — Cockpit drives the `claude` and `codex` CLIs on the user's own subscription and holds no credentials at all (`overview.md`). A metering proxy needs API keys, which this product deliberately has nowhere to put. Not planned. |

## The sandbox

| The reference | Cockpit v1 | Verdict |
|---|---|---|
| Code-changing blocks run inside a Docker container holding a complete GitLab dev environment — code, postgres, redis, rails, vite, a real browser, roughly 32 GB. | A fresh git worktree per run, branched from a pinned base commit under `~/.cockpit/worktrees/`. | **Deviation** — ADR-005 rejected a container or VM per run: slow on large repos, loses local caches, infra overkill. Both designs leave the user's checkout untouched, which was the actual requirement. |
| Work crosses the wall as patches: the diff so far goes in, the robot's diff comes back out. | Nothing crosses anything. Blocks run in the worktree and every success is a commit in it. | **Deviation** — the patch channel exists because the workspace sits on the far side of a container wall. With no wall, the diff is already where it belongs (ADR-005). |
| A **reconcile** step pins the container to the task's exact base commit, migrates the database, activates the licence and fixes the test config — then a health probe must go green three times before a robot is let in. | `WorkspaceManager.reconcile` restores the worktree to the run's recorded state before start and before resume. No service probe. | **Deviation** — the reconcile Cockpit needs is a git one. There is no database to migrate, no licence, and no service to wait for (ADR-005). |

## Durability

| The reference | Cockpit v1 | Verdict |
|---|---|---|
| Every workflow runs on **Temporal**, whose ledger holds what started, finished and returned; `kill -9` the worker and a restart replays the ledger and continues. | A custom SQLite journal: the state row and the event that narrates it are written in one transaction, published only after it commits. The boot scan reads the journal and *marks* what was left open. | **Match in substance, deviation in mechanism** — ADR-002 rejected Temporal by name: a separate server, database and worker runtime is prohibited infrastructure for a local single-user tool. Recovery granularity here is block and attempt, which the journal covers exactly. |
| A failed run is re-kicked with `/retry`, or continued from its last good step. | `POST /api/runs/:id/resume` re-enters an interrupted or failed run: completed blocks come back as `BlockReplayed` rather than re-executed, loops carry on at the iteration they stopped in, and decided gates keep their decisions. | **Match** (contracts §9). |
| A `jj` workspace makes every block's work a commit — save points, restorable per step. | The same in git: a success checkpoint per block, a salvage commit for a failed attempt that changed files, and rollback by `git reset --hard` to a checkpoint for loops whose policy declares it. | **Match** — same guarantee, the VCS already in the repo (ADR-005). |

## The machines

| The reference | Cockpit v1 | Verdict |
|---|---|---|
| Two machines: a coordinator Mac (worker, web UI, LiteLLM proxy, a read-only git mirror) and a home-lab executor running Docker and the 32 GB containers, joined by `DOCKER_HOST=ssh://…` and a reverse tunnel. | One machine, one daemon, one process. | **Deferred** — the remote executor is deferred indefinitely by ADR-006, with the seam preserved at the daemon boundary (ADR-001), which is precisely where an executor would attach. |

## Landing the work

| The reference | Cockpit v1 | Verdict |
|---|---|---|
| `finalize` squashes the run's mess into one clean branch. | `finalize` replays the run's success checkpoints onto the branch the checkout was on when the run started — `commit-tree` plus `reset --keep`, or a compare-and-swap `update-ref` — and never checks anything out. Salvage commits stay behind. | **Match**. |
| **Create the MR**: title, description, labels, in the project's house style. | Nothing. The run ends on a local branch. | **Deviation** — no PR creation in v1 (ADR-006); an explicit non-goal in `overview.md`. Cockpit talks to no network service. |
| A **review loop**, up to three rounds: an AI reviewer reads the merge request and the good comments get applied. | No loop over a merge request. A cartridge can put a reviewer agent block inside a corrective loop in its own template; the pilot's gates are format and lint. | **Deviation** — follows from the row above: with no MR there is nothing to review. The loop *shape* is available to any cartridge (ADR-003). |
| A **CI stage** runs the pipeline and fixes what is the run's own fault, politely handing flaky and infrastructure failures back. | Local command blocks — typecheck, test, lint, format — inside the run. | **Deviation** — there is no pipeline to talk to; v1 lands locally (ADR-006). |
| GitLab is the second control room: one progress comment kept up to date with a live-coloured diagram, a timeline and a cost table, and the approved plan in the work item's Agent Plan widget — "your colleagues never need to know the cockpit UI exists". | One control room: the local three-panel UI. | **Deviation** — the mirror image of the two rows above. There is no tracker to report into, and no colleagues on a single-user local tool (ADR-006). |

## Supervision and learning

| The reference | Cockpit v1 | Verdict |
|---|---|---|
| Some gates are the human's: the plan stops and waits for approval, with a proper review screen, before a single line of code is written. | The whole run parks at `awaiting-start` once planning settles — the tree is on screen, nothing has executed, and Run, Regenerate and Cancel belong to the human. Mid-run, `Gate` nodes park on a human decision and a session's question suspends its attempt until answered. | **Match** — the same guarantee, one level up: not "the plan waits" but "the run waits". Waiting is a row, not a parked fiber, so it survives a restart. |
| A **retrospective** robot rereads every transcript, classifies each suggestion by where the fix would be edited — engine or cartridge — and files it as a real issue in the matching repo; a suggestion seen again becomes a comment on the existing issue rather than a duplicate. | The same read and the same `core` / `cartridge` classification, recorded as insights in SQLite under a normalized dedup key: a repeat gains evidence links and an occurrence count instead of a duplicate row. Nothing is filed anywhere. | **Deviation** — the classification and the dedupe are identical; only the destination differs, and Cockpit has no tracker to write to (ADR-006). The insights view is where they land. |
| Cockpit is registered as one of its own projects, so some of its own retrospective issues get picked up by cockpit. | Possible in principle — `cockpit-harness` is a git repository like any other — but it ships no `.cockpit/`, so it has never been registered against itself. | **Deviation** — nothing blocks it; no one has written the cartridge. |
| One command to fly: `./cockpit dev` brings up the worker, the UI, the proxy, the mirror and the SSH tunnels. | `pnpm start` builds and starts the daemon; `pnpm cockpit add <path>` registers a project. | **Match** — one command either way. Ours has one process to start instead of five. |

## What the reference material does not show

These are Cockpit's, not corrections to the reference. Twelve screenshots are not a full account of
someone else's system, so read this as "what v1 has", never as "what the reference lacks".

- **Terminal handoff.** One press assembles a task brief from the journal and opens a canonical
  provider-native session in the run's worktree through herdr; every later press resumes that same
  session (ADR-008).
- **Stop, then Resume.** A running run can be stopped into `interrupted` — resumable — rather than
  cancelled, and a graceful daemon restart leaves it resumable too.
- **Skip.** A pending block can be skipped for its next visit; the request is refused when the skip
  would starve a downstream block's input, and the refusal names that block.
- **The `answer` template.** A question that is not a code change gets one read-only block and no
  finalize.
- **`skipWhenUnchanged`.** A block flagged this way is journal-skipped when the run changed no files,
  with the reason recorded — so a question run never executes the project's formatter.
- **Per-block `model` and `effort`.** Pinned in the cartridge, composed into the same argv on every
  retry and every resume.

## Provenance

The reference was read from twelve screenshots of `cockpit-eli5.html` (its sections 1–10 and the
cheat sheet) plus one of the running reference UI, captured 2026-08-07 at `~/Desktop/cockpit-image/`.
The HTML itself is not in this repository. Three things the screenshots do not settle:

- The reference UI shows **Run** and **Regenerate workflow** controls on a run that is already
  `running`. Whether it also parks a run before execution, the way `awaiting-start` does, is not
  shown — per reference doc, unverified. The gate row above compares against the plan-approval gate
  the document describes, not against those two buttons.
- Whether the reference has a terminal handoff, a stop control, a per-block skip, or per-block model
  pinning is not shown either way — hence the framing of the section above.
- The cost badges are real in the UI screenshot (`$2.13 · 16m40s` per step, `~$2.91 · claude
  all-time` per run). That **LiteLLM** is what computes them is the document's claim; the screenshot
  does not prove it.
