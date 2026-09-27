import { entityExists, hasComponent, query, removeEntity } from 'bitecs';
import {
  familyDamagePermission,
  getCombatFamilyIndex,
  getCombatSourceEid,
} from '../family-combat.js';
import type { CollisionResult } from './collisionSystem.js';
import {
  Companion,
  Damage,
  DeathTimer,
  Enemy,
  EnemyProjectile,
  EffectiveStats,
  Glowing,
  Health,
  Homing,
  Owner,
  Player,
  Projectile,
  Returning,
  SiegeHero,
  SiegeMinion,
  Team,
} from '../components.js';
import { applyDamage } from '../apply-damage.js';
import { readDamageMeta } from '../damage-meta.js';
import { clearEntityStores } from '../helpers.js';
import { isEntityInSafeSpace } from '../safe-space.js';
import type { GameWorld } from '../world.js';
import { emitWeaponHitSkillEventsForSource } from '../weapon-skill-bridge.js';
import { recordWeaponEnemyHit, pruneAttackEntity } from '../weapon-telemetry.js';
import { computeArmorReducedDamage } from '../combat-math.js';
import { getMobAbilityMeleeDamageMultiplier } from '../mob-abilities/runtime.js';
import { pushVfxEvent } from '../../shared/vfx-events.js';

/** Fallback impact tint for a Homing projectile with no `Glowing` color of its own. */
const HOMING_IMPACT_FALLBACK_COLOR = 0xc084fc;

const DEFAULT_PROJECTILE_DAMAGE = 10;
const DEFAULT_CONTACT_DAMAGE = 5;
const PLAYER_INVINCIBILITY_MS = 250;
const MAX_TRACKED_ENTITIES = 10_000;

/** Throttle: emit at most one 'blocked' event per invincibility window. */
const lastBlockedEventMs = new WeakMap<GameWorld, number>();

const playerHitTimestamps = new WeakMap<GameWorld, Float64Array>();

function getPlayerHitTimestamps(world: GameWorld): Float64Array {
  let hitTimestamps = playerHitTimestamps.get(world);

  if (hitTimestamps === undefined) {
    hitTimestamps = new Float64Array(MAX_TRACKED_ENTITIES);
    hitTimestamps.fill(-Infinity);
    playerHitTimestamps.set(world, hitTimestamps);
  }

  return hitTimestamps;
}

/** Per-projectile hit tracking for pierce (prevents double-hitting same enemy). */
const pierceHitSets = new WeakMap<GameWorld, Map<number, Set<number>>>();

function getPierceHitSet(world: GameWorld, eid: number): Set<number> {
  let worldHits = pierceHitSets.get(world);
  if (worldHits === undefined) {
    worldHits = new Map();
    pierceHitSets.set(world, worldHits);
  }
  let hits = worldHits.get(eid);
  if (hits === undefined) {
    hits = new Set();
    worldHits.set(eid, hits);
  }
  return hits;
}

export function clearProjectilePierceHits(world: GameWorld, eid: number): void {
  const worldHits = pierceHitSets.get(world);
  if (worldHits !== undefined) worldHits.delete(eid);
}

function destroyEntity(world: GameWorld, eid: number): void {
  clearEntityStores(world, eid);
  // Clean up pierce hit tracking
  clearProjectilePierceHits(world, eid);
  pruneAttackEntity(world, eid);
  removeEntity(world.ecs, eid);
}

function getDamageAmount(world: GameWorld, eid: number, fallbackAmount: number): number {
  if (!hasComponent(world.ecs, eid, Damage)) {
    return fallbackAmount;
  }

  // When the Damage component is present, trust its value — 0 is valid (e.g. miss
  // projectiles that exist purely for cosmetic animation).
  return world.stores.damage.amount[eid] ?? 0;
}

function applyArmorReduction(world: GameWorld, player: number, rawDamage: number): number {
  if (!hasComponent(world.ecs, player, EffectiveStats)) {
    return rawDamage;
  }
  const armor = world.stores.effectiveStats.armor[player] ?? 0;
  return computeArmorReducedDamage(rawDamage, armor);
}

function sameTeam(world: GameWorld, source: number, target: number): boolean {
  const familyPermission = familyDamagePermission(world, source, target);
  if (familyPermission !== undefined) return !familyPermission;
  return (
    hasComponent(world.ecs, source, Team) &&
    hasComponent(world.ecs, target, Team) &&
    (world.stores.team.id[source] ?? 0) === (world.stores.team.id[target] ?? 0)
  );
}

function projectileSource(world: GameWorld, projectile: number): number {
  if (getCombatFamilyIndex(world, projectile) !== undefined) return projectile;
  return hasComponent(world.ecs, projectile, Owner)
    ? (world.stores.owner.eid[projectile] ?? projectile)
    : projectile;
}

