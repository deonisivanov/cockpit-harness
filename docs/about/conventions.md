# Conventions

The rules below are what this repository actually enforces — from `CLAUDE.md` and from the practice
every phase was reviewed against.

## Language

**Everything is English**: code, identifiers, filenames, comments, UI strings, commit messages,
documentation. The owner's own conversations happen in Russian; nothing written into the repository
does.

## Comments

A comment earns its place only when it explains a non-obvious **why** — an invariant, a workaround, a
subtle constraint, a decision whose alternative looks more sensible than it is. Not what the next
line does, not where the code came from, not why the change is correct.

Rejected outright: banner comments, restated types, docblocks on self-evident functions, TODO
placeholders, and any comment addressed to a reviewer rather than to the next reader.

The house style is a compact prose sentence stating the trap. From `Journal.ts`:

> Journal-first: the row change and its event commit together, and the event reaches subscribers only
> once that transaction is durable. A caller's own transaction would demote this one to a savepoint —
> publishing an event the outer rollback then erases — so nesting is refused rather than silently
> breaking the invariant.

There is one dedicated marker. A deliberate simplification with a known ceiling is tagged
`ponytail:` and names both the ceiling and the upgrade path, so the shortcut is tracked instead of
forgotten:

```ts
// ponytail: one lock across every worktree. Parallel branches of a run share one worktree and
// git serializes on .git/index.lock regardless; make it per-worktree if runs ever overlap.
```

## Effect-native style

- Every service is a `Context.Tag` class with a `Live` `Layer`. Composition happens in
  `packages/core/src/index.ts` (`KernelLive` → `EngineLive` → `PlanningLive` → `ContinuityLive` →
  `RetrospectiveLive`) and is assembled once in `apps/cockpitd/src/main.ts`.
- Every failure is one of the tagged errors in `errors.ts`. **No untyped throws.** Where third-party
  code can throw, it is wrapped in `Effect.try` / `Effect.tryPromise` with an explicit `catch` that
  produces a tagged error.
- Every boundary is `Schema`-validated: HTTP bodies, journal payloads, cartridge configs, analyzer
  decisions, retrospective reports, the persisted workflow tree. Artifacts are **decoded, not cast** —
  a truncated file must read as "nothing there", never as a structure with holes in it.
- Every resource is `Scope`d. Child processes are acquired as scoped resources whose finalizer kills
  the whole process group.
- `Effect.runPromise` appears only at the process entry point and in tests.
- Configuration is `Config.string` / `Config.integer` with a default, never a raw `process.env` read.

## The journal-first invariant

This is the one rule nothing may bend:

1. The row change and its event are written in **one** SQLite transaction.
2. The event is published to the `EventBus` **only after that transaction commits**.
3. A journal write may **not** run inside a caller's transaction — nesting would demote it to a
   savepoint, so the outer rollback would erase an event that was already published. `Journal.commit`
   refuses this explicitly.
4. Publish order equals `seq` order, kept so by a semaphore around the write.
5. Every state transition is guarded: `startRun` requires `created`, `finishRun` requires `running`
   with no open children, `resumeRun` requires `interrupted` or `failed`, and so on. The log cannot
   narrate a state the tables never took.

The corollary is idempotence at the boundaries: any effect outside the journal (a git commit, a
branch move, a terminal handoff) is either recorded before it is reported outward or made safe to
re-attempt. Finalize, for instance, answers with its journaled `RunFinalized` rather than refusing
when it re-enters and finds the branch already at its own commit.

## Tests

- **A regression test for every fix, a test for every new behaviour.** No exceptions.
- Tests live in `packages/core/test/`, `apps/cockpitd/test/`, and next to the source in
  `apps/ui/src/*.test.ts(x)`.
- Nothing in the suite spends provider time. The engine is exercised through
  `packages/core/test/fake-provider.mjs`; the parsers are pinned to recorded fixtures; herdr and
  Ghostty have their own fakes.
