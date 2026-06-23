import { hasComponent, query, removeEntity } from 'bitecs';
import {
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
  spawnBouncingProjectile,
  spawnReturningProjectile,
  spawnTrap,
} from '../core/helpers.js';
import { clearMeleeSwingHits } from '../core/systems/meleeSwingSystem.js';
import { isEntityInSafeSpace } from '../core/safe-space.js';
import type { GameWorld } from '../core/world.js';
import { TeamId, MeleeSpriteId, WEAPON, WeaponType } from '../shared/constants.js';
import type { WeaponDef } from '../shared/weaponDefs.js';
import { createLogger } from '../shared/logger.js';

interface WeaponState {
  lastFireMs: number;
  aimX: number;
  aimY: number;
  /** Active weapon definition id, or undefined when no weapon is equipped. */
  activeWeaponId: string | undefined;
  /** Cached weapon def for the active weapon. */
  activeWeaponDef: WeaponDef | undefined;
}

interface EnemyTarget {
  direction: { x: number; y: number };
  distanceSq: number;
  radiusPx: number;
}

const ATTACK_TARGET_GATE_MULTIPLIER = 1.5;
// Enemies spawn around 160ft away, so keep combat targeting slightly beyond that.
const COMBAT_RADIUS_FT = 150;

const weaponStates = new WeakMap<GameWorld, WeaponState>();
const logger = createLogger('game:weapon-system');

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

function getNearestEnemyTarget(
  world: GameWorld,
  playerX: number,
  playerY: number,
  ignoreFov: boolean = false,
): EnemyTarget | undefined {
  const enemies = query(world.ecs, [Enemy, Position]);
  let nearestTarget: EnemyTarget | undefined;
  let nearestDistanceSq = Number.POSITIVE_INFINITY;

  for (const enemy of enemies) {
    const ex = world.stores.position.x[enemy]!;
    const ey = world.stores.position.y[enemy]!;

    // Only target enemies the player can currently see (FOV + open doors).
    // Exception: ignore FOV if player is in active combat (being attacked).
    if (!ignoreFov && world.floorMap) {
      const tile = world.floorMap.worldToTile(ex, ey);
      if (!world.floorMap.isVisible(tile.x, tile.y)) {
        continue;
      }
    }

    const deltaX = ex - playerX;
    const deltaY = ey - playerY;
    const distanceSq = deltaX * deltaX + deltaY * deltaY;

    if (distanceSq >= nearestDistanceSq || distanceSq <= 0.0001) {
      continue;
    }

    nearestDistanceSq = distanceSq;
    const enemyRadiusPx =
      Math.max(world.stores.sprite.width[enemy] ?? 0, world.stores.sprite.height[enemy] ?? 0) * 0.5;
    nearestTarget = {
      direction: normalizeVector(deltaX, deltaY),
      distanceSq,
      radiusPx: enemyRadiusPx,
    };
  }

  return nearestTarget;
}

/**
 * Boss-priority targeting: returns a target aimed at a permanently-aggroed boss
 * (the elite marker, set only on Floor 1 bosses) when one is within `gateRangePx`
 * and reachable. Auto-fire otherwise locks onto the strictly nearest enemy — in a
 * room full of respawning adds an add is almost always nearer than the boss, so a
 * single-target shot or arc swing rarely lands on the boss, leaving it effectively
 * unkillable. Focusing the elite when it is already in legitimate reach is a
 * standard combat heuristic: it does not bypass weapon range (still gated by
 * `gateRangePx`), quest gating, or any UI-driven choice.
 */
