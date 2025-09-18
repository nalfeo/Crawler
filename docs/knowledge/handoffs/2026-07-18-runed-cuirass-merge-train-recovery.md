# Handoff: runed-cuirass merge-train recovery

## Date

2026-07-18

## Persona

Producer

## Systems touched

inventory

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

Recovered PR #1464 from a merge-train-only unit-test failure by replacing the
brittle global item-catalog length snapshot with a direct `runed-cuirass`
catalog assertion that composes with other queued item PRs.

## Files touched

- `tests/unit/items.test.ts`
- `docs/knowledge/handoffs/2026-07-18-runed-cuirass-merge-train-recovery.md`
- `docs/knowledge/review-ledgers/2026-07-18-runed-cuirass-merge-train-recovery.review-ledger.json`

## What changed

- Diagnosed merge-train validation run `29657256693` and isolated the sole
  failing job: `Candidate unit tests (1/3)`.
- Traced the failure to `tests/unit/items.test.ts`, where the exact
  `ITEM_CATALOG.length === 131` snapshot failed in the candidate prefix because
  another queued item PR raised the combined catalog length to `132`.
- Replaced that global-count snapshot with a direct assertion that
  `runed-cuirass` exists as rare, non-stackable `Gear`, preserving coverage for
  this PR’s actual behavior without coupling the branch to unrelated queued item
  additions.

## Observe before done

- Before: merge-train candidate validation failed with
  `expected ... to have a length of 131 but got 132` in
  `tests/unit/items.test.ts`.
- After: the exact failing shard command
  `npx vitest run --project unit --shard=1/3 --reporter=dot` passes cleanly on
  this branch, along with the repo’s fast verification and PR prereq gates.

## Verification run

- `npx vitest run tests/unit/items.test.ts`
- `npx vitest run --project unit --shard=1/3 --reporter=dot`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-18-runed-cuirass-merge-train-recovery.review-ledger.json`
- `npm run verify:pr-prereqs`
- `parallel_validation`

## Recommended next steps

- Push this recovery commit so merge-train and PR CI can rerun on the repaired
  branch head.