/** Emit a throttled 'blocked' event (max one per invincibility window). */
function emitBlockedEvent(world: GameWorld, player: number): void {
  const last = lastBlockedEventMs.get(world) ?? -Infinity;
  if (world.elapsedMs - last < PLAYER_INVINCIBILITY_MS) return;
  lastBlockedEventMs.set(world, world.elapsedMs);
  world.combatEvents.push({
    type: 'blocked',
    x: world.stores.position.x[player] ?? 0,
    y: world.stores.position.y[player] ?? 0,
    amount: 0,
    targetType: 'player',
    timestamp: world.elapsedMs,
    targetEid: player,
  });
}

function applyProjectileHit(world: GameWorld, projectile: number, enemy: number): void {
  // If this is the first hit for this projectile, clear stale hit tracking
  // from any previous entity that used the same recycled ECS ID.
  if ((world.stores.projectile.hitCount[projectile] ?? 0) === 0) {
    clearProjectilePierceHits(world, projectile);
  }

  // Check if this enemy was already hit by this piercing projectile
  const hitSet = getPierceHitSet(world, projectile);
  if (hitSet.has(enemy)) return;

  if (hasComponent(world.ecs, enemy, Health)) {
    const amount = getDamageAmount(world, projectile, DEFAULT_PROJECTILE_DAMAGE);
    const ownerEid = getCombatSourceEid(world, projectile) ?? -1;
    const dealt = applyDamage(
      world,
      enemy,
      amount,
      world.stores.position.x[enemy] ?? 0,
      world.stores.position.y[enemy] ?? 0,
      {
        ...readDamageMeta(world, projectile),
        sourceX: world.stores.position.x[projectile] ?? 0,
        sourceY: world.stores.position.y[projectile] ?? 0,
        sourceEid: ownerEid >= 0 ? ownerEid : undefined,
        sourceFamilyIndex: getCombatFamilyIndex(world, projectile),
      },
    );

    // Emit weapon skill XP for the projectile's owner when damage lands on an enemy.
    if (dealt > 0 && hasComponent(world.ecs, enemy, Enemy)) {
      if (ownerEid !== -1) {
        emitWeaponHitSkillEventsForSource(world, ownerEid, projectile);
      }
      recordWeaponEnemyHit(world, projectile, enemy);
    }

    // Permanently aggro this enemy so it chases regardless of detection range
    world.stores.enemyBehavior.aggroedPermanently[enemy] = 1;
  }

  hitSet.add(enemy);

  const pierce = world.stores.projectile.pierce[projectile] ?? 0;
  const hitCount = (world.stores.projectile.hitCount[projectile] ?? 0) + 1;
  world.stores.projectile.hitCount[projectile] = hitCount;

  if (hitCount > pierce) {
    if (hasComponent(world.ecs, projectile, Returning)) {
      world.stores.returning.isReturning[projectile] = 1;
      world.stores.projectile.pierce[projectile] = 255;
      world.stores.projectile.hitCount[projectile] = 0;
      clearProjectilePierceHits(world, projectile);
      return;
    }
    if (hasComponent(world.ecs, projectile, Homing)) {
      // Guided spell bolt (currently only Magic Missile — issue #3248): the
      // impact burst fires here, at its real point of contact, rather than
      // at cast time, since the missile now travels before it actually
      // connects. Color comes from the projectile's own `Glowing` light (so
      // a future non-Magic-Missile homing spell isn't forced into Magic
      // Missile's purple) and falls back to that purple only if the
      // projectile somehow has no `Glowing` component.
      const color = hasComponent(world.ecs, projectile, Glowing)
        ? ((world.stores.glowing.colorR[projectile] ?? 0) << 16) |
          ((world.stores.glowing.colorG[projectile] ?? 0) << 8) |
          (world.stores.glowing.colorB[projectile] ?? 0)
        : HOMING_IMPACT_FALLBACK_COLOR;
      pushVfxEvent(world.vfxEvents, {
        kind: 'arcaneBoltImpact',
        x: world.stores.position.x[projectile] ?? world.stores.position.x[enemy] ?? 0,
        y: world.stores.position.y[projectile] ?? world.stores.position.y[enemy] ?? 0,
        color,
      });
    }
    destroyEntity(world, projectile);
  }
}

