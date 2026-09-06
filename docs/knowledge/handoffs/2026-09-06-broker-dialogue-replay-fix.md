# Broker dialogue replay fix

**Date:** 2026-09-06
**Session:** broker-dialogue-replay-fix
**Apple estimate:** 2🍎

## Systems touched

quests

## Summary

Fixed the Floor 1 spell broker re-playing the Slime Rat intro after the objective was already complete. The broker now resolves from the current quest state and advances to the next valid post-boss progression beat instead of repeating the stale pre-boss prompt.

## Changes

- Added a `bossDefeated` branch to `selectSpellBrokerDialogue()` so the post-boss beat suppresses the stale intro while keeping the reward flow locked behind the real claim state.
- Threaded the Slime Rat kill state (`objective.bossBattles.get('slime-rat').defeated`) — not the `floor1-boss-battle-complete` goal flag — into `resolveDialogueLines('spell-quest-giver', ...)`. That goal flag is the quest's `onCompleteGoalFlag`, which only fires once the `claim-spellbook` objective is _also_ done; `claim-spellbook` is satisfied by `meetSpellQuestGiver()`, which runs after dialogue is resolved. Gating on the goal flag meant the very first post-kill Broker interaction still replayed the stale intro. Reading the kill objective directly covers that first return correctly.
- Added deterministic unit coverage for the completed-objective (using real kill → return ordering via `freshFloor1World()`), post-claim, and locked-state broker dialogue branches.

## Validation

- `npx vitest run tests/unit/spell-broker-dialogue.test.ts tests/unit/main-game-scene-helpers.test.ts` ✅
- `bash scripts/agent/verify-fast.sh` ✅
