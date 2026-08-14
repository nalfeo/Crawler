import { hasComponent, query, removeEntity } from 'bitecs';
import {
  DeathTimer,
  Enemy,
  EffectiveStats,
  Health,
  MeleeSwing,
  Owner,
  Player,
  Position,
} from '../core/components.js';
import {
  spawnAoeProjectile,
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
import {
  beginWeaponActivation,
  endWeaponActivation,
  markWeaponAccuracyMiss,
} from '../core/weapon-telemetry.js';
import { recordRunItemActivation } from '../core/run-events.js';
import type { GameWorld } from '../core/world.js';
import { getBodyRadius } from '../core/physics-body.js';
import { tagDamageMeta } from '../core/damage-meta.js';
import { computeEffectiveAccuracyFromValues } from '../core/combat-math.js';
import { computeEffectiveValue, getStatusEffects } from '../core/status-effects.js';
import {
  setActiveWeaponDef,
  clearActiveWeaponDef,
  getActiveWeaponDef,
  getActiveWeaponGeneration,
} from '../core/active-weapon.js';
import { TeamId, MeleeSpriteId, WEAPON, WeaponType } from '../shared/constants.js';
import { applyAttackSpeedAndCooldownReduction } from '../shared/stats.js';
import type { WeaponDef } from '../shared/weaponDefs.js';
import { createLogger } from '../shared/logger.js';
import { normalize } from '../shared/vec.js';
import { isEnemyCombatEligible } from './floor2BossEligibility.js';

interface WeaponState {
  lastFireMs: number;
  aimX: number;
  aimY: number;
  /**
   * Last active-weapon generation observed by this system. When the core
   * `active-weapon` module bumps its generation on a real weapon switch we
   * reset `lastFireMs` so the new weapon can fire immediately instead of
   * inheriting the previous weapon's cooldown state.
   */
  lastActiveGeneration: number;
}

interface EnemyTarget {
  direction: { x: number; y: number };
  distanceSq: number;
  radiusFt: number;
  /** Vector from the shooter to the target's current position (ft). */
  deltaX: number;
  deltaY: number;
  /** Target velocity (ft/frame), used to lead projectiles. */
  velocityX: number;
  velocityY: number;
}

const ATTACK_TARGET_GATE_MULTIPLIER = 1.5;
// Enemies spawn around 160ft away, so keep combat targeting slightly beyond that.
const COMBAT_RADIUS_FT = 150;

const weaponStates = new WeakMap<GameWorld, WeaponState>();
const preferredTargets = new WeakMap<GameWorld, number>();
const logger = createLogger('game:weapon-system');

/** Set or clear the deterministic AI-preferred auto-aim target for this frame. */
export function setPreferredWeaponTarget(world: GameWorld, targetEid: number | null): void {
  if (targetEid === null) {
    preferredTargets.delete(world);
    return;
  }
  preferredTargets.set(world, targetEid);
}

function getWeaponState(world: GameWorld): WeaponState {
  let state = weaponStates.get(world);

  if (state === undefined) {
    state = {
      lastFireMs: -WEAPON.FIRE_RATE_MS,
      aimX: 1,
      aimY: 0,
      lastActiveGeneration: getActiveWeaponGeneration(world),
    };
    weaponStates.set(world, state);
  }

  return state;
}

/**
 * Sync this system's local fire-timer bookkeeping with the core active-weapon
 * generation. Called each tick before we consult `getActiveWeaponDef` — on a
 * real switch we reset `lastFireMs` so the freshly-equipped weapon can fire
 * immediately.
 */
function syncActiveWeaponGeneration(world: GameWorld, state: WeaponState): void {
  const generation = getActiveWeaponGeneration(world);
  if (generation === state.lastActiveGeneration) {
    return;
  }
  state.lastActiveGeneration = generation;
  const def = getActiveWeaponDef(world);
  if (def === undefined) {
    state.lastFireMs = world.elapsedMs;
    return;
  }
  const player = getPlayerEntity(world);
  const cooldownMs =
    player === undefined ? def.cooldownMs : getEffectiveCooldownMs(world, player, def.cooldownMs);
  if (!Number.isFinite(cooldownMs)) {
    // Preserve the "cannot fire" gate for non-positive attack-speed multipliers.
    // Using elapsedMs - Infinity here would store -Infinity and make
    // `(elapsed - lastFire) < cooldown` comparisons misfire (Infinity < Infinity
    // is false), allowing shots while disabled.
    state.lastFireMs = world.elapsedMs;
    return;
  }
  // Mirror setActiveWeapon's floating-point guard: with non-integer effective
  // cooldowns (for example under attack-speed debuffs), `x - (x - y)` can be
  // fractionally below `y` and delay readiness by one tick.
  state.lastFireMs = world.elapsedMs - (cooldownMs + 1);
}

function normalizeVector(x: number, y: number): { x: number; y: number } {
  return normalize(x, y, 1, 0);
}

/**
 * Compute a normalized aim direction that leads a moving target so a projectile
 * fired at `projectileSpeed` (ft/frame) intercepts it, rather than aiming at
 * where the target currently is. Solves the standard intercept quadratic
 * |delta + targetVelocity * t| = projectileSpeed * t for the smallest positive
 * time `t`, then aims at the predicted position `delta + targetVelocity * t`.
 *
 * Falls back to aiming at the target's current position when no positive
 * interception time exists (target outrunning the projectile) or the projectile
 * is effectively stationary. Pure and deterministic — no RNG, no time source.
 */
export function computeLeadDirection(
  deltaX: number,
  deltaY: number,
  targetVelocityX: number,
  targetVelocityY: number,
  projectileSpeed: number,
): { x: number; y: number } {
  const fallback = normalizeVector(deltaX, deltaY);
  if (!(projectileSpeed > 0.0001)) {
    return fallback;
  }

  const a =
    targetVelocityX * targetVelocityX +
    targetVelocityY * targetVelocityY -
    projectileSpeed * projectileSpeed;
  const b = 2 * (deltaX * targetVelocityX + deltaY * targetVelocityY);
  const c = deltaX * deltaX + deltaY * deltaY;

  let t = Number.POSITIVE_INFINITY;
  if (Math.abs(a) < 1e-6) {
    // Target speed ~= projectile speed: quadratic degenerates to linear b*t + c = 0.
    if (Math.abs(b) > 1e-6) {
      const linear = -c / b;
      if (linear > 1e-6) {
        t = linear;
      }
    }
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const sqrtDisc = Math.sqrt(discriminant);
      const root1 = (-b - sqrtDisc) / (2 * a);
      const root2 = (-b + sqrtDisc) / (2 * a);
      if (root1 > 1e-6) {
        t = root1;
      }
      if (root2 > 1e-6 && root2 < t) {
        t = root2;
      }
    }
  }

  if (!Number.isFinite(t)) {
    return fallback;
  }

  return normalizeVector(deltaX + targetVelocityX * t, deltaY + targetVelocityY * t);
}

