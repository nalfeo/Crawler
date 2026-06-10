# Handoff — 2026-06-10 — weight-component

## Summary

Added a `Weight` ECS component to all entity types. Every entity (player, enemies, XP gems, gold, dropped items, projectiles) now carries a physical weight value in pounds. This is the data foundation for future weight×strength knockback interactions.

## What Was Done

- **`src/core/components.ts`** — Added `Weight` component tag and `weight: { value: Float32Array }` store.
- **`src/core/world.ts`** — Imported `Weight`; wired its `onSet` observer via `wireStore`.
- **`src/core/helpers.ts`** — Imported `Weight`; added weight `addComponent` to `spawnPlayer` (default 180), `spawnEnemy` (default 120), `spawnBehaviorEnemy` (options.weight, default 120), `spawnXpGem` (default 1), `spawnGold` (default 1), `spawnDroppedItem` (default 5), `spawnProjectile` (default 1). All new params are optional with sensible defaults — no call sites broken.
- **`tests/ecs/weight.test.ts`** — 14 unit tests covering default and custom weight for every spawn helper.
- **`src/labs/weight-lab/index.ts`** — Canvas lab: click to spawn entities, circle radius scales with weight, controls for kind and weight.
- **`src/lab-main.ts`** — Registered `weight-lab`.

## Apples

- Estimated: 🍎🍎🍎 (Medium)
- Actual: 🍎🍎🍎 (Medium)
- Delta: 0 → 🎯 Exact
- Notes: Straightforward ECS component extension; no surprises.

## Hello Kitties

0.6 🎀

## Next Steps

- Implement strength×weight knockback attenuation in `knockbackSystem` (when an entity is hit, final knockback distance = base_knockback × (attacker_strength / target_weight))
- Consider weight-based movement speed penalty (heavy entities move slower)
- Future: item weight affects carry capacity
