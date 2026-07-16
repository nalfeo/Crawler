# Handoff: Simplify Floor 1 Layout

**Date:** 2026-07-04  
**Branch:** nalfeo-simplify-floor1-layout  
**Complexity:** 🍎 (1 apple)

## Summary

Consolidated all three Floor 1 quest NPCs (Tutorial Goon, Spell Broker, Sweaty Merchant) into the welcome bar (welcomeOfficePos). Previously the Spell Broker and Shopkeeper each had their own dedicated safe rooms scattered across the map, requiring significant travel between quest waypoints.

## Systems touched

mapgen, ai-behavior-tree

## Changes

### `src/shared/data/floors/floor1.manifest.json`

- `spell-quest-giver`: `roomRole` changed from `"any"` → `"spawn"` (= welcomeOfficePos)
- `shopkeeper`: `roomRole` changed from `"shop"` → `"spawn"` (= welcomeOfficePos)

### `src/game/floorScenario.ts`

- Removed `tagRoomAsSafe(world, shopRoomPos)` and `tagRoomAsSafe(world, spellQuestGiverPos)`
- `objective.shopRoomPos` and `objective.spellQuestGiverPos` now set to `welcomeOfficePos` so AI navigation targets the bar
- Fallback hardcoded NPC spawning also moved both NPCs to `welcomeOfficePos`

### Tests updated

- `floor1-scenario.test.ts`: replaced old "shop ≥ 3 hops from welcome" test with "all quest NPCs in the welcome bar" test; sealed-room count lowered from 5 → 3
- `behavior-tree-ai.test.ts`: moved tutorial goon and spell broker far away in the shopkeeper interaction test so only the shopkeeper is in range

## Design rationale

The welcome room is the bar. All quest givers live there. Players no longer need to travel between 3 separate safe rooms to progress quests — everything is in one hub. The quest item (rat tail), slime-rat boss room, and staircase are still distinct rooms elsewhere in the floor.

## Lessons

- `chooseObjectiveTiles` still computes `shopRoomPos` and `spellQuestGiverPos` internally (for room deduplication and slime-rat placement), but these values are now overridden in the objective state to point at `welcomeOfficePos`.
- AI uses `objective.shopRoomPos` and `objective.spellQuestGiverPos` as navigation targets — setting both to `welcomeOfficePos` correctly directs the bot to the bar.
