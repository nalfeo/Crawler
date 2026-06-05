# ADR-0006: Drops System Architecture

**Status**: Accepted
**Date**: 2026-06-05
**Affects**: `src/core/`, `src/engine/`, `src/shared/`

## Context

Enemies need to drop gold, XP crystals, and items on death. The game also needs gore VFX triggered by hits and deaths. These systems span ECS logic (core), rendering (engine), and shared data (weaponDefs, combat events).

## Decision

### Drops: ECS-driven loot with 4-layer resolution

- A `dropSystem` runs before `healthSystem` to read position data before entity removal.
- Loot tables live in `src/shared/loot-tables.ts` as pure data. Resolution unions 4 layers: entity → type → area → floor.
- Gold is a separate resource from BroadcastScore (gold = currency for crafting/shopping, score = reality show rating).
- All pickup logic (Gold, XpGem, DroppedItem) consolidated in `itemPickupSystem`.

### Gore: Rendering-layer particle VFX

- `GoreVfx` lives in `src/engine/` — it reads `combatEvents` without draining (CombatVfx drains).
- Gore intensity is weapon-type dependent via `goreFactor` on `WeaponDef` (0..1).
- Hit-gore triggers on regular damage; death-gore triggers on death with overkill scaling.
- Uses a simple LCG PRNG for VFX randomness (doesn't need SeededRandom determinism).

## Consequences

- `dropSystem` must run before `healthSystem` in the system pipeline.
- `GoreVfx.update()` must run before `CombatVfx.update()` in the render loop.
- New enemy types need loot table assignments (currently hardcoded to BASIC_MELEE).
- Adding new drop types only requires a new component + loot entry type — no system changes.
