# Claude Design Prompt — Cockpit Control Room UI

> **Status: executed.** This prompt produced the Claude Design prototype that is now the authoritative visual reference:
> https://claude.ai/design/p/cfbbafca-56a2-4192-8e62-f063230ac008?file=Cockpit.dc.html
> (import via the claude_design MCP, `https://api.anthropic.com/v1/design/mcp`, auth `/design-login`; implement `Cockpit.dc.html`, read `support.js` too).
> Scope agreed with the owner when generating it: 8 states (retrospective excluded), full simulation (streaming, timers, pulse), one app + state switcher, close to the Klimov reference; priority-rendered parts: ANSI terminal output, unified diff, inter-attempt failure packet.
> ⚠ marks below mean: take the value from the prototype's CSS, not from this text.

You are designing the web UI for **Cockpit**, a local, single-user control room that runs AI coding workflows (Claude Code / Codex sessions, shell commands) as observable workflow trees with retries, checkpoints, and human approval gates. The interface is inspired by Illia Klimov's Cockpit (see `refs/` screenshots — the primary reference). Do not copy pixel-for-pixel; deliver a high-quality realization of the same product idea — a calm, dense, dark control room for watching long-running autonomous work — never a generic dashboard.

## Visual direction

- Dark control-room interface. Deep neutral background (not pure black), ⚠ close to the reference's tone.
- High information density, close to the reference: this is a professional monitoring surface, not a marketing page. Compact rows, tight vertical rhythm, no card shadows, no decorative gradients.
- Thin 1px borders in a low-contrast neutral for panel and row separation; hierarchy through spacing and type, not boxes.
- Calm status colors: muted green (success), amber (running/waiting), red (failure), gray (skipped/cancelled), blue (info/approval). Desaturated — status reads at a glance without shouting. ⚠ match reference hues.
- Typography: a clean UI sans for chrome and labels; a first-class monospace for everything execution-related (prompts, commands, output, diffs, file paths, session ids). ⚠ pick faces and sizes after the screenshots; the monospace portion must feel precise and calm at small sizes.
- Minimal decorative noise. Maximum readability over multi-hour runs: stable layout, no layout shift on streaming updates, subtle animation only for state transitions (a soft pulse on the actively running block, a brief highlight on new stream rows).

## Layout

Three-panel control room, full viewport height:

1. **Left — task rail** (fixed width, collapsible): projects and their tasks.
2. **Center — execution stream** (flexible): live structured events of the selected task/block/attempt.
3. **Right — workflow tree** (fixed width, collapsible): the run's block tree with loops, attempts, statuses.

Top bar: current project/task title, run status chip, elapsed time, global actions: `Open session in terminal` (primary, always visible), Cancel, Retry.

## Left task rail

- Projects as section headers; tasks beneath with: status dot (running pulse / waiting amber / success green / failed red / cancelled gray), short task title (one line, ellipsis), relative time, attempt-loop indicator when running (e.g. `2/3`).
- Counters per project: running, waiting, failed.
- Quick navigation to previous tasks; keyboard `↑/↓` moves selection, `Enter` opens.
- Waiting-for-approval tasks surface with a distinct badge and rise to the top of their project group.

## Center execution stream

- A virtualized, append-only stream of **structured meaningful events**, not a raw terminal log: Session, Agent, Plugin, Prompt, Command/Bash, Result, Question, Error, Artifact, Checkpoint, Approval, Attempt, Retry, Verification, Failure feedback.
- Each event: compact single row — icon/type tag, monospace summary, timestamp, duration where relevant. Rows expand in place to full detail:
  - full prompt; full transcript; raw stdout/stderr in an embedded terminal view (xterm-style, ANSI-correct);
  - command details (argv, exit code, cwd); plugin and subagent details; stack traces; structured metadata;
  - generated artifacts (with preview for text/images); attempt input envelope; attempt result; failure summary; the exact feedback packet forwarded to the next attempt.
