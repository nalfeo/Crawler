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
  FamilyMembership,
  Health,
  Knockback,
  Owner,
  Size,
  SpawnAnim,
  Spawner,
  Sprite,
} from '../components.js';
import {
  DEFAULT_BLOOD_COLOR,
  setEnemyAppearanceKey,
  spawnBehaviorEnemy,
  spawnDroppedItem,
  spawnGold,
  spawnXpGem,
} from '../helpers.js';
import type { GameWorld } from '../world.js';
import { MAX_BLOOD_POOLS, createBloodPoolSurface } from '../../shared/blood-surfaces.js';
import {
  getEnemyDropConfig,
  rollLootTable,
  resolveLootTables,
  LOOT_TABLES,
  getLootTable,
  type LootDrop,
  type LootTable,
} from '../../shared/loot-tables.js';
import { getItemIndex } from '../../shared/items.js';
import { createLogger } from '../../shared/logger.js';
import { MINI_SLIME_SPAWN_ANIM_MS } from '../../shared/spawn-anim.js';
import type { EntitySpriteMappings } from '../../shared/data/entity-sprite-mappings.js';
import ENTITY_SPRITE_MAPPINGS from '../../shared/data/entity-sprite-mappings.json';
import { markImmuneToActiveMeleeSwings } from './meleeSwingSystem.js';
import { getFloorManifest } from '../../shared/floor-registry.js';
import { SPAWNER_MAX_BANKED_CHILDREN } from '../spawner-arena.js';
import { getBodyHalfWidth, getBodyHalfHeight } from '../physics-body.js';
import { SHAPE_CIRCLE } from '../physics-defs.js';
import { CORPSE, MINI_SLIME_COLLISION_EPSILON_FT } from '../../shared/constants.js';

const logger = createLogger('core:drop-system');

/** Base knockback distance for death (1 foot). Scales with overkill. */
const DEATH_KNOCKBACK_BASE = 1;
/** Max knockback distance on death (8 feet). */
const DEATH_KNOCKBACK_MAX = 8;
/** Knockback speed (feet per frame-step). */
const DEATH_KNOCKBACK_SPEED = 0.75;
const DEFAULT_CONTACT_DAMAGE = 5;
// Keep in sync with AI_TYPE.LEAPER in src/game/enemyAISystem.ts.
const SLIME_LEAPER_AI_TYPE = 3;
const SLIME_SPLIT_CHANCE = 0.35;
const MINI_SLIME_COUNT = 2;
const MINI_SLIME_SIZE_SCALE = 0.65;
const MINI_SLIME_TEXTURE_ID = (ENTITY_SPRITE_MAPPINGS as EntitySpriteMappings).enemies
  .enemy_baby_slime?.textureId;
/**
 * Floor for a baby slime's sprite size in feet, so a degenerate (zero-width)
 * parent can't yield an invisible baby. Equal to the legacy 1px floor ÷
 * PIXELS_PER_FOOT; real slimes (2–3.75 ft wide) never reach it.
 */
const MINI_SLIME_MIN_SIZE_FT = 0.125;
/**
 * Minimum spawn distance for baby slimes (feet).
 * Increased from 0.5 to 1.5 so babies are ejected further from parent body.
 */
const MINI_SLIME_SPAWN_MIN_DIST = 1.5;
/**
 * Maximum spawn distance for baby slimes (feet).
 * Increased from 2.0 to 3.5 so babies are ejected further from parent body for greater separation.
 */
const MINI_SLIME_SPAWN_MAX_DIST = 3.5;
/**
 * How many randomized angle/distance candidates to try before giving up and
 * falling back to the parent's own (necessarily-passable) death position.
 * Bounded so a fully wall-hemmed death spot can't loop indefinitely.
 */
const MINI_SLIME_SPAWN_MAX_ATTEMPTS = 8;
// Sample just inside the candidate footprint so exact tile-edge contact does
// not read as a wall hit because of floating-point rounding. Mirrors
// knockbackSystem's COLLISION_EPSILON.
/**
 * Whether a baby slime's full footprint (not just its center point) would fit
 * on passable ground at (x, y). Without this check, a candidate position
 * offset from the parent's death spot by up to MINI_SLIME_SPAWN_MAX_DIST can
 * land inside a wall whenever the parent dies near one, leaving the baby
 * stuck. Falls back to `true` when there is no floor map (e.g. labs/tests).
 */
