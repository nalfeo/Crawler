/**
 * Drop System — spawns loot when enemies die.
 *
 * Runs BEFORE healthSystem so it can read position data before entity removal.
 * Queries enemies at 0 HP, rolls the loot table, and spawns Gold/XpGem/DroppedItem
 * entities at the death position. Also emits 'death' combat events for gore VFX
 * and applies death knockback.
 */
import { query, addComponent, hasComponent, set, setComponent } from 'bitecs';
import { Damage, DeathTimer, Enemy, Health, Knockback, Sprite } from '../components.js';
import { spawnBehaviorEnemy, spawnDroppedItem, spawnGold, spawnXpGem } from '../helpers.js';
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
import { ftToPx } from '../../shared/units.js';

const logger = createLogger('core:drop-system');

/** Base knockback distance for death (1 foot). Scales with overkill. */
const DEATH_KNOCKBACK_BASE = ftToPx(1);
/** Max knockback distance on death (8 feet). */
const DEATH_KNOCKBACK_MAX = ftToPx(8);
/** Knockback speed (pixels per frame-step). */
const DEATH_KNOCKBACK_SPEED = 6;
/** How long a dead entity persists before removal (ms). */
const DEATH_LINGER_MS = 300;
const DEFAULT_CONTACT_DAMAGE = 5;
const SLIME_LEAPER_AI_TYPE = 3;
const SLIME_SPLIT_CHANCE = 0.5;
const MINI_SLIME_COUNT = 2;
const MINI_SLIME_SIZE_SCALE = 0.65;

export interface DropSystemOptions {
  readonly spawnLoot?: boolean;
  readonly deathLingerMs?: number;
}

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

function spawnDrops(
  world: GameWorld,
  x: number,
  y: number,
  drops: LootDrop[],
  allowDrops: boolean,
): void {
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
          // Always consume RNG to keep the seeded sequence stable regardless
          // of whether drops are currently gated (Floor 1 onboarding pacing).
          const gx = dx + (world.rng.next() - 0.5) * 8;
          const gy = dy + (world.rng.next() - 0.5) * 8;
          if (allowDrops) {
            spawnGold(world, gx, gy, drop.value);
          }
        }
        break;
      case 'xp':
        for (let i = 0; i < drop.quantity; i++) {
          // Always consume RNG to keep the seeded sequence stable regardless
          // of whether drops are currently gated.
          const ex = dx + (world.rng.next() - 0.5) * 8;
          const ey = dy + (world.rng.next() - 0.5) * 8;
          if (allowDrops) {
            spawnXpGem(world, ex, ey, drop.value);
          }
        }

        break;
      case 'item':
        if (drop.itemId && allowDrops) {
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

function maybeSplitSlime(world: GameWorld, eid: number, x: number, y: number): void {
  if (world.floor1?.enemyArchetypes.get(eid) !== 'slime') {
    return;
  }
  if (world.rng.next() >= SLIME_SPLIT_CHANCE) {
    return;
  }

  const parentMaxHp = world.stores.health.max[eid] ?? 0;
  const miniHp = Math.max(1, Math.round(parentMaxHp * 0.5));
  const parentDamage = hasComponent(world.ecs, eid, Damage)
    ? Math.max(1, world.stores.damage.amount[eid] ?? DEFAULT_CONTACT_DAMAGE)
    : DEFAULT_CONTACT_DAMAGE;
  const miniDamage = Math.max(1, Math.round(parentDamage * 0.5));
  const parentSpeed = world.stores.enemyBehavior.speed[eid] ?? 0.9;
  const parentAggroRange = world.stores.enemyBehavior.aggroRange[eid] ?? 320;
  const parentSpriteTexture = world.stores.sprite.textureId[eid] ?? 0;
  const parentSpriteWidth = world.stores.sprite.width[eid] ?? 16;
  const parentSpriteHeight = world.stores.sprite.height[eid] ?? 16;
  const miniWidth = Math.max(8, Math.round(parentSpriteWidth * MINI_SLIME_SIZE_SCALE));
  const miniHeight = Math.max(8, Math.round(parentSpriteHeight * MINI_SLIME_SIZE_SCALE));

  for (let i = 0; i < MINI_SLIME_COUNT; i += 1) {
    const angle = world.rng.next() * Math.PI * 2;
    const distance = 4 + world.rng.next() * 12;
    const miniEid = spawnBehaviorEnemy(
      world,
      x + Math.cos(angle) * distance,
      y + Math.sin(angle) * distance,
      miniHp,
      SLIME_LEAPER_AI_TYPE,
      Math.max(0.4, parentSpeed),
      Math.max(48, parentAggroRange),
      0,
      {
        persona: world.stores.enemyBehavior.persona[eid] ?? 0,
        traversalMode: world.stores.enemyBehavior.traversalMode[eid] ?? 0,
        flankDistance: world.stores.enemyBehavior.flankDistance[eid] ?? 96,
        pathRefreshFrames: world.stores.enemyBehavior.pathRefreshFrames[eid] ?? 10,
        isFlying: (world.stores.enemyBehavior.traversalMode[eid] ?? 0) === 1,
        weight: Math.max(1, (world.stores.weight.value[eid] ?? 120) * 0.5),
      },
    );
    setComponent(world.ecs, miniEid, Sprite, {
      textureId: parentSpriteTexture,
      width: miniWidth,
      height: miniHeight,
    });
    addComponent(world.ecs, miniEid, set(Damage, { amount: miniDamage }));
    world.floor1?.enemyArchetypes.set(miniEid, 'slime-mini');
  }
}

export function dropSystem(world: GameWorld, options: DropSystemOptions = {}): void {
  const entities = query(world.ecs, [Enemy, Health]);
  const { health, position } = world.stores;
  const processed = getProcessedDeaths(world);
  const spawnLoot = options.spawnLoot ?? true;
  const deathLingerMs = options.deathLingerMs ?? DEATH_LINGER_MS;
  // Floor 1 onboarding pacing: gold, XP, and junk only start dropping after the
  // player finds the Welcome Office and the Tutorial Goon explains the rules.
  // Off-floor (e.g. labs) drops are always enabled.
  const allowDrops = !world.floor1 || world.goalFlags.get('floor1-drops-unlocked') === true;

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
    maybeSplitSlime(world, eid, x, y);
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

    if (spawnLoot) {
      // Resolve and roll loot tables
      const tables = getEnemyLootTables(world, eid);
      const entries = resolveLootTables(
        tables.entityTable,
        tables.typeTable,
        tables.areaTable,
        tables.floorTable,
      );
      const drops = rollLootTable(entries, world.rng);
      spawnDrops(world, x, y, drops, allowDrops);
      logger.info('Processed enemy death drops', {
        eid,
        x,
        y,
        dropCount: drops.length,
        floor: world.floor,
      });
    }

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
    addComponent(world.ecs, eid, set(DeathTimer, { remainingMs: deathLingerMs }));
  }
}

/** Clear processed deaths tracking (no-op — tracking is now per-frame). */
export function clearProcessedDeaths(_world: GameWorld): void {
  // Per-frame tracking auto-resets on each new frameCount, so this is a no-op.
  // Kept for API compatibility.
}
