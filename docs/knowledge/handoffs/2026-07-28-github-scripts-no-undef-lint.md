# Handoff: Harden .github/scripts with no-undef lint and coordinator recovery-state coverage

## Summary

Added Node-aware `no-undef` ESLint coverage for `.github/scripts/**/*.mjs`, fixed a silent
missing-import bug in the conflict coordinator, and exercised the trusted recovery-state
(shepherd lease) code path that previously had no integration coverage.

## Systems touched

ci-conflict-coordinator, verify-fast, lint

## Files touched

- `eslint.config.js` — new override block for `.github/scripts/*.mjs` with Node globals + no-undef
- `package.json` — `lint`, `lint:cache`, `lint:fix` now include `.github/scripts/`
- `scripts/agent/verify-fast.sh` — `is_linted_mjs_path` (what gets linted locally) vs
  `is_known_mjs_path` (.github/extensions/ and scripts/ accepted but not linted locally; truly
  unsupported locations still rejected)
- `tests/unit/verify-fast-typecheck.test.ts` — acceptance tests for `.github/extensions/` and
  `scripts/` .mjs paths; rejection test updated to truly unsupported location + correct message
- `.github/scripts/ci-conflict-coordinator/reconcile.mjs` — removed unused `whoMustLandFirst` import
- `.github/scripts/ci-conflict-coordinator/reconcile.test.mjs` — shepherd-lease test (enforcement
  enabled, PR1 seeded with ORDER_WAIT so no-removal assertion is non-trivial); plus enforcement-
  disabled and auto-merge-disarmed tests merged from main
- `docs/knowledge/review-ledgers/2026-07-27-github-scripts-no-undef-lint.review-ledger.json` —
  completed code-review loop (2 rounds, clean)

## Verification

- `npm run verify:fast` — all 1787 unit tests pass, lint clean, typecheck clean
- `npx prettier --check tests/unit/verify-fast-typecheck.test.ts` — clean
- `node scripts/agent/review/cli.mjs validate docs/knowledge/review-ledgers/2026-07-27-github-scripts-no-undef-lint.review-ledger.json` — valid 3-apple ledger

## Unresolved issues

None.

## Recommended next steps

None — change is ready to merge once CI passes.
