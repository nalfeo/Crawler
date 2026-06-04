import { hasComponent, query, setComponent } from 'bitecs';
import { Damage, Enemy, Player, Position, Stats } from '../core/components.js';
import { spawnProjectile } from '../core/helpers.js';
import type { GameWorld } from '../core/world.js';
import { WEAPON } from '../shared/constants.js';

export interface WeaponConfig {
  projectileSpeed: number;
  fireRateMs: number;
  baseDamage: number;
}

interface WeaponState {
  lastFireMs: number;
  aimX: number;
  aimY: number;
}

const weaponConfigs = new WeakMap<GameWorld, WeaponConfig>();
const weaponStates = new WeakMap<GameWorld, WeaponState>();

function createDefaultConfig(): WeaponConfig {
  return {
    projectileSpeed: WEAPON.PROJECTILE_SPEED,
    fireRateMs: WEAPON.FIRE_RATE_MS,
    baseDamage: WEAPON.BASE_DAMAGE,
  };
}

function getWeaponConfig(world: GameWorld): WeaponConfig {
  let config = weaponConfigs.get(world);

  if (config === undefined) {
    config = createDefaultConfig();
    weaponConfigs.set(world, config);
  }

  return config;
}

function getWeaponState(world: GameWorld): WeaponState {
  let state = weaponStates.get(world);

  if (state === undefined) {
    state = {
      lastFireMs: -WEAPON.FIRE_RATE_MS,
      aimX: 1,
      aimY: 0,
    };
    weaponStates.set(world, state);
  }

  return state;
}

function normalizeVector(x: number, y: number): { x: number; y: number } {
  const length = Math.hypot(x, y);

  if (length <= 0.0001) {
    return { x: 1, y: 0 };
  }

  return {
    x: x / length,
    y: y / length,
  };
}

function getPlayerEntity(world: GameWorld): number | undefined {
  const players = query(world.ecs, [Player, Position]);
  return players[0];
}

/**
 * Resolves the effective weapon config for the current frame.
 * If the player has a Stats component, reads from the stats store:
 *   - effectiveCooldownMs = baseCooldownMs / max(0.1, attackSpeed)
 *   - baseDamage = stats.damage
 * Falls back to the WeaponConfig set via configureWeaponSystem.
 */
function resolveWeaponConfig(world: GameWorld, player: number): WeaponConfig {
  const config = getWeaponConfig(world);

  if (hasComponent(world.ecs, player, Stats)) {
    const attackSpeed = Math.max(0.1, world.stores.stats.attackSpeed[player] ?? 1.0);
    const rawDamage = world.stores.stats.damage[player];
    const damage = rawDamage !== undefined && rawDamage > 0 ? rawDamage : config.baseDamage;
    return {
      projectileSpeed: config.projectileSpeed,
      fireRateMs: config.fireRateMs / attackSpeed,
      baseDamage: damage,
    };
  }

  if (!hasComponent(world.ecs, player, Damage)) {
    return config;
  }

  const baseDamage = world.stores.damage.amount[player] ?? 0;
  const fireRateMs = world.stores.damage.cooldownMs[player] ?? 0;

  return {
    projectileSpeed: config.projectileSpeed,
    fireRateMs: fireRateMs > 0 ? fireRateMs : config.fireRateMs,
    baseDamage: baseDamage > 0 ? baseDamage : config.baseDamage,
  };
}

function readLastFireMs(world: GameWorld, player: number): number {
  const state = getWeaponState(world);

  if (hasComponent(world.ecs, player, Damage)) {
    return world.stores.damage.lastFireMs[player] ?? state.lastFireMs;
  }

  return state.lastFireMs;
}

function writeLastFireMs(world: GameWorld, player: number, config: WeaponConfig, lastFireMs: number): void {
  const state = getWeaponState(world);
  state.lastFireMs = lastFireMs;

  if (hasComponent(world.ecs, player, Damage)) {
    setComponent(world.ecs, player, Damage, {
      amount: config.baseDamage,
      cooldownMs: config.fireRateMs,
      lastFireMs,
    });
  }
}

function updateAimFromVelocity(world: GameWorld, player: number, state: WeaponState): void {
  const velocityX = world.stores.velocity.x[player] ?? 0;
  const velocityY = world.stores.velocity.y[player] ?? 0;

  if (Math.hypot(velocityX, velocityY) <= 0.0001) {
    return;
  }

  const direction = normalizeVector(velocityX, velocityY);
  state.aimX = direction.x;
  state.aimY = direction.y;
}

function getNearestEnemyDirection(world: GameWorld, playerX: number, playerY: number): { x: number; y: number } | undefined {
  const enemies = query(world.ecs, [Enemy, Position]);
  let nearestDirection: { x: number; y: number } | undefined;
  let nearestDistanceSq = Number.POSITIVE_INFINITY;

  for (const enemy of enemies) {
    if (enemy === undefined) {
      continue;
    }

    const deltaX = (world.stores.position.x[enemy] ?? 0) - playerX;
    const deltaY = (world.stores.position.y[enemy] ?? 0) - playerY;
    const distanceSq = (deltaX * deltaX) + (deltaY * deltaY);

    if (distanceSq >= nearestDistanceSq || distanceSq <= 0.0001) {
      continue;
    }

    nearestDistanceSq = distanceSq;
    nearestDirection = normalizeVector(deltaX, deltaY);
  }

  return nearestDirection;
}

export function configureWeaponSystem(world: GameWorld, config: Partial<WeaponConfig>): void {
  weaponConfigs.set(world, {
    ...getWeaponConfig(world),
    ...config,
  });
}

export function weaponSystem(world: GameWorld): void {
  const player = getPlayerEntity(world);

  if (player === undefined) {
    return;
  }

  const state = getWeaponState(world);
  updateAimFromVelocity(world, player, state);

  const config = resolveWeaponConfig(world, player);
  const lastFireMs = readLastFireMs(world, player);

  if ((world.elapsedMs - lastFireMs) < config.fireRateMs) {
    return;
  }

  const playerX = world.stores.position.x[player] ?? 0;
  const playerY = world.stores.position.y[player] ?? 0;
  const direction = getNearestEnemyDirection(world, playerX, playerY) ?? { x: state.aimX, y: state.aimY };

  // Determine how many projectiles to fire (1 + floor(projectileCount bonus))
  const extraProjectiles = hasComponent(world.ecs, player, Stats)
    ? Math.floor(world.stores.stats.projectileCount[player] ?? 0)
    : 0;
  const totalProjectiles = 1 + extraProjectiles;

  for (let i = 0; i < totalProjectiles; i++) {
    // Spread extra projectiles slightly so they don't perfectly overlap
    let dx = direction.x;
    let dy = direction.y;
    if (i > 0) {
      const spreadAngle = (i % 2 === 1 ? 1 : -1) * (Math.ceil(i / 2) * 0.15);
      const cos = Math.cos(spreadAngle);
      const sin = Math.sin(spreadAngle);
      dx = direction.x * cos - direction.y * sin;
      dy = direction.x * sin + direction.y * cos;
      const len = Math.hypot(dx, dy);
      dx /= len;
      dy /= len;
    }

    spawnProjectile(
      world,
      playerX,
      playerY,
      dx * config.projectileSpeed,
      dy * config.projectileSpeed,
      config.baseDamage,
    );
  }

  state.aimX = direction.x;
  state.aimY = direction.y;
  writeLastFireMs(world, player, config, world.elapsedMs);
}
