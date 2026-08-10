# Handoff: Harvest Range Fix

**Date:** 2026-07-10  
**Session:** harvest-range-fix  
**Estimated apples:** 🍎  
**Actual apples:** 🍎  
**Verdict:** exact

## Systems touched

quests, ai-behavior-tree

## What was done

- Changed `HARVEST_RANGE_FT` from `1.0` to `4.0` in `src/core/systems/harvestSystem.ts`
- Updated the inline comment to reflect the new intent: "4 ft from center gives a comfortable pickup radius that is forgiving to both manual play and AI navigation"

## Why

The 1ft range was too finicky — the player (or AI) had to stand essentially pixel-perfect on the node for harvesting to trigger. 4ft is a generous but sensible reach.

## AI loot (no change needed)

Confirmed that `findNearestLoot` in `bt-ai-provider.ts` already includes `{ kind: 'harvest', entities: query(world.ecs, [Harvestable, Position]) }` alongside gold/xp/items. The AI already routes harvestables through the COLLECT state. No AI changes were needed.

## Validation

- `npm run verify:fast` — 1155 tests, all green
- Code review + CodeQL: clean