- Rendering quality bar: ANSI colors, syntax-highlighted code, unified diffs with intra-line emphasis, long-line handling (wrap toggle), Markdown, and smooth streaming text for the currently running agent.
- Attempt boundaries are visually strong: an attempt header row (`Attempt 2 of 3 — implement`, session id, strategy note), failed attempts get a compact failure-summary footer with a link "feedback passed to next attempt →".
- Approval events render as an inline approval screen: payload (e.g. the plan) rendered in full, Approve / Reject with note; the stream pauses visually (dimmed subsequent area) until decided.
- Questions from sessions render as inline question rows with an answer input; answered questions keep both question and answer visible.
- Auto-follow toggle (stick to bottom while streaming; scrolling up disengages; a "jump to live" pill appears).

## Right workflow tree

- The full block tree: block name, type icon (agent/command/gate/loop/condition), plugin or agent badge (e.g. `omc:plan`, `codex`), status color, duration.
- Loops render with attempt indicators exactly in the reference's spirit: `2/3`, `1/4` — instantly readable which attempt is live, which failed (small red ticks per failed attempt), and that feedback flowed forward (a subtle arrow between attempt ticks).
- Current running block: soft pulse + auto-scroll into view. Skipped blocks: dimmed with strikethrough-free "skipped" tag. Human gates: distinct diamond marker; pending gate glows amber.
- Dependencies/conditions: indentation + thin connector lines; conditions show their predicate on hover.
- Clicking any block or attempt filters the center stream to it (breadcrumb appears; clear filter returns to full run). Selection state is visible in the tree.
- Per-attempt sub-rows on expand: verdict, duration, session link, checkpoint sha.

## Key screens/states

1. **Idle / new task**: prompt input front and center for the selected project, recent tasks below.
2. **Analyzing**: template selection + rationale shown as the first stream events; tree skeleton appears on the right.
3. **Plan approval**: inline approval screen (above) — the canonical gate.
4. **Running**: live stream + pulsing tree.
5. **Failed attempt → retry**: failure summary, forwarded packet link, next attempt header.
6. **Waiting on question**: inline question row + task rail badge.
7. **Finished (success/failure/cancelled)**: result summary card at stream end — changed files, checkpoints, verification evidence, `Open session in terminal`.
8. **Recovery**: after daemon restart, an unobtrusive banner "run recovered from checkpoint <sha>" at the recovery point in the stream.
9. **Retrospective**: per-run insights list (Core vs cartridge), each with evidence links and occurrence count.

## Interactions

- `Open session in terminal` is the one obvious continuation control: available during execution, after success, error, cancellation, retries exhausted, on new questions, on review feedback. Never ask the user to pick among internal block/attempt sessions.
- Retry/recovery controls: retry a failed block, rollback an attempt (where the loop allows), continue from last checkpoint — each with a confirm popover stating exactly what will happen.
- Keyboard: `j/k` stream navigation, `o` expand/collapse row, `t` focus tree, `g g`/`G` top/bottom, `f` follow toggle, `a` approve focused gate, `/` filter, `⌘K` command palette (switch task/project, actions).
- Loading states: skeleton rows for stream backfill, spinner only inside the affected panel — never a full-screen blocker. Reconnect after daemon restart is seamless (cursor backfill).

## Responsive behavior

Desktop-first (this is a local developer tool). Below ~1280px the right tree collapses to a toggleable overlay; below ~1024px the left rail collapses to icons. Panels are user-resizable with persisted widths. Never let the center stream drop below comfortable monospace reading width.

## Component states to specify

For each: default, hover, selected, focused (keyboard), running (pulse), success, failed, skipped, disabled — task rail row, stream event row (collapsed/expanded), attempt header/footer, tree node, loop indicator, gate marker, approval screen buttons, question input, terminal viewport, diff block, artifact chip, status chips, `Open session in terminal` button (enabled/fallback-mode/disabled-with-reason).

## Feel

The reference's essence to preserve ⚠ (verify against screenshots): the calm confidence of a mission control room — dense monospace telemetry, restrained color, thin structure lines, everything readable at a glance after hours of runtime. If a choice arises between decoration and legibility of long-running state, legibility wins every time.