function isMiniSlimeSpawnPassable(
  world: GameWorld,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return true;
  }

  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const left = x - halfWidth + MINI_SLIME_COLLISION_EPSILON_FT;
  const right = x + halfWidth - MINI_SLIME_COLLISION_EPSILON_FT;
  const top = y - halfHeight + MINI_SLIME_COLLISION_EPSILON_FT;
  const bottom = y + halfHeight - MINI_SLIME_COLLISION_EPSILON_FT;

  return (
    floorMap.isPassableAt(x, y) &&
    floorMap.isPassableAt(left, top) &&
    floorMap.isPassableAt(right, top) &&
    floorMap.isPassableAt(left, bottom) &&
    floorMap.isPassableAt(right, bottom)
  );
}

export interface DropSystemOptions {
  readonly spawnLoot?: boolean;
  readonly deathLingerMs?: number;
}

/**
 * Resolve which loot tables apply for a given enemy.
 * Boss entities (tracked via floor1 objective bossBattles) receive a dedicated
 * boss-tier loot table instead of the standard BASIC_MELEE + floor bonus.
 * BOSS_MINOR is used for the mid-floor Slime Rat encounter; BOSS for the final
 * Rat Slime staircase boss.
 */
function getEnemyLootTables(
  world: GameWorld,
  eid: number,
): {
  entityTable?: LootTable;
  typeTable?: LootTable;
  areaTable?: LootTable;
  floorTable?: LootTable;
} {
  // Detect boss entities by checking both floor encounter registries.
  // dropSystem runs before floorObjectiveSystem each frame, so bossEid is still
  // set when we process the death; it gets nulled out later that same tick.
  const bossRegistries = [
    world.floorScenario?.objective?.bossBattles,
    world.floorExtendedState?.familyState?.bossEncounters,
  ];
  for (const registry of bossRegistries) {
    if (registry) {
      for (const battle of registry.values()) {
        if (battle.bossEid !== eid) continue;
        const bossTable =
          (battle.lootTableId ? getLootTable(battle.lootTableId) : undefined) ?? LOOT_TABLES.BOSS;
        return { typeTable: bossTable };
      }
    }
  }

  const floorLootTableId = world.floorId
    ? getFloorManifest(world.floorId)?.floorLootTableId
    : undefined;
  return {
    typeTable: LOOT_TABLES.BASIC_MELEE,
    floorTable: floorLootTableId ? getLootTable(floorLootTableId) : undefined,
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
  interceptSpawnerOwnedXp: boolean,
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
          // of whether drops are currently gated. `interceptSpawnerOwnedXp`
          // skips the actual gem spawn (the caller banked the value into the
          // owning spawner) but still consumes the two scatter RNG rolls so
          // seed order matches the un-owned kill path exactly.
          const ex = dx + (world.rng.next() - 0.5) * 1;
          const ey = dy + (world.rng.next() - 0.5) * 1;
          if (allowDrops && !interceptSpawnerOwnedXp) {
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
  if (world.floorScenario?.enemyArchetypes.get(eid) !== 'slime') {
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
  const parentSpriteWidth = getBodyHalfWidth(world, eid, 'dropSystem') * 2 || 2;
  const parentSpriteHeight = getBodyHalfHeight(world, eid, 'dropSystem') * 2 || 2;
  const parentBaseWeight = world.stores.weight.value[eid] ?? 120;
  const miniWidth = Math.max(MINI_SLIME_MIN_SIZE_FT, parentSpriteWidth * MINI_SLIME_SIZE_SCALE);
  const miniHeight = Math.max(MINI_SLIME_MIN_SIZE_FT, parentSpriteHeight * MINI_SLIME_SIZE_SCALE);
  // Inherit blood colour from the parent slime
  const parentBloodColor = hasComponent(world.ecs, eid, BloodColor)
    ? (world.stores.bloodColor.r[eid]! << 16) |
      (world.stores.bloodColor.g[eid]! << 8) |
      world.stores.bloodColor.b[eid]!
    : undefined;

  for (let i = 0; i < MINI_SLIME_COUNT; i += 1) {
    // Try several randomized angle/distance offsets and only keep one whose
    // full footprint lands on passable ground; a fixed offset from the
    // parent's death spot can otherwise land inside a wall whenever the
    // parent dies near one (spawning a baby stuck in the wall). Falls back to
    // the parent's own death position — which was necessarily passable —
    // if every attempt fails (e.g. a fully wall-hemmed corner).
    let miniX = x;
    let miniY = y;
    for (let attempt = 0; attempt < MINI_SLIME_SPAWN_MAX_ATTEMPTS; attempt += 1) {
      const angle = world.rng.next() * Math.PI * 2;
      const distance =
        MINI_SLIME_SPAWN_MIN_DIST +
        world.rng.next() * (MINI_SLIME_SPAWN_MAX_DIST - MINI_SLIME_SPAWN_MIN_DIST);
      const candidateX = x + Math.cos(angle) * distance;
      const candidateY = y + Math.sin(angle) * distance;
      if (isMiniSlimeSpawnPassable(world, candidateX, candidateY, miniWidth, miniHeight)) {
        miniX = candidateX;
        miniY = candidateY;
        break;
      }
    }
    const miniEid = spawnBehaviorEnemy(
      world,
      miniX,
      miniY,
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
        weight: Math.max(1, parentBaseWeight * 0.5),
        bloodColor: parentBloodColor,
      },
    );
    setComponent(world.ecs, miniEid, Sprite, {
      textureId: MINI_SLIME_TEXTURE_ID ?? parentSpriteTexture,
      width: miniWidth,
      height: miniHeight,
    });
    setComponent(world.ecs, miniEid, Size, {
      radius: Math.max(miniWidth, miniHeight) * 0.5,
      halfWidth: 0,
      halfHeight: 0,
      shape: SHAPE_CIRCLE,
    });
    setEnemyAppearanceKey(world, miniEid, 'slime-mini');
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
    world.floorScenario?.enemyArchetypes.set(miniEid, 'slime-mini');
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
  const deathLingerMs = options.deathLingerMs ?? CORPSE.LINGER_MS;
  // Floor 1 onboarding pacing: gold, XP, and junk only start dropping after the
  // player finds the Welcome Office and the Tutorial Goon explains the rules.
  // Off-floor (e.g. labs) drops are always enabled.
  const allowFloorDrops =
    !world.floorScenario || world.goalFlags.get('floor1-drops-unlocked') === true;

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
    const archetypeId = world.floorScenario?.enemyArchetypes.get(eid);
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
    let killingSourceEid: number | undefined;
    for (let i = world.combatEvents.length - 1; i >= 0; i--) {
      const evt = world.combatEvents[i]!;
      if (evt.targetEid === eid && evt.type === 'hit') {
        killingSourceEid = evt.sourceEid;
        if (evt.sourceX !== undefined && evt.sourceY !== undefined) {
          const dx = x - evt.sourceX;
          const dy = y - evt.sourceY;
          const dist = Math.hypot(dx, dy);
          if (dist > 0.01) {
            killDirX = dx / dist;
            killDirY = dy / dist;
          }
        }
        break;
      }
    }
    killingSourceEid ??= world.lethalDamageSourceByTarget.get(eid);
    world.lethalDamageSourceByTarget.delete(eid);

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
      // Spawner-arena XP intercept (spec `Requirements§4,5,7`): a spawner-owned
      // child NEVER drops an on-map XP gem (requirement 4 — "mobs spawned by
      // spawners do NOT drop experience"). Its XP portion is instead banked on
      // the owning spawner and awarded once when the arena resolves. The
      // banking is capped at SPAWNER_MAX_BANKED_CHILDREN kills (anti-farm), but
      // that cap ONLY limits how much XP is banked — it does NOT re-enable
      // on-map XP drops for the 11th+ kill. We do the intercept AFTER
      // `rollLootTable` so the RNG stream stays exactly the same as it would in
      // the un-owned case — only the destination of the XP entries changes.
      const ownerEid = hasComponent(world.ecs, eid, Owner)
        ? (world.stores.owner.eid[eid] ?? -1)
        : -1;
      if (ownerEid >= 0 && hasComponent(world.ecs, ownerEid, Spawner)) {
        const bankedChildren = world.stores.spawner.bankedChildren[ownerEid] ?? 0;
        // Only bank when the un-intercepted path would actually have spawned
        // XP gems. Otherwise the spawner would grant XP that its children
        // couldn't — violating the user's verbatim spec ("equal to the amount
        // that would have dropped from killing the number of spawned mobs")
        // and bypassing Floor-1 onboarding drop gates. This gate controls only
        // the banked reward; the on-map XP gem is suppressed unconditionally
        // below so requirement 4 holds for every owned kill.
        const dropsAllowed = allowFloorDrops && allowEnemyDrops;
        if (dropsAllowed && bankedChildren < SPAWNER_MAX_BANKED_CHILDREN) {
          let intercepted = 0;
          for (const drop of drops) {
            if (drop.type !== 'xp') continue;
            // Bank total value = value × quantity. spawnDrops still consumes
            // its per-gem scatter RNG below because we leave the drop entry
            // in the list with its original quantity — we just tell spawnDrops
            // to skip spawning the XP gem for this specific enemy (via the
            // `interceptSpawnerOwnedXp` flag). Preserves seed order.
            intercepted += drop.value * drop.quantity;
          }
          if (intercepted > 0) {
            world.stores.spawner.bankedXp[ownerEid] =
              (world.stores.spawner.bankedXp[ownerEid] ?? 0) + intercepted;
            world.stores.spawner.bankedChildren[ownerEid] = bankedChildren + 1;
            logger.info('Spawner arena banked XP from child kill', {
              childEid: eid,
              spawnerEid: ownerEid,
              intercepted,
              bankedTotal: world.stores.spawner.bankedXp[ownerEid],
              bankedChildren: world.stores.spawner.bankedChildren[ownerEid],
            });
          }
        }
        // Requirement 4: suppress the on-map XP gem for EVERY spawner-owned
        // child, whether or not it was banked (beyond the cap or drop-gated).
        // Gold/items still drop normally inside spawnDrops when drops are
        // allowed; only the XP gem is intercepted. RNG-neutral: spawnDrops
        // always consumes its scatter rolls regardless of the intercept flag.
        spawnDrops(world, x, y, drops, allowFloorDrops && allowEnemyDrops, true);
      } else {
        spawnDrops(world, x, y, drops, allowFloorDrops && allowEnemyDrops, false);
      }
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
    const familyIndex = hasComponent(world.ecs, eid, FamilyMembership)
      ? (world.stores.familyMembership.familyId[eid] ?? -1)
      : -1;
    const isBoss = hasComponent(world.ecs, eid, FamilyMembership)
      ? ((world.stores.familyMembership.isBoss[eid] ?? 0) as 0 | 1)
      : 0;
    const enemySizeFt = Math.max(
      getBodyHalfWidth(world, eid, 'dropSystem') * 2,
      getBodyHalfHeight(world, eid, 'dropSystem') * 2,
    );
    world.bloodPools.push(
      createBloodPoolSurface({
        worldSeed: world.seed,
        poolId: world.bloodyFootprintState.nextPoolId++,
        x,
        y,
        color: bloodColor,
        overkill,
        enemySizeFt: enemySizeFt > 0 ? enemySizeFt : undefined,
        createdAtMs: world.elapsedMs,
      }),
    );
    if (world.bloodPools.length > MAX_BLOOD_POOLS) {
      world.bloodPools.splice(0, world.bloodPools.length - MAX_BLOOD_POOLS);
    }
    world.combatEvents.push({
      type: 'death',
      x,
      y,
      amount: maxHp,
      targetType: 'enemy',
      timestamp: world.elapsedMs,
      targetEid: eid,
      sourceEid: killingSourceEid,
      overkill,
      knockbackDirX: killDirX,
      knockbackDirY: killDirY,
      sourceX: killDirX !== 0 || killDirY !== 0 ? x - killDirX * 2.5 : undefined,
      sourceY: killDirX !== 0 || killDirY !== 0 ? y - killDirY * 2.5 : undefined,
      bloodColor,
      familyIndex: familyIndex >= 0 ? familyIndex : undefined,
      isBoss: familyIndex >= 0 ? isBoss : undefined,
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
