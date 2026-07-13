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

Recovered the remaining PR #1095 reviewer finding in `MainGameScene`: while the
abilities loadout was open, blocked scene-level key latches could survive the
early return and fire on the next frame after close.

Applied the smallest safe fix:

- drain the blocked `E`, `I`, `G`, `V`, and `Escape` Phaser `JustDown` latches
  when the abilities loadout opens/closes
- add a real-scene E2E regression that presses `I` inside the loadout, closes
  it with `B`, and proves inventory stays closed

## Files touched

- `src/engine/scenes/MainGameScene.ts`
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
  - `npm run test:e2e -- tests/e2e/main-game-scene-ui-exclusivity.test.ts` ✅
  - `npm run verify:fast` ✅

## Unresolved issues

- None in local validation. CI for the branch was already green/in-progress when
  this fix landed; only the newly reported loadout key-latch thread required a
  code change in this session.
