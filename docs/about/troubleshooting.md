# Troubleshooting

Real failure modes, with the message each one actually produces.

## Install and build

### `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` on `pnpm install`

pnpm 11 refuses packages published within the last 1440 minutes even when no `minimumReleaseAge` is
configured. `pnpm-workspace.yaml` carries the exclusion that makes this install work:

```yaml
minimumReleaseAgeExclude:
  - '@types/node@26.2.0'
```

It is load-bearing, not dead configuration. If a newly pinned dependency trips the same rule, add it
to that list rather than lowering the global setting.

### `better-sqlite3` installs but the daemon cannot open the database

The native build step did not run. pnpm 11 does not execute a dependency's build scripts unless it is
allow-listed, and `pnpm-workspace.yaml` does exactly that:

```yaml
allowBuilds:
  better-sqlite3: true
```

Re-run `pnpm install` after restoring that entry.

### `pnpm start` serves a blank page

The daemon serves the UI from `apps/ui/dist`, which only exists after a build. `pnpm start` builds
first; `node apps/cockpitd/dist/main.js` on its own does not. Run `pnpm -r build` once.

## The daemon will not start

### A second daemon is refused

```
DaemonError: ~/.cockpit/daemon.pid: cockpitd is already running as pid 41287
```

One daemon per `COCKPIT_HOME` — a second would race the first over the same journal and worktrees.
Either stop the running one, or give the second a different `COCKPIT_HOME`.

A **stale** pidfile needs no cleanup: the lock reads the recorded pid, signals it with `0`, and if
nothing answers it removes the file and re-claims it exclusively. An `EPERM` reply counts as running —
the pid belongs to a process this user may not signal — so it is refused rather than stolen. The
pidfile is removed when the daemon's scope closes.

### Migrations fail

The daemon dies during layer construction and the log names the failing SQL. `Db.ts` runs three
migrations: `0001_initial`, `0002_target_branch`, and `0003_run_scoped_blocks`, which rebuilds `blocks`
and `attempts` so that a block id is unique per run rather than globally, moves the rows across, and
recreates the indexes. The migrator keys on migration *names* and ignores their content, so an old
database that has already recorded `0001` will never see a change made to `0001` in place — that is
exactly why the fix arrived as a new migration.

If a journal is scratch data and the rebuild fails on it, moving it aside is legitimate:

```sh
mv ~/.cockpit/cockpit.db ~/.cockpit/cockpit.db.broken     # also the -wal and -shm files
```

This discards every run's history. The worktrees under `~/.cockpit/worktrees/` and the artifacts under
`~/.cockpit/runs/` survive, but nothing indexes them any more.

## A run fails immediately

### The provider CLI is not available

```
PreflightError: provider-unavailable —
claude-code did not answer --version; the CLI must be installed and authorized
```

The catalog probes `claude --version` / `codex --version` once per daemon lifetime, with a 10-second
timeout. Common causes: the binary is not on the daemon's `PATH` (the daemon inherits the environment
of whatever shell started it, which is not necessarily your interactive one), the CLI is installed but
not logged in, or `COCKPIT_CLAUDE_BIN` / `COCKPIT_CODEX_BIN` points somewhere stale — at a fake
provider left over from a test, for instance. Check with `which claude` **in the daemon's own
environment**, and set the variable to an absolute path if in doubt.

### A block hangs instead of running

A CLI that reads stdin and never gets EOF waits forever. `ProcessSupervisor` prevents this for every
child by attaching an empty stdin stream (`codex exec` in particular reads stdin), so a genuine hang
here almost always means `COCKPIT_CODEX_BIN` or `COCKPIT_CLAUDE_BIN` points at something that is not
the CLI — a wrapper script, or a shell that waits for input. Every block also has its own
`timeoutMs`, after which the process group is killed and the attempt reports
`… exceeded <timeoutMs>ms` as a timeout rather than a crash.

### Preflight rejects a plugin binding

There is never a silent substitution. Whichever check failed says so precisely:

| Message | Meaning |
|---|---|
| `plugin X is not installed or not enabled` | Not in `installed_plugins.json`, or disabled in `settings.json` |
| `plugin X is 4.15.6, which does not satisfy the required 5.0.0` | `minVersion` unmet. A version carrying no digits — some marketplaces install by commit sha — can never satisfy one |
| `plugin X 4.15.6 provides no slash named autopilot` | The entry kind is wrong, or the entry lives in a nested namespace, which discovery does not walk |
| `plugin X 4.15.6 is missing required capabilities: …` | `requiredCapabilities` unmet |

What happens next is the block's declared `fallback`: `Fail` stops the run, `SkipWithWarning` skips the
block and warns that any later block requiring its output will now fail its input contract, and
`AlternativeBinding` preflights the alternative and records `alternative: true` on the resolved event.

### The Analyzer produced nothing usable

```
ValidationError: analyzer-template — the Analyzer produced no usable decision: …
ValidationError: analyzer-template — the Analyzer chose template "x", which does not exist;
                 known templates: task, quickfix, guarded-fix
ValidationError: analyzer-decision — … and template "y" cannot fall back to its defaults: …
```

The Analyzer gets exactly one retry with the precise rejection appended. After that, the template's
defaults are used with a visible warning — except when the template has required parameters, which
defaults cannot fill: a run with unfilled slots would render prompts with holes in them, so it fails
instead.

### The cartridge will not load

```
CartridgeError: load — <path>/cockpit.config.ts: <the thrown message>
CartridgeError: load — …: did not finish loading within 10000ms; a cartridge is expected to be
                data and pure functions, not work
CartridgeError: validate — …: promptFile ./prompts/x.md: escapes .cockpit
CartridgeError: validate — …: promptFile ./prompts/x.md: escapes .cockpit through a symlink
CartridgeError: validate — cartridge declares block ids more than once: aia-test
```

A project with no `.cockpit/cockpit.config.ts` runs on the core templates and is not an error; a
`.cockpit/` that exists but does not load *is*. Type-check it directly with
`npx tsc -p .cockpit/tsconfig.json` — the same schema runs in `defineCartridge` at authoring time and
again at the daemon boundary.

### A block reports a contract failure

```
no JSON result was written to $COCKPIT_OUTPUT (/Users/…/runs/<runId>/<attemptId>.output.json)
$COCKPIT_OUTPUT (…) is not a regular file
the result at $COCKPIT_OUTPUT is 2097152 bytes, over the 1048576 byte limit
the result written to $COCKPIT_OUTPUT is not valid JSON
missing required field "summary"
field "passed" must be boolean, got string
```

These are semantic failures, so they feed the failure packet and the block retries within its policy.
A symlink at `$COCKPIT_OUTPUT` is refused outright rather than followed out of the run directory.

`<def> is missing required input "x": no source that ran produced it` is different: a wired input was
never produced because the branch that would have produced it did not run. Handing the block an empty
envelope would make it invent the missing half, so the attempt stops.

## Finalize refused to land

Each refusal is a *failed block with a readable reason*, not a crashed run, and the branch is left
exactly where it was.

| Message | What it means |
|---|---|
| `main is checked out with uncommitted changes; commit or stash them before finalizing` | A checked-out target is carried along with `reset --keep`, which needs a clean tree. Commit or `git stash -u` first. |
| `main is at <sha>, not the <base> this run branched from; rebase the run or start a new one rather than overwrite it` | Each finalized commit carries a checkpoint's whole tree, so a branch that moved on since the run pinned its base would have that newer work reverted. Refused rather than reverted. |
| `<repo> has an operation in progress (rebase-merge, MERGE_HEAD, …); finish or abort it before finalizing` | A sequencer holds state about where `HEAD` is going; moving the branch under it corrupts the operation. |
| `main is checked out in another worktree (<path>); finalize would move it out from under that checkout` | Only the main checkout can be carried along; any other worktree would be left pointing at a commit its files never saw. |
| `run <id> started from a detached checkout, so there is no branch to finalize onto` | `targetBranch` was recorded as `HEAD`. |
| `run <id> predates target-branch tracking, so the branch it started from is unknown; finalize it by hand from cockpit/run-<id>` | The run was created before migration `0002` added the column. |

