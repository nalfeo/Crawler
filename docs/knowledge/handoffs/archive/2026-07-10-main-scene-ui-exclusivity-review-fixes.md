# Main scene UI exclusivity review fixes

## Date

2026-07-10

## Persona

UX Designer

## Systems touched

hud-ux

## Apples

- Estimated: 🍎🍎
- Actual: 🍎🍎
- Verdict: 🎯 Exact

## What was done

- Fixed `MainGameScene` interaction gating so queued/tapped interaction requests are blocked after the combined request is formed, preventing dialogue and stair modals from opening behind an already-open character surface.
- Fixed the achievements toggle race by re-checking the live modal/level-up lock state after the abilities toggle path runs, so same-frame B+V requests keep a single primary surface open.
- Corrected the prior session’s apple-metrics artifact verdict from `on_estimate` to the canonical `exact`.
- Added a deterministic `main-scene-probe-lab` e2e guard that boots the real `MainGameScene` and covers both the same-frame abilities/achievements race and queued interaction behind an open achievements panel.

## Observe before done

- Before: the review identified two real runtime gaps in the previous code path — queued interaction could bypass the new blocker through `tapped`, and same-frame B+V could open Achievements after Abilities because the lock state was captured too early.
- After: `tests/e2e/main-game-scene-ui-exclusivity.test.ts` now observes the real booted `MainGameScene` and proves (1) same-frame B+V leaves only the abilities modal open and (2) a queued interaction does not open NPC dialogue behind the achievements panel.

## Verification

- `npx vitest run tests/unit/main-game-scene-mobile-ui.test.ts tests/unit/equipment-inventory-ux-wiring.test.ts` ✅
- `npx vitest run --project e2e tests/e2e/main-game-scene-ui-exclusivity.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run verify` ✅

## Notes

- No guard telemetry file was present in this session (`files/guard-telemetry.jsonl` absent), so no telemetry capture artifact was written.
