import { hasComponent, query, removeEntity, setComponent } from 'bitecs';
import {
  Damage,
  Enemy,
  MeleeSwing,
  Owner,
  Player,
  Position,
  Stats,
  Team,
  Weapon,
} from '../core/components.js';
import {
  spawnAoeProjectile,
  spawnAreaAttack,
  spawnBeam,
  clearEntityStores,
  spawnMeleeSwing,
  spawnProjectile,
  spawnReturningProjectile,
  spawnTrap,
} from '../core/helpers.js';
import { clearMeleeSwingHits } from '../core/systems/meleeSwingSystem.js';
import type { GameWorld } from '../core/world.js';
import { TeamId, WEAPON, WeaponType } from '../shared/constants.js';
import type { WeaponDef } from '../shared/weaponDefs.js';

export interface WeaponConfig {
  projectileSpeed: number;
  fireRateMs: number;
  baseDamage: number;
}

interface WeaponState {
  lastFireMs: number;
  aimX: number;
  aimY: number;
  /** Active weapon definition id, or undefined for legacy projectile mode. */
  activeWeaponId: string | undefined;
  /** Cached weapon def for the active weapon. */
  activeWeaponDef: WeaponDef | undefined;
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
      activeWeaponId: undefined,
      activeWeaponDef: undefined,
    };
    weaponStates.set(world, state);
  }

  return state;
}

function normalizeVector(x: number, y: number): { x: number; y: number } {
  const length = Math.hypot(x, y);

  // Callers guard near-zero vectors before invoking this helper.
  /* c8 ignore next 3 */
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
    const attackSpeed = Math.max(0.1, world.stores.stats.attackSpeed[player]!);
    const rawDamage = world.stores.stats.damage[player]!;
    const damage = rawDamage;
    return {
      projectileSpeed: config.projectileSpeed,
      fireRateMs: config.fireRateMs / attackSpeed,
      baseDamage: damage,
    };
  }

  if (!hasComponent(world.ecs, player, Damage)) {
    return config;
  }

  const baseDamage = world.stores.damage.amount[player]!;
  const fireRateMs = world.stores.damage.cooldownMs[player]!;

  return {
    projectileSpeed: config.projectileSpeed,
    fireRateMs: fireRateMs > 0 ? fireRateMs : config.fireRateMs,
    baseDamage: baseDamage > 0 ? baseDamage : config.baseDamage,
  };
}

function readLastFireMs(world: GameWorld, player: number): number {
  const state = getWeaponState(world);

  if (hasComponent(world.ecs, player, Damage)) {
    return world.stores.damage.lastFireMs[player]!;
  }

  return state.lastFireMs;
}

function writeLastFireMs(
  world: GameWorld,
  player: number,
  config: WeaponConfig,
  lastFireMs: number,
): void {
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
  const velocityX = world.stores.velocity.x[player]!;
  const velocityY = world.stores.velocity.y[player]!;

  if (Math.hypot(velocityX, velocityY) <= 0.0001) {
    return;
  }

  const direction = normalizeVector(velocityX, velocityY);
  state.aimX = direction.x;
  state.aimY = direction.y;
}

function getNearestEnemyDirection(
  world: GameWorld,
  playerX: number,
  playerY: number,
): { x: number; y: number } | undefined {
  const enemies = query(world.ecs, [Enemy, Position]);
  let nearestDirection: { x: number; y: number } | undefined;
  let nearestDistanceSq = Number.POSITIVE_INFINITY;

  for (const enemy of enemies) {
    const deltaX = world.stores.position.x[enemy]! - playerX;
    const deltaY = world.stores.position.y[enemy]! - playerY;
    const distanceSq = deltaX * deltaX + deltaY * deltaY;

    if (distanceSq >= nearestDistanceSq || distanceSq <= 0.0001) {
      continue;
    }

    nearestDistanceSq = distanceSq;
    nearestDirection = normalizeVector(deltaX, deltaY);
  }

  return nearestDirection;
}

// --- Attack dispatchers per weapon type ---

