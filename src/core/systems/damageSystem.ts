import { entityExists, hasComponent, query, removeEntity } from "bitecs";
import type { CollisionResult } from "./collisionSystem.js";
import {
  Damage,
  DeathTimer,
  Enemy,
  EnemyProjectile,
  EffectiveStats,
  Health,
  Owner,
  Player,
  Projectile,
  Returning,
  Team,
} from "../components.js";
import { applyDamage } from "../apply-damage.js";
import { readDamageMeta } from "../damage-meta.js";
import { clearEntityStores } from "../helpers.js";
import { isEntityInSafeSpace } from "../safe-space.js";
import type { GameWorld } from "../world.js";
import { emitWeaponHitSkillEventsForSource } from "../weapon-skill-bridge.js";
import {
  recordWeaponEnemyHit,
  pruneAttackEntity,
} from "../weapon-telemetry.js";
import { computeArmorReducedDamage } from "../combat-math.js";
import { getMobAbilityMeleeDamageMultiplier } from "../mob-abilities/runtime.js";

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

function getDamageAmount(
  world: GameWorld,
  eid: number,
  fallbackAmount: number,
): number {
  if (!hasComponent(world.ecs, eid, Damage)) {
    return fallbackAmount;
  }

  // When the Damage component is present, trust its value — 0 is valid (e.g. miss
  // projectiles that exist purely for cosmetic animation).
  return world.stores.damage.amount[eid] ?? 0;
}

function applyArmorReduction(
  world: GameWorld,
  player: number,
  rawDamage: number,
): number {
  if (!hasComponent(world.ecs, player, EffectiveStats)) {
    return rawDamage;
  }
  const armor = world.stores.effectiveStats.armor[player] ?? 0;
  return computeArmorReducedDamage(rawDamage, armor);
}

function sameTeam(world: GameWorld, source: number, target: number): boolean {
  return (
    hasComponent(world.ecs, source, Team) &&
    hasComponent(world.ecs, target, Team) &&
    (world.stores.team.id[source] ?? 0) === (world.stores.team.id[target] ?? 0)
  );
}

function projectileSource(world: GameWorld, projectile: number): number {
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
    type: "blocked",
    x: world.stores.position.x[player] ?? 0,
    y: world.stores.position.y[player] ?? 0,
    amount: 0,
    targetType: "player",
    timestamp: world.elapsedMs,
    targetEid: player,
  });
}

function applyProjectileHit(
  world: GameWorld,
  projectile: number,
  enemy: number,
): void {
  // If this is the first hit for this projectile, clear stale hit tracking
  // from any previous entity that used the same recycled ECS ID.
  if ((world.stores.projectile.hitCount[projectile] ?? 0) === 0) {
    clearProjectilePierceHits(world, projectile);
  }

  // Check if this enemy was already hit by this piercing projectile
  const hitSet = getPierceHitSet(world, projectile);
  if (hitSet.has(enemy)) return;

  if (hasComponent(world.ecs, enemy, Health)) {
    const amount = getDamageAmount(
      world,
      projectile,
      DEFAULT_PROJECTILE_DAMAGE,
    );
    const ownerEid = hasComponent(world.ecs, projectile, Owner)
      ? (world.stores.owner.eid[projectile] ?? -1)
      : -1;
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
    destroyEntity(world, projectile);
  }
}

function applyPlayerEnemyHit(
  world: GameWorld,
  player: number,
  enemy: number,
  hitTimestamps: Float64Array,
): void {
  // Dead enemies keep their Enemy component during the death-linger window
  // (deathTimerSystem removes them once the corpse animation finishes). A
  // corpse must not deal contact damage just because the player walks over it.
  if (hasComponent(world.ecs, enemy, DeathTimer)) {
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
  const amount = applyArmorReduction(world, player, raw * hostileMult);
  applyDamage(
    world,
    player,
    amount,
    world.stores.position.x[player] ?? 0,
    world.stores.position.y[player] ?? 0,
    {
      origin: "enemy",
      affinity: "unscaled",
      scaleWithPrimary: false,
      canCrit: false,
      delivery: "contact",
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
  const amount = applyArmorReduction(world, player, raw * hostileMult);
  const projectileOwner = hasComponent(world.ecs, projectile, Owner)
    ? (world.stores.owner.eid[projectile] ?? -1)
    : -1;
  applyDamage(
    world,
    player,
    amount,
    world.stores.position.x[player] ?? 0,
    world.stores.position.y[player] ?? 0,
    {
      origin: "enemy",
      affinity: "unscaled",
      scaleWithPrimary: false,
      canCrit: false,
      delivery: "projectile",
      sourceX: world.stores.position.x[projectile] ?? 0,
      sourceY: world.stores.position.y[projectile] ?? 0,
      sourceEid: projectileOwner !== -1 ? projectileOwner : projectile,
      // Pass the archetype key snapshotted at projectile-spawn time so that
      // attribution in apply-damage is correct even if the shooter has been
      // reaped and its EID recycled before this hit occurs.
      sourceArchetypeKey: world.enemyProjectileArchetypeKeys.get(projectile),
    },
  );
  hitTimestamps[player] = world.elapsedMs;

  destroyEntity(world, projectile);
}

export function damageSystem(
  world: GameWorld,
  collisionResult: CollisionResult,
): void {
  const hitTimestamps = getPlayerHitTimestamps(world);
  const players = query(world.ecs, [Player, Health]);
  const player = players[0];
  const playerInSafeSpace =
    player !== undefined && isEntityInSafeSpace(world, player);

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
    if (
      hasComponent(world.ecs, a, EnemyProjectile) &&
      hasComponent(world.ecs, b, Player)
    ) {
      applyEnemyProjectileHit(world, a, b, hitTimestamps);
      continue;
    }

    if (
      hasComponent(world.ecs, b, EnemyProjectile) &&
      hasComponent(world.ecs, a, Player)
    ) {
      applyEnemyProjectileHit(world, b, a, hitTimestamps);
      continue;
    }

    if (
      hasComponent(world.ecs, a, Player) &&
      hasComponent(world.ecs, b, Enemy)
    ) {
      if (sameTeam(world, a, b)) continue;
      applyPlayerEnemyHit(world, a, b, hitTimestamps);
      continue;
    }

    if (
      hasComponent(world.ecs, b, Player) &&
      hasComponent(world.ecs, a, Enemy)
    ) {
      if (sameTeam(world, b, a)) continue;
      applyPlayerEnemyHit(world, b, a, hitTimestamps);
    }
  }
}
