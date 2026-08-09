# Workspace mode — problem brief (sportsbook-projects)

Status: **discussion brief, nothing implemented.** This describes the problem and the required end
state only — deliberately not the solution. Written to be read on another machine, next to the real
`sportsbook-projects` checkout, and turned into a design together. v2-scale work (same tier as the
remote-executor split).

> **⚠️ To the assistant reading this next to the real project: this document is PRELIMINARY and
> second-hand. Do not trust it as ground truth.** It was written far from the actual codebase,
> entirely from the owner's verbal description — the repo layout, the counts, the toolchain
> examples, even the folder tree below are the owner's recollection, not an inspection. Nothing
> here has been verified against the real repositories.
>
> Before designing anything:
> 1. **Inspect the real workspace first** — enumerate the actual repos, their manifests, their
>    real toolchains (which have tests, lint, how they build, how they depend on each other).
>    Where reality contradicts this brief, reality wins and the brief must be corrected.
> 2. **Challenge every assumption and requirement here** — the problem framing, the acceptance
>    scenario, the invariants list. Treat them as hypotheses from one conversation, not settled
>    decisions. If a requirement looks wrong or missing once you see the real code, say so to the
>    owner instead of building on it.
> 3. **Run the design through OMC ralplan** (`/oh-my-claudecode:ralplan`) — the consensus
>    Planner → Architect → Critic loop — with the verified picture of the workspace as input.
>    Let the critics attack this brief's framing too, not just the solution.

## Context

Cockpit v1 is single-repo by construction: a project **is** one git repository, a run owns one
worktree cut from it, checkpoints/salvage/rollback are commits in that worktree, `finalize` lands
onto that repository's branch, and the cartridge is `<repo>/.cockpit/`. Every guarantee the engine
gives — isolation, durable resume, machine-checked success, honest finalize — is anchored to that
one repo's git.

The owner's real environment does not look like that:

```
~/sportsbook-projects/
  mf-header/          # microfrontend, has lint + unit tests
  mf-cart/            # microfrontend, lint only, no tests
  mf-checkout/        # microfrontend, tests only
  ...                 # ~10 microfrontends total
  svc-odds/           # microservice, its own toolchain
  svc-bets/           # microservice, no lint configured
  ...                 # ~10 microbackends/microservices
  shared-ui/          # shared library several MFs depend on
```

Twenty-plus sibling git repositories, one product. The owner's working habit — and the mental model
Cockpit must match — is to run the assistant **from the root folder** and let it figure out which
repositories a task touches. Today that habit is served by a plain `claude`/`codex` session in the
root: full freedom, zero guarantees.

## The problem

1. **A real task rarely fits one repository.** "Add a promo banner to checkout" touches
   `shared-ui`, `mf-checkout`, maybe `svc-odds`. Today Cockpit forces the owner to decompose that
   by hand into N runs, carry the shared design decision into N prompts personally, order the runs
   personally (library first, consumers after), and gets no cross-repo verification at all — each
   run's verify sees only its own worktree.
2. **Routing knowledge lives in the owner's head.** Which of the twenty repos a change touches is
   exactly the kind of judgement the Analyzer exists for, but the Analyzer today wakes up inside
   one already-chosen repo. The choosing step — the first and hardest one — happens before Cockpit
   is even involved.
3. **The repos are heterogeneous.** Some have tests, some do not; some have lint, some do not;
   frontends and services need different blocks entirely. A quality gate that assumes a uniform
   toolchain would either block repos that lack it or silently skip repos that have it. Each repo
   needs its own blocks and checks — while the product-level rules (conventions, review policy,
   commit style) are shared and should be declared once.
4. **The obvious workaround is a trap.** Registering the root folder and letting the agent walk
   into the real checkouts recreates the plain-terminal session with Cockpit's UI on top: no
   worktree isolation (it edits the working copies), no checkpoints, no meaningful resume, nothing
   for finalize to land. Any solution that compromises the isolation model is not a solution.

