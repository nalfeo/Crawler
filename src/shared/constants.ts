/** Game-wide constants. */

export const GAME = {
  WIDTH: 1280,
  HEIGHT: 720,
  TARGET_FPS: 60,
  DELTA_MS: 1000 / 60,
} as const;

export const PLAYER_SPEED = 3.0;

export const WeaponType = {
  MELEE: 0,
  RANGED: 1,
  UNARMED: 2,
  MAGIC: 3,
  THROWN: 4,
  BEAM: 5,
  TRAP: 6,
} as const;
export type WeaponTypeValue = (typeof WeaponType)[keyof typeof WeaponType];

export const TeamId = {
  PLAYER: 0,
  ENEMY: 1,
  NEUTRAL: 2,
} as const;
export type TeamIdValue = (typeof TeamId)[keyof typeof TeamId];

export const WEAPON = {
  PROJECTILE_SPEED: 5.0,
  FIRE_RATE_MS: 500,
  BASE_DAMAGE: 10,
  MELEE_RANGE: 40,
  MELEE_DURATION_MS: 200,
  UNARMED_RANGE: 24,
  UNARMED_DURATION_MS: 150,
  BEAM_LENGTH: 200,
  BEAM_DURATION_MS: 300,
  BEAM_TICK_MS: 100,
  TRAP_ARM_MS: 500,
  TRAP_TRIGGER_RADIUS: 32,
  TRAP_EXPLOSION_RADIUS: 64,
  THROWN_RETURN_SPEED: 4.0,
  THROWN_MAX_RANGE: 200,
  AOE_RADIUS: 48,
} as const;

export const ENEMY_PROJECTILE = {
  SPEED: 3.0,
  FIRE_COOLDOWN_MS: 1200,
  DAMAGE: 8,
  MUZZLE_OFFSET: 12,
} as const;

export const FLOOR = {
  MIN_DURATION_S: 120,
  MAX_DURATION_S: 300,
  BOSS_TRIGGER_WARNING_S: 10,
} as const;

export const SAFE_ROOM = {
  MIN_DURATION_S: 60,
  OPTIMAL_DURATION_S: 120,
  IMPATIENCE_THRESHOLD_S: 180,
} as const;

export const XP = {
  BASE_PER_LEVEL: 10,
  SCALING_FACTOR: 1.15,
} as const;
