import { entityExists, hasComponent, removeEntity } from 'bitecs';
import type { CollisionResult } from './collisionSystem.js';
import { Damage, Enemy, Health, Player, Projectile, XpGem } from '../components.js';
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

function destroyEntity(world: GameWorld, eid: number): void {
  clearEntityStores(world, eid);
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
  if (hasComponent(world.ecs, enemy, Health)) {
    const amount = getDamageAmount(world, projectile, DEFAULT_PROJECTILE_DAMAGE);
    const currentHealth = world.stores.health.current[enemy] ?? 0;
    world.stores.health.current[enemy] = Math.max(0, currentHealth - amount);
  }

  destroyEntity(world, projectile);
}

function applyPlayerEnemyHit(world: GameWorld, player: number, enemy: number, hitTimestamps: Float64Array): void {
  if (!hasComponent(world.ecs, player, Health)) {
    return;
  }

  const lastHitMs = hitTimestamps[player] ?? -Infinity;

  if ((world.elapsedMs - lastHitMs) < PLAYER_INVINCIBILITY_MS) {
    return;
  }

  const amount = getDamageAmount(world, enemy, DEFAULT_CONTACT_DAMAGE);
  const currentHealth = world.stores.health.current[player] ?? 0;
  world.stores.health.current[player] = Math.max(0, currentHealth - amount);
  hitTimestamps[player] = world.elapsedMs;
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

    if (hasComponent(world.ecs, a, Projectile) && hasComponent(world.ecs, b, Enemy)) {
      applyProjectileHit(world, a, b);
      continue;
    }

    if (hasComponent(world.ecs, b, Projectile) && hasComponent(world.ecs, a, Enemy)) {
      applyProjectileHit(world, b, a);
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
