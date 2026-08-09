# Adding a project — from a fresh machine to the first run

The shortest path from "I have a repository" to "Cockpit runs tasks against it". Details for every
step live in [`setup.md`](setup.md); this page is the order to do them in.

Two facts shape everything below:

- **Repositories stay independent.** Cockpit never links repositories to each other and knows
  nothing about GitHub. The harness is one repo (the tool); each work project is its own repo. A
  registered project is just a pointer to a **local absolute path**, stored in the machine-local
  SQLite at `~/.cockpit/cockpit.db`.
- **Registration is per machine.** `~/.cockpit/` (the journal, run history, artifacts, worktrees,
  insights) never travels through git — by design. On a new machine you register the project again;
  that is one command, not a migration.

## 1. New machine: install the harness once

Prerequisites (full table in [`setup.md`](setup.md)): Node ≥ 22, pnpm 11.17.0, git, the `claude`
CLI logged in on your own subscription (`codex` only if blocks use it; `herdr`/Ghostty optional,
terminal handoff only). No API keys exist or are needed.

```sh
git clone <your-harness-url> cockpit-harness
cd cockpit-harness
pnpm install
pnpm start        # builds everything, serves the UI at http://127.0.0.1:4177
```

## 2. Register the project

The project must already be a git repository on this machine. Three equivalent ways:

```sh
# CLI — from inside the project (path defaults to cwd, name to its basename):
pnpm --dir /path/to/cockpit-harness cockpit add
# or from anywhere in the harness checkout:
pnpm cockpit add /path/to/project --name my-project
pnpm cockpit projects            # verify

# UI — the add-project form in the left rail.

# API:
curl -s localhost:4177/api/projects \
  -H 'content-type: application/json' \
  -d '{"name":"my-project","repoPath":"/path/to/project"}'
```

Cockpit stores the git **root** it resolves from the path, not the path you typed. A path outside a
git repository is refused with `400 {"error":"not a git repository"}`.

## 3. Decide on the cartridge

A project **without** `.cockpit/` is not an error — it runs on the core templates alone. Add a
cartridge only when the project needs its own blocks, prompts, templates or rules.

- **Commit `.cockpit/` into the project's repository.** It is plain TypeScript owned by the project;
  committed, it travels to every machine with `git clone` and nothing needs copying by hand. (If it
  is gitignored, you carry it to each machine yourself.)
- **Recreate the kit symlink on every machine.** `@cockpit/cartridge-kit` is unpublished, so the
  cartridge reaches it through a relative symlink into the harness checkout — which is why the
  symlink depends on your directory layout and cannot be committed usefully:

```sh
cd <project>/.cockpit
mkdir -p node_modules/@cockpit
ln -s ../../../../cockpit-harness/packages/cartridge-kit node_modules/@cockpit/cartridge-kit
npx tsc -p tsconfig.json         # type-check the cartridge against the kit
```

Adjust the `../` depth to where the harness checkout actually is. Keeping the same folder layout on
every machine (e.g. both checkouts side by side) is the one piece of planning that pays off.

The daemon watches `.cockpit/` and reloads it on the next run — no build, no restart. The full
cartridge layout and `defineCartridge` reference are in
[`setup.md` → Giving a project a cartridge](setup.md#giving-a-project-a-cartridge).

## 4. First run

Commit your work first: a run branches from the project's `HEAD` into
`~/.cockpit/worktrees/<projectId>/<runId>` — **a dirty working tree is neither copied nor touched**,
so the prompt must name code that is committed.

Then type a prompt in the UI (attach screenshots or files if the task needs them), or:

```sh
curl -s localhost:4177/api/runs \
  -H 'content-type: application/json' \
  -d '{"projectId":"<id from step 2>","prompt":"<what to change>"}'
```

The run plans, parks at `awaiting-start`, and waits for you to press **Run**.

## What transfers between machines, what does not

| | Travels via git | Per machine |
|---|---|---|
| Harness code | ✓ (its repo) | |
| Project code | ✓ (its repo) | |
| Cartridge `.cockpit/` | ✓ if committed | kit symlink |
| Project registration | | ✓ (`cockpit add`) |
| Run history, artifacts, worktrees, insights | | ✓ (`~/.cockpit/`, stays local) |
