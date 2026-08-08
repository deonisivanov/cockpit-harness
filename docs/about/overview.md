# Overview — what Cockpit does

## Purpose

Cockpit turns "ask an agent to do a task" into an observable, recoverable, isolated execution with a
durable record. It is a local daemon plus a browser UI for one user on one machine. It does not host
models, hold credentials, or talk to any network service: the intelligence comes from the `claude`
and `codex` command-line tools already installed and authorized on the user's machine, and Cockpit
drives them headlessly.

Two halves, kept strictly apart:

- **Core** (`packages/core`) — project-agnostic engine: workflow interpretation, blocks, providers,
  persistence, retries, recovery, isolation, observability. Core contains no knowledge of any
  particular project.
- **Cartridge** (`<project>/.cockpit/`) — TypeScript configuration owned by the project being worked
  on: its blocks, prompts, commands, workflow templates, transforms, validators, retry policies and
  rules. Data and pure functions only.

## Capabilities

**Hybrid analyzer over templates.** The Analyzer never generates an arbitrary graph. It receives the
prompt, the project's rules, the template library and the machine's actual capabilities, and returns
a typed `AnalyzerDecision`: a template id, parameter values, optional-block toggles, plugin binding
choices from the template's allowed set, retry counts within declared bounds, and a rationale. An
invalid decision is retried exactly once with the precise rejection appended; a second failure falls
back to the template's defaults with a visible warning — unless the template has required parameters
that defaults cannot fill, in which case the run fails rather than rendering prompts with holes in
them.

**Three kinds of block.** *Agent* blocks run one provider-native CLI session with a composed prompt
and a permission profile. *Command* blocks run a shell command with a timeout, captured output, and
optional output-matching success rules. *Workspace* blocks are executed natively by the engine —
`finalize` is the only one Core ships. Every block declares its input and output contract as data, so
the validator can check that two connected blocks actually fit.

**Failure packets and budgeted retry context.** A failed attempt is distilled into a typed
`FailurePacket`: what it believed, what it did, which commands it ran, what exactly failed, why it
was judged a failure, what must not be repeated, and what directions remain. The next attempt gets
the last packet in full plus one-paragraph summaries of older ones, with repeated error signatures
collapsed to a count. The whole thing is fitted to a per-policy character budget by removing or
summarizing entire structural parts — never by cutting text in half — and the rendered text is stored
as an artifact, because that is exactly what the next attempt reads.

**Approval gates.** A `Gate` node parks the run on a human decision, writing its payload as an
artifact and journaling `ApprovalRequested`. Retry policies can also raise a gate automatically after
N failed attempts, or when no-progress detection sees the same failure signature twice.

**Question suspend and resume.** When a headless Claude session asks a question (surfaced as an
`AskUserQuestion` tool call) and ends without writing its result, the attempt suspends rather than
failing. The UI shows the question; the answer resumes that same session inside the same attempt, so
the block keeps its timeout and its history.

**Crash recovery and run re-entry.** Child processes die with the daemon because they are spawned in
their own process groups. On boot the journal is scanned and anything still open is *marked*
interrupted — nothing restarts itself, on the grounds that a run resuming without being asked is a
worse surprise than a button. `POST /api/runs/:id/resume` then re-enters an interrupted or failed
run: blocks the journal already completed are replayed from their recorded output (`BlockReplayed`)
rather than executed again, loops carry on at the iteration they stopped in with the pre-crash retry
context, decided gates keep their decisions, and the worktree is salvaged and reset — or rebuilt from
the last confirmed checkpoint if it is gone.

**Checkpoints and salvage.** Every successful block that had write access earns a git commit in the
run's worktree. A failed attempt that changed files gets a *salvage* commit, tagged so a rollback
cannot strand it. Rollback is `git reset --hard` to a checkpoint, and only for loops whose policy
declares it.

**Finalize onto the target branch.** The `finalize` block replays the run's success checkpoints onto
the branch the user's checkout was on when the run started. It never checks anything out: each commit
reuses a checkpoint's tree via `git commit-tree`, and the branch is moved by `reset --keep` when it is
the checked-out one and by a compare-and-swap `update-ref` otherwise. Salvage commits stay behind. A
refusal is an outcome, not a crash — the block fails with a readable reason and the branch is left
alone.

