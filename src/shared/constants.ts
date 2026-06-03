/** Game-wide constants. */

export const GAME = {
  WIDTH: 1280,
  HEIGHT: 720,
  TARGET_FPS: 60,
  DELTA_MS: 1000 / 60,
} as const;

export const PLAYER_SPEED = 3.0;

export const WEAPON = {
  PROJECTILE_SPEED: 5.0,
  FIRE_RATE_MS: 500,
  BASE_DAMAGE: 10,
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
