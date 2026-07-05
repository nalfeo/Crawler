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
 *
 * The signal used is **Euclidean** distance from the floor spawn tile, which is
 * a good approximation of "how far into the dungeon" the player is. Ambient
 * enemies spawn between `spawnRadiusMin` (20 ft) and `ambientSpawnMaxDistanceFt`
 * (160 ft) of the *current* player position (see `src/shared/floor-config.ts`),
 * so as the player pushes deeper into the floor their distance from the spawn
 * tile grows and the ramp engages naturally. Room-graph hop-distance would be a
 * more topologically accurate depth metric but requires plumbing
 * `floorMap.roomGraph` through the spawn path — tracked as a future improvement
 * if tuning shows the Euclidean metric misfires (e.g. on compact loopy maps).
 *
 * TODO: These constants should migrate into the per-floor config / enemy-pack
 * JSON once the data-driven tuning path (floor-config.ts) supports balance
 * scaling parameters, so designers can adjust them without touching shared code.
 */
export const MOB_SCALING_REFERENCE_DIST_FT = 250;

/**
 * HP multiplier at spawn (distance 0). Always 1.0 — base archetype stats apply
 * exactly at the starting room.
 */
export const MOB_SCALING_HP_MULT_MIN = 1.0;

/**
 * HP multiplier at {@link MOB_SCALING_REFERENCE_DIST_FT} and beyond.
 * Calibrated to 1.25× — distant trash mobs feel meaningfully tougher while
 * staying beatable by a player who has levelled up through the floor. The
 * endpoint was tuned against the headless Floor-1 AI-time budget (the sword +
 * arena sweep in `tests/headless/spawner-arena-win-rate.test.ts`): a steeper
 * 1.5× ramp pushed one winning seed's clear time to 379s, past the 360s AI
 * budget, because deeper mobs take proportionally longer to kill. 1.25× keeps
 * the ramp meaningful while every winning seed clears with ~40s+ of headroom.
 */
export const MOB_SCALING_HP_MULT_MAX = 1.25;

/**
 * Speed multiplier at {@link MOB_SCALING_REFERENCE_DIST_FT} and beyond.
 * Kept small (1.05×) — speed increases disproportionately raise difficulty for
 * ranged/kiting play styles and can spike run failures unexpectedly, so the
 * speed ramp is intentionally gentler than the HP ramp.
 */
export const MOB_SCALING_SPEED_MULT_MAX = 1.05;

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