function fireMeleeAttack(
  world: GameWorld,
  player: number,
  def: WeaponDef,
  dir: { x: number; y: number },
): void {
  // Remove any existing swing — only one active at a time
  const existingSwings = query(world.ecs, [MeleeSwing, Owner]);
  for (const eid of existingSwings) {
    if (world.stores.owner.eid[eid]! === player) {
      clearMeleeSwingHits(world, eid);
      clearEntityStores(world, eid);
      removeEntity(world.ecs, eid);
    }
  }

  const px = world.stores.position.x[player]!;
  const py = world.stores.position.y[player]!;
  spawnMeleeSwing(
    world,
    px,
    py,
    player,
    def.baseDamage,
    def.aoeRadius,
    def.durationMs,
    dir.x,
    dir.y,
    def.swingArcDeg,
    TeamId.PLAYER,
    def.meleeStyle,
    def.headRadius,
    def.shaftDamageMult,
    def.knockback,
  );
}

function fireRangedAttack(
  world: GameWorld,
  player: number,
  def: WeaponDef,
  dir: { x: number; y: number },
): void {
  const px = world.stores.position.x[player]!;
  const py = world.stores.position.y[player]!;
  spawnProjectile(
    world,
    px,
    py,
    dir.x * def.projectileSpeed,
    dir.y * def.projectileSpeed,
    def.baseDamage,
    def.pierce,
  );
}

function fireMagicAttack(
  world: GameWorld,
  player: number,
  def: WeaponDef,
  dir: { x: number; y: number },
): void {
  const px = world.stores.position.x[player]!;
  const py = world.stores.position.y[player]!;
  spawnAoeProjectile(
    world,
    px,
    py,
    dir.x * def.projectileSpeed,
    dir.y * def.projectileSpeed,
    def.baseDamage,
    def.aoeRadius,
    def.baseDamage,
    player,
    TeamId.PLAYER,
  );
}

function fireThrownAttack(
  world: GameWorld,
  player: number,
  def: WeaponDef,
  dir: { x: number; y: number },
): void {
  const px = world.stores.position.x[player]!;
  const py = world.stores.position.y[player]!;
  spawnReturningProjectile(
    world,
    px,
    py,
    dir.x * def.projectileSpeed,
    dir.y * def.projectileSpeed,
    def.baseDamage,
    player,
    def.returnSpeed,
    def.maxRange,
    TeamId.PLAYER,
    def.pierce,
  );
}

function fireBeamAttack(
  world: GameWorld,
  player: number,
  def: WeaponDef,
  dir: { x: number; y: number },
): void {
  const px = world.stores.position.x[player]!;
  const py = world.stores.position.y[player]!;
  spawnBeam(
    world,
    px,
    py,
    dir.x,
    dir.y,
    def.beamLength,
    def.baseDamage,
    def.durationMs,
    def.beamTickMs,
    player,
    TeamId.PLAYER,
  );
}

function fireTrapAttack(world: GameWorld, player: number, def: WeaponDef): void {
  const px = world.stores.position.x[player] ?? 0;
  const py = world.stores.position.y[player] ?? 0;
  spawnTrap(
    world,
    px,
    py,
    def.baseDamage,
    def.trapTriggerRadius,
    def.trapExplosionRadius,
    def.trapArmMs,
    player,
    TeamId.PLAYER,
  );
}

function dispatchAttack(
  world: GameWorld,
  player: number,
  def: WeaponDef,
  dir: { x: number; y: number },
): void {
  switch (def.weaponType) {
    case WeaponType.MELEE:
      fireMeleeAttack(world, player, def, dir);
      break;
    case WeaponType.RANGED:
      fireRangedAttack(world, player, def, dir);
      break;
    case WeaponType.MAGIC:
      fireMagicAttack(world, player, def, dir);
      break;
    case WeaponType.THROWN:
      fireThrownAttack(world, player, def, dir);
      break;
    case WeaponType.BEAM:
      fireBeamAttack(world, player, def, dir);
      break;
    case WeaponType.TRAP:
      fireTrapAttack(world, player, def);
      break;
    default:
      break;
  }
}

export function configureWeaponSystem(world: GameWorld, config: Partial<WeaponConfig>): void {
  weaponConfigs.set(world, {
    ...getWeaponConfig(world),
    ...config,
  });
}