function applyPlayerEnemyHit(
  world: GameWorld,
  player: number,
  enemy: number,
  hitTimestamps: Float64Array,
): void {
  // These hostile actors carry Enemy for player weapon hits, but their siege
  // systems exclusively own attacks and cooldowns against objective targets.
  if (hasComponent(world.ecs, enemy, SiegeMinion) || hasComponent(world.ecs, enemy, SiegeHero)) {
    return;
  }
  // Dead enemies keep their Enemy component during the death-linger window
  // (deathTimerSystem removes them once the corpse animation finishes). A
  // corpse must not deal contact damage just because the player walks over it.
  if (
    hasComponent(world.ecs, enemy, DeathTimer) ||
    (world.stores.health.current[enemy] ?? 0) <= 0
  ) {
    return;
  }
  if (isEntityInSafeSpace(world, player)) {
    return;
  }
  if (!hasComponent(world.ecs, player, Health)) {
    return;
  }

  const lastHitMs = hitTimestamps[player] ?? -Infinity;

  if (world.elapsedMs - lastHitMs < PLAYER_INVINCIBILITY_MS) {
    emitBlockedEvent(world, player);
    return;
  }

  const raw =
    getDamageAmount(world, enemy, DEFAULT_CONTACT_DAMAGE) *
    getMobAbilityMeleeDamageMultiplier(world, enemy);
  const hostileMult = world.hostileDamageMultiplier ?? 1;
  const scaled = raw * hostileMult;
  if (scaled <= 0) {
    return;
  }
  const amount = applyArmorReduction(world, player, scaled);
  applyDamage(
    world,
    player,
    amount,
    world.stores.position.x[player] ?? 0,
    world.stores.position.y[player] ?? 0,
    {
      origin: 'enemy',
      affinity: 'unscaled',
      scaleWithPrimary: false,
      canCrit: false,
      delivery: 'contact',
      sourceX: world.stores.position.x[enemy] ?? 0,
      sourceY: world.stores.position.y[enemy] ?? 0,
      sourceEid: enemy,
    },
  );
  hitTimestamps[player] = world.elapsedMs;
}

function applyEnemyProjectileHit(
  world: GameWorld,
  projectile: number,
  player: number,
  hitTimestamps: Float64Array,
): void {
  if (isEntityInSafeSpace(world, player)) {
    destroyEntity(world, projectile);
    return;
  }
  if (!hasComponent(world.ecs, player, Health)) {
    destroyEntity(world, projectile);
    return;
  }

  const lastHitMs = hitTimestamps[player] ?? -Infinity;

  if (world.elapsedMs - lastHitMs < PLAYER_INVINCIBILITY_MS) {
    emitBlockedEvent(world, player);
    destroyEntity(world, projectile);
    return;
  }

  const raw = getDamageAmount(world, projectile, DEFAULT_PROJECTILE_DAMAGE);
  const hostileMult = world.hostileDamageMultiplier ?? 1;
  const scaled = raw * hostileMult;
  if (scaled <= 0) {
    destroyEntity(world, projectile);
    return;
  }
  const amount = applyArmorReduction(world, player, scaled);
  const projectileOwner = getCombatSourceEid(world, projectile);
  applyDamage(
    world,
    player,
    amount,
    world.stores.position.x[player] ?? 0,
    world.stores.position.y[player] ?? 0,
    {
      origin: 'enemy',
      affinity: 'unscaled',
      scaleWithPrimary: false,
      canCrit: false,
      delivery: 'projectile',
      sourceX: world.stores.position.x[projectile] ?? 0,
      sourceY: world.stores.position.y[projectile] ?? 0,
      sourceEid:
        projectileOwner ??
        (getCombatFamilyIndex(world, projectile) === undefined ? projectile : undefined),
      sourceFamilyIndex: getCombatFamilyIndex(world, projectile),
      // Pass the archetype key snapshotted at projectile-spawn time so that
      // attribution in apply-damage is correct even if the shooter has been
      // reaped and its EID recycled before this hit occurs.
      sourceArchetypeKey: world.enemyProjectileArchetypeKeys.get(projectile),
    },
  );
  hitTimestamps[player] = world.elapsedMs;

  destroyEntity(world, projectile);
}

// One contact per living family attacker per contact interval, independent of
// ranged fire clocks. Generation checks prevent a recycled EID inheriting delay.
const familyContactTimes = new WeakMap<
  GameWorld,
  Map<number, { generation: number; atMs: number }>
>();

