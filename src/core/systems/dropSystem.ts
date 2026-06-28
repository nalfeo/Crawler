/**
 * Drop System — spawns loot when enemies die.
 *
 * Runs BEFORE healthSystem so it can read position data before entity removal.
 * Queries enemies at 0 HP, rolls the loot table, and spawns Gold/XpGem/DroppedItem
 * entities at the death position. Also emits 'death' combat events for gore VFX
 * and applies death knockback.
 */
import { query, addComponent, hasComponent, set, setComponent } from 'bitecs';
import {
  BloodColor,
  Damage,
  DeathTimer,
  Enemy,
  Health,
  Knockback,
  SpawnAnim,
  Sprite,
} from '../components.js';
import {
  DEFAULT_BLOOD_COLOR,
  spawnBehaviorEnemy,
  spawnDroppedItem,
  spawnGold,
  spawnXpGem,
} from '../helpers.js';
import type { GameWorld } from '../world.js';
import {
  getEnemyDropConfig,
  rollLootTable,
  resolveLootTables,
  LOOT_TABLES,
  type LootDrop,
  type LootTable,
} from '../../shared/loot-tables.js';
import { getItemIndex } from '../../shared/items.js';
import { createLogger } from '../../shared/logger.js';
import { MINI_SLIME_SPAWN_ANIM_MS } from '../../shared/spawn-anim.js';
import { markImmuneToActiveMeleeSwings } from './meleeSwingSystem.js';

const logger = createLogger('core:drop-system');

/** Base knockback distance for death (1 foot). Scales with overkill. */
const DEATH_KNOCKBACK_BASE = 1;
/** Max knockback distance on death (8 feet). */
const DEATH_KNOCKBACK_MAX = 8;
/** Knockback speed (feet per frame-step). */
const DEATH_KNOCKBACK_SPEED = 0.75;
/** How long a dead entity persists before removal (ms). */
const DEATH_LINGER_MS = 3000;
const DEFAULT_CONTACT_DAMAGE = 5;
// Keep in sync with AI_TYPE.LEAPER in src/game/enemyAISystem.ts.
const SLIME_LEAPER_AI_TYPE = 3;
const SLIME_SPLIT_CHANCE = 0.35;
const MINI_SLIME_COUNT = 2;
const MINI_SLIME_SIZE_SCALE = 0.65;
/**
 * Floor for a baby slime's sprite size in feet, so a degenerate (zero-width)
 * parent can't yield an invisible baby. Equal to the legacy 1px floor ÷
 * PIXELS_PER_FOOT; real slimes (2–3.75 ft wide) never reach it.
 */