function findBossTargetInRange(
  world: GameWorld,
  playerX: number,
  playerY: number,
  gateRangePx: number,
): EnemyTarget | undefined {
  const behavior = world.stores.enemyBehavior;
  if (behavior?.aggroedPermanently === undefined) {
    return undefined;
  }
  const enemies = query(world.ecs, [Enemy, Position]);
  const gateSq = gateRangePx * gateRangePx;
  let best: EnemyTarget | undefined;
  let bestDistanceSq = Number.POSITIVE_INFINITY;

  for (const enemy of enemies) {
    if ((behavior.aggroedPermanently[enemy] ?? 0) !== 1) {
      continue;
    }
    const ex = world.stores.position.x[enemy]!;
    const ey = world.stores.position.y[enemy]!;
    const deltaX = ex - playerX;
    const deltaY = ey - playerY;
    const distanceSq = deltaX * deltaX + deltaY * deltaY;
    if (distanceSq <= 0.0001 || distanceSq > gateSq || distanceSq >= bestDistanceSq) {
      continue;
    }
    bestDistanceSq = distanceSq;
    const enemyRadiusPx =
      Math.max(world.stores.sprite.width[enemy] ?? 0, world.stores.sprite.height[enemy] ?? 0) * 0.5;
    best = {
      direction: normalizeVector(deltaX, deltaY),
      distanceSq,
      radiusPx: enemyRadiusPx,
    };
  }

  return best;
}

function getWeaponGateRangePx(def: WeaponDef): number {
  switch (def.weaponType) {
    case WeaponType.MELEE:
      return Math.max(def.aoeRadius, def.range);
    case WeaponType.BEAM:
      return Math.max(def.beamLength, def.range);
    case WeaponType.TRAP:
      return Math.max(def.trapTriggerRadius, def.trapExplosionRadius, def.range);
    case WeaponType.THROWN:
      return def.maxRange > 0 ? def.maxRange : def.range;
    case WeaponType.RANGED:
    case WeaponType.MAGIC:
    default:
      return def.range;
  }
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
    getMeleeSpriteId(def.id),
  );
}

