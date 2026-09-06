# Broker dialogue replay fix

**Date:** 2026-09-06
**Session:** broker-dialogue-replay-fix
**Apple estimate:** 2🍎

## Systems touched

quests

## Summary

Fixed the Floor 1 spell broker re-playing the Slime Rat intro after the objective was already complete. The broker now resolves from the current quest state and advances to the next valid post-boss progression beat instead of repeating the stale pre-boss prompt.

## Changes

- Added a `bossBattleComplete` branch to `selectSpellBrokerDialogue()` so the post-boss beat suppresses the stale intro while keeping the reward flow locked behind the real claim state.
- Threaded the `floor1-boss-battle-complete` world flag into `resolveDialogueLines('spell-quest-giver', ...)` so save/re-entry and repeated interaction reuse the same goal-driven state.
- Added deterministic unit coverage for the completed-objective, post-claim, and locked-state broker dialogue branches.

## Validation

- `npx vitest run tests/unit/spell-broker-dialogue.test.ts tests/unit/main-game-scene-helpers.test.ts` ✅
- `bash scripts/agent/verify-fast.sh` ✅
