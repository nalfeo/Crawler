# Session Handoff: AI Runner level-up modal no longer stalls

## Date

2026-06-21

## Persona(s) adopted

Producer (cross-layer bug touching engine scene flow + unit coverage).

## Routing verdict

✅ right persona — fix required tracing scene control flow plus regression guard.

## Apples

Estimated: 🍎 x 3
Actual: 🍎 x 3
Verdict: 🎯 Exact — matched expected medium scope (targeted bug fix + test + validation).

Hello kitties: 3/5 = 0.60 🎀

## Systems touched

ai-combat-balance, inventory

## What Was Done

- Root-caused stall: `MainGameScene.update()` returned early while `LevelUpUI` was open, so `driveAutoLevelUp()` only ran on the first open frame and never advanced the hold-frame counter afterward.
- Fixed by calling `driveAutoLevelUp()` inside the `this.levelUpUI?.isOpen()` early-return branch, so AI auto-resolution continues while modal remains open.
- Updated `tests/unit/ai-level-up-ux-wiring.test.ts` to assert the open-modal path runs `driveAutoLevelUp()`.

## What's Next

- Optional browser/lab smoke to visually confirm repeated level-up cycles in `?lab=ai-runner`.

## Blockers

- None.

## Branch State

- Branch: `copilot/ai-runner-fix-level-up-selection`
- All tests passing: yes
- PR created: no

## Test Results

- `npm run verify:fast` ✅
- `npm run verify` ✅

## Key Decisions Made

- Kept fix surgical in scene control flow (no allocator or UI behavior changes).
- Strengthened existing wiring test instead of adding a heavy scene integration test.