**Canonical terminal session.** At any point the user can press *Open session in terminal*. Cockpit
assembles a **task brief** from the journal (prompt, plan, blocks, attempts and failure reasons,
decisions, changed files, checkpoints, verification results, errors, artifact index, how to run the
project's checks), writes it as an artifact, and starts one provider-native session in the run's
worktree seeded with a pointer to that file. Subsequent presses resume that same session. The tab is
opened through the `herdr` workspace manager's CLI, with a Ghostty window as the fallback when the
herdr server is not running.

**Retrospective insights.** After a run finishes — succeeded or failed, never cancelled — an agent
reads a journal-derived summary and reports what should change, split into `core` and `cartridge`
targets. Insights are deduplicated by a normalized key: a recurring one gains evidence links and an
occurrence count instead of a duplicate row.

**Three-panel UI.** A dark control-room SPA: left rail with projects and run history, center stream of
folded journal events with expandable prompts, transcripts, diffs, ANSI output and artifacts, right
panel with the workflow tree showing loop attempt indicators, conditions, gates, durations and
statuses. Keyboard navigation throughout (`j`/`k` move, `o` expand, `t` tree, `G` end, `esc` clear
filter, `a` approve).

## Main user scenarios

| Scenario | What happens |
|---|---|
| **Start a task** | Type a prompt on the idle screen (or `POST /api/runs`). A worktree is created before the request returns, then planning and execution run in a fiber owned by the daemon — closing the browser tab changes nothing. |
| **Approve a gate** | The stream shows an approval card with the gate's payload artifact. Approve or reject; the parked run continues or ends. |
| **Answer a question** | The stream shows the question the session asked with an answer box. The answer resumes that same provider session inside the same attempt. |
| **Resume a crashed run** | After a `kill -9` and restart, the run shows as `interrupted` with a Resume button. Pressing it re-enters the persisted tree; nothing already completed runs twice. |
| **Open a terminal session** | One press opens a herdr tab in the run's worktree with the canonical session seeded from the task brief; the next press resumes it. |
| **Browse insights** | The insights view lists retrospective suggestions filtered by `core` / `cartridge`, each with its evidence and occurrence count. |

## Limitations (v1 non-goals and known gaps)

Deliberately out of scope for v1:

- **No multi-user, no multi-tenancy.** One user, one machine, one daemon per `COCKPIT_HOME`.
- **No remote executor.** The seam is preserved at the daemon boundary, but nothing runs off-machine.
- **No provider or plugin switching between attempts.** A retry changes strategy only through the
  failure packet. The schema reserves the hook for v2.
- **No task sources and no PR creation.** No Jira, no GitLab, no pull requests — Cockpit lands commits
  on a local branch and stops there.
- **Not a pixel-perfect clone of the reference UI design.**

Known gaps that are documented rather than fixed:

- **Codex cannot scope writes the way Claude can.** The `read-plus-output` profile needs a writable
  directory outside the worktree, and codex's sandbox only consults `writable_roots` under
  `workspace-write` — so on codex such a block can also write to the worktree. Claude scopes this
  profile properly; codex does not.
- **Plugin discovery is a documented subset.** It reads `installed_plugins.json` plus top-level
  `commands/*.md`, `skills/<name>/` and `agents/*.md` in each install directory. Nested command
  namespaces are not walked, and a plugin versioned by commit sha cannot satisfy a `minVersion`.
- **Cartridge code runs with the daemon's privileges** (ADR-007). The "no IO at load time" rule is
  upheld by review, not by the runtime; the loader's 10-second timeout only catches a load that
  stalls asynchronously. Success-rule regexes run on the stock backtracking engine, so a pathological
  pattern can stall its own block. Accepted for a single-user local tool running the user's own code.
- **The boot scan marks only.** It never resumes a run by itself — that is the Resume button's job.
- **A loop body whose closing block runs only under a `Condition`** reads as an open iteration on
  re-entry for the iterations that skipped it. The cost is one replay, never a repeated side effect.
- **The WebSocket has no protocol-level ping.** `@effect/platform` 0.97 exposes no ping frame, so
  Cockpit sends a JSON `{"type":"ping"}` heartbeat and a half-open socket is noticed when the OS gives
  up on a write.
