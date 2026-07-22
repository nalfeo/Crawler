# Temporary fast-uri proxy compatibility exception

## Date

2026-07-22

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2 apples, actual 2 apples. The change required a lockfile rollback plus
an advisory-specific, fail-closed audit filter.

## Outcome

- Downgraded the dev-only `fast-uri` lock entry from `3.1.4` to proxy-available
  `3.1.3` so clean installs work through the mandatory Microsoft npm proxy.
- Added a temporary exception for only `GHSA-v2hh-gcrm-f6hx` and findings derived
  solely from that advisory.
- The exception expires after 2026-07-29. On expiry, the audit gate fails until
  `fast-uri` is upgraded to a fixed release.
- Unrelated advisories, mixed dependency chains, and malformed audit output
  continue to fail closed.

## Validation

- Clean `npm ci --prefer-offline` completed through the Microsoft proxy.
- `node --test scripts/agent/security/npm-audit.test.mjs` passed 4 tests.
- `npm run security:audit` passed with only the dated exception.
- `npm run verify:fast` passed.

## Follow-up

Upgrade back to `fast-uri@3.1.4` or a dependency-supported secure 4.x release as
soon as the mandatory proxy serves it, and remove the exception wrapper if no
other scoped exceptions remain.
