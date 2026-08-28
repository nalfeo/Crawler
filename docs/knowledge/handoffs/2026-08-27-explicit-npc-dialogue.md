# Handoff — Explicit NPC dialogue activation

## Systems touched

hud-ux

## Summary

- Replaced arbitrary desktop canvas-click dialogue activation with a click on a nearby NPC's actual collision footprint.
- Preserved the existing Talk prompt and E-key interaction paths, and retained ordinary pointer advancement while dialogue is already open.
- Added deterministic selection for overlapping NPC hit footprints and real-scene E2E coverage that Awards opens without starting nearby dialogue.

## Apples

- Estimated: 3🍎
- Actual: 3🍎
- Verdict: exact — the focused engine input change, test seam, E2E coverage, and required review harness matched the estimate.

## Validation

- `npm run typecheck` ✅
- `npx vitest run tests/unit/main-game-scene-helpers.test.ts --project unit` ✅
- `npx vitest run tests/e2e/main-game-scene-ui-exclusivity.test.ts --project e2e -t "requires an explicit NPC interaction"` ✅
- `npm run verify:fast` ✅ (144 files / 2368 tests)
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-08-27-explicit-npc-dialogue.review-ledger.json` ✅

## Runtime observation

- Before: `handlePointerDown()` turned every non-touch canvas click outside a corner button into an interaction request, so a player within NPC range could start dialogue without clicking that NPC.
- After: the real `MainGameScene` probe E2E clicked blank canvas beside a primed NPC and observed no dialogue, then clicked Awards and observed Awards open without dialogue; direct NPC click, Talk-button click, and E each opened dialogue.
