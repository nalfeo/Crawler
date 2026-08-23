# CI recovery `gh api` repository guardrail

## Systems touched

ci-policy

## Summary

- Replaced review-thread recovery's universal `gh --repo` instruction with
  `GH_REPO`, which also works with `gh api`.
- Require fully qualified `repos/owner/repo/...` endpoints for `gh api` and
  explicitly prohibit its unsupported `--repo` flag.
- Updated focused reconcile coverage for the compatible guidance.

## Validation

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`

## Apples

1🍎 estimated, 1🍎 actual.