/** Set the active weapon definition for the weapon system. */
export function setActiveWeapon(world: GameWorld, weaponDef: WeaponDef): void {
  const state = getWeaponState(world);
  if (state.activeWeaponId === weaponDef.id) {
    // Update def for live tuning without resetting cooldown
    state.activeWeaponDef = weaponDef;
    return;
  }
  state.activeWeaponId = weaponDef.id;
  state.activeWeaponDef = weaponDef;
  state.lastFireMs = world.elapsedMs - weaponDef.cooldownMs;
}

/** Clear the active weapon, reverting to legacy projectile mode. */
export function clearActiveWeapon(world: GameWorld): void {
  const state = getWeaponState(world);
  state.activeWeaponId = undefined;
  state.activeWeaponDef = undefined;
}

/** Get the active weapon definition, if any. */
export function getActiveWeapon(world: GameWorld): WeaponDef | undefined {
  return getWeaponState(world).activeWeaponDef;
}

export function weaponSystem(world: GameWorld): void {
  const player = getPlayerEntity(world);

  if (player === undefined) {
    return;
  }

  const state = getWeaponState(world);
  updateAimFromVelocity(world, player, state);

  const playerX = world.stores.position.x[player]!;
  const playerY = world.stores.position.y[player]!;
  const direction = getNearestEnemyDirection(world, playerX, playerY) ?? {
    x: state.aimX,
    y: state.aimY,
  };

  // Data-driven weapon mode
  if (state.activeWeaponDef !== undefined) {
    const def = state.activeWeaponDef;
    const lastFire = state.lastFireMs;

    if (world.elapsedMs - lastFire < def.cooldownMs) {
      return;
    }

    dispatchAttack(world, player, def, direction);
    state.aimX = direction.x;
    state.aimY = direction.y;
    state.lastFireMs = world.elapsedMs;
    return;
  }

  // Legacy projectile mode (backwards compatible)
  const config = resolveWeaponConfig(world, player);
  const lastFireMs = readLastFireMs(world, player);

  if (world.elapsedMs - lastFireMs < config.fireRateMs) {
    return;
  }

  // Determine how many projectiles to fire (1 + floor(projectileCount bonus))
  const extraProjectiles = hasComponent(world.ecs, player, Stats)
    ? Math.floor(world.stores.stats.projectileCount[player]!)
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

/** Process weapon entities (for multi-weapon support). */
export function weaponEntitySystem(world: GameWorld): void {
  const weaponEntities = query(world.ecs, [Weapon, Owner]);
  const { weapon, owner, position, team } = world.stores;

  for (const weid of weaponEntities) {
    const ownerEid = owner.eid[weid]!;
    if (!hasComponent(world.ecs, ownerEid, Position)) {
      continue;
    }

    const cooldownMs = weapon.cooldownMs[weid]!;
    const lastFireMs = weapon.lastFireMs[weid]!;

    if (world.elapsedMs - lastFireMs < cooldownMs) {
      continue;
    }

    const px = position.x[ownerEid]!;
    const py = position.y[ownerEid]!;
    const dir = getNearestEnemyDirection(world, px, py) ?? { x: 1, y: 0 };
    const baseDamage = weapon.baseDamage[weid]!;
    const weaponType = weapon.weaponType[weid]!;
    const projSpeed = weapon.projectileSpeed[weid]!;

    switch (weaponType) {
      case WeaponType.RANGED:
        spawnProjectile(world, px, py, dir.x * projSpeed, dir.y * projSpeed, baseDamage);
        break;
      case WeaponType.MELEE: {
        const range = weapon.range[weid]!;
        const ownerTeam = hasComponent(world.ecs, ownerEid, Team)
          ? team.id[ownerEid]!
          : TeamId.PLAYER;
        spawnAreaAttack(
          world,
          px,
          py,
          ownerEid,
          baseDamage,
          range,
          WEAPON.MELEE_DURATION_MS,
          ownerTeam,
        );
        break;
      }
      default:
        spawnProjectile(world, px, py, dir.x * projSpeed, dir.y * projSpeed, baseDamage);
        break;
    }

    weapon.lastFireMs[weid] = world.elapsedMs;
  }
}