/** Map weapon id to a renderer sprite hint (0 = default sword). */
function getMeleeSpriteId(weaponId: string): number {
  switch (weaponId) {
    case 'sword':
      return MeleeSpriteId.SWORD;
    case 'baseball-bat':
      return MeleeSpriteId.BAT;
    default:
      return 0;
  }
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
    def.range,
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
    def.range,
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
  if (def.returnSpeed > 0 && def.maxRange > 0) {
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
    return;
  }

  if (def.bounceCount > 0) {
    spawnBouncingProjectile(
      world,
      px,
      py,
      dir.x * def.projectileSpeed,
      dir.y * def.projectileSpeed,
      def.baseDamage,
      def.bounceCount,
      def.pierce,
      def.range,
    );
    return;
  }

  spawnProjectile(
    world,
    px,
    py,
    dir.x * def.projectileSpeed,
    dir.y * def.projectileSpeed,
    def.baseDamage,
    def.pierce,
    def.range,
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

/**
 * Emit weapon_fired skill usage events for the active weapon's class and type skills.
 * Called on every attack attempt (hit or miss) so skills always progress with use.
 */
export function emitWeaponSkillEvents(world: GameWorld, player: number, def: WeaponDef): void {
  world.skillUsageEvents.push({
    holderEid: player,
    skillId: def.weaponClassSkillId,
    metric: 'weapon_fired',
    amount: 1,
  });
  world.skillUsageEvents.push({
    holderEid: player,
    skillId: def.weaponTypeSkillId,
    metric: 'weapon_fired',
    amount: 1,
  });
}

/**
 * Compute effective hit chance for an attack.
 * effectiveAccuracy = clamp(0, 1, def.baseAccuracy + player accuracy bonus)
 * Traps (TRAP type) always hit regardless of accuracy.
 */
export function computeEffectiveAccuracy(world: GameWorld, player: number, def: WeaponDef): number {
  if (def.weaponType === WeaponType.TRAP) return 1.0;
  const bonus = hasComponent(world.ecs, player, Stats)
    ? (world.stores.stats.accuracy[player] ?? 0)
    : 0;
  return Math.min(1.0, Math.max(0, def.baseAccuracy + bonus));
}

function dispatchAttack(
  world: GameWorld,
  player: number,
  def: WeaponDef,
  dir: { x: number; y: number },
): void {
  // Emit skill progression events on every weapon fire (hit or miss).
  emitWeaponSkillEvents(world, player, def);

  // Accuracy roll: miss if roll > effectiveAccuracy.
  // rng.next() returns [0,1); roll exactly at the threshold counts as a hit.
  const effectiveAccuracy = computeEffectiveAccuracy(world, player, def);
  if (world.rng.next() > effectiveAccuracy) {
    const px = world.stores.position.x[player] ?? 0;
    const py = world.stores.position.y[player] ?? 0;
    world.combatEvents.push({
      type: 'miss',
      x: px,
      y: py,
      amount: 0,
      targetType: 'enemy',
      timestamp: world.elapsedMs,
    });
    return;
  }

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

/** Set the active weapon definition for the weapon system. */
export function setActiveWeapon(world: GameWorld, weaponDef: WeaponDef): void {
  const state = getWeaponState(world);
  if (state.activeWeaponId === weaponDef.id) {
    // Update def for live tuning without resetting cooldown
    state.activeWeaponDef = weaponDef;
    logger.debug('Updated active weapon tuning in place', { weaponId: weaponDef.id });
    return;
  }
  state.activeWeaponId = weaponDef.id;
  state.activeWeaponDef = weaponDef;
  state.lastFireMs = world.elapsedMs - weaponDef.cooldownMs;
  logger.info('Equipped active weapon', {
    weaponId: weaponDef.id,
    weaponType: weaponDef.weaponType,
    cooldownMs: weaponDef.cooldownMs,
  });
}

/** Clear the active weapon. The player will not auto-fire until a new weapon is set. */
export function clearActiveWeapon(world: GameWorld): void {
  const state = getWeaponState(world);
  const previousWeaponId = state.activeWeaponId;
  state.activeWeaponId = undefined;
  state.activeWeaponDef = undefined;
  logger.info('Cleared active weapon', { previousWeaponId });
}

/** Get the active weapon definition, if any. */
export function getActiveWeapon(world: GameWorld): WeaponDef | undefined {
  return getWeaponState(world).activeWeaponDef;
}

/**
 * Active-weapon cooldown readiness, mirroring the gate the melee/data-driven fire
 * path uses (`world.elapsedMs - state.lastFireMs >= def.cooldownMs`). Returns
 * `null` when no weapon is equipped. Exposed so the headless AI can stutter-step:
 * dart into strike range when `ready`, ease back out while a swing is on cooldown
 * instead of standing still and trading blows.
 */
export function getActiveWeaponReadiness(
  world: GameWorld,
): { ready: boolean; remainingMs: number; cooldownMs: number } | null {
  const state = getWeaponState(world);
  const def = state.activeWeaponDef;
  if (def === undefined) {
    return null;
  }
  const remainingMs = Math.max(0, def.cooldownMs - (world.elapsedMs - state.lastFireMs));
  return { ready: remainingMs <= 0, remainingMs, cooldownMs: def.cooldownMs };
}

export function weaponSystem(world: GameWorld): void {
  const player = getPlayerEntity(world);

  if (player === undefined) {
    return;
  }
  if (isEntityInSafeSpace(world, player)) {
    return;
  }

  const state = getWeaponState(world);
  updateAimFromVelocity(world, player, state);

  const playerX = world.stores.position.x[player]!;
  const playerY = world.stores.position.y[player]!;

  // Detect if player is in active combat (enemies nearby within aggro range)
  const enemies = query(world.ecs, [Enemy, Position]);
  let inCombat = false;
  for (const enemy of enemies) {
    const ex = world.stores.position.x[enemy]!;
    const ey = world.stores.position.y[enemy]!;
    const dx = ex - playerX;
    const dy = ey - playerY;
    const distSq = dx * dx + dy * dy;
    if (distSq < COMBAT_RADIUS_FT * COMBAT_RADIUS_FT) {
      inCombat = true;
      break;
    }
  }

  // Data-driven weapon mode
  if (state.activeWeaponDef !== undefined) {
    const def = state.activeWeaponDef;

    // Trap weapons deploy at the player's feet regardless of enemy proximity.
    if (def.weaponType === WeaponType.TRAP) {
      const lastFire = state.lastFireMs;
      if (world.elapsedMs - lastFire >= def.cooldownMs) {
        dispatchAttack(world, player, def, { x: 0, y: 0 });
        state.lastFireMs = world.elapsedMs;
      }
      return;
    }

    // Melee weapons: Fire only when an enemy is in legitimate reach.
    if (def.weaponType === WeaponType.MELEE) {
      if (!inCombat) {
        return;
      }
      const target = getNearestEnemyTarget(world, playerX, playerY, true);
      if (!target) {
        return;
      }
      const lastFire = state.lastFireMs;
      if (world.elapsedMs - lastFire < def.cooldownMs) {
        return;
      }
      const gateRangePx = getWeaponGateRangePx(def) * ATTACK_TARGET_GATE_MULTIPLIER;
      if (target.distanceSq > gateRangePx * gateRangePx) {
        return;
      }

      // Boss-priority aim: if a boss/elite is itself within legitimate reach,
      // center the swing on it so the arc reliably lands on the boss instead of a
      // transient add. Falls back to the nearest enemy when no boss is in range,
      // preserving normal add-clearing.
      const bossTarget = findBossTargetInRange(world, playerX, playerY, gateRangePx);
      const fireTarget = bossTarget ?? target;

      dispatchAttack(world, player, def, fireTarget.direction);
      state.aimX = fireTarget.direction.x;
      state.aimY = fireTarget.direction.y;
      state.lastFireMs = world.elapsedMs;
      return;
    }

    // Ignore FOV checks if in active combat (enemies nearby)
    const target = getNearestEnemyTarget(world, playerX, playerY, inCombat);
    if (!target) {
      return;
    }
    const fireDir = target.direction;
    const gateRangePx = getWeaponGateRangePx(def) * ATTACK_TARGET_GATE_MULTIPLIER;
    if (target.distanceSq > gateRangePx * gateRangePx) {
      return;
    }
    const lastFire = state.lastFireMs;

    if (world.elapsedMs - lastFire < def.cooldownMs) {
      return;
    }

    dispatchAttack(world, player, def, fireDir);
    state.aimX = fireDir.x;
    state.aimY = fireDir.y;
    state.lastFireMs = world.elapsedMs;
    logger.debug('Fired active weapon attack', {
      weaponId: def.id,
      weaponType: def.weaponType,
      elapsedMs: world.elapsedMs,
    });
  }
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
    if (hasComponent(world.ecs, ownerEid, Player) && isEntityInSafeSpace(world, ownerEid)) {
      continue;
    }

    const cooldownMs = weapon.cooldownMs[weid]!;
    const lastFireMs = weapon.lastFireMs[weid]!;

    if (world.elapsedMs - lastFireMs < cooldownMs) {
      continue;
    }

    const px = position.x[ownerEid]!;
    const py = position.y[ownerEid]!;
    const target = getNearestEnemyTarget(world, px, py);
    if (!target) {
      continue;
    }
    const weaponType = weapon.weaponType[weid]!;
    const rawRange = weapon.range[weid] ?? 0;
    if (rawRange > 0) {
      let gateRangePx = rawRange * ATTACK_TARGET_GATE_MULTIPLIER;
      if (weaponType === WeaponType.MELEE) {
        gateRangePx += target.radiusPx;
      }
      if (target.distanceSq > gateRangePx * gateRangePx) {
        continue;
      }
    }
    const dir = target.direction;
    const baseDamage = weapon.baseDamage[weid]!;
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
