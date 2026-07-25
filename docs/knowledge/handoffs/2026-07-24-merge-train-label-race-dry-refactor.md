# Sprite-queue reconciler: DRY the merge-train label re-ensure logic + race-path test

## Systems touched: sprite-pipeline, sprite-workflow

## Apples

Estimated: 1🍎 (Trivial) — actual: 1🍎. Pure internal refactor of one already-merged
file plus one added regression test; no behavior change. Per
`docs/agent-os/policies/complexity-policy.md`, 1🍎 requires no review stages and no
`apples:record` entry. A tier-only review ledger was still initialized/validated:
`docs/knowledge/review-ledgers/2026-07-24-merge-train-label-race-dry-refactor.review-ledger.json`.

## Context

Direct follow-up to #1925 (merged to `main` as
`7380e3e71592ffa6a33f9eb0882614263b617da0`), which fixed the merge-train label
enrollment gap in `scripts/sprites/reconcile-queue.ts` (see
`docs/knowledge/handoffs/2026-07-24-sprite-queue-reconciler-label-fix.md`).

While #1925 was still open, an automated PR reviewer correctly flagged that the
create-race fallback path (the `else` branch after `gh pr create` fails, where a
re-query finds a PR opened by a concurrent writer) did not re-ensure the
`merge-train` label the same way the main update path did — a race could leave a
promote PR unlabeled and blocked-forever, reproducing the exact bug #1925 fixed.

**Both this session and the cloud coding agent (auto-assigned per the CI Recovery
policy in `AGENTS.md`) fixed this independently in parallel** while #1925 was open.
The cloud agent's fix (`596204eaa`, inline duplication of the exclusion check) landed
first and was squash-merged into `main` as part of #1925 — the bug is fully fixed on
`main` already. This follow-up is pure cleanup on top of that already-merged fix:

1. Extract `hasMergeTrainExcludeLabel(labels)` and
   `reEnsureMergeTrainLabel(exec, repoRoot, repo, pr)` helpers so the normal update
   path and the create-race fallback path share one implementation instead of
   duplicating the exclusion-check-then-`--add-label` logic inline in two places.
2. Add a regression test: a create-race-recovered PR that already carries
   `merge-train-blocked` must NOT be re-labeled `merge-train`. This exact skip case
   was previously only covered on the normal update path (tests `(k)`/`(l)`), not on
   the create-race fallback path — a genuine coverage gap since the two paths now
   share logic but weren't both exercised for the skip behavior.

No functional/behavioral change; `main`'s bug-fix behavior is unchanged.

## Verification

- Standalone `tsc --noEmit --strict` (scratch project with `typescript@5.7`,
  `@types/node@22`) on `scripts/sprites/reconcile-queue.ts`: 0 errors.
- The same scratch `tsc` check on
  `tests/unit/sprites/reconcile-queue.test.ts` hits the expected `vitest`
  module-not-found because `vitest` types are not installed in the standalone
  scratch project; full repo/CI typecheck remains authoritative for the test
  file.
- `prettier --config .prettierrc --write` on both files: no changes needed.
- Local `npm ci`/`vitest` continues to hit the known MS-proxy `E404` issue
  documented in PR2's and #1925's handoffs (pre-existing, out of scope). Worked
  around it again with the same technique: scratch npm install of
  `vitest@4.1.8` (version-matched to the repo's pinned `^4.1.8` — v2 silently
  ignores the `test.projects` config key), then a temporary Windows directory
  junction swapping the repo's `node_modules` for the scratch install to run
  `vitest run --project sprites tests/unit/sprites/reconcile-queue.test.ts`
  against the repo's real `vitest.config.ts` — **32/32 tests passed** (28
  pre-existing + 4 new from #1925's own change), with `node_modules` restored
  immediately after each run.
- CI is authoritative for `npm run typecheck` (whole-project) and `npm run lint`
  (full eslint plugin graph) per PR2/#1925 precedent.

## Branch reconciliation note

This session originally pushed the DRY refactor directly onto the
`nalfeo-friendly-succotash` branch backing #1925, but #1925 merged (via the
cloud agent's parallel fix) before that push landed, so the extra commit was
orphaned on the now-closed branch. This handoff's PR resets that branch to
`origin/main` and carries forward only the DRY-refactor diff as a single new
commit, avoiding any merge-commit noise from the already-landed fix.

## Follow-ups

None. This is the pending terminal cleanup for the merge-train label enrollment
gap; #1925 (parent fix) is merged, and this PR (DRY + test) is open and ready
to merge.