## Required end state

The acceptance scenario, as the owner should experience it:

1. `~/sportsbook-projects/.cockpit/` exists — **one** root cartridge for the workspace: shared
   rules, routing hints, product-level templates. Individual repos may carry their own
   `.cockpit/` with repo-specific blocks (their lint, their tests, their build), and those
   compose with the root one rather than replacing it.
2. The owner registers the **workspace root** once. Cockpit discovers the member repositories
   itself (and notices new ones appearing later).
3. The owner types one task in one prompt box — phrased at product level, not per-repo.
4. Cockpit plans: it determines which repositories the task touches, what has to happen in each,
   and in what order (dependencies between repos respected — a shared library lands before its
   consumers build against it). The plan is visible as one tree spanning the affected repos, each
   repo's own blocks appearing under it — tests where tests exist, lint where lint exists, neither
   where neither exists, never a gate a repo cannot run.
5. The run **waits**; the owner reviews the tree — including the routing decision — and presses
   Run (or Regenerate, or edits the scope by skipping).
6. Execution keeps every v1 guarantee, now per affected repo: isolated worktrees (the real
   checkouts are never touched), checkpoints and salvage per repo, cross-repo verification that
   can see all the involved worktrees together (integration checks, contract checks between a
   service and its consumers), durable journal, Stop/Skip/Resume behaving exactly as they do
   today.
7. Finalize lands each affected repo's commits onto that repo's branch. A partial landing is an
   explicit, visible outcome — never a silent half-product: the owner must be able to see "3 of 5
   landed, these 2 refused and why" and act on it.
8. Everything is one run in the UI: one stream, one tree (grouped by repo), one journal, one
   retrospective — not five browser tabs to correlate by hand.

## Quality bar

The owner asked for the ideal shape, explicitly not a quick adaptation:

- No compromise on isolation, journal-first durability, or machine-checked success — the workspace
  mode must be as trustworthy as a single-repo run, or it is not worth building.
- Convenient by default: registering a workspace, adding a new microfrontend later, or having no
  per-repo cartridge at all must all "just work" with sensible defaults.
- Understandable: the routing decision is shown and explainable before anything runs; a wrong
  route is fixable by the human (regenerate/skip), not something to fight.
- Honest about heterogeneity: a repo without tests is a fact, not an error — but the run must
  record what was and was not checked, so "green" never overstates itself.

## Invariants that must survive the design

- Engine/cartridge split: the engine learns the *concept* of a workspace; everything
  sportsbook-specific (which repos, which blocks, which rules) stays in cartridges.
- The Analyzer picks and parameterizes from declared options (ADR-003); routing must fit that
  discipline — a declared decision surface, validated, with a fallback — not free-form graph
  authoring.
- Journal-first: every routing decision, per-repo checkpoint, and partial-finalize outcome is an
  event before it is behaviour.
- Existing single-repo projects keep working unchanged.

## Hard questions to settle together (deliberately unanswered here)

1. Routing correctness: what evidence does the router read (dependency manifests, code search,
   an exploratory read-only pass?) and what happens when it routes wrong — how cheap is the
   correction loop?
2. Cross-repo atomicity: five repos, three land, two refuse — what is the recovery story, and is
   there ever a case for "all-or-nothing"?
3. Ordering and contracts between repos: how does the plan express "shared-ui first, consumers
   after, then the contract check across both"?
4. Resume semantics when the interruption falls between repos, and what one worktree-set
   reconcile means on re-entry.
5. Cartridge composition: exact precedence between the root cartridge and a member repo's own
   (blocks, transforms, validators, rules), and what a member without any cartridge inherits.
6. How the UI presents a multi-repo tree without becoming noise — grouping, per-repo status
   rollups, where skip/stop attach.
7. Registration/discovery lifecycle: repos added, moved, archived; a member that is dirty or on
   an unexpected branch at run start.
