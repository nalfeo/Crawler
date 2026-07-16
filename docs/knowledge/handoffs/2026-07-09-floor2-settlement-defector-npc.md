# Handoff: Floor 2 Starter Quest + Defected Family Member NPC

**Date:** 2026-07-09  
**Session:** Floor 2 playability check  
**Branch:** nalfeo-floor2-trash-territories-timer-tuning  
**Status:** PR-ready — ledger validated, ADR filed, tests green

## Systems touched

mapgen, enemies, vfx, quests

## What was done

### 1. Starter quest — `floor2-find-settlement`

- New quest pack in `src/shared/data/quests.floor2.json` — `goal`-type quest that auto-accepts at Floor 2 boot and completes when the player first enters the settlement cluster.
- Registered in `src/shared/quest-types.ts`; `FLOOR2_FIND_SETTLEMENT_QUEST_ID` exported.
- `floor2Scenario.ts`: auto-accept in `initializeFloor2Scenario`, progress tick in `floor2ObjectiveTick` detects settlement room entry.
- Regression tests: `tests/unit/quest-types.test.ts`, `tests/unit/floor2-scenario-initialization.test.ts`.

### 2. Defected family member NPC

- `FLOOR2_DEFECTOR_NPC_ID` + `FLOOR2_DEFECTOR_DEF` + `buildFloor2DefectorDialogue()` in `src/shared/npc-types.ts`. `NpcInstance` extended with `dialogueOverride` + `appearanceFallbackKey`.
- `SpawnNpcOptions` in `src/core/spawners/world-objects.ts` — optional `appearanceKey`, `appearanceFallbackKey`, `dialogueOverride`; `spawnNpc()` stores them.
- `resolveDialogueLines` in `main-game-scene-helpers.ts` — optional `npcEid` param; checks `dialogueOverride` first. Both conversation paths in `MainGameScene.ts` now pass the NPC eid.
- `resolveNpcTexture` in `PhaserBridge.ts` — 3-step chain: elite `-v1` brief → `appearanceFallbackKey` → `appearanceKey`. Both create and late-load-reconcile paths thread `appearanceFallbackKey`.
- `getFloor2FamilyEliteArchetype` / `getFloor2FamilyFallbackArchetype` helpers in `src/shared/enemy-packs.ts`.
- `Floor2SettlementSnapshot` gains `defectorEid`, `defectorFamilyId`, `defectorAppearanceKey`, `defectorFallbackAppearanceKey`.
- `floor2Settlement.ts` — full NPC placement rewrite: derived settlement RNG, defector family pick, `buildSettlementPlacementPlan`, `placeSettlementNpcs`, `boundedInteriorCells`, `tileDistanceSq`. 3-tile spacing between all NPCs, door-adjacent tiles excluded.
- Integration test extended: defector presence/art/dialogue/placement/spacing asserted.
- ADR 0054 filed for the 3-layer appearance-key + dialogue-override threading pattern.

## Test status

- Unit: 1541 passing
- Integration: 126 passing
- `npm run check:wired-systems`: 48 systems checked, all wired (1 advisory finding, non-blocking)
- Review ledger: `docs/knowledge/review-ledgers/2026-07-09-floor2-settlement-defector.review-ledger.json` — valid 3-apple ledger (plan_review + code_review stages)

## Known limitations / follow-up

- Elite sprite art exists for only 6 of 18 families (goblin, myconid, toadkin, batfolk, imp, cactusfolk). Other families fall back to the non-elite (grunt) appearance. The fallback is deterministic and tested; the art will automatically upgrade as more elite briefs are approved.
- The `floor2-find-settlement` quest has no reward yet — intentionally left open pending game-design decision on what reward makes sense at this point.
- Floor 2 still has untested systems (boss-lair unlock quest, collapse timer hook, family patrol spawning). These are separate work items.

## Files changed (key)

- `src/game/floor2Settlement.ts` — settlement init with defector + new placement helpers
- `src/game/floor2Scenario.ts` — starter quest wiring
- `src/shared/npc-types.ts` — defector def + NpcInstance extensions
- `src/shared/enemy-packs.ts` — elite/fallback archetype helpers
- `src/shared/floor-types.ts` — Floor2SettlementSnapshot defector fields
- `src/core/spawners/world-objects.ts` — SpawnNpcOptions + spawnNpc updates
- `src/engine/scenes/main-game-scene-helpers.ts` — resolveDialogueLines signature
- `src/engine/scenes/MainGameScene.ts` — conversation paths pass npcEid
- `src/engine/PhaserBridge.ts` — resolveNpcTexture appearance + fallback chain
- `src/engine/phaser-bridge/sprite-kind.ts` — 18 elite archetype appearance key mappings
- `src/shared/data/quests.floor2.json` — new quest pack
- `docs/knowledge/adr/0054-floor2-settlement-npc-appearance-and-dialogue-threading.md`
- `docs/knowledge/review-ledgers/2026-07-09-floor2-settlement-defector.review-ledger.json`
