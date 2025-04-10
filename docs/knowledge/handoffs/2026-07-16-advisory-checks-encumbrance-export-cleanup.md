# Handoff: PR #1203 advisory-checks dead-export cleanup

## Date

2026-07-16

## Persona

Producer -> Systems Engineer

## Systems touched

inventory, ci-policy

## Apples

Estimated 🍎, actual 🍎.

## What changed

- Diagnosed failing GitHub Actions `Advisory checks` job (`87706923235`) and confirmed the failure was `npm run lint:dead-code` reporting two unused exports in `src/shared/encumbrance.ts`.
- Made the smallest possible fix:
  - made `ENCUMBRANCE_ENCUMBERED_FACTOR` internal (still used by `getEncumbranceBand`),
  - removed unused `ENCUMBRANCE_BAND_COLORS` export.
- Left runtime encumbrance behavior unchanged.

## Verification

- `npm run lint:dead-code`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`