/** Forward-fired projectile weapons whose shots benefit from target leading. */
function isLeadingProjectileWeapon(def: WeaponDef): boolean {
  return (
    def.weaponType === WeaponType.RANGED ||
    def.weaponType === WeaponType.MAGIC ||
    def.weaponType === WeaponType.THROWN
  );
}

function getEffectiveCooldownMs(world: GameWorld, player: number, baseCooldownMs: number): number {
  let cooldownMs = baseCooldownMs;
  if (hasComponent(world.ecs, player, EffectiveStats)) {
    const attackSpeedBonus = world.stores.effectiveStats.attackSpeed[player] ?? 0;
    const reduction = world.stores.effectiveStats.cooldownReduction[player] ?? 0;
    cooldownMs = applyAttackSpeedAndCooldownReduction(cooldownMs, attackSpeedBonus, reduction);
  }
  // Fold in the `attackSpeed` status channel (e.g. Queen Mab's Tarnished 0.75x).
  // A multiplier < 1 means "attacks slower", so it LENGTHENS the cooldown.
  // A zero or negative multiplier represents a "cannot attack" state (e.g. a
  // stun/disarm effect). Negative values are mathematically invalid as a rate
  // and zero yields a divide-by-zero; both map to Infinity so the weapon never
  // fires while the effect is active.
  const attackSpeedMult = computeEffectiveValue(1, getStatusEffects(world, player), 'attackSpeed');
  if (attackSpeedMult <= 0) {
    cooldownMs = Infinity;
  } else if (attackSpeedMult !== 1) {
    cooldownMs /= attackSpeedMult;
  }
  return cooldownMs;
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
    if (!isEnemyCombatEligible(world, enemy)) {
      continue;
    }
    // Skip corpses. Dead enemies keep their Enemy + Position components during
    // the death-linger window (deathTimerSystem removes them once the corpse
    // animation finishes); auto-aim must not waste swings or projectiles on
    // them, or the player keeps attacking a body while live enemies close in.
    if (hasComponent(world.ecs, enemy, DeathTimer)) {
      continue;
    }
    if (hasComponent(world.ecs, enemy, Health) && (world.stores.health.current[enemy] ?? 0) <= 0) {
      continue;
    }

    const ex = world.stores.position.x[enemy]!;
    const ey = world.stores.position.y[enemy]!;

    // Only target enemies the player has a clear line to: inside the computed
    // FOV, or at least reachable by an unobstructed straight line (covers
    // enemies just past the FOV radius in the same room). This stops ranged
    // weapons from firing through walls at enemies in the next room.
    if (!ignoreFov && world.floorMap) {
      const tile = world.floorMap.worldToTile(ex, ey);
      const visible = world.floorMap.isVisible(tile.x, tile.y);
      if (!visible && !world.floorMap.hasLineOfSight(playerX, playerY, ex, ey)) {
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
    const enemyRadiusFt = getBodyRadius(world, enemy, 'weaponSystem');
    nearestTarget = {
      direction: normalizeVector(deltaX, deltaY),
      distanceSq,
      radiusFt: enemyRadiusFt,
      deltaX,
      deltaY,
      velocityX: world.stores.velocity.x[enemy] ?? 0,
      velocityY: world.stores.velocity.y[enemy] ?? 0,
    };
  }

  return nearestTarget;
}

function getPreferredEnemyTarget(
  world: GameWorld,
  playerX: number,
  playerY: number,
): EnemyTarget | undefined {
  const enemy = preferredTargets.get(world);
  if (
    enemy === undefined ||
    !isEnemyCombatEligible(world, enemy) ||
    !hasComponent(world.ecs, enemy, Enemy) ||
    !hasComponent(world.ecs, enemy, Position) ||
    hasComponent(world.ecs, enemy, DeathTimer) ||
    (hasComponent(world.ecs, enemy, Health) && (world.stores.health.current[enemy] ?? 0) <= 0)
  ) {
    return undefined;
  }
  const ex = world.stores.position.x[enemy]!;
  const ey = world.stores.position.y[enemy]!;
  if (world.floorMap) {
    const tile = world.floorMap.worldToTile(ex, ey);
    if (
      !world.floorMap.isVisible(tile.x, tile.y) &&
      !world.floorMap.hasLineOfSight(playerX, playerY, ex, ey)
    ) {
      return undefined;
    }
  }
  const deltaX = ex - playerX;
  const deltaY = ey - playerY;
  const distanceSq = deltaX * deltaX + deltaY * deltaY;
  if (distanceSq <= 0.0001) {
    return undefined;
  }
  return {
    direction: normalizeVector(deltaX, deltaY),
    distanceSq,
    radiusFt: getBodyRadius(world, enemy, 'weaponSystem'),
    deltaX,
    deltaY,
    velocityX: world.stores.velocity.x[enemy] ?? 0,
    velocityY: world.stores.velocity.y[enemy] ?? 0,
  };
}

/**
 * Boss-priority targeting: returns a target aimed at a permanently-aggroed boss
 * (the elite marker, set only on Floor 1 bosses) when one is within `gateRangeFt`
 * and reachable. Auto-fire otherwise locks onto the strictly nearest enemy — in a
 * room full of respawning adds an add is almost always nearer than the boss, so a
 * single-target shot or arc swing rarely lands on the boss, leaving it effectively
 * unkillable. Focusing the elite when it is already in legitimate reach is a
 * standard combat heuristic: it does not bypass weapon range (still gated by
 * `gateRangeFt`), quest gating, or any UI-driven choice.
 */
function findBossTargetInRange(
  world: GameWorld,
  playerX: number,
  playerY: number,
  gateRangeFt: number,
): EnemyTarget | undefined {
  const behavior = world.stores.enemyBehavior;
  if (behavior?.aggroedPermanently === undefined) {
    return undefined;
  }
  const enemies = query(world.ecs, [Enemy, Position]);
  const gateSq = gateRangeFt * gateRangeFt;
  let best: EnemyTarget | undefined;
  let bestDistanceSq = Number.POSITIVE_INFINITY;

  for (const enemy of enemies) {
    if (!isEnemyCombatEligible(world, enemy)) {
      continue;
    }
    if ((behavior.aggroedPermanently[enemy] ?? 0) !== 1) {
      continue;
    }
    // Skip corpses — see getNearestEnemyTarget for rationale.
    if (hasComponent(world.ecs, enemy, DeathTimer)) {
      continue;
    }
    if (hasComponent(world.ecs, enemy, Health) && (world.stores.health.current[enemy] ?? 0) <= 0) {
      continue;
    }
    const ex = world.stores.position.x[enemy]!;
    const ey = world.stores.position.y[enemy]!;

    // Never aim through walls. A boss the player cannot see and has no clear
    // straight line to — e.g. on the far side of the still-locked boss door —
    // must not be targeted, or boss-priority auto-fire would shoot or swing
    // straight through the wall. Mirrors getNearestEnemyTarget's sight gate so
    // both the melee and ranged call sites respect line of sight to the boss.
    if (world.floorMap) {
      const tile = world.floorMap.worldToTile(ex, ey);
      if (
        !world.floorMap.isVisible(tile.x, tile.y) &&
        !world.floorMap.hasLineOfSight(playerX, playerY, ex, ey)
      ) {
        continue;
      }
    }

    const deltaX = ex - playerX;
    const deltaY = ey - playerY;
    const distanceSq = deltaX * deltaX + deltaY * deltaY;
    if (distanceSq <= 0.0001 || distanceSq > gateSq || distanceSq >= bestDistanceSq) {
      continue;
    }
    bestDistanceSq = distanceSq;
    const enemyRadiusFt = getBodyRadius(world, enemy, 'weaponSystem');
    best = {
      direction: normalizeVector(deltaX, deltaY),
      distanceSq,
      radiusFt: enemyRadiusFt,
      deltaX,
      deltaY,
      velocityX: world.stores.velocity.x[enemy] ?? 0,
      velocityY: world.stores.velocity.y[enemy] ?? 0,
    };
  }

  return best;
}

function getWeaponGateRangeFt(def: WeaponDef): number {
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
): number {
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
  return spawnMeleeSwing(
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
): number {
  const px = world.stores.position.x[player]!;
  const py = world.stores.position.y[player]!;
  if (def.bounceCount > 0) {
    return spawnBouncingProjectile(
      world,
      px,
      py,
      dir.x * def.projectileSpeed,
      dir.y * def.projectileSpeed,
      def.baseDamage,
      def.bounceCount,
      def.pierce,
      def.range,
      player,
    );
  }
  return spawnProjectile(
    world,
    px,
    py,
    dir.x * def.projectileSpeed,
    dir.y * def.projectileSpeed,
    def.baseDamage,
    def.pierce,
    def.range,
    1,
    player,
  );
}

function fireMagicAttack(
  world: GameWorld,
  player: number,
  def: WeaponDef,
  dir: { x: number; y: number },
): number {
  const px = world.stores.position.x[player]!;
  const py = world.stores.position.y[player]!;
  return spawnAoeProjectile(
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
): number {
  const px = world.stores.position.x[player]!;
  const py = world.stores.position.y[player]!;
  if (def.returnSpeed > 0 && def.maxRange > 0) {
    return spawnReturningProjectile(
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

  if (def.bounceCount > 0) {
    return spawnBouncingProjectile(
      world,
      px,
      py,
      dir.x * def.projectileSpeed,
      dir.y * def.projectileSpeed,
      def.baseDamage,
      def.bounceCount,
      def.pierce,
      def.range,
      player,
    );
  }

  return spawnProjectile(
    world,
    px,
    py,
    dir.x * def.projectileSpeed,
    dir.y * def.projectileSpeed,
    def.baseDamage,
    def.pierce,
    def.range,
    1,
    player,
  );
}

function fireBeamAttack(
  world: GameWorld,
  player: number,
  def: WeaponDef,
  dir: { x: number; y: number },
): number {
  const px = world.stores.position.x[player]!;
  const py = world.stores.position.y[player]!;
  return spawnBeam(
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

function fireTrapAttack(world: GameWorld, player: number, def: WeaponDef): number {
  const px = world.stores.position.x[player] ?? 0;
  const py = world.stores.position.y[player] ?? 0;
  return spawnTrap(
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
 * Used directly in labs/tests to simulate a weapon hit without running the full
 * attack pipeline. In live gameplay, damage systems call emitWeaponHitSkillEventsForSource
 * instead (see src/core/weapon-skill-bridge.ts).
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
  const bonus = hasComponent(world.ecs, player, EffectiveStats)
    ? (world.stores.effectiveStats.accuracy[player] ?? 0)
    : 0;
  return computeEffectiveAccuracyFromValues(def.weaponType, def.baseAccuracy, bonus);
}

/**
 * Rotate a normalized direction vector by `angleRad` radians (2-D rotation).
 */
function rotateDir(dir: { x: number; y: number }, angleRad: number): { x: number; y: number } {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: dir.x * cos - dir.y * sin,
    y: dir.x * sin + dir.y * cos,
  };
}

/** Minimum deflection angle for a ranged/magic/thrown miss (radians). */
const MISS_DEFLECT_MIN_RAD = Math.PI / 6; // 30°
/** Maximum deflection angle for a ranged/magic/thrown miss (radians). */
const MISS_DEFLECT_MAX_RAD = Math.PI / 3; // 60°

/**
 * Return a direction that deliberately misses: rotate `dir` by a random angle
 * between ±MISS_DEFLECT_MIN_RAD and ±MISS_DEFLECT_MAX_RAD.
 * Uses world.rng so the result is deterministic and reproducible.
 */
function deflectDirectionForMiss(
  world: GameWorld,
  dir: { x: number; y: number },
): { x: number; y: number } {
  const range = MISS_DEFLECT_MAX_RAD - MISS_DEFLECT_MIN_RAD;
  const magnitude = MISS_DEFLECT_MIN_RAD + world.rng.next() * range;
  const sign = world.rng.next() < 0.5 ? 1 : -1;
  return rotateDir(dir, magnitude * sign);
}

function dispatchAttack(
  world: GameWorld,
  player: number,
  def: WeaponDef,
  dir: { x: number; y: number },
): void {
  const generatedInstanceId =
    'generatedEquipmentInstanceId' in def ? String(def.generatedEquipmentInstanceId) : undefined;
  recordRunItemActivation(world, [
    generatedInstanceId
      ? `generated-equipment-instance:${generatedInstanceId}`
      : `weapon:${def.id}`,
  ]);
  // Count every committed activation as one telemetry "swing" and open an
  // activation id that spawned attack entities tag to. begin/end are no-ops
  // unless `world.weaponTelemetry` is enabled, so the shipping sim is unaffected.
  beginWeaponActivation(world);
  try {
    dispatchAttackInner(world, player, def, dir);
  } finally {
    endWeaponActivation(world);
  }
}

function dispatchAttackInner(
  world: GameWorld,
  player: number,
  def: WeaponDef,
  dir: { x: number; y: number },
): void {
  // Accuracy roll: miss if roll > effectiveAccuracy.
  // rng.next() returns [0,1); roll exactly at the threshold counts as a hit.
  const effectiveAccuracy = computeEffectiveAccuracy(world, player, def);
  if (world.rng.next() > effectiveAccuracy) {
    const px = world.stores.position.x[player] ?? 0;
    const py = world.stores.position.y[player] ?? 0;
    // Project forward in attack direction to ~weapon reach.
    // Cap at MAX_MISS_VFX_REACH_FT so ranged-weapon misses don't vanish off-screen.
    const MAX_MISS_VFX_REACH_FT = 8;
    const attackReach = Math.min(def.aoeRadius || def.range, MAX_MISS_VFX_REACH_FT);
    world.combatEvents.push({
      type: 'miss',
      x: px + dir.x * attackReach,
      y: py + dir.y * attackReach,
      amount: 0,
      targetType: 'enemy',
      timestamp: world.elapsedMs,
    });
    markWeaponAccuracyMiss(world);

    // Fire cosmetic animations even on a miss — no damage, no skill XP.
    const zeroDamageDef = { ...def, baseDamage: 0 };
    switch (def.weaponType) {
      case WeaponType.MELEE:
        // Swing still plays; 0-damage swing deals no harm on contact.
        fireMeleeAttack(world, player, zeroDamageDef, dir);
        break;
      case WeaponType.RANGED:
        // Shoot wide: deflect direction so the projectile clearly misses.
        fireRangedAttack(world, player, zeroDamageDef, deflectDirectionForMiss(world, dir));
        break;
      case WeaponType.MAGIC:
        // Spell whiffs still cast the spell's own AoE projectile (not a stray
        // arrow); the deflected direction makes it sail wide for zero damage.
        fireMagicAttack(world, player, zeroDamageDef, deflectDirectionForMiss(world, dir));
        break;
      case WeaponType.THROWN:
        fireThrownAttack(world, player, zeroDamageDef, deflectDirectionForMiss(world, dir));
        break;
      // BEAM and TRAP have no meaningful cosmetic-only miss animation; skip.
      default:
        break;
    }
    return;
  }

  // Register attacker-level fallback skill IDs and attack-level skill IDs.
  // Damage systems prefer the per-attack map so delayed hits stay attributed to
  // the weapon that spawned the attack, even after later weapon switches.
  world.attackerWeaponSkills.set(player, {
    classSkillId: def.weaponClassSkillId,
    typeSkillId: def.weaponTypeSkillId,
  });
  let attackEid: number | undefined;

  switch (def.weaponType) {
    case WeaponType.MELEE:
      attackEid = fireMeleeAttack(world, player, def, dir);
      break;
    case WeaponType.RANGED:
      attackEid = fireRangedAttack(world, player, def, dir);
      break;
    case WeaponType.MAGIC:
      attackEid = fireMagicAttack(world, player, def, dir);
      break;
    case WeaponType.THROWN:
      attackEid = fireThrownAttack(world, player, def, dir);
      break;
    case WeaponType.BEAM:
      attackEid = fireBeamAttack(world, player, def, dir);
      break;
    case WeaponType.TRAP:
      attackEid = fireTrapAttack(world, player, def);
      break;
    default:
      break;
  }
  if (attackEid !== undefined) {
    // Persist fail-closed damage-scaling metadata onto the spawned attack
    // entity so the collision system that eventually calls applyDamage (or a
    // later explosion/impact entity that propagates this tag — see
    // trapSystem.ts / aoeOnImpactSystem.ts) knows this is player-sourced and
    // whether it's physical (STR-scaled) or magic (INT-scaled) offense. Only
    // WeaponType.MAGIC is magic affinity — every other weapon type (melee,
    // ranged, thrown, beam, trap) is physical.
    tagDamageMeta(world, attackEid, {
      origin: 'player',
      affinity: def.weaponType === WeaponType.MAGIC ? 'magic' : 'physical',
      scaleWithPrimary: true,
      canCrit: true,
    });
    world.attackWeaponSkillsByEntity.set(attackEid, {
      classSkillId: def.weaponClassSkillId,
      typeSkillId: def.weaponTypeSkillId,
    });
  }
}

/**
 * Set the active weapon definition for the weapon system.
 *
 * Thin wrapper around `setActiveWeaponDef` in `core/active-weapon.ts` — kept
 * as a game-layer entry point so labs and legacy callers that bypass the
 * equipment path (weapon-lab, gore-lab, abilities-lab) can drive the active
 * weapon directly. The equipment-driven path (`equipmentSystem.equip`) writes
 * to the same core state, so both paths converge on one source of truth.
 *
 * Also eagerly syncs this system's local fire-timer bookkeeping: captures
 * `world.elapsedMs - def.cooldownMs` into `lastFireMs` immediately so callers
 * that swap weapons and then rewind `elapsedMs` for testing (see
 * `behavior-tree-ai.test.ts`) see a fully-charged weapon at the wall-clock
 * moment of the swap, not at the next tick.
 */
export function setActiveWeapon(world: GameWorld, weaponDef: WeaponDef): void {
  const previousGeneration = getActiveWeaponGeneration(world);
  setActiveWeaponDef(world, weaponDef);
  const state = getWeaponState(world);
  const nextGeneration = getActiveWeaponGeneration(world);
  const isSwitch = nextGeneration !== previousGeneration;
  state.lastActiveGeneration = nextGeneration;
  if (isSwitch) {
    // Real switch: charge the new weapon so it can fire immediately.
    // Use the effective cooldown (folding in status-effect attack-speed
    // multipliers such as Tarnished's 0.75x) so the fresh weapon is actually
    // ready at the switch instant when the player is slowed. Mirrors the same
    // logic in syncActiveWeaponGeneration.
    //
    // Adding 1ms to the back-offset guarantees the gate
    // `elapsedMs - lastFireMs >= effectiveCooldown` is satisfied even when
    // effectiveCooldown is non-integer (e.g. 500/0.75 ≈ 666.6̄ms), avoiding
    // floating-point rounding where `x − (x − y) < y`.
    const player = getPlayerEntity(world);
    const effectiveCooldown =
      player !== undefined
        ? getEffectiveCooldownMs(world, player, weaponDef.cooldownMs)
        : weaponDef.cooldownMs;
    state.lastFireMs =
      world.elapsedMs -
      (Number.isFinite(effectiveCooldown)
        ? effectiveCooldown + 1
        : // Non-finite (Infinity or NaN) means "cannot attack" (e.g. zero/negative
          // attack speed). Setting lastFireMs = elapsedMs means elapsed = 0 ≪
          // Infinity cooldown → ready = false, preserving the disabled state.
          0);
  }
  if (!isSwitch) {
    logger.debug('Updated active weapon tuning in place', { weaponId: weaponDef.id });
    return;
  }
  logger.info('Equipped active weapon', {
    weaponId: weaponDef.id,
    weaponType: weaponDef.weaponType,
    cooldownMs: weaponDef.cooldownMs,
  });
}

/** Clear the active weapon. The player will not auto-fire until a new weapon is set. */
export function clearActiveWeapon(world: GameWorld): void {
  const previousWeaponId = getActiveWeaponDef(world)?.id;
  clearActiveWeaponDef(world);
  const state = getWeaponState(world);
  state.lastActiveGeneration = getActiveWeaponGeneration(world);
  state.lastFireMs = world.elapsedMs;
  logger.info('Cleared active weapon', { previousWeaponId });
}

/** Get the active weapon definition, if any. */
export function getActiveWeapon(world: GameWorld): WeaponDef | undefined {
  return getActiveWeaponDef(world);
}

/**
 * Active-weapon cooldown readiness, mirroring the same effective-cooldown gate
 * used by the melee/data-driven fire path:
 * `world.elapsedMs - state.lastFireMs >= getEffectiveCooldownMs(...)`.
 * Returns `null` when no weapon is equipped. Exposed so the headless AI can
 * stutter-step: dart into strike range when `ready`, ease back out while a
 * swing is on cooldown instead of standing still and trading blows.
 */
export function getActiveWeaponReadiness(
  world: GameWorld,
): { ready: boolean; remainingMs: number; cooldownMs: number } | null {
  const state = getWeaponState(world);
  syncActiveWeaponGeneration(world, state);
  const def = getActiveWeaponDef(world);
  if (def === undefined) {
    return null;
  }
  const player = getPlayerEntity(world);
  const cooldownMs =
    player === undefined ? def.cooldownMs : getEffectiveCooldownMs(world, player, def.cooldownMs);
  const remainingMs = Math.max(0, cooldownMs - (world.elapsedMs - state.lastFireMs));
  return { ready: remainingMs <= 0, remainingMs, cooldownMs };
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
  syncActiveWeaponGeneration(world, state);
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
  const activeDef = getActiveWeaponDef(world);
  if (activeDef !== undefined) {
    const def = activeDef;
    const cooldownMs = getEffectiveCooldownMs(world, player, def.cooldownMs);

    // Trap weapons deploy at the player's feet regardless of enemy proximity.
    if (def.weaponType === WeaponType.TRAP) {
      const lastFire = state.lastFireMs;
      if (world.elapsedMs - lastFire >= cooldownMs) {
        dispatchAttack(world, player, def, { x: 0, y: 0 });
        state.lastFireMs = world.elapsedMs;
      }
      return;
    }

    // Melee weapons: Fire only when an enemy is in legitimate reach with a clear
    // line to it. Passing ignoreFov=false gates on FOV + line of sight, so the
    // swing never auto-aims at (and the arc never lands on) an enemy through a
    // wall — the melee analogue of the ranged sight gate below.
    if (def.weaponType === WeaponType.MELEE) {
      if (!inCombat) {
        return;
      }
      const target = getNearestEnemyTarget(world, playerX, playerY, false);
      if (!target) {
        return;
      }
      const lastFire = state.lastFireMs;
      if (world.elapsedMs - lastFire < cooldownMs) {
        return;
      }
      const gateRangeFt = getWeaponGateRangeFt(def) * ATTACK_TARGET_GATE_MULTIPLIER;
      if (target.distanceSq > gateRangeFt * gateRangeFt) {
        return;
      }

      // Boss-priority aim: if a boss/elite is itself within legitimate reach,
      // center the swing on it so the arc reliably lands on the boss instead of a
      // transient add. Falls back to the nearest enemy when no boss is in range,
      // preserving normal add-clearing.
      const bossTarget = findBossTargetInRange(world, playerX, playerY, gateRangeFt);
      const preferredTarget = getPreferredEnemyTarget(world, playerX, playerY);
      const preferredInRange =
        preferredTarget && preferredTarget.distanceSq <= gateRangeFt * gateRangeFt
          ? preferredTarget
          : undefined;
      const fireTarget = bossTarget ?? preferredInRange ?? target;

      dispatchAttack(world, player, def, fireTarget.direction);
      state.aimX = fireTarget.direction.x;
      state.aimY = fireTarget.direction.y;
      state.lastFireMs = world.elapsedMs;
      return;
    }

    // Require a clear line of sight to the target. Ranged/magic/thrown/beam
    // weapons must never fire through walls at an enemy in the next room, even
    // while in active combat — getNearestEnemyTarget gates on FOV + line of sight.
    const target = getNearestEnemyTarget(world, playerX, playerY, false);
    if (!target) {
      return;
    }
    const gateRangeFt = getWeaponGateRangeFt(def) * ATTACK_TARGET_GATE_MULTIPLIER;
    if (target.distanceSq > gateRangeFt * gateRangeFt) {
      return;
    }
    const lastFire = state.lastFireMs;

    if (world.elapsedMs - lastFire < cooldownMs) {
      return;
    }

    // Boss-priority aim: focus an in-reach boss/elite so projectiles reliably
    // land on it instead of a transient add (mirrors the melee path). A slow
    // arrow chasing the nearest respawning add never closes the boss fight.
    const bossTarget = findBossTargetInRange(world, playerX, playerY, gateRangeFt);
    const preferredTarget = getPreferredEnemyTarget(world, playerX, playerY);
    const preferredInRange =
      preferredTarget && preferredTarget.distanceSq <= gateRangeFt * gateRangeFt
        ? preferredTarget
        : undefined;
    const fireTarget = bossTarget ?? preferredInRange ?? target;

    // Lead moving targets for forward-fired projectiles so slow arrows/bolts
    // intercept a strafing enemy instead of trailing its current position.
    const fireDir = isLeadingProjectileWeapon(def)
      ? computeLeadDirection(
          fireTarget.deltaX,
          fireTarget.deltaY,
          fireTarget.velocityX,
          fireTarget.velocityY,
          def.projectileSpeed,
        )
      : fireTarget.direction;

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
