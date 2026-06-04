import { entityExists, hasComponent, removeEntity } from 'bitecs';
import type { CollisionResult } from './collisionSystem.js';
import { Damage, Enemy, EnemyProjectile, Health, Player, Projectile, Returning, XpGem } from '../components.js';
import { clearEntityStores } from '../helpers.js';
import type { GameWorld } from '../world.js';

const DEFAULT_PROJECTILE_DAMAGE = 10;
const DEFAULT_CONTACT_DAMAGE = 5;
const PLAYER_INVINCIBILITY_MS = 250;
const MAX_TRACKED_ENTITIES = 10_000;

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

function applyProjectileHit(world: GameWorld, projectile: number, enemy: number): void {
  // Check if this enemy was already hit by this piercing projectile
  const hitSet = getPierceHitSet(world, projectile);
  if (hitSet.has(enemy)) return;

  if (hasComponent(world.ecs, enemy, Health)) {
    const amount = getDamageAmount(world, projectile, DEFAULT_PROJECTILE_DAMAGE);
    const currentHealth = world.stores.health.current[enemy] ?? 0;
    world.stores.health.current[enemy] = Math.max(0, currentHealth - amount);
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
    return;
  }

  const amount = getDamageAmount(world, enemy, DEFAULT_CONTACT_DAMAGE);
  const currentHealth = world.stores.health.current[player] ?? 0;
  world.stores.health.current[player] = Math.max(0, currentHealth - amount);
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
    destroyEntity(world, projectile);
    return;
  }

  const amount = getDamageAmount(world, projectile, DEFAULT_PROJECTILE_DAMAGE);
  const currentHealth = world.stores.health.current[player] ?? 0;
  world.stores.health.current[player] = Math.max(0, currentHealth - amount);
  hitTimestamps[player] = world.elapsedMs;

  destroyEntity(world, projectile);
}

function collectXpGem(world: GameWorld, player: number, gem: number): void {
  const currentScore = world.stores.broadcastScore.current[player] ?? 0;
  const gemValue = world.stores.xpGem.value[gem] ?? 0;
  world.stores.broadcastScore.current[player] = currentScore + gemValue;

  destroyEntity(world, gem);
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
      continue;
    }

    if (hasComponent(world.ecs, a, Player) && hasComponent(world.ecs, b, XpGem)) {
      collectXpGem(world, a, b);
      continue;
    }

    if (hasComponent(world.ecs, b, Player) && hasComponent(world.ecs, a, XpGem)) {
      collectXpGem(world, b, a);
    }
  }
}
