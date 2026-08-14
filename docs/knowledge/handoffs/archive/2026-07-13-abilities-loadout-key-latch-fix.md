# Handoff — Abilities loadout key latch fix

**Date:** 2026-07-13  
**Branch:** `nalfeo-polish-abilities-ux`  
**Session slug:** abilities-loadout-key-latch-fix

## Systems touched

hud-ux

## Apple estimate

- Declared: **2 apples**
- Actual: **2 apples**
- Verdict: **on-target**

## Summary

Recovered the remaining PR #1095 reviewer findings around input retained while
the abilities loadout was open. Blocked scene-level key latches could survive
the early return, and raw movement/action input could remain held in
`InputCapture`, then fire on the next frame after close.

Applied the smallest safe fix:

- drain the blocked `E`, `I`, `G`, `V`, and `Escape` Phaser `JustDown` latches
  when the abilities loadout opens/closes
- reset raw keyboard/touch capture on open/close, suppressing still-held keys
  until their matching release so key-repeat cannot restore blocked input
- add a real-scene E2E regression that presses `I` inside the loadout, closes
  it with `B`, and proves inventory stays closed
- add unit coverage for keyboard/touch reset and real-scene coverage proving a
  held `S` cannot move the player after close

## Files touched

- `src/engine/scenes/MainGameScene.ts`
- `src/engine/InputCapture.ts`
- `tests/unit/input-capture.test.ts`
- `tests/e2e/main-game-scene-ui-exclusivity.test.ts`
- `docs/knowledge/handoffs/2026-07-13-abilities-loadout-key-latch-fix.md`

## Verification

- Reviewer-thread validation agents:
  - ledger/code-review thread → deterministically outdated
  - ledger/multi-model thread → deterministically outdated
  - `shortLabel` coverage thread → deterministically addressed
  - ability-icon coverage thread → deterministically addressed
  - loadout key-latch thread → valid on current head
- Local validation:
  - `npm run test:unit -- tests/unit/input-capture.test.ts` ✅
  - `npm run test:e2e -- tests/e2e/main-game-scene-ui-exclusivity.test.ts` ✅
  - `npm run verify:fast` ✅

## Unresolved issues

- None in local validation. CI for the branch was already green/in-progress when
  these input-isolation fixes landed.
