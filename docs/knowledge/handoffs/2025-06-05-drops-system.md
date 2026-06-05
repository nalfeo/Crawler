# Drops System + Gore VFX — Handoff

**Date**: 2025-06-05
**Branch**: `nalfeo/drops-system`
**Status**: Complete — all tests pass, lint clean, typecheck clean

## What Was Done

### Drops System (ECS, pure logic)
- **Loot tables** (`src/shared/loot-tables.ts`): Data-driven loot with 4-layer resolution (entity → type → area → floor). Tables: BASIC_MELEE, BASIC_RANGED, ELITE, BOSS, FLOOR_1
- **Gold component** (`src/core/components.ts`, `world.ts`): New Gold tag + store, playerGold on GameWorld
- **dropSystem** (`src/core/systems/dropSystem.ts`): Queries dying enemies, rolls loot, spawns Gold/XpGem/DroppedItem entities, emits 'death' combat events
- **itemPickupSystem rewrite**: Now handles Gold, XpGem, and DroppedItem pickup (consolidated from damageSystem)
- **healthSystem refactor**: Removed hardcoded XP gem spawn (now in dropSystem)

### Gore VFX (rendering layer)
- **GoreVfx** (`src/engine/GoreVfx.ts`): Phaser particle effects consuming hit + death combat events
- **goreFactor on weapons** (`src/shared/weaponDefs.ts`): Per-weapon gore intensity (bladed=high, blunt=low, magic=zero)
- **Combat events extended** (`src/shared/combat-events.ts`): Added 'death' type, overkill, knockback direction, weaponGoreFactor

### Labs
- **drops-lab**: Spawn enemies, kill them, see Gold/XpGem/Item drops with adjustable parameters
- **gore-lab**: Simulate hit/death gore events, tune intensity/overkill/goreFactor

### Tests
- `tests/ecs/loot-tables.test.ts`: Roll logic, determinism, multi-layer resolution
- `tests/ecs/drop-system.test.ts`: Drop spawning, death events, idempotency
- `tests/ecs/item-pickup.test.ts`: Gold/XP gem pickup, accumulation

## Known Limitations
- dropSystem currently hardcodes all enemies to BASIC_MELEE loot table — needs enemy-type metadata for full 4-layer resolution
- System pipeline ordering (dropSystem before healthSystem) is exported but not wired into the actual game loop — consumer needs to call dropSystem(world) before healthSystem(world)
- Gore lab is event-simulation only (no live Phaser particles) — full visual preview requires in-game context

## Key Decisions
- Gold ≠ BroadcastScore (gold = currency, score = reality show rating)
- XP gem collection moved from damageSystem → itemPickupSystem (single pickup system)
- GoreVfx reads combatEvents without draining (runs before CombatVfx which drains)
