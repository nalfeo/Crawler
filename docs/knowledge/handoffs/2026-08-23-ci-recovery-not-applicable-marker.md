# CI recovery Not applicable marker hardening

## Systems touched

ci-policy

## Summary

- Fixed the remaining CI-recovery task-comment examples that rendered
  `✅ Not applicable: <one-line reason>` with an empty reason on GitHub.
- Replaced their HTML-like placeholder with `[one-line reason]` and updated both
  reconcile regression assertions.

## Validation

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` (pass)
- `npm run verify:fast` (pass)

## Apples

1🍎 estimated, 1🍎 actual.
