/**
 * Drop System — spawns loot when enemies die.
 *
 * Runs BEFORE healthSystem so it can read position data before entity removal.
 * Queries enemies at 0 HP, rolls the loot table, and spawns Gold/XpGem/DroppedItem
 * entities at the death position. Also emits 'death' combat events for gore VFX.
 */
import { hasComponent, query } from 'bitecs';
import { Enemy, Health } from '../components.js';
import { spawnXpGem, spawnGold, spawnDroppedItem } from '../helpers.js';
import type { GameWorld } from '../world.js';
import {
  rollLootTable,
  resolveLootTables,
  LOOT_TABLES,
  type LootDrop,
  type LootTable,
} from '../../shared/loot-tables.js';
import { getItemIndex } from '../../shared/items.js';

/**
 * Resolve which loot tables apply for a given enemy.
 * Currently uses BASIC_MELEE for all enemies + floor-level table.
 * Future: read enemy-type component and area context.
 */
function getEnemyLootTables(
  _world: GameWorld,
  _eid: number,
): {
  entityTable?: LootTable;
  typeTable?: LootTable;
  areaTable?: LootTable;
  floorTable?: LootTable;
} {
  return {
    typeTable: LOOT_TABLES.BASIC_MELEE,
    floorTable: _world.floor === 1 ? LOOT_TABLES.FLOOR_1 : undefined,
  };
}

/**
 * Track which entities have been processed this frame to prevent double-spawning.
 * Uses per-frame tracking (cleared each frame) to avoid eid recycling issues.
 */
const processedDeaths = new WeakMap<GameWorld, { frame: number; eids: Set<number> }>();

function getProcessedDeaths(world: GameWorld): Set<number> {
  let tracking = processedDeaths.get(world);
  const currentFrame = world.frameCount;
  if (!tracking || tracking.frame !== currentFrame) {
    tracking = { frame: currentFrame, eids: new Set() };
    processedDeaths.set(world, tracking);
  }
  return tracking.eids;
}

function spawnDrops(world: GameWorld, x: number, y: number, drops: LootDrop[]): void {
  for (const drop of drops) {
    // Scatter drops slightly around the death position
    const offsetX = (world.rng.next() - 0.5) * 20;
    const offsetY = (world.rng.next() - 0.5) * 20;
    const dx = x + offsetX;
    const dy = y + offsetY;

    switch (drop.type) {
      case 'gold':
        for (let i = 0; i < drop.quantity; i++) {
          const gx = dx + (world.rng.next() - 0.5) * 8;
          const gy = dy + (world.rng.next() - 0.5) * 8;
          spawnGold(world, gx, gy, drop.value);
        }
        break;
      case 'xp':
        for (let i = 0; i < drop.quantity; i++) {
          const ex = dx + (world.rng.next() - 0.5) * 8;
          const ey = dy + (world.rng.next() - 0.5) * 8;
          spawnXpGem(world, ex, ey, drop.value);
        }
        break;
      case 'item':
        if (drop.itemId) {
          const itemIndex = getItemIndex(drop.itemId);
          if (itemIndex >= 0) {
            for (let i = 0; i < drop.quantity; i++) {
              spawnDroppedItem(world, dx, dy, itemIndex);
            }
          }
        }
        break;
    }
  }
}

export function dropSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Health]);
  const { health, position } = world.stores;
  const processed = getProcessedDeaths(world);

  for (const eid of Array.from(entities)) {
    if (eid === undefined) continue;

    const currentHealth = health.current[eid] ?? 0;
    if (currentHealth > 0) continue;
    if (!hasComponent(world.ecs, eid, Enemy)) continue;
    if (processed.has(eid)) continue;

    processed.add(eid);

    const x = position.x[eid] ?? 0;
    const y = position.y[eid] ?? 0;
    const maxHp = health.max[eid] ?? 0;
    const overkill = Math.abs(currentHealth);

    // Resolve and roll loot tables
    const tables = getEnemyLootTables(world, eid);
    const entries = resolveLootTables(
      tables.entityTable,
      tables.typeTable,
      tables.areaTable,
      tables.floorTable,
    );
    const drops = rollLootTable(entries, world.rng);
    spawnDrops(world, x, y, drops);

    // Emit death combat event for gore VFX
    world.combatEvents.push({
      type: 'death',
      x,
      y,
      amount: maxHp,
      targetType: 'enemy',
      timestamp: world.elapsedMs,
      targetEid: eid,
      overkill,
    });
  }
}

/** Clear processed deaths tracking (no-op — tracking is now per-frame). */
export function clearProcessedDeaths(_world: GameWorld): void {
  // Per-frame tracking auto-resets on each new frameCount, so this is a no-op.
  // Kept for API compatibility.
}
