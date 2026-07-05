/**
 * Mob Level Scaling — distance-from-spawn difficulty ramp.
 *
 * Enemies that spawn farther from the player's starting tile receive boosted HP
 * and speed so the dungeon feels increasingly dangerous as the player explores.
 * The ramp is intentionally gentle: trash mobs that a surviving player
 * encounters should feel challenging but never impossible.
 *
 * All values are in **feet** (ADR 0023).
 */

/**
 * Distance (ft) at which the scaling multipliers reach their maximum.
 * Enemies spawned at or beyond this distance are fully scaled.
 */
export const MOB_SCALING_REFERENCE_DIST_FT = 250;

/**
 * HP multiplier at spawn (distance 0). Always 1.0 — base archetype stats apply
 * exactly at the starting room.
 */
export const MOB_SCALING_HP_MULT_MIN = 1.0;

/**
 * HP multiplier at {@link MOB_SCALING_REFERENCE_DIST_FT} and beyond.
 * A value of 2.0 means mobs at the far edge of the floor have twice the HP of
 * their near-spawn counterparts.
 */
export const MOB_SCALING_HP_MULT_MAX = 2.0;

/**
 * Speed multiplier at {@link MOB_SCALING_REFERENCE_DIST_FT} and beyond.
 * Kept conservative (1.15×) so distant mobs feel faster but not overwhelming.
 */
export const MOB_SCALING_SPEED_MULT_MAX = 1.15;

/** Result returned by {@link computeMobLevelScale}. */
export interface MobLevelScale {
  /** Multiply base HP by this value. Always ≥ 1.0. */
  readonly hpMult: number;
  /** Multiply base speed by this value. Always ≥ 1.0. */
  readonly speedMult: number;
}

/**
 * Compute the HP and speed multipliers for a mob spawned at a given Euclidean
 * distance from the player's floor spawn point.
 *
 * The ramp is linear between 0 and {@link MOB_SCALING_REFERENCE_DIST_FT},
 * clamped to [min, max] at both ends. The function is pure and deterministic.
 *
 * @param distFromSpawnFt - Euclidean distance in feet from the player's spawn
 *   tile to the mob's spawn position. Negative values are treated as 0.
 */
export function computeMobLevelScale(distFromSpawnFt: number): MobLevelScale {
  const t = Math.max(0, Math.min(1, distFromSpawnFt / MOB_SCALING_REFERENCE_DIST_FT));
  const hpMult = MOB_SCALING_HP_MULT_MIN + t * (MOB_SCALING_HP_MULT_MAX - MOB_SCALING_HP_MULT_MIN);
  const speedMult = 1.0 + t * (MOB_SCALING_SPEED_MULT_MAX - 1.0);
  return { hpMult, speedMult };
}
