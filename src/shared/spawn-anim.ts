/**
 * Spawn-in animation math — pure, deterministic, rendering-free.
 *
 * Drives the "pop out + slight wiggle" effect used when an entity emerges into
 * the world (e.g. baby slimes spawned by a slime split). Lives in `src/shared/`
 * so the core `spawnAnimSystem` timing, the engine renderer, and the spawn-anim
 * lab all share one source of truth and can be unit-tested in isolation.
 *
 * The animation is expressed purely as a function of normalised progress
 * `p ∈ [0, 1]` (0 = just spawned, 1 = settled), so it is frame-rate independent
 * and identical wherever it is evaluated.
 */

/** Duration of a mini-slime's spawn-in animation / invulnerability window (ms). */
export const MINI_SLIME_SPAWN_ANIM_MS = 280;

/** Default jelly-wiggle amplitude (fraction of base scale) at p = 0. */
export const SPAWN_ANIM_WIGGLE_AMPLITUDE = 0.18;

/** Default number of squash/stretch oscillations across the animation. */
export const SPAWN_ANIM_WIGGLE_CYCLES = 3;

/** Per-axis render scale multipliers for the spawn animation. */
export interface SpawnPopScale {
  /** Horizontal scale multiplier (stretches outward as it wobbles). */
  readonly x: number;
  /** Vertical scale multiplier (squashes inward as it wobbles). */
  readonly y: number;
}

export interface SpawnPopOptions {
  /** Override the jelly-wiggle amplitude (fraction of base scale). */
  readonly wiggleAmplitude?: number;
  /** Override the number of squash/stretch oscillations. */
  readonly wiggleCycles?: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Normalised spawn-animation progress from a countdown timer.
 * Returns 0 when the animation has just started (remaining == total) and 1 when
 * it has finished (remaining <= 0). A non-positive `totalMs` is treated as
 * already-complete.
 */
export function spawnAnimProgress(remainingMs: number, totalMs: number): number {
  if (!(totalMs > 0)) return 1;
  return clamp01(1 - remainingMs / totalMs);
}

/**
 * Ease-out-back curve: rises from 0, overshoots slightly past 1, then settles at
 * 1. Gives the "pop" — the entity grows beyond full size before relaxing.
 */
export function easeOutBack(p: number): number {
  const t = clamp01(p) - 1;
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * t * t * t + c1 * t * t;
}

/**
 * Compute the per-axis scale multipliers for a spawning entity at progress `p`.
 *
 * Combines the ease-out-back "pop" with a decaying sine wobble that stretches
 * the x-axis while squashing the y-axis (and vice-versa), producing a jelly-like
 * wiggle that fades to nothing as the entity settles. At p = 0 the result is
 * {0, 0} (invisible); at p = 1 it is {1, 1} (full, steady size).
 */
export function computeSpawnPopScale(p: number, options: SpawnPopOptions = {}): SpawnPopScale {
  const amplitude = options.wiggleAmplitude ?? SPAWN_ANIM_WIGGLE_AMPLITUDE;
  const cycles = options.wiggleCycles ?? SPAWN_ANIM_WIGGLE_CYCLES;
  const progress = clamp01(p);
  const pop = easeOutBack(progress);
  // Wobble decays linearly to zero so the entity holds a steady size once settled.
  const wobble = Math.sin(progress * Math.PI * cycles) * amplitude * (1 - progress);
  return { x: pop * (1 + wobble), y: pop * (1 - wobble) };
}
