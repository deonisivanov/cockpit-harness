# Setup

## Requirements

| Requirement | Version | Why |
|---|---|---|
| Node.js | `>=22` (`engines` in the root `package.json`) | The engine uses `node:fs/promises` `glob` with `withFileTypes` and `exclude`, among other recent APIs. |
| pnpm | `11.17.0` (pinned by `packageManager`) | Workspace protocol, `allowBuilds`, and `minimumReleaseAgeExclude` all behave as this repo expects only on pnpm 11. |
| git | any modern version | Worktrees, `commit-tree`, `update-ref`, `reset --keep`, `worktree list --porcelain`. |
| `claude` CLI | logged in on the user's own subscription | Agent blocks, the Analyzer, and the retrospective. |
| `codex` CLI | logged in | Only needed for blocks that declare `provider: "codex"`. |
| `herdr` | optional | The terminal handoff. Without it, Cockpit falls back to opening a Ghostty window. |

The daemon is macOS-oriented in two specific places, both of them the terminal handoff: the Ghostty
fallback shells out to `open -na Ghostty.app --args …` (Ghostty's own binary refuses to launch the
emulator from the CLI on macOS), and the herdr integration assumes herdr's macOS CLI. Everything else
— journal, worktrees, providers, commands — is plain Node and git.

**There are no API keys in this project, and none are needed.** Provider authentication is whatever
login the user already has in their `claude` / `codex` CLI. Cockpit never reads a token, never stores
a credential, and has no configuration slot for one. Child processes inherit the daemon's environment
precisely so the CLIs can find their own subscription credentials there.

## Install

```sh
git clone <repo-url> cockpit-harness
cd cockpit-harness
pnpm install
```

Two lines in `pnpm-workspace.yaml` are load-bearing and should not be removed:

```yaml
allowBuilds:
  '@parcel/watcher': false
  better-sqlite3: true      # the SQLite driver needs its native build step to run
  msgpackr-extract: false
# pnpm 11 defaults minimumReleaseAge to 1440 minutes even with none configured here;
# this exclusion is load-bearing, not dead.
minimumReleaseAgeExclude:
  - '@types/node@26.2.0'
```

pnpm 11 refuses packages published within the last 24 hours unless they are excluded, and it refuses
to run a dependency's build scripts unless they are allow-listed. Without the first line
`better-sqlite3` installs without its binary; without the second, a fresh install fails with
`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`.

The workspace also includes `packages/core/test/fixtures/sample-cartridge` on purpose: a cartridge is
a project that depends on the kit, so the fixture being one is what proves the published types
compile outside this repo's own build.

Then build and start:

```sh
pnpm start      # pnpm -r build && node apps/cockpitd/dist/main.js
```

The UI is served by the daemon from `apps/ui/dist`, so `pnpm -r build` has to have run at least once
before `http://127.0.0.1:4177` shows anything but a blank page.

## Environment variables

Everything Cockpit reads as configuration, verified against the `Config.*` calls in
`packages/core/src` and `apps/cockpitd/src`. All of them have defaults; a working install needs none
of them set.

| Variable | Default | Meaning |
|---|---|---|
| `COCKPIT_HOME` | `~/.cockpit` | Root of all state: `cockpit.db`, `daemon.pid`, `runs/<runId>/`, `worktrees/<projectId>/<runId>/`. Created on boot if missing. One daemon per `COCKPIT_HOME`. |
| `COCKPIT_PORT` | `4177` | The daemon's HTTP/WS port. The host is always `127.0.0.1` and is not configurable. |
| `COCKPIT_KILL_GRACE_MS` | `5000` | How long a child process group gets between `SIGTERM` and `SIGKILL` when its scope closes. |
| `COCKPIT_CLAUDE_BIN` | `claude` | The Claude Code executable. Point it at a script to substitute a fake provider in tests. |
| `COCKPIT_CODEX_BIN` | `codex` | The Codex executable, same idea. |
| `COCKPIT_HERDR_BIN` | `herdr` | The herdr CLI used for the terminal handoff. |
| `COCKPIT_OPEN_BIN` | `open` | The macOS `open` used for the Ghostty fallback. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's own configuration directory. Cockpit reads it for two things it does not own: plugin discovery (`plugins/installed_plugins.json`, `settings.json`, and each install's `commands/` · `skills/` · `agents/`), and the session-resume probe (`projects/<escaped cwd>/<sessionId>.jsonl`). If the directory is not where expected, plugin discovery reads as "nothing installed" and the resume probe stays optimistic rather than discarding a live session. |

