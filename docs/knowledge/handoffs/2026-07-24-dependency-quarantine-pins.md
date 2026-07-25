# Handoff: Emergency dependency quarantine pins

## Date

2026-07-24

## Persona

DevOps Engineer (Producer-routed).

## Systems touched

ci-policy

## Apples

Estimated 2 apples, actual 2 apples (exact).

## Summary

Microsoft's mandatory npm proxy had not mirrored three dependency releases selected
during unrelated lockfile churn, causing `npm ci` to fail with false 404 responses.
The maintainer authorized a direct-to-main emergency repair.

- Pinned `postcss` to mirrored version `8.5.19`.
- Pinned `find-my-way` to mirrored version `9.6.0`.
- Pinned `fast-uri` to mirrored version `3.1.3`.
- Restored the exact `find-my-way` advisory exception through 2026-07-31. The
  existing `fast-uri` exception remains bounded through 2026-07-29.
- Kept PostCSS unexcepted because the pinned version has no reported advisory.
- Filed a separate follow-up to exact-pin all direct dependencies and enforce the
  policy rather than expanding this emergency change.

## Verification

- `npm ci --prefer-offline` completed through the Microsoft feed.
- `npm ls postcss find-my-way fast-uri --all` resolved only the pinned versions.
- `node --test scripts/agent/security/npm-audit.test.mjs` passed 14 tests.
- `npm run security:audit` passed with only exact, time-bounded exceptions.
- `npm run verify:fast` passed.
