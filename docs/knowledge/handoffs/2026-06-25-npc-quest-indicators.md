# Session Handoff: NPC quest indicators

## Date

2026-06-25

## Persona(s) adopted

Producer + UX Designer — this was small cross-layer quest-affordance polish spanning Floor 1 quest state and main-scene NPC presentation.

## Systems touched

quests

## Apple estimate / actual

- Estimated: 🍎🍎
- Actual: 🍎🍎
- Verdict: 🎯 Exact
- Hello kitties: 0.40

## What Was Done

- Removed the blue welcome-room glow circle from the Tutorial Goon area by retiring the safe-room objective marker in `MainGameScene`.
- Added bobbing NPC exclamation indicators in `MainGameScene`: yellow for NPCs whose interaction can accept or advance a quest, grey for NPCs with an accepted active quest but no new interaction yet.
- Added `getNpcQuestIndicatorState(world, npcId)` in `src/game/floor1Scenario.ts` so indicator colors follow real Floor 1 quest progression, including:
  - Tutorial Goon actionable before check-in, grey while his accepted quests remain active.
  - Shopkeeper yellow when he can offer the errand, accept the fetched rat tail, or sell the charm; grey while the accepted quest is waiting on off-NPC progress.
  - Spell Broker yellow when he can offer the boss quest or claim the spellbook; grey while the boss progress is still pending.
- Wired the selector through `createFloor1MainSceneOptions()` so the engine keeps game-layer rules injected rather than importing game logic directly.
- Added regression coverage for the selector states and the new scene-option wiring.

## Files changed

- `src/game/floor1Scenario.ts`
- `src/bootstrap/floor1-main-scene-options.ts`
- `src/engine/scenes/MainGameScene.ts`
- `tests/game/floor1-scenario.test.ts`
- `tests/game/floor1-main-scene-options.test.ts`

## Validation

- `npm run verify:fast` ✅
- `npx vitest run tests/game/floor1-scenario.test.ts tests/game/floor1-main-scene-options.test.ts` ✅
- `npm run verify` ✅
- `bash scripts/agent/lab-gate-check.sh` ✅

## Unresolved issues

- None noted.

## Blockers

- None.

## Agent-OS Telemetry

- `files/guard-telemetry.jsonl` does not exist — no telemetry section.
