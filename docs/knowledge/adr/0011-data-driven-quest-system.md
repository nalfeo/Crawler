# ADR 0011: Data-driven quest system and quest tracker

## Status

Accepted

## Date

2026-06-12

## Estimated Complexity

🍎 x 4 — new quest data model + system, HUD tracker, Floor 1 rewrite, shop NPC,
inventory/equipment unlock gating, and a new lab. Spans core, engine, game, and
shared layers.

## Context

Floor 1 tracked its objectives with ad-hoc booleans baked into
`floor1ObjectiveSystem` (e.g. `ratsKilled`, `questAccepted`, `questCompleted`).
This did not scale to multiple concurrent quests, gave no reusable model for
future floors, and had no player-facing tracker. We also needed a multistep
shopkeeper errand that gates the inventory and equipment systems behind player
progress, plus a Skyrim/WoW-style tracker that surfaces at most three quests.

## Decision

- **Pure quest model in `src/shared/quest-types.ts`.** Quests are ordered lists
  of typed objectives (`counter`, `collect`, `talk`, `goal`, `haveEquippable`,
  `equip`). The module has no ECS/engine imports so it stays portable. A small
  registry holds the Floor 1 tutorial quest ("Pest Control for Beginners") and
  the shopkeeper errand ("The Merchant's Disgusting Little Errand").

- **`world.questLog: Map<string, QuestState>`** is the single source of truth
  for the tracker and replaces Floor 1's objective booleans. `QuestState`
  carries per-objective `progress` (counters) and `done` (latched one-shots).

- **`questSystem` lives in `src/core/systems/`, not `src/game/`.** The engine
  HUD tracker (`HudQuestTracker`) must read quest state, and ESLint forbids
  `engine → game` imports. Placing the read helpers + evaluation pass in `core`
  lets both the engine HUD and game systems consume them. The system shape is
  the standard deterministic `(world) => void`.

- **`onCompleteGoalFlag` bridges quests to other systems.** When a quest
  completes, the system sets a goal flag (e.g. `floor1-goon-quest-complete`),
  which the existing door-lock conditions already consume. No coupling between
  the quest system and the door system is required.

- **Feature unlocks are latched in the quest system.**
  `world.featureUnlocks.inventory` flips true the moment the player holds the
  fetch item; `world.featureUnlocks.equipment` flips true once the player holds
  anything equippable (the purchased charm). Both are one-way latches.

- **One-shot acquisition objectives latch.** `collect` and `haveEquippable`
  objectives set `quest.done[id]` once satisfied, because returning the fetch
  item and equipping the charm both remove the item from the bag and would
  otherwise retroactively un-satisfy an earlier step.

- **Shop room selection reuses existing room data** rather than introducing a
  new `RoomRole`. `chooseObjectiveTiles` returns shop/quest-item positions from
  the already-generated floor rooms.

- **Item catalog invariant preserved.** The 100-item / 20-per-canonical-tag
  invariant (`tests/unit/items.test.ts`) forbids appending items, so two unused
  catalog entries were repurposed into `glistening-rat-tail` (Key Items) and
  `merchants-stained-charm` (Misc).

## Consequences

### Positive

- Adding a quest is now data-only (define a `QuestDef`, accept it).
- The tracker is generic and respects `MAX_ACTIVE_QUESTS` (3).
- Inventory/equipment unlocks are driven by gameplay, not hardcoded.
- Quest completion integrates with door locks via the existing goal-flag system.

### Negative

- Floor 1's legacy objective booleans still exist for the boss/stair flow and
  are now mirrored into the quest log; a future pass should fully migrate them.
- `questSystem` sitting in `core/systems` is a pragmatic layering choice driven
  by the HUD import rule rather than a purely conceptual one.

### Risks

- The shopkeeper sprite uses placeholder `textureId 10`; a real sprite brief is
  still needed.
- Latching logic must stay correct as new objective kinds are added.

## Alternatives Considered

- **Keep booleans, add more flags.** Rejected: does not scale or generalize.
- **Put `questSystem` in `src/game/` and pass read callbacks into the HUD.**
  Rejected: the tracker needs broad read access; injecting many callbacks is
  noisier than relocating the pure read helpers to `core`.
- **Add a dedicated `RoomRole` for the shop.** Deferred: not needed for a single
  Floor 1 room; revisit when shops generalize across floors.