const MINI_SLIME_MIN_SIZE_FT = 0.125;

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
    const offsetX = (world.rng.next() - 0.5) * 2.5;
    const offsetY = (world.rng.next() - 0.5) * 2.5;
    const dx = x + offsetX;
    const dy = y + offsetY;

    switch (drop.type) {
      case 'gold':
        for (let i = 0; i < drop.quantity; i++) {
          // Always consume RNG to keep the seeded sequence stable regardless
          // of whether drops are currently gated (Floor 1 onboarding pacing).
          const gx = dx + (world.rng.next() - 0.5) * 1;
          const gy = dy + (world.rng.next() - 0.5) * 1;
          if (allowDrops) {
            spawnGold(world, gx, gy, drop.value);
          }
        }
        break;
      case 'xp':
        for (let i = 0; i < drop.quantity; i++) {
          // Always consume RNG to keep the seeded sequence stable regardless
          // of whether drops are currently gated.
          const ex = dx + (world.rng.next() - 0.5) * 1;
          const ey = dy + (world.rng.next() - 0.5) * 1;
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
  const parentSpeed = world.stores.enemyBehavior.speed[eid] ?? 0.1125;
  const parentAggroRange = world.stores.enemyBehavior.aggroRange[eid] ?? 40;
  const hasSprite = hasComponent(world.ecs, eid, Sprite);
  const parentSpriteTexture = hasSprite ? (world.stores.sprite.textureId[eid] ?? 0) : 0;
  const parentSpriteWidth = hasSprite ? (world.stores.sprite.width[eid] ?? 2) : 2;
  const parentSpriteHeight = hasSprite ? (world.stores.sprite.height[eid] ?? 2) : 2;
  const miniWidth = Math.max(MINI_SLIME_MIN_SIZE_FT, parentSpriteWidth * MINI_SLIME_SIZE_SCALE);
  const miniHeight = Math.max(MINI_SLIME_MIN_SIZE_FT, parentSpriteHeight * MINI_SLIME_SIZE_SCALE);
  // Inherit blood colour from the parent slime
  const parentBloodColor = hasComponent(world.ecs, eid, BloodColor)
    ? (world.stores.bloodColor.r[eid]! << 16) |
      (world.stores.bloodColor.g[eid]! << 8) |
      world.stores.bloodColor.b[eid]!
    : undefined;

  for (let i = 0; i < MINI_SLIME_COUNT; i += 1) {
    const angle = world.rng.next() * Math.PI * 2;
    const distance = 0.5 + world.rng.next() * 1.5;
    const miniEid = spawnBehaviorEnemy(
      world,
      x + Math.cos(angle) * distance,
      y + Math.sin(angle) * distance,
      miniHp,
      SLIME_LEAPER_AI_TYPE,
      Math.max(0.05, parentSpeed),
      Math.max(6, parentAggroRange),
      0,
      {
        persona: world.stores.enemyBehavior.persona[eid] ?? 0,
        traversalMode: world.stores.enemyBehavior.traversalMode[eid] ?? 0,
        flankDistance: world.stores.enemyBehavior.flankDistance[eid] ?? 12,
        pathRefreshFrames: world.stores.enemyBehavior.pathRefreshFrames[eid] ?? 10,
        isFlying: (world.stores.enemyBehavior.traversalMode[eid] ?? 0) === 1,
        weight: Math.max(1, (world.stores.weight.value[eid] ?? 120) * 0.5),
        bloodColor: parentBloodColor,
      },
    );
    setComponent(world.ecs, miniEid, Sprite, {
      textureId: parentSpriteTexture,
      width: miniWidth,
      height: miniHeight,
    });
    addComponent(world.ecs, miniEid, set(Damage, { amount: miniDamage }));
    // Babies pop out smaller and wiggle into existence; spawnAnimSystem ticks the
    // timer and strips SpawnAnim when it expires (purely cosmetic).
    addComponent(
      world.ecs,
      miniEid,
      set(SpawnAnim, {
        remainingMs: MINI_SLIME_SPAWN_ANIM_MS,
        totalMs: MINI_SLIME_SPAWN_ANIM_MS,
      }),
    );
    world.floor1?.enemyArchetypes.set(miniEid, 'slime-mini');
    // Survive the swing that killed the parent: register this baby in every
    // active melee swing's hit set so the player must swing again to kill it.
    markImmuneToActiveMeleeSwings(world, miniEid);
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
  const allowFloorDrops = !world.floor1 || world.goalFlags.get('floor1-drops-unlocked') === true;

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
    const archetypeId = world.floor1?.enemyArchetypes.get(eid);
    const allowEnemyDrops = getEnemyDropConfig(archetypeId)?.dropsEnabled ?? true;
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
      spawnDrops(world, x, y, drops, allowFloorDrops && allowEnemyDrops);
      logger.info('Processed enemy death drops', {
        eid,
        archetypeId,
        x,
        y,
        dropCount: drops.length,
        floor: world.floor,
      });
    }

    // Emit death combat event for gore VFX (with direction info)
    const bloodColor = hasComponent(world.ecs, eid, BloodColor)
      ? (world.stores.bloodColor.r[eid]! << 16) |
        (world.stores.bloodColor.g[eid]! << 8) |
        world.stores.bloodColor.b[eid]!
      : DEFAULT_BLOOD_COLOR;
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
      sourceX: killDirX !== 0 || killDirY !== 0 ? x - killDirX * 2.5 : undefined,
      sourceY: killDirX !== 0 || killDirY !== 0 ? y - killDirY * 2.5 : undefined,
      bloodColor,
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
