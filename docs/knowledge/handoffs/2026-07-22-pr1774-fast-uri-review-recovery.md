# Handoff: PR #1774 fast-uri review recovery

## Date

2026-07-22

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2 apples, actual 2 apples. This stayed a narrow tooling/security
recovery across the audit wrapper, its node-test coverage, and the CI guard-test
entrypoint.

## Outcome

- Moved malformed-severity blocking ahead of ignored-package suppression in
  `scripts/agent/security/npm-audit.mjs`, so an excepted `fast-uri` advisory with
  `null`, array, unknown, or missing severity now still fails closed.
- Added a regression test for the exact previously-missed case: the excepted
  `fast-uri` advisory with `severity: null`.
- Added `scripts/agent/security/*.test.mjs` to `npm run test:guards` so the
  audit-wrapper node tests run in CI.

## Validation

- `node --test scripts/agent/security/npm-audit.test.mjs` ✅
- `npm run security:audit` ✅
- `npm run verify:fast` ❌ local environment missing installed dev dependencies
  (`typescript`, `@eslint/js`, etc.) after fetch; verifier now resolves the merge
  base but cannot complete static checks in this sandbox.
- `npm run test:guards` ❌ same local dependency gap (`playwright`, `zod`,
  `yaml`) prevented unrelated pre-existing guard suites from loading.

## Follow-up

Re-run `npm run verify:fast` and `npm run test:guards` in a workspace with the
full cached `node_modules` set (or in CI) to confirm the broader guard suites
after this repair lands on the branch.
