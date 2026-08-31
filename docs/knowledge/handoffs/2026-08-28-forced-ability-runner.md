# Handoff: Forced Ability Runner Controls

## Date

2026-08-28

## Persona

Game AI Engineer

## Systems touched

ai-combat-balance, weapons

## Apples

- Estimated: 🍎🍎🍎
- Actual: 🍎🍎🍎
- Verdict: exact

## What changed

- Added repeatable `--force-ability <id>` CLI flags and the programmatic
  `forceAbilityIds` runner option.
- Forced abilities are validated and granted before frame 0. Forced spells
  unlock spell execution, passives apply immediately, and forced active
  abilities receive slot priority in argument order.
- Added deterministic forced-ability activation counts to `RunStats` and CLI
  output.
- Added parser and headless regression coverage for ordering, validation,
  immediate state, spell activation, and crash telemetry.

## Verification

- Focused forced-ability tests: 33 passed.
- `npm run verify:fast`: 2,397 tests passed.
- Review harness: plan review, clean code review, and independent grade passed.
- CodeQL: 0 alerts (analysis reused the prior unchanged-code result).
