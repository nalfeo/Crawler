# Emergency brace-expansion audit exception

## Date

2026-07-24

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2 apples, actual 2 apples (exact). This was a focused security-gate exception and regression-test update.

## Outcome

- Added a temporary exception for only `brace-expansion` advisory
  `GHSA-mh99-v99m-4gvg` (`source: 1124334`).
- The exception expires after 2026-07-31. On 2026-08-01, the audit gate fails
  closed until a patched release is available.
- Findings derived solely from the exact advisory are suppressed; mixed chains,
  unrelated advisories, and malformed findings continue to block.
- The emergency commit was intended for direct delivery to `main` so blocked
  pull requests could rebase immediately.

## Validation

- `node --test scripts/agent/security/npm-audit.test.mjs` passed all 13 tests.
- `npm run security:audit` passed and reported only the dated exception.
- `npm run verify:fast` could not run because dependency restore is blocked by
  the mandatory proxy returning 404 for the `postcss@8.5.23` lockfile tarball.

## Follow-up

Remove the exception and upgrade `brace-expansion` as soon as a patched release
is available, no later than the exception expiry.