function applyFamilyContact(world: GameWorld, source: number, target: number): void {
  if (getCombatFamilyIndex(world, source) === undefined || sameTeam(world, source, target)) return;
  if (hasComponent(world.ecs, source, DeathTimer) || hasComponent(world.ecs, target, DeathTimer))
    return;
  if (
    !hasComponent(world.ecs, target, Health) ||
    (world.stores.health.current[source] ?? 0) <= 0 ||
    (world.stores.health.current[target] ?? 0) <= 0
  )
    return;
  const times = familyContactTimes.get(world) ?? new Map();
  familyContactTimes.set(world, times);
  const generation = world.entityRenderGeneration[source] ?? 0;
  const previous = times.get(source);
  if (
    previous?.generation === generation &&
    world.elapsedMs - previous.atMs < PLAYER_INVINCIBILITY_MS
  )
    return;
  const dealt = applyDamage(
    world,
    target,
    getDamageAmount(world, source, DEFAULT_CONTACT_DAMAGE) *
      getMobAbilityMeleeDamageMultiplier(world, source),
    world.stores.position.x[target] ?? 0,
    world.stores.position.y[target] ?? 0,
    {
      origin: 'enemy',
      affinity: 'unscaled',
      scaleWithPrimary: false,
      canCrit: false,
      delivery: 'contact',
      sourceEid: source,
      sourceX: world.stores.position.x[source] ?? 0,
      sourceY: world.stores.position.y[source] ?? 0,
    },
  );
  if (dealt > 0) times.set(source, { generation, atMs: world.elapsedMs });
}

export function damageSystem(world: GameWorld, collisionResult: CollisionResult): void {
  const hitTimestamps = getPlayerHitTimestamps(world);
  const players = query(world.ecs, [Player, Health]);
  const player = players[0];
  const playerInSafeSpace = player !== undefined && isEntityInSafeSpace(world, player);

  for (const pair of collisionResult.pairs) {
    const { a, b } = pair;

    if (!entityExists(world.ecs, a) || !entityExists(world.ecs, b)) {
      continue;
    }

    // Player projectile hits enemy (skip enemy projectiles)
    if (
      hasComponent(world.ecs, a, Projectile) &&
      !hasComponent(world.ecs, a, EnemyProjectile) &&
      hasComponent(world.ecs, b, Enemy)
    ) {
      if (sameTeam(world, projectileSource(world, a), b)) continue;
      if (playerInSafeSpace) {
        destroyEntity(world, a);
        continue;
      }
      applyProjectileHit(world, a, b);
      continue;
    }

    if (
      hasComponent(world.ecs, b, Projectile) &&
      !hasComponent(world.ecs, b, EnemyProjectile) &&
      hasComponent(world.ecs, a, Enemy)
    ) {
      if (sameTeam(world, projectileSource(world, b), a)) continue;
      if (playerInSafeSpace) {
        destroyEntity(world, b);
        continue;
      }
      applyProjectileHit(world, b, a);
      continue;
    }

    // Enemy projectile hits player
    if (hasComponent(world.ecs, a, EnemyProjectile) && hasComponent(world.ecs, b, Player)) {
      if (sameTeam(world, projectileSource(world, a), b)) continue;
      // A Floor 3 Companion projectile (rival-vs-rival friendly fire crossing
      // the player en route to its real target) must never resolve as a hit
      // on the player — Floor 3's Wrangler is a contractually invulnerable
      // non-combatant, only ever caught in the crossfire between Companions.
      if (hasComponent(world.ecs, projectileSource(world, a), Companion)) continue;
      applyEnemyProjectileHit(world, a, b, hitTimestamps);
      continue;
    }

    if (hasComponent(world.ecs, b, EnemyProjectile) && hasComponent(world.ecs, a, Player)) {
      if (sameTeam(world, projectileSource(world, b), a)) continue;
      if (hasComponent(world.ecs, projectileSource(world, b), Companion)) continue;
      applyEnemyProjectileHit(world, b, a, hitTimestamps);
      continue;
    }

    if (
      hasComponent(world.ecs, a, EnemyProjectile) &&
      hasComponent(world.ecs, a, Owner) &&
      hasComponent(world.ecs, b, Enemy) &&
      !sameTeam(world, projectileSource(world, a), b)
    ) {
      applyProjectileHit(world, a, b);
      continue;
    }

    if (
      hasComponent(world.ecs, b, EnemyProjectile) &&
      hasComponent(world.ecs, b, Owner) &&
      hasComponent(world.ecs, a, Enemy) &&
      !sameTeam(world, projectileSource(world, b), a)
    ) {
      applyProjectileHit(world, b, a);
      continue;
    }

    if (hasComponent(world.ecs, a, Enemy) && hasComponent(world.ecs, b, Enemy)) {
      applyFamilyContact(world, a, b);
      applyFamilyContact(world, b, a);
      continue;
    }

    if (hasComponent(world.ecs, a, Player) && hasComponent(world.ecs, b, Enemy)) {
      if (sameTeam(world, b, a)) continue;
      applyPlayerEnemyHit(world, a, b, hitTimestamps);
      continue;
    }

    if (hasComponent(world.ecs, b, Player) && hasComponent(world.ecs, a, Enemy)) {
      if (sameTeam(world, a, b)) continue;
      applyPlayerEnemyHit(world, b, a, hitTimestamps);
    }
  }
}
