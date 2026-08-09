# Cockpit — onboarding documentation

Cockpit is a **fully local, single-user control room for AI-assisted development**. It orchestrates
the `claude` and `codex` CLIs — running on the user's own subscription, never on API keys — through
declarative workflow templates, executes every task in an isolated git worktree, and records
everything it does in a durable SQLite journal that survives `kill -9`.

## The problem it solves

Running a coding agent from a terminal gives you one session, no memory of what it tried, no
isolation from your working copy, and nothing to inspect afterwards. A long task becomes a wall of
scrollback: you cannot see which step failed, why the next attempt was any different, or what the
agent actually changed. If the process dies, the work is gone.

Cockpit puts a machine around the agent. A task becomes a **workflow tree** of typed blocks — agent
blocks, shell command blocks, human approval gates — running in a throwaway git worktree branched
from a pinned commit. Every event lands in SQLite before anything acts on it, so the UI, the crash
recovery, and the post-run analysis all read the same durable record. A failed attempt produces a
structured **failure packet** that the next attempt receives instead of a fresh session with no
memory. The user's own checkout is untouched until an explicit finalize step lands the result.

## How it works, in one paragraph

The user types a prompt for a registered project. An **Analyzer** — itself a headless provider call —
picks one of the available workflow templates and fills in its parameters, optional blocks, plugin
bindings and retry counts; it never invents a graph. The project's **cartridge** (`<project>/.cockpit/`,
plain TypeScript) then applies deterministic transforms and extra validators, and a structural
validator rejects the tree if anything is inconsistent. The **WorkflowEngine** interprets the tree:
sequences, parallel branches, conditions, retry loops and approval gates. Each block runs as one
provider session or one shell command inside the run's worktree, must write a JSON result to
`$COCKPIT_OUTPUT`, and gets a git commit ("checkpoint") when it succeeds. Failures feed a budgeted
retry context into the next attempt. Everything is journaled first, published to an in-process bus
second, and streamed to the browser over a WebSocket with a monotonic cursor — so a reconnecting UI
backfills from where it left off, and a restarted daemon can re-enter an interrupted run without
re-executing anything the journal already completed.

## The documents

| File | What it covers |
|---|---|
| [`overview.md`](overview.md) | What Cockpit does: capabilities one by one, the main user scenarios, and the explicit v1 limitations. |
| [`architecture.md`](architecture.md) | Layer map, every source file and its responsibility, data flow, key entities, SQLite schema, and diagrams. |
| [`setup.md`](setup.md) | Requirements, install, the complete environment-variable list, and how to give a new project a cartridge. |
| [`run.md`](run.md) | Every real command in the repo: build, dev, test, e2e, lint, the UI mock harness, boot verification, and CI. |
| [`conventions.md`](conventions.md) | The rules this codebase actually lives by, plus how to add a service, a cartridge, an API route or an event type. |
| [`troubleshooting.md`](troubleshooting.md) | Real failure modes with the exact messages they produce and what each one means. |
| [`deviations.md`](deviations.md) | Every deliberate difference from the reference cockpit this one was read from, with the decision behind each. |

## Facts worth knowing before you read further

- **No API keys exist anywhere in this project, by design.** Provider authentication is the user's own
  `claude` / `codex` CLI login. There are no secrets in the repo, no `.env` file, and no credential
  handling code to review.
- **Effect (v3) is the mandatory foundation.** Every service is a `Context.Tag` with a `Layer`, every
  resource is `Scope`d, every boundary is `Schema`-validated, and `Effect.runPromise` appears only at
  the process entry point.
- **The repository is a pnpm monorepo**: `apps/cockpitd` (daemon), `apps/ui` (React SPA),
  `packages/core` (the engine), `packages/cartridge-kit` (the surface a project's cartridge imports).
- **State lives outside the repo**, under `~/.cockpit/`: the SQLite journal, run artifact directories,
  and the per-run git worktrees.
