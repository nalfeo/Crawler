import { entityExists, hasComponent, removeEntity } from 'bitecs';
import type { CollisionResult } from './collisionSystem.js';
import {
  AoeOnImpact,
  Damage,
  Enemy,
  EnemyProjectile,
  Health,
  Player,
  Projectile,
  Returning,
  Stats,
} from '../components.js';
import { applyDamage } from '../apply-damage.js';
import { clearEntityStores } from '../helpers.js';
import type { GameWorld } from '../world.js';
import { WeaponType } from '../../shared/constants.js';
import type { CombatWeaponType } from '../../shared/combat-events.js';

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
  removeEntity(world.ecs, eid);
}

function getDamageAmount(world: GameWorld, eid: number, fallbackAmount: number): number {
  if (!hasComponent(world.ecs, eid, Damage)) {
    return fallbackAmount;
  }

  const amount = world.stores.damage.amount[eid] ?? 0;
  return amount > 0 ? amount : fallbackAmount;
}

/** Apply armor mitigation for player: damageTaken = max(1, incoming - armor) */
function applyArmorReduction(world: GameWorld, player: number, rawDamage: number): number {
  if (!hasComponent(world.ecs, player, Stats)) {
    return rawDamage;
  }
  const armor = world.stores.stats.armor[player] ?? 0;
  return Math.max(1, rawDamage - armor);
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
    const weaponType = getProjectileWeaponType(world, projectile);
    applyDamage(
      world,
      enemy,
      amount,
      world.stores.position.x[enemy] ?? 0,
      world.stores.position.y[enemy] ?? 0,
      undefined,
      world.stores.position.x[projectile] ?? 0,
      world.stores.position.y[projectile] ?? 0,
      weaponType,
    );

    // Emit skill usage event for projectile hits (swordsmanship uses hits_landed)
    world.skillUsageEvents.push({ skillId: 'swordsmanship', metric: 'hits_landed', amount: 1 });
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
  if (!hasComponent(world.ecs, player, Health)) {
    return;
  }

  const lastHitMs = hitTimestamps[player] ?? -Infinity;

  if (world.elapsedMs - lastHitMs < PLAYER_INVINCIBILITY_MS) {
    emitBlockedEvent(world, player);
    return;
  }

  const raw = getDamageAmount(world, enemy, DEFAULT_CONTACT_DAMAGE);
  const amount = applyArmorReduction(world, player, raw);
  applyDamage(
    world,
    player,
    amount,
    world.stores.position.x[player] ?? 0,
    world.stores.position.y[player] ?? 0,
    undefined,
    world.stores.position.x[enemy] ?? 0,
    world.stores.position.y[enemy] ?? 0,
    'unknown',
  );
  hitTimestamps[player] = world.elapsedMs;
}

function applyEnemyProjectileHit(
  world: GameWorld,
  projectile: number,
  player: number,
  hitTimestamps: Float64Array,
): void {
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
  const amount = applyArmorReduction(world, player, raw);
  applyDamage(
    world,
    player,
    amount,
    world.stores.position.x[player] ?? 0,
    world.stores.position.y[player] ?? 0,
    undefined,
    world.stores.position.x[projectile] ?? 0,
    world.stores.position.y[projectile] ?? 0,
    'enemy-projectile',
  );
  hitTimestamps[player] = world.elapsedMs;

  destroyEntity(world, projectile);
}

function getProjectileWeaponType(world: GameWorld, projectile: number): CombatWeaponType {
  if (hasComponent(world.ecs, projectile, AoeOnImpact)) return WeaponType.MAGIC;
  if (hasComponent(world.ecs, projectile, Returning)) return WeaponType.THROWN;
  return WeaponType.RANGED;
}

export function damageSystem(world: GameWorld, collisionResult: CollisionResult): void {
  const hitTimestamps = getPlayerHitTimestamps(world);

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
      applyProjectileHit(world, a, b);
      continue;
    }

    if (
      hasComponent(world.ecs, b, Projectile) &&
      !hasComponent(world.ecs, b, EnemyProjectile) &&
      hasComponent(world.ecs, a, Enemy)
    ) {
      applyProjectileHit(world, b, a);
      continue;
    }

    // Enemy projectile hits player
    if (hasComponent(world.ecs, a, EnemyProjectile) && hasComponent(world.ecs, b, Player)) {
      applyEnemyProjectileHit(world, a, b, hitTimestamps);
      continue;
    }

    if (hasComponent(world.ecs, b, EnemyProjectile) && hasComponent(world.ecs, a, Player)) {
      applyEnemyProjectileHit(world, b, a, hitTimestamps);
      continue;
    }

    if (hasComponent(world.ecs, a, Player) && hasComponent(world.ecs, b, Enemy)) {
      applyPlayerEnemyHit(world, a, b, hitTimestamps);
      continue;
    }

    if (hasComponent(world.ecs, b, Player) && hasComponent(world.ecs, a, Enemy)) {
      applyPlayerEnemyHit(world, b, a, hitTimestamps);
    }
  }
}
