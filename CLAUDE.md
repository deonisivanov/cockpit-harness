# CLAUDE.md

## Working rules

- Read the relevant docs and existing implementation before editing.
- Preserve unrelated user changes and intended behavior.
- Add a regression test for every fix and a test for every new behavior.
- Write as few comments as possible. A comment earns its place only when it explains a non-obvious *why* — an invariant, a workaround, a subtle constraint. No restating code, no banners, no TODO placeholders, no docblocks on self-evident functions.
- Before finishing, re-read the diff and delete slop: filler comments, dead defensive branches, one-implementation interfaces, unused config knobs, restated types, verbose names, duplicated helpers, "for future use" scaffolding.
- Conventional Commits, logically scoped. Never commit, push or tag without explicit permission.
- Everything must be in English

## Dependencies

Prefer DX: a proven library beats hand-rolled infrastructure. Order: platform/standard API →
already-installed dependency → new proven library → custom code. Check current docs with Context7
before choosing one. **Owner approval is required before adding or updating any dependency.**
Dependencies must respect package boundaries, secret isolation, and bundle size.

## Tooling

- **Ponytail** — always on. Climb the ladder, ship the laziest solution that actually works.
- **OMC** — delegate multi-file changes, refactors, debugging, planning, and the review pass where it pays off.
- **Context7** — use for any library, framework, SDK, or CLI question. Never answer library API details from memory.

## Review: after every finished unit of work

A unit is a whole feature, or a plan stage finished end to end, that changed code — docs-, config-
or comment-only work skips the pass. Never review inside a unit. Run the reviews in parallel, each
in a fresh context, each scoped strictly to that unit's diff:

- `oh-my-claudecode:code-reviewer` — correctness and quality.
- `oh-my-claudecode:ai-slop-cleaner` in reviewer-only mode — AI slop.

Commit the unit first and point Codex at `--base HEAD~1` — one increment against a quiet tree. Never
run tests or builds while a reviewer is running; two suites on one machine is what makes them fail.

Capped at 30 minutes. Watch the runs: a stalled or idle reviewer is killed, then re-run once on a
narrower scope or reported as skipped. Classify findings Critical / High / Medium / Low, fix every
valid one, rerun affected tests and gates. Claim the unit done only when the review is clean.