Two more variables exist but are **injected by Cockpit into child processes**, not read from your
environment: `COCKPIT_OUTPUT` (the absolute path where the block must write its JSON result) and
`COCKPIT_BLOCK` (which block is asking). Both are also named in the prompt text.

### Test-only variables

These are read exclusively by the fake CLIs under `packages/core/test/` and by the suites that drive
them. Never set them in a real run.

| Variable | Used by | Effect |
|---|---|---|
| `COCKPIT_FAKE_SCENARIO` | `fake-provider.mjs` | Selects a canned provider behaviour (default `success`). |
| `COCKPIT_FAKE_SCRIPT` | `fake-provider.mjs` | Path to a JSON script keyed `"<blockDefId>:<nth call>"` or `"<blockDefId>"`, so one file can drive block retries and loop iterations that differ in neither argv nor environment. |
| `COCKPIT_FAKE_HERDR_DOWN` | `fake-herdr.mjs` | `1` plays a stopped herdr server. |
| `COCKPIT_FAKE_HERDR_PROTOCOL` | `fake-herdr.mjs` | Overrides the protocol version it claims (real value: `17`). |
| `COCKPIT_FAKE_HERDR_PANE_FAIL` | `fake-herdr.mjs` | `1` makes `pane run` fail after the tab was created. |
| `COCKPIT_FAKE_HERDR_LOG` | `fake-herdr.mjs` | Appends every invocation's argv to this file. |
| `COCKPIT_FAKE_OPEN_FAIL` | `fake-open.mjs` | `1` plays a missing `Ghostty.app`. |
| `COCKPIT_FAKE_OPEN_LOG` | `fake-open.mjs` | Appends every invocation's argv to this file. |

## Giving a project a cartridge

A cartridge is a **directory, not a file**: `cockpit.config.ts` is assembly, and everything it names
lives in its own module. The layout is a convention — the loader evaluates the entry file and follows
its imports wherever they lead — but the pilot cartridge at
`~/Desktop/ai-interview-assistant/.cockpit/` is the worked example:

```
.cockpit/
  cockpit.config.ts   # assembly only: imports + the defineCartridge call
  README.md           # what this cartridge does, how to run a task against this repo
  blocks/             # one file per block (+ a shared commandBlock helper)
  prompts/            # agent prompts as Markdown, referenced by promptFile
  templates/          # one file per workflow template
  transforms.ts  validators.ts  policies.ts
  tsconfig.json
  package.json
  node_modules/@cockpit/cartridge-kit -> <symlink to the harness checkout>
```

### The kit symlink

`@cockpit/cartridge-kit` is unpublished, and it declares `"@cockpit/core": "workspace:*"` — which is
unresolvable outside this workspace, so a `file:` dependency does not work. The cartridge therefore
reaches the kit through a **relative symlink** inside its own `node_modules`:

```sh
cd <project>/.cockpit
mkdir -p node_modules/@cockpit
ln -s ../../../../cockpit-harness/packages/cartridge-kit node_modules/@cockpit/cartridge-kit
```

Adjust the `../` depth to your own layout. The symlink target must be the harness checkout's
`packages/cartridge-kit` directory. `node_modules` is excluded from the cartridge hash precisely
because the kit is linked there.

