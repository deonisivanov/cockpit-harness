# Running, testing and verifying

Every command below is defined in a real `package.json` in this repo. Run them from the repository
root unless stated otherwise.

## Root commands

| Command | What it does |
|---|---|
| `pnpm start` | `pnpm -r build && node apps/cockpitd/dist/main.js` — builds every package, then runs the daemon in the foreground. |
| `pnpm build` | `pnpm -r build` |
| `pnpm lint` | `eslint .` — the flat config at `eslint.config.js`, ignoring `**/dist/**` and `docs/design-prototype/**`. |
| `pnpm test` | `pnpm -r test` — every package's own test script. |
| `pnpm cockpit <cmd>` | `node apps/cockpitd/dist/cli.js` — the small client CLI (`add`, `projects`, `help`) that talks to a running daemon. Needs a build first; also installed as the `cockpit` bin of `apps/cockpitd`. |

## Per-package commands

| Package | Command | What it does |
|---|---|---|
| `packages/core` | `pnpm --filter @cockpit/core build` | `tsc -b tsconfig.json` |
| | `pnpm --filter @cockpit/core test` | `tsc -b ../cartridge-kit/tsconfig.json && tsc -p tsconfig.test.json && vitest run` — the kit build is first on purpose: it is what proves the cartridge-facing types still compile. |
| `apps/cockpitd` | `pnpm --filter cockpitd build` | `tsc -b tsconfig.json` |
| | `pnpm --filter cockpitd test` | `tsc -b tsconfig.json && tsc -p tsconfig.test.json && vitest run` |
| | `pnpm --filter cockpitd start` | `node dist/main.js` (no rebuild) |
| `apps/ui` | `pnpm --filter cockpit-ui dev` | `vite` — dev server with HMR |
| | `pnpm --filter cockpit-ui build` | `tsc --noEmit && vite build` |
| | `pnpm --filter cockpit-ui test` | `vitest run` — the co-located `src/**/*.test.ts(x)` unit tests only; `e2e/` belongs to Playwright |
| | `pnpm --filter cockpit-ui test:e2e` | `playwright test` |
| `packages/cartridge-kit` | `pnpm --filter @cockpit/cartridge-kit build` | `tsc -b tsconfig.json` |
| | `pnpm --filter @cockpit/cartridge-kit test` | `tsc -b tsconfig.json` — type-checking *is* the test for this package |

To run one core suite: `pnpm --filter @cockpit/core exec vitest run test/resume.test.ts`.

## The UI without a daemon

`apps/ui/src/mock.ts` is a complete in-memory `Source`. Append `?mock=<state>` to the dev-server URL
and the SPA renders that state with no daemon running at all:

```sh
pnpm --filter cockpit-ui dev
# then open the URL Vite prints, with ?mock=running appended
```

The ten states are `idle`, `analyzing`, `approval`, `running`, `retry`, `question`, `finished`,
`cancelled`, `recovery`, `insights`. `recovery` shows an interrupted run with its Resume button;
`insights` opens the retrospective view directly.

## Playwright

`apps/ui/playwright.config.ts` runs Chromium at 1600×980 against `http://localhost:4173`, and its
`webServer` block builds the SPA and serves it with `vite preview --strictPort` — so `test:e2e` needs
no daemon either, only the mock harness. `apps/ui/e2e/` holds `smoke.spec.ts`, `insights.spec.ts` and
`screenshots.spec.ts`; the last one writes into `apps/ui/screenshots/`.

## Refreshing the provider fixtures

`packages/core/test/fixtures/claude-stream.jsonl` and `codex-stream.jsonl` are real recordings that
pin the two stream parsers. Re-record them after a CLI upgrade:

```sh
./scripts/refresh-fixtures.sh
```

It prints both CLI versions, records a trivial prompt from each with the recorder's own settings,
hooks, plugins and MCP servers suppressed (`--setting-sources ""`, `--strict-mcp-config`,
`--ignore-user-config`), and only replaces a committed fixture once the CLI exited clean. Review the
diff before committing. The recordings currently pin `claude 2.1.224` and `codex 0.146.0`.

