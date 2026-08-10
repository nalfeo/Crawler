# Handoff — Reputation System Gated Behind Broker Dialogue

**Date:** 2026-07-10  
**Branch:** current  
**Estimate:** 1 apple 🍎

## Systems touched

mapgen, quests, ai-combat-balance

## Summary

The Floor 2 family relationship system (reputation) now activates only after the
player reads all of the Broker's intro dialogue lines — not merely on entering the
settlement. This creates a proper narrative gate: the Broker explains the system
before it starts affecting gameplay.

## What changed

**Trigger:** `reputationSystemActive` flips `false → true` in `floor2ObjectiveTick`
when `FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID` (`'floor2-broker-intro-complete'`) is
true — was previously `FLOOR2_SETTLEMENT_FOUND_GOAL_ID`.

**Activation path (human play):**  
Player advances past the last of the Broker's 3 intro dialogue lines →
`MainGameScene` fires `this.options.broker?.met(this.world)` →
`meetBroker(world)` sets the goal flag → next `floor2ObjectiveTick` tick flips
`reputationSystemActive = true`.

**ESC/close-early path:** Closing the Broker's dialogue before the last line does
NOT set the flag — the player must read all lines. The broker's conversation can be
restarted by talking to her again.

**Headless path:** `autoNpcInteractionSystem` in `auto-progression.ts` now handles
`'the-broker'` defId, calling `meetBroker(world)` when the AI reaches the broker.
While `reputationSystemActive === false`, `getNpcInteractionReason` returns
`'meet-broker-intro'` for `'the-broker'` and `null` for other NPCs, so headless
targeting prioritizes the Broker until the intro flag is completed.

## Files changed

- `src/game/floor2Scenario.ts` — `FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID`, `meetBroker()`,
  activation check change, flag init
- `src/engine/scenes/MainGameScene.ts` — `broker?` option, dialogue-end hook
- `src/bootstrap/floor-main-scene-options.ts` — wire `meetBroker` as `broker.met`
- `src/game/ai/auto-progression.ts` — `'the-broker'` case in `autoNpcInteractionSystem`
- `src/game/index.ts` — export `meetBroker` and `FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID`
- `tests/unit/floor2-scenario-initialization.test.ts` — updated reputation test (broker
  gate); new negative test (settlement found alone doesn't activate); hidden-quest
  mechanical-activity assertion

## Verification

- `npm run verify:fast` ✅ (286 + 85 test files, 3332 + 1155 tests pass)
- Specific: `npx vitest run tests/unit/floor2-scenario-initialization.test.ts` ✅

## Notes

- `=== false` in the activation guard is intentional: `undefined` means "active by
  default" (backwards compat for labs that don't set `reputationSystemActive`).
- The `FLOOR2_SETTLEMENT_FOUND_GOAL_ID` flag is unchanged — it still fires when the
  player physically enters the settlement cluster. Only the reputation activation
  trigger moved.
- The Broker's dialogue can be re-read (dialogueIndex cycles); calling `meetBroker`
  is idempotent (setting an already-true flag is a no-op).
