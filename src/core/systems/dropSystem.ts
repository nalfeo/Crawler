/**
 * Drop System — spawns loot when enemies die.
 *
 * Runs BEFORE healthSystem so it can read position data before entity removal.
 * Queries enemies at 0 HP, rolls the loot table, and spawns Gold/XpGem/DroppedItem
 * entities at the death position. Also emits 'death' combat events for gore VFX
 * and applies death knockback.
 */
import { query, addComponent, hasComponent, set, setComponent } from 'bitecs';
import { DeathTimer, Enemy, Health, Knockback } from '../components.js';
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
import { createLogger } from '../../shared/logger.js';

const logger = createLogger('core:drop-system');

/** Base knockback distance for death (pixels). Scales with overkill. */
const DEATH_KNOCKBACK_BASE = 8;
/** Max knockback distance on death. */
const DEATH_KNOCKBACK_MAX = 60;
/** Knockback speed (pixels per frame-step). */
const DEATH_KNOCKBACK_SPEED = 6;
/** How long a dead entity persists before removal (ms). */
const DEATH_LINGER_MS = 300;

/**
 * Resolve which loot tables apply for a given enemy.
 * Currently uses BASIC_MELEE for all enemies + floor-level table.
 * Future: read enemy-type component and area context.
 */
function getEnemyLootTables(
  world: GameWorld,
  _eid: number,
): {
  entityTable?: LootTable;
  typeTable?: LootTable;
  areaTable?: LootTable;
  floorTable?: LootTable;
} {
  return {
    typeTable: LOOT_TABLES.BASIC_MELEE,
    floorTable: world.floor === 1 ? LOOT_TABLES.FLOOR_1 : undefined,
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
  logger.debug('Spawning drops', {
    dropCount: drops.length,
    x,
    y,
    frameCount: world.frameCount,
  });

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
  const entities = query(world.ecs, [Enemy, Health]);
  const { health, position } = world.stores;
  const processed = getProcessedDeaths(world);

  for (const eid of Array.from(entities)) {
    if (eid === undefined) continue;

    const currentHealth = health.current[eid] ?? 0;
    if (currentHealth > 0) continue;
    if (processed.has(eid)) {
      logger.warn('Skipping duplicate death processing for enemy in same frame', {
        eid,
        frameCount: world.frameCount,
      });
      continue;
    }
    // Skip entities already in death linger (processed on a prior frame)
    if (hasComponent(world.ecs, eid, DeathTimer)) continue;

    processed.add(eid);

    const x = position.x[eid] ?? 0;
    const y = position.y[eid] ?? 0;
    const maxHp = health.max[eid] ?? 0;
    // Overkill tracking: applyDamage clamps HP to 0, so we cannot derive
    // true overkill here. Currently always 0; will be properly tracked once
    // applyDamage stores excess damage on the entity (follow-up).
    const overkill = 0;

    // Find the killing blow direction from the most recent hit event on this entity
    let killDirX = 0;
    let killDirY = 0;
    for (let i = world.combatEvents.length - 1; i >= 0; i--) {
      const evt = world.combatEvents[i]!;
      if (
        evt.targetEid === eid &&
        evt.type === 'hit' &&
        evt.sourceX !== undefined &&
        evt.sourceY !== undefined
      ) {
        const dx = x - evt.sourceX;
        const dy = y - evt.sourceY;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.01) {
          killDirX = dx / dist;
          killDirY = dy / dist;
        }
        break;
      }
    }

    // Apply death knockback (small impulse in the killing blow direction)
    const knockbackDist = Math.min(DEATH_KNOCKBACK_MAX, DEATH_KNOCKBACK_BASE + overkill * 2);
    if (knockbackDist > 0 && Math.abs(killDirX) + Math.abs(killDirY) > 0.01) {
      if (hasComponent(world.ecs, eid, Knockback)) {
        setComponent(world.ecs, eid, Knockback, {
          dirX: killDirX,
          dirY: killDirY,
          remaining: knockbackDist,
          speed: DEATH_KNOCKBACK_SPEED,
        });
      } else {
        addComponent(
          world.ecs,
          eid,
          set(Knockback, {
            dirX: killDirX,
            dirY: killDirY,
            remaining: knockbackDist,
            speed: DEATH_KNOCKBACK_SPEED,
          }),
        );
      }
    }

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
    logger.info('Processed enemy death drops', {
      eid,
      x,
      y,
      dropCount: drops.length,
      floor: world.floor,
    });

    // Emit death combat event for gore VFX (with direction info)
    world.combatEvents.push({
      type: 'death',
      x,
      y,
      amount: maxHp,
      targetType: 'enemy',
      timestamp: world.elapsedMs,
      targetEid: eid,
      overkill,
      knockbackDirX: killDirX,
      knockbackDirY: killDirY,
      sourceX: killDirX !== 0 || killDirY !== 0 ? x - killDirX * 20 : undefined,
      sourceY: killDirX !== 0 || killDirY !== 0 ? y - killDirY * 20 : undefined,
    });

    // Add death linger timer so entity persists for knockback/death animation
    addComponent(world.ecs, eid, set(DeathTimer, { remainingMs: DEATH_LINGER_MS }));
  }
}

/** Clear processed deaths tracking (no-op — tracking is now per-frame). */
export function clearProcessedDeaths(_world: GameWorld): void {
  // Per-frame tracking auto-resets on each new frameCount, so this is a no-op.
  // Kept for API compatibility.
}
