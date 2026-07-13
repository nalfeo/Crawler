# Handoff: Floor 1 Quest System & Shopkeeper Errand — 2026-06-12

## Session Summary

Replaced Floor 1's hardcoded objective booleans with a data-driven quest system
plus a Skyrim/WoW-style quest tracker HUD, and added a multistep shopkeeper
errand that unlocks the inventory and equipment systems. Delivered as a single
PR per the user's request.

## Apple Estimate

- Declared: 🍎🍎🍎🍎 (Large)
- Actual: 🍎🍎🍎🍎
- Verdict: **on-estimate**. New quest model + system, HUD tracker, Floor 1
  rewiring, new shop NPC, inventory/equipment unlock gating, and a new lab —
  spanning core/engine/game/shared layers.

## What Shipped

### Quest model & system

- `src/shared/quest-types.ts` — pure, serializable quest model + Floor 1
  registry: "Pest Control for Beginners" (tutorial) and "The Merchant's
  Disgusting Little Errand" (shop). Objective kinds: `counter`, `collect`,
  `talk`, `goal`, `haveEquippable`, `equip`. Also exports `ShopkeeperStage`.
- `src/core/systems/questSystem.ts` — evaluation pass `(world) => void` plus
  quest-log helpers (`acceptQuest`, `getActiveQuests`, `getQuestObjectiveViews`,
  `notifyQuestTalk`, `setQuestCounter`, `setTrackedQuest`, `isQuestComplete`).
  Lives in **core** (not game) so the engine HUD can import its read helpers
  without violating the ESLint `engine → game` ban. Latches `collect` /
  `haveEquippable` objectives and the inventory/equipment feature unlocks.
- `world.questLog` + `world.featureUnlocks {inventory, equipment}` added to
  `src/core/world.ts`.

### Items / equipment

- Repurposed two unused catalog items (to preserve the 100-item / 20-per-tag
  invariant in `tests/unit/items.test.ts`):
  `glistening-rat-tail` (Key Items, the gross fetch item) and
  `merchants-stained-charm` (Misc, the purchasable equippable).
- `src/shared/equipmentDefs.ts` — item↔equipment bridge; `MERCHANTS_CHARM_DEF`
  (slot `neck`, +2 constitution / +1 luck, uncommon), `MERCHANTS_CHARM_COST=15`.

### Floor 1 integration (`src/game/floor1Scenario.ts`)

- Spawns the shopkeeper NPC + drops the fetch item, accepts both quests,
  initializes base stats, syncs tutorial kill counters into the quest log.
- Shop helpers: `getShopkeeperStage`, `meetShopkeeper`, `returnShopkeeperPrize`,
  `purchaseShopkeeperEquipment`, `equipPurchasedGear`, `SHOPKEEPER_EQUIPMENT_COST`.
- Boss-door unlock still keys off `floor1-goon-quest-complete` (independent of
  the shop errand).

### HUD / scene

- `src/engine/HudQuestTracker.ts` — top-right tracker, ≤3 quests, tracked quest
  expanded with ☐/☑, multistep objectives revealed one at a time. Wired into
  `HudUI.ts`.
- `MainGameScene.ts` — shopkeeper dialogue branches, purchase modal, `[I]`
  inventory and `[G]` equip keys gated by `featureUnlocks`, `flashHint`,
  `updateFeatureUnlocks`. Game-layer shop logic injected via
  `MainGameSceneOptions.shopkeeper` callbacks from `main.ts` / `floor1-lab`.

### Lab

- `src/labs/quest-lab/index.ts` — DOM lab driving the full quest flow; registered
  in `LAB_MODULE_PATHS` (`src/lab-main.ts`).

## Tests

- `tests/ecs/quest-system.test.ts` — unit + property-based (fast-check):
  accept/idempotency, counter completion + goal flag, multistep hiding, full
  errand walk, `haveEquippable` latch, tracking, `MAX_ACTIVE_QUESTS`, and the
  invariants "tutorial never completes early" and "counter is non-negative int".
- `tests/game/floor1-scenario.test.ts` — extended with the shopkeeper errand
  integration (meet → fetch → return → buy → equip), can't-afford, can't-return,
  and boss-door independence.
- `npm run verify` (full) passes: **1143 unit/property tests + 25 integration**,
  lint clean, build OK.

## Known Follow-ups / Notes

- **Shopkeeper sprite is a placeholder** (`textureId 10` in
  `src/shared/npc-types.ts`). Needs a real sprite brief/asset.
- Floor 1's legacy boss/stair objective booleans still coexist with the quest
  log (mirrored). A future pass could migrate them fully into the quest model.
- `questSystem` in `core/systems` is a pragmatic layering choice (HUD import
  rule), documented in ADR 0011.

## Key Files

- `src/shared/quest-types.ts`, `src/shared/equipmentDefs.ts`
- `src/core/systems/questSystem.ts`, `src/core/world.ts`
- `src/game/floor1Scenario.ts`
- `src/engine/HudQuestTracker.ts`, `src/engine/HudUI.ts`,
  `src/engine/scenes/MainGameScene.ts`
- `src/labs/quest-lab/index.ts`
- `docs/knowledge/adr/0011-data-driven-quest-system.md`