### Writing the cartridge

`cockpit.config.ts` calls `defineCartridge({...})`, which validates the config where the author can
see it. Every field is optional except `name` (which must be a lowercase slug):

```ts
import { defineCartridge } from "@cockpit/cartridge-kit"
// … imports of blocks, templates, transforms, validators, policies

export default defineCartridge({
  name: "ai-interview-assistant",
  environment: { healthChecks: [{ argv: ["pnpm", "install", "--frozen-lockfile"], timeoutMs: 600_000 }] },
  blocks: [implement, typecheck, test, lint, format, clippy, cargoTest],
  templates: [guardedFix, quickTask],
  transforms: [{ name: "append-lint", apply: appendLint }],
  validators: [{ name: "no-filtered-checks", check: noFilteredChecks }],
  retryPolicies: [corrective],
  rules: { /* free-form project rules the Analyzer plans against */ },
})
```

Naming rules the registry enforces: cartridge **templates** are namespaced automatically
(`ai-interview-assistant/guarded-fix`), so a cartridge may reuse a core template's short name; **block
ids** share one namespace with core and a collision is refused; **retry policies** deliberately
override core defaults by id; duplicate transform or validator names are refused because both are
journaled by name alone.

Type-check it against the kit:

```sh
cd <project> && npx tsc -p .cockpit/tsconfig.json
```

Nothing needs to be built or restarted. The daemon watches `.cockpit/` and reloads on the next run,
and **any** edit under it — a block, a prompt, the README — changes the cartridge hash that run
records.

### Registering the project

Runs are addressed by project, and a project is registered once by absolute repository path. There
are three equivalent ways to do it.

```sh
# 1. The CLI, from inside the project (path defaults to cwd, name to its basename):
cockpit add                      # or: cockpit add /path/to/repo --name my-project
cockpit projects                 # list what is registered
```

`cockpit` is `apps/cockpitd`'s `bin` entry. `pnpm cockpit add …` works from anywhere in the harness
checkout without any linking, since it's the root `package.json`'s own script. A bare `cockpit` on
the shell's `PATH` needs one more step: the root `package.json` lists `cockpitd` as a
devDependency precisely so `pnpm install` links the `bin` into the root `node_modules/.bin`, which
makes `pnpm exec cockpit add …` work too. A `cockpit` reachable outside the checkout entirely (e.g.
from a project directory with no relation to this repo) needs a real global link:
`pnpm --filter cockpitd exec pnpm link --global`.

It talks to the daemon over the same loopback API and reports
`daemon is not running — start it with \`pnpm start\`` if nothing is listening, or a timeout message
if the daemon accepted the connection but never answered within 10s. It reads `COCKPIT_PORT` to find
the daemon.

```sh
# 2. The UI: the left rail has an add-project form.

# 3. The API directly:
curl -s localhost:4177/api/projects \
  -H 'content-type: application/json' \
  -d '{"name":"ai-interview-assistant","repoPath":"/Users/you/Desktop/ai-interview-assistant"}'
```

The response carries the project's `id` — keep it, it is what `POST /api/runs` needs. Cockpit stores
the git **root** it resolved from `repoPath`, not the path you typed, because a run's worktree
branches off the root. A path that is not inside a git repository is refused with
`400 {"error":"not a git repository"}`.

A project without a `.cockpit/` directory is not an error: it runs on the core templates alone. A
`.cockpit/` that exists but fails to load *is* an error, and the run fails with the loader's reason.

### Starting a run

```sh
curl -s localhost:4177/api/runs \
  -H 'content-type: application/json' \
  -d '{"projectId":"<id>","prompt":"<what to change>"}'
```

The run executes in `~/.cockpit/worktrees/<projectId>/<runId>` on branch `cockpit/run-<runId>`,
branched from the project's `HEAD` at that moment. **A dirty working tree in the project is neither
copied nor touched**, so a prompt must name code that is committed.