- Crash behaviour is tested with a real `SIGKILL` of a child-process engine
  (`test/recovery.test.ts`, `test/resume.test.ts`), not with a simulation.

## Commits and review

- **Conventional Commits**, logically scoped.
- **Never commit, push or tag without the owner's explicit permission.** This is not a style
  preference.
- After every finished unit of work that changed code — a whole feature, or a plan stage finished end
  to end — two reviewers run **in parallel, in fresh contexts, scoped strictly to that unit's diff**:
  one for correctness and quality, one for AI slop. Never review inside a unit. Commit the unit first
  and point the reviewer at `--base HEAD~1`, so it sees one increment against a quiet tree. Never run
  tests or builds while a reviewer is running. Findings are classified Critical / High / Medium / Low;
  every valid one is fixed and the affected tests re-run. The unit is done only when the review is
  clean.

## Dependencies

**Owner approval is required before adding or updating any dependency.** The preference order is:
platform or standard API → an already-installed dependency → a new proven library → custom code. Check
current documentation (via Context7) before choosing one; never answer a library API question from
memory. Versions are pinned exactly — no ranges — and the pinned set is recorded in `PROJECT_STATUS.md`.

## How to add things

### A new core service

1. One file in `packages/core/src/`, named after the service.
2. A `Context.Tag` class plus a `Live` `Layer` in the same file.
3. Its failures go through an existing tagged error, or a new one added to `errors.ts`.
4. Wire it into the right bundle in `index.ts` and re-export it from there.
5. A suite in `packages/core/test/`, using the layer helpers in `test/helpers.ts`.

### A new block kind

Think twice. `BlockKind` is `"agent" | "command" | "workspace"`, and adding a fourth touches the
schema, the validator's per-kind rules (including the declared-output check against what that kind can
actually produce), the engine's dispatch, the journal's `BlockKind` literal, and the UI's mirrored
type in `apps/ui/src/model.ts`. `workspace` exists because `finalize` genuinely executes natively
rather than through a provider or a shell; a new kind needs an equally structural reason.

### A new cartridge

Copy the shape of the pilot at `~/Desktop/ai-interview-assistant/.cockpit/` — it is the worked
example of every rule:

- **`cockpit.config.ts` is assembly only**: imports plus one `defineCartridge` call.
- **One file per block** under `blocks/`, with a shared helper for the repetitive ones
  (`commandBlock(id, title, command, timeoutMs)`).
- **Prompts are Markdown** under `prompts/`, referenced by `promptFile: "./prompts/implement.md"`.
  The path resolves against `.cockpit`, and Core does the reading — a cartridge performs no IO at load
  time. Declaring both `promptFile` and `promptTemplate` is refused by the schema.
- **One file per template** under `templates/`, each with a `description` written for the Analyzer to
  choose by, `optionalBlocks` whose `hint` says when to drop each one, and `retryBounds` for what the
  Analyzer may tune.
- **`transforms.ts`** holds pure `(tree, context) => tree` functions. The pilot's `append-lint` inserts
  the two cheap gates *ahead of* finalize, on the grounds that a gate running after the result reached
  the branch is not a gate.
- **`validators.ts`** holds `(tree, context) => ValidationError[]`. The pilot's `no-filtered-checks`
  refuses a verification command piped, chained or redirected in a way that hides its exit code — and
  scans only argv that actually reaches a shell, so a literal `|` in a non-shell argument means
  nothing.
- **`policies.ts`** overrides core retry policies by id; that override is deliberate, unlike block ids,
  which may not collide with core's.
- **`rules`** is free-form data injected into the Analyzer's prompt: the project's non-negotiables.
- **`model` and `effort`** sit on a block, or on a node's `overrides` where they win: a cheap gate need
  not run on the model that writes the code, and `analyzer: { provider, model, effort }` says the same
  about planning. Naming neither spawns the CLI with no flag at all, as before. Model names are
  unchecked beyond being non-empty — a wrong one fails at the CLI more clearly than a schema could.

### A new API route

1. Add the handler to `apps/cockpitd/src/api.ts` as an `Effect` closing over the services it needs, and
   add those services to the `ApiServices` union.
