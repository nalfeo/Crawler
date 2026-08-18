# Handoff: Floor 1 NPC review follow-ups

**Date:** 2026-07-11  
**Session:** floor1-npc-review-followups  
**Estimated apples:** 🍎🍎  
**Actual apples:** 🍎🍎  
**Verdict:** exact

## Systems touched

ai-behavior-tree, mapgen

## What was done

- Fixed EXPLORE fallback NPC interactions to require actual player-to-target-NPC proximity (`NPC_INTERACT_RANGE_FT`) before dispatching interaction actions.
- Hardened spawn-reachability masking to respect initially locked Floor 1 doors (staircase + slime-rat room) when certifying critical NPC routability.
- Preserved authored welcome-room stamped NPC positions when those tiles are passable/routable, and only fell back to deterministic scatter when validation fails.
- Updated placement resolution so explicit placement coordinates are honored before critical-NPC welcome-hub fallback.
- Added/updated focused tests for:
  - no remote EXPLORE interactions through anchor-only proximity,
  - lock-aware critical NPC routability assertions,
  - deterministic collision-pair parity fingerprints after the intentional NPC placement behavior change.

## Runtime observation

- Before: EXPLORE fallback could interact with NPCs while still outside real interaction range; critical stamped NPCs were always scattered; routability checks could route through doors locked at floor start.
- After: interactions only fire at real NPC range, valid authored stamp tiles are preserved, and critical NPC routability is validated against effective initial lock topology.

## Validation

- `npm run test -- tests/game/auto-progression-npc.test.ts tests/game/floor1-scenario.test.ts tests/headless/floor1-npc-objective-anchor-regression.test.ts tests/headless/collision-pair-parity.test.ts`
- `npm run verify:fast`
- `npm run verify`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-11-floor1-npc-review-followups.review-ledger.json`
