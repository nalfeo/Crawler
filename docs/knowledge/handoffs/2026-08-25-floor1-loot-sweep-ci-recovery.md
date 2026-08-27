# Handoff: Floor 1 loot sweep CI recovery

## Systems touched

ai-behavior-tree, loot-and-drops

## Persona

QA Engineer / Game AI Engineer

## Apples

3🍎 estimated, 3🍎 actual (🎯 exact) — PR recovery touched runtime AI comments, deterministic regression tests, CI fixture repair, and review-ledger completion.

## Summary

Recovered PR #3528 after the Integration Tests job failed in `tests/integration/floor2-collapse-panic-exit.test.ts`. The original test still expected an early pre-exit loot sweep on a cross-map gold pile, but the PR intentionally bounds pre-exit sweeps to `scanRadius`, so the fixture now places the early-run gold target near the player while keeping the exit stairs in a separate room.

Also tightened the pre-exit scan-radius coverage requested during review: `tests/unit/ai/bt-loot-sweep.test.ts` now covers an enemy outside engage range but inside `scanRadius` during the pre-exit window, and comments no longer describe the pre-exit chase as unbounded.

## Verification

- GitHub Actions failing job logs fetched for `Integration Tests` job `97642925111`; failure was `expected 'Heading to the Floor 2 exit stairs' to contain 'Loot sweep'` at `tests/integration/floor2-collapse-panic-exit.test.ts:126`.
- `npm run test:integration -- tests/integration/floor2-collapse-panic-exit.test.ts`: passed after fixture repair.
- `npm test -- tests/unit/ai/bt-loot-sweep.test.ts`: passed after adding the pre-exit scan-radius threat regression.
- `npm run verify:fast`: passed before the follow-up review-test cleanup; rerun pending after final ledger/handoff updates.

## Key decisions

- Kept the production `scanRadius` target bound intact; the CI repair was a test-fixture update, not a gameplay relaxation.
- Lowered the Floor 2 fixture anchor guard from three rooms to two because the gold target is now deliberately near the player.
- Merged `origin/main` locally after unshallowing so review-grade diffs compare against the current base and do not include already-merged main work.

## Next steps

- Run final `verify:fast`, `verify:pr-prereqs`, code review, and CodeQL after the ledger is re-graded against the final head.
- Do not rebuild `docs/knowledge/handoffs/INDEX.md`; CI owns that generated index.

## Retrospective

### Lessons learned

When a production fix converts an intentionally broad behavior into a bounded one, any integration fixture that relied on broad placement must be re-centered inside the new bound while preserving the behavior being asserted.

### Mistakes made

The first independent-grade prompt ran before merging current `origin/main`, so it incorrectly graded duplicate already-merged commits as part of the PR scope.

### Opportunities for future improvement

The review-grade prompt could surface a warning when the branch contains duplicate patch-equivalent commits from current `origin/main`, since that usually means the PR branch needs a main merge before grading.
