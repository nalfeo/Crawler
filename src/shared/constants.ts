/**
 * Game-wide constants.
 *
 * Tunable values are loaded from src/shared/data/tuning.json so labs can
 * save tweaked values back to disk without editing source. Non-tunable
 * structural constants (enums, game dimensions) remain hardcoded.
 */
import tuning from './data/tuning.json';

export const GAME = {
  /** Render canvas width in pixels (rendering layer only). */
  WIDTH: 1280,
  /** Render canvas height in pixels (rendering layer only). */
  HEIGHT: 720,
  TARGET_FPS: 60,
  DELTA_MS: 1000 / 60,
} as const;

/**
 * Default arena bounds in FEET, used by core systems as a fallback play area
 * when no floor map is loaded. Mirrors the render canvas (1280×720 px) at
 * PIXELS_PER_FOOT = 8 → 160×90 ft.
 */
export const ARENA = {
  WIDTH_FT: 160,
  HEIGHT_FT: 90,
} as const;

export const PLAYER_SPEED: number = tuning.player.speed;

export const WeaponType = {
  MELEE: 0,
  RANGED: 1,
  MAGIC: 3,
  THROWN: 4,
  BEAM: 5,
  TRAP: 6,
} as const;
export type WeaponTypeValue = (typeof WeaponType)[keyof typeof WeaponType];

export const MeleeStyle = {
  SLASH: 0,
  STAB: 1,
} as const;
export type MeleeStyleValue = (typeof MeleeStyle)[keyof typeof MeleeStyle];

/** Sprite hint IDs stored in the meleeSwing.spriteId ECS field and read by PhaserBridge. */
export const MeleeSpriteId = {
  SWORD: 1,
  BAT: 2,
} as const;

export const TeamId = {
  PLAYER: 0,
  ENEMY: 1,
  NEUTRAL: 2,
} as const;
export type TeamIdValue = (typeof TeamId)[keyof typeof TeamId];

export const WEAPON = {
  PROJECTILE_SPEED: tuning.weapon.projectileSpeed,
  FIRE_RATE_MS: tuning.weapon.fireRateMs,
  BASE_DAMAGE: tuning.weapon.baseDamage,
  MELEE_RANGE: tuning.weapon.meleeRange,
  MELEE_DURATION_MS: tuning.weapon.meleeDurationMs,
  BEAM_LENGTH: tuning.weapon.beamLength,
  BEAM_DURATION_MS: tuning.weapon.beamDurationMs,
  BEAM_TICK_MS: tuning.weapon.beamTickMs,
  TRAP_ARM_MS: tuning.weapon.trapArmMs,
  TRAP_TRIGGER_RADIUS: tuning.weapon.trapTriggerRadius,
  TRAP_EXPLOSION_RADIUS: tuning.weapon.trapExplosionRadius,
  THROWN_RETURN_SPEED: tuning.weapon.thrownReturnSpeed,
  THROWN_MAX_RANGE: tuning.weapon.thrownMaxRange,
  AOE_RADIUS: tuning.weapon.aoeRadius,
} as const;

export const ENEMY_PROJECTILE = {
  SPEED: tuning.enemyProjectile.speed,
  FIRE_COOLDOWN_MS: tuning.enemyProjectile.fireCooldownMs,
  DAMAGE: tuning.enemyProjectile.damage,
  MUZZLE_OFFSET: tuning.enemyProjectile.muzzleOffset,
  ACCURACY: tuning.enemyProjectile.accuracy,
} as const;

export const FLOOR = {
  MIN_DURATION_S: tuning.floor.minDurationS,
  MAX_DURATION_S: tuning.floor.maxDurationS,
  BOSS_TRIGGER_WARNING_S: tuning.floor.bossWarningS,
} as const;

export const SAFE_ROOM = {
  MIN_DURATION_S: tuning.safeRoom.minDurationS,
  OPTIMAL_DURATION_S: tuning.safeRoom.optimalDurationS,
  IMPATIENCE_THRESHOLD_S: tuning.safeRoom.impatienceThresholdS,
} as const;

export const XP = {
  BASE_PER_LEVEL: tuning.xp.basePerLevel,
  SCALING_FACTOR: tuning.xp.scalingFactor,
} as const;