Two non-failures worth recognizing: a run that changed **no file** finalizes with `commits: 0` and
moves nothing, and a run that re-enters after being killed between the branch move and its own record
of finishing answers with the result its journaled `RunFinalized` holds instead of refusing — it does
not land a second time.

## Resume

| Response | Meaning |
|---|---|
| `404 {"error":"not found","detail":"run <id>"}` | No such run. |
| `409 … "run <id> is succeeded; only an interrupted or failed run can be resumed"` | A finished run has nothing to carry on, and a **cancelled** run stays cancelled — it was stopped on purpose. |
| `409 … "run <id> has no workflow tree that still reads, so there is nothing to re-enter; start a new run"` | The run was interrupted before planning settled on a tree, or the `workflow-tree` artifact no longer decodes. It is Schema-decoded, never cast, so a truncated file reads as "nothing to re-enter". |
| `409 … "run <id> is running, expected one of interrupted, failed"` | A second resume arrived while the first was already under way. The status change *is* the claim on the run. |
| `202 {"runId":"…"}` | Accepted; progress arrives through the normal event stream. |

Re-entry can also fail *inside* the run rather than at the request — deliberately, so the reason lands
in the journal like any other run failure. The common one is a worktree that is no longer this run's:
`<path> is no longer this run's worktree (git reports <other>)`. If a completed block's output
artifact cannot be read back, the resume stops rather than running the blocks wired to it against an
empty envelope.

## Approvals and questions

Both actions answer `409` when nothing is parked:

```
409 {"error":"no gate awaiting a decision",
     "detail":"run <id> has no gate approve-plan awaiting a decision"}
409 {"error":"no question awaiting an answer",
     "detail":"run <id> has no question awaiting an answer on block implement"}
```

For questions this is expected in one narrow window: the `QuestionAsked` event is journaled from the
provider stream slightly before the attempt actually parks on the answer. The UI handles it — it
retries the POST with backoff starting at 200 ms, doubling to a 2 s cap, for up to 30 s, and gives up
early if the question disappears from its state because someone else answered. A `curl` by hand needs
the same patience. Answers are never buffered: the answer must arrive while the attempt is parked.

## The UI shows nothing

**`403 forbidden — cockpit serves loopback hosts only`.** Every request passes a `Host` header check;
only `127.0.0.1`, `localhost` and `[::1]` are accepted. Binding loopback does not stop DNS rebinding,
and neither a WebSocket nor a `text/plain` form post is subject to CORS, so the Host header is the one
thing separating a page the user opened here from a page that merely points here. Reaching the daemon
through a LAN address or a custom hostname will not work.

**`403 forbidden — origin <x> may not open a run stream`.** The WebSocket route additionally checks
the browser's `Origin`. An absent `Origin` means a non-browser client (curl, the tests), which no page
can forge on a browser's behalf, and is allowed.

**`400 invalid request — a runId query parameter is required`.** `/api/ws` needs `?runId=<id>`;
`&from=<seq>` is optional and defaults to 0.

**The stream is silent but the run is progressing.** The socket may be half-open. There is no
protocol-level ping in `@effect/platform` 0.97, so Cockpit sends a JSON `{"type":"ping"}` every 30 s
and a dead peer is only noticed when the OS gives up on that write. The client reconnects on close
with exponential backoff and resumes from its own cursor, so nothing is lost.

## The workflow panel is stuck on "the analyzer is still assembling this workflow…"

That placeholder appears whenever `GET /api/runs/:id` returned no tree, which is truthful while the
Analyzer is still working — the tree is written as a `workflow-tree` artifact only after transforms
and validation settle. The UI re-fetches the run detail as soon as the run status becomes `running`,
because the engine starts strictly after that artifact is written. If it persists on a run that is
clearly executing, look at the journal for `TreeAnalyzed` / `TreeValidated`: a run that failed
validation never wrote a tree.

