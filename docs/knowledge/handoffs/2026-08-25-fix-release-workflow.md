# Handoff: Fix release workflow issue deduplication

## Date

2026-08-25

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3🍎 estimated, 3🍎 actual.

## Summary

Fixed Floor 1 release-loss issue filing so recurring failures with the same
sweep configuration do not create duplicate bugs. Configuration matching now
ignores only the failed seed while retaining weapon and all other sweep
settings. An existing managed open issue receives a recurrence comment and is
left as the canonical tracker; new configurations still create and intake a
new issue.

## Files touched

- `.github/scripts/baseline-regression-issue.mjs`
- `.github/scripts/baseline-regression-issue.test.mjs`

## Verification

- `node --test .github/scripts/baseline-regression-issue.test.mjs` — passed, 10 tests.
- `npx vitest run --project unit tests/unit/baseline-regression-check.test.ts --reporter=dot` — passed, 14 tests.
- `npm run verify:fast` — passed.

## Unresolved issues

None known.