## Verifying a running daemon

```sh
curl -s localhost:4177/healthz     # {"status":"ok"}
```

Expect these four lines on boot:

```
journal ready (migrations applied: N)
recovery scan: N interrupted run(s) marked, none resumed
cockpitd core v0.0.0
Listening on http://127.0.0.1:4177
```

The journal and recovery lines come from layers built underneath the HTTP server, so migrations and
the recovery scan have both finished before the first request can be served. `migrations applied`
counts the migrations *this boot* ran — `3` on a fresh `COCKPIT_HOME`, `0` on an up-to-date one. The
recovery line always ends `none resumed`: the scan marks only.

Useful reads against a live daemon:

```sh
curl -s localhost:4177/api/projects
curl -s "localhost:4177/api/runs/$RUN/events?from=0&limit=500"
curl -s localhost:4177/api/artifacts/<artifactId>/raw
```

Note that every request must carry a loopback `Host` header — `localhost`, `127.0.0.1` or `[::1]`.
Anything else is answered with `403 forbidden`.

## Smoking a run end to end without spending tokens

`packages/core/test/fake-provider.mjs` is a scripted stand-in for both provider CLIs. It answers
`--version` with `9.9.9 (fake provider)` so preflight passes, emits real stream-json or JSONL
depending on which flags it was called with, and writes whatever the script tells it to
`$COCKPIT_OUTPUT`. The engine suites select it exactly the way you would by hand — by pointing
`COCKPIT_CLAUDE_BIN` and `COCKPIT_CODEX_BIN` at its absolute path — so the adapters keep using their
real spawn, stream, parse and kill paths.

```sh
# 1. A script keyed by block definition id, optionally by attempt: "<defId>:<nth call>".
cat > /tmp/fake-script.json <<'JSON'
{
  "analyzer": { "output": { "templateId": "quickfix", "rationale": "small change" } },
  "agent-task": { "output": { "summary": "edited the file" }, "writes": { "note.txt": "hello\n" } },
  "verify-output": { "output": { "passed": true, "findings": [] } }
}
JSON

# 2. An isolated home, so nothing touches the real journal or worktrees.
export COCKPIT_HOME=$(mktemp -d)
export COCKPIT_CLAUDE_BIN=$PWD/packages/core/test/fake-provider.mjs
export COCKPIT_CODEX_BIN=$PWD/packages/core/test/fake-provider.mjs
export COCKPIT_FAKE_SCRIPT=/tmp/fake-script.json

# 3. Run the daemon, register a git repository, start a run, watch the journal.
node apps/cockpitd/dist/main.js
```

A `FakeStep` in that script may carry `output`, `text`, `isError`, `stderr`, `delayMs`, `hang`,
`writes`, `question`, `echoPrompt`, `exitCode`, `failResume` or `symlinkOutputTo` — which is how the
suites reproduce a semantic failure, a headless question, a crash, a hang, and a session the CLI has
lost. The same idea covers herdr and Ghostty: `COCKPIT_HERDR_BIN` and `COCKPIT_OPEN_BIN` can point at
`fake-herdr.mjs` and `fake-open.mjs`, which log every invocation instead of opening a window.

For the full owner-driven acceptance run against the real pilot project — the one that spends real
provider time — `docs/acceptance-plan.md` is the runnable checklist, mapping each of the plan's §17
criteria to the exact command or click that decides it.

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on every pull request, with in-progress runs
of the same ref cancelled. One `ubuntu-latest` job:

```yaml
- uses: actions/checkout@v4
- uses: pnpm/action-setup@v4
- uses: actions/setup-node@v4      # node-version: 22, cache: pnpm
- run: pnpm install --frozen-lockfile
- run: pnpm lint
- run: pnpm -r test
- run: pnpm -r build
```

Note what CI does **not** do: it never runs Playwright, and it never spends provider time. Every
engine test runs against the fake provider or a recorded fixture, which is what keeps the suite
tokenless.