2. Validate the body with `HttpServerRequest.schemaBodyJson(<Schema>)`. Query parameters go through
   `intParam` / `single`, which clamp rather than trust.
3. Wrap the handler in `respond(...)` so failures answer as JSON, and use `problem(status, error,
   detail)` for the deliberate ones. Keep the existing status conventions: `404` unknown, `409` wrong
   state, `413` too large, `502` an external tool failed, `500` ours.
4. Register it in `apiRoutes`. The `localOnly` Host guard applies automatically; a WebSocket route also
   needs its own `Origin` check, since sockets are exempt from CORS.
5. A test in `apps/cockpitd/test/`.

### A new event type

1. Add a `Schema.TaggedStruct` to the union in `packages/core/src/events.ts` — to `LifecyclePayload`
   only if `Journal` itself emits it under a guarded transition, otherwise to `AncillaryPayload`.
2. Emit it. Ancillary payloads go through `journal.append`; lifecycle ones belong inside the
   `Journal` method that performs the matching row change.
3. Mirror the type in `apps/ui/src/model.ts` (hand-mirrored on purpose, to keep `effect` out of the
   browser bundle).
4. Fold it in the UI: a case in `describe` in `presentation.ts` for its tag, tone and summary; a
   `buildRows` case if it deserves a richer row than a plain event line; `store.ts` only if it changes
   run, block, attempt, gate or question state; the `HIDDEN` set if the other panels already carry it.
5. Consider the consumers that read events rather than rows: `brief.ts`, `Retrospective.ts` and
   `Resume.ts` all fold the journal with the helpers in `events.ts`.

## Anti-patterns rejected in this repository

These were tried and abandoned with evidence. Do not revisit them without new evidence.

| Rejected | Why | What replaced it |
|---|---|---|
| Temporal, or `@effect/workflow` + `@effect/cluster` | Prohibited infra for a local single-user tool; the Effect packages were experimental and still fixing replay bugs | A custom SQLite journal we own (ADR-002) |
| Tauri / Electron / TUI shells | Extra runtime, packaging burden, or insufficient density | Local daemon + browser SPA (ADR-001) |
| Free-form LLM-generated DAGs | The most fragile design point: invalid trees, a validator that must anticipate anything | Templates the Analyzer parameterizes (ADR-003) |
| Resuming the previous attempt's session by default | The agent anchors on failed strategies and accumulates noise | Fresh session + typed failure packet (ADR-004) |
| In-place execution, or a copy/container per run | No isolation, or slow and cache-destroying | Git worktree per run (ADR-005) |
| Subprocess-isolated cartridges with an RPC bridge, or esbuild bundling | Serializing transform functions across a process boundary defeats the design | `jiti` in-process behind a Schema boundary (ADR-007) |
| TypeScript 7 native compiler | Risk to Effect's type-level machinery | TypeScript 5.9.3 |
| `--bare` when recording provider fixtures | Breaks subscription auth | `--setting-sources ""` |
| `-s` on `codex exec resume` | Not accepted by that form | `-c sandbox_mode=…` config override |
| Ordering checkpoints by wall clock | A clock that steps backwards reorders them | `ORDER BY rowid` |
| Plan mode for output-writing blocks | Plan mode withholds `Write`, which such a block must do | `acceptEdits` plus a deny list |
| Finalizing through a temporary worktree | Git refuses to check out a branch that is already checked out | `commit-tree` plumbing, no checkout at all |
| `update-ref` on a checked-out target branch | A silent no-op — HEAD follows the branch, so a later reset has nothing to do | `reset --keep` when it is checked out, CAS `update-ref` otherwise |
| A `file:` dependency for the pilot's kit | The kit declares `workspace:*`, unresolvable outside the workspace | A relative symlink in `.cockpit/node_modules` |
| Editing migration `0001` in place | The migrator keys on the name and ignores the content, so existing databases never see the change | A new migration (`0003`) that rebuilds the tables |
