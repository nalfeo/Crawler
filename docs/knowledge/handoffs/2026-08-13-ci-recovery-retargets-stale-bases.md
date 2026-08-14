# Handoff — CI recovery retargets stale bases

## Systems touched

ci-policy

## Summary

- CI Recovery now discovers every open PR, while keeping normal merge-train recovery eligibility restricted to PRs based on `main`.
- A non-`main` PR is retargeted only when its base PR is no longer open and its base ref is deleted, matches a merged base PR tip, or is fully contained in `main`.
- Retargets use the existing owner-scoped mutation token, write an idempotent managed explanation comment, wait for GitHub to resolve mergeability, and dispatch existing reconcile/rebase recovery with expected head/base metadata.
- Branch lookup failures are logged per PR and do not abandon the remaining sweep.

## Apples

- Estimated: 3🍎
- Actual: 3🍎

## Validation

- `node --test .github/scripts/ci-recovery/router.test.mjs`
- `npm run verify:fast`

## Notes

- This would remediate PR #2863's verified state: its surviving base branch matches the merged base PR tip, so it is retargeted to `main`; once GitHub resolves the refreshed diff, existing conflict-only rebase recovery handles the squash-merge divergence.
