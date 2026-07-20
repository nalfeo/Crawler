# Handoff: CI recovery protected-path fix

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2 apples, actual 1 apple.

## What changed

- Added `.github/scripts/ci-recovery/issue-intake-lib.mjs` to the privileged `PROTECTED_WORKFLOW_PATHS` boundary in `.github/scripts/ci-recovery/review-wake-bridge.mjs`.
- Updated `.github/scripts/ci-recovery/review-wake-bridge.test.mjs` so the exact-boundary fixture matches the runtime protected-path set.

## Observe before done

- Before: the new shared intake helper was imported by privileged CI-recovery code but was not listed in the protected-path boundary, so `npm run test:guards` failed the exact-boundary assertion and CI red-lined `Format & Labs`.
- After: the helper is now treated as part of the privileged execution boundary, and the boundary assertion passes locally.
- Verified via the focused review-wake bridge test, the full guard suite, `verify:fast`, and `verify:pr-prereqs`.

## Verification run

- `node --test .github/scripts/ci-recovery/review-wake-bridge.test.mjs`
- `npm run test:guards`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved issues

- None.
