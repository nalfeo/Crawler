# Handoff: Weapon active stacked-base conflict recovery

## Date

2026-08-29

## Persona

Producer

## Systems touched

weapons, hud-ux, ci-policy

## Apples

Estimated 1🍎, actual 3🍎. The merge itself was small, but the updated base exposed
two typecheck errors, one stale E2E expectation, and an incomplete carryover
migration found by the required independent grade.

## Summary

- Merged `crawler-quarantine-repair/pr-3728-29f4b2f32a42` at `86a3b6744` into the
  active-ability branch without rewriting history.
- Preserved the stacked base's newer NPC-interaction retry behavior, release-sweep
  strict-typing fix, and complete Floor 4 handoff content.
- Removed an obsolete E2E helper and duplicate integration-test import introduced
  by combining independently landed fixes.
- Updated the newly inherited loadout E2E expectation from the legacy dagger
  passive to `dagger-rapid-strike-active`.
- Expanded saved-state migration from Arcane-only handling to every renamed
  level-5/15 weapon milestone while preserving canonical skill grant ownership.

## Validation

- `npm run typecheck`
- 106 targeted carryover, weapon, and shipped-pipeline tests
- Targeted milestone loadout E2E test
- Full `main-game-scene-ui-exclusivity.test.ts`: 20 passed; its one stale passive
  expectation failed before the integration update and passed when rerun directly
- `npm run verify:fast`