## The terminal button opens Ghostty instead of a herdr tab

Expected when the herdr server is not running. The preflight (`herdr status server --json`) reports
`herdr server is not running`, and any failure *before a tab exists* falls through to
`open -na Ghostty.app --args --working-directory=<worktree> -e <command>`, with the herdr reason
carried back as `warning`.

A failed `herdr pane run` does **not** fall through — the tab is already on the user's screen, and a
second window would leave one session with two terminals. The error names the tab so it can be closed:
`… — tab w1:t9 is now empty`. If both terminals fail, the error names both reasons.

Also expected: `fallback: "fresh-session"` when the previously recorded session could not be resumed
(claude's transcript file for that cwd is gone), and `fallback: "fresh-worktree"` when the run's
worktree had to be rebuilt from its last checkpoint. Both are reported, never silent.

## `413 artifact too large`

```
413 {"error":"artifact too large","detail":"2097152 bytes is over the 1048576 byte limit"}
```

`GET /api/artifacts/:id/raw` caps a body at 1 MiB — the same `outputBudget` that bounds a block's
result and a captured command stream. The row itself (`GET /api/artifacts/:id`) still returns, with
`path` and `bytes`, and the UI shows *"artifact too large to preview (over 1 MiB) — open it from the
workspace"*. Read the file from `~/.cockpit/runs/<runId>/` directly.

## Fixture tests fail after a CLI upgrade

`test/provider-parsers.test.ts` runs against recorded stream fixtures pinned to specific CLI versions.
When a provider changes its output shape, re-record and review the diff:

```sh
./scripts/refresh-fixtures.sh
```

Current recordings pin `claude 2.1.224` and `codex 0.146.0`. A newer CLI on the machine is not itself
a problem — the parsers are tolerant, and the drift only matters when a test starts failing.

## What `kill -9` actually does

**What survives.** Every completed effect is in the journal before it was reported outward, so the
event log, the block and attempt rows, the artifacts under `~/.cockpit/runs/<runId>/`, and the git
commits in `~/.cockpit/worktrees/<projectId>/<runId>/` are all intact. WAL mode is on precisely so a
force-killed daemon leaves a journal that recovers rather than tears.

**What dies.** Every child process. They are spawned in their own process groups, so plugin subagents
and shells go with them. Nothing is left orphaned.

**What the boot scan does.** For every run still `created` or `running`: mark each attempt with no
verdict as `interrupted`, mark each `running` block `interrupted`, and close the run as `interrupted`
with a `RunRecovered` event naming its last **success** checkpoint (found by insertion order, not by
wall clock — a clock that stepped backwards would reorder them). Salvage checkpoints are never treated
as resume points. The log says `recovery scan: N interrupted run(s) marked, none resumed`.

**What it deliberately does not do.** It does not resume anything, does not touch a worktree, and does
not roll anything back. A run that restarts itself on boot is a worse surprise than a button to press.

**What resuming then does.** `POST /api/runs/:id/resume` reads the persisted tree and builds the
resume plan *before* execution, so nothing it decides depends on rows the resumed run is itself
writing. Whatever the interrupted attempt left uncommitted in the worktree is kept as a salvage commit
under that attempt, the tree is reset to the last confirmed checkpoint, and the run re-enters. Blocks
whose newest instance is `succeeded` or `skipped` are **never executed again** — their result is
rehydrated into `priorOutputs` and a `BlockReplayed` event records that the journal answered for them.
Instance numbering continues (`implement#2` → `implement#3`), decided gates keep their decisions,
undecided ones re-raise, and an interrupted attempt is not charged against the block's attempt budget
because it was never judged. Block definitions come from the cartridge **as it stands now**, so a
project edited since the run started resumes against what it has today.

**One documented soft edge.** A loop body whose closing block runs only under a `Condition` reads as
an open iteration for the iterations that skipped that block. The cost is one replay, never a repeated
side effect.
