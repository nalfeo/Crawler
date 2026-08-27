# 2026-08-21 — Merge train async direct-merge recovery

## Systems touched

ci-cd, merge-train

## Summary

Investigated PR #3193 being stuck despite green PR checks. The latest PR head had already fixed the earlier `Lightweight Checks` failure, but scheduled `Merge Train` runs on `main` were failing in `.github/scripts/merge-train/reconcile-lib.mjs` while trying to promote bottom-of-stack PR #3027:

```text
MergeTrainPromotionError: promotion aborted at pr=#3027: merge-async failed: Required status check "merge-train" is expected.
```

Root cause: the bottom-of-stack async merge path submitted GitHub's `merge-async` request with `merge_action: 'default'`. In this repository the custom train, not GitHub's merge queue, owns the required `merge-train` status. `default` let GitHub enforce ordinary required-check behavior for the async operation, so it waited for the train's own not-yet-written check and blocked the train.

## Fix

- Changed `createMergeBottomOfStackPr()` to submit async stacked merges with `merge_action: 'direct_merge'`, matching the custom merge train's trusted App-bypass promotion path instead of GitHub's default merge-queue behavior.
- Added a regression assertion that the async bottom-of-stack request uses `direct_merge`.

## Verification

- `bash scripts/agent/preflight.sh` — passed.
- `node --test .github/scripts/merge-train/reconcile-promotion.test.mjs` — 65 passed.
- `node --test .github/scripts/merge-train/*.test.mjs` — 271 passed.
- `npx eslint .github/scripts/merge-train/reconcile-lib.mjs .github/scripts/merge-train/reconcile-promotion.test.mjs` — passed.
- `npm run verify:fast` — passed.
- `npm run verify:pr-prereqs` — passed.
