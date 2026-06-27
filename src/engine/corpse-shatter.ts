/**
 * corpse-shatter — pure, Phaser-free geometry + kinematics for the corpse
 * explosion VFX.
 *
 * When a corpse is struck it bursts into a `cols x rows` grid of shards cut from
 * the corpse's own texture frame. Each shard is the full sprite cropped to one
 * grid cell, with its transform origin pinned to that cell's centre so it
 * tumbles in place as it sprays outward.
 *
 * This module owns only the numbers — tiling rectangles, outward directions,
 * launch velocities and the fade/scale curves — so they can be unit-tested in
 * isolation. {@link ./CorpseShatterVfx} owns the actual Phaser objects and the
 * per-frame loop. Randomness here is injected (`rng: () => number`) and is VFX
 * only; it never touches game state, so it does not need the deterministic
 * SeededRandom.
 */

/** Default shard grid. 3x3 = 9 chunks reads as a clean burst without churn. */
export const SHATTER_COLS = 3;
export const SHATTER_ROWS = 3;

/** Base outward speed (px/s) of a shard at impact, before jitter. */
export const SHATTER_BASE_SPEED = 90;
/** Random speed multiplier range per shard: `[1 - j, 1 + j]`. */
export const SHATTER_SPEED_JITTER = 0.45;
/** Extra speed (px/s) added along the blow direction so shards follow the hit. */
export const SHATTER_IMPACT_BOOST = 70;
/** Downward acceleration (px/s^2) so shards arc and fall. */
export const SHATTER_GRAVITY = 240;
/** Velocity retained per second (linear drag): `v *= 1 - DRAG * dt`. */
export const SHATTER_DRAG = 0.6;
/** Max absolute angular velocity (rad/s) of a tumbling shard. */
export const SHATTER_SPIN = 12;
/** Shard lifetime (ms) before it has fully faded. */
export const SHATTER_LIFETIME_MS = 650;
/** Random +/- fraction applied to each shard's lifetime. */
export const SHATTER_LIFETIME_JITTER = 0.25;

/** Progress at/below which a shard holds full opacity (then it fades to 0). */
const ALPHA_HOLD_FRACTION = 0.5;
/** Total shrink applied across a shard's life (1 -> 1 - this). */
const SCALE_SHRINK = 0.35;

/** Geometry for one shard, independent of where the corpse is on screen. */
export interface ShatterPieceSpec {
  col: number;
  row: number;
  /** Crop rectangle in source-texture pixels (tiles the frame exactly). */
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  /** Transform origin as a fraction of the full frame, at the cell's centre. */
  originX: number;
  originY: number;
  /** Offset (unscaled px) from the sprite centre to this cell's centre. */
  offsetX: number;
  offsetY: number;
  /** Unit vector from the sprite centre out through the cell (0,0 if centred). */
  dirX: number;
  dirY: number;
}

/** Launch kinematics rolled for a single shard. */
export interface ShatterPieceLaunch {
  vx: number;
  vy: number;
  /** Angular velocity in rad/s. */
  rotVel: number;
  lifetimeMs: number;
}

/** Tunable inputs for {@link rollPieceLaunch}. */
export interface ShatterLaunchParams {
  baseSpeed: number;
  speedJitter: number;
  impactDirX: number;
  impactDirY: number;
  impactBoost: number;
  spin: number;
  lifetimeMs: number;
  lifetimeJitter: number;
}

/** Default launch params, scaled by impact strength via {@link scaleLaunchParams}. */
export const DEFAULT_LAUNCH_PARAMS: ShatterLaunchParams = {
  baseSpeed: SHATTER_BASE_SPEED,
  speedJitter: SHATTER_SPEED_JITTER,
  impactDirX: 0,
  impactDirY: 0,
  impactBoost: SHATTER_IMPACT_BOOST,
  spin: SHATTER_SPIN,
  lifetimeMs: SHATTER_LIFETIME_MS,
  lifetimeJitter: SHATTER_LIFETIME_JITTER,
};

function clamp01(value: number): number {
  if (value < 0 || Number.isNaN(value)) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Cut a `frameW x frameH` texture frame into a `cols x rows` grid of shard
 * specs. Cell boundaries are rounded so the crops tile the frame exactly (no
 * gaps or overlaps), even when the dimensions do not divide evenly.
 */
export function buildShatterSpecs(
  frameW: number,
  frameH: number,
  cols: number = SHATTER_COLS,
  rows: number = SHATTER_ROWS,
): ShatterPieceSpec[] {
  const safeW = Math.max(1, frameW);
  const safeH = Math.max(1, frameH);
  const safeCols = Math.max(1, Math.floor(cols));
  const safeRows = Math.max(1, Math.floor(rows));
  const specs: ShatterPieceSpec[] = [];

  for (let row = 0; row < safeRows; row++) {
    const y0 = Math.round((row * safeH) / safeRows);
    const y1 = Math.round(((row + 1) * safeH) / safeRows);
    for (let col = 0; col < safeCols; col++) {
      const x0 = Math.round((col * safeW) / safeCols);
      const x1 = Math.round(((col + 1) * safeW) / safeCols);

      const cropW = x1 - x0;
      const cropH = y1 - y0;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const offsetX = cx - safeW / 2;
      const offsetY = cy - safeH / 2;
      const mag = Math.hypot(offsetX, offsetY);

      specs.push({
        col,
        row,
        cropX: x0,
        cropY: y0,
        cropW,
        cropH,
        originX: cx / safeW,
        originY: cy / safeH,
        offsetX,
        offsetY,
        dirX: mag > 0.0001 ? offsetX / mag : 0,
        dirY: mag > 0.0001 ? offsetY / mag : 0,
      });
    }
  }

  return specs;
}

/**
 * Scale the launch params by an impact strength (the hit's damage `amount`).
 * Harder hits throw shards faster and further; the curve saturates so a huge
 * overkill does not fling pieces off-screen.
 */
export function scaleLaunchParams(
  base: ShatterLaunchParams,
  amount: number,
  impactDirX: number,
  impactDirY: number,
): ShatterLaunchParams {
  const strength = 1 + Math.min(1, Math.max(0, amount) / 40);
  return {
    ...base,
    baseSpeed: base.baseSpeed * strength,
    impactBoost: base.impactBoost * strength,
    impactDirX,
    impactDirY,
  };
}

/**
 * Roll the launch velocity, spin and lifetime for one shard. Outward direction
 * comes from the shard's grid position; a dead-centre shard (which has no
 * outward direction) gets a random angle instead so it still flies. The blow
 * direction biases every shard so the burst leans the way the hit travelled.
 */
export function rollPieceLaunch(
  spec: ShatterPieceSpec,
  params: ShatterLaunchParams,
  rng: () => number,
): ShatterPieceLaunch {
  const speed = params.baseSpeed * (1 + (rng() * 2 - 1) * params.speedJitter);

  let dirX = spec.dirX;
  let dirY = spec.dirY;
  if (Math.abs(dirX) + Math.abs(dirY) < 0.0001) {
    const angle = rng() * Math.PI * 2;
    dirX = Math.cos(angle);
    dirY = Math.sin(angle);
  }

  return {
    vx: dirX * speed + params.impactDirX * params.impactBoost,
    vy: dirY * speed + params.impactDirY * params.impactBoost,
    rotVel: (rng() * 2 - 1) * params.spin,
    lifetimeMs: Math.max(1, params.lifetimeMs * (1 + (rng() * 2 - 1) * params.lifetimeJitter)),
  };
}

/** Fraction of a shard's life elapsed (0 at birth, 1 at death), clamped. */
export function pieceProgress(ageMs: number, lifetimeMs: number): number {
  if (lifetimeMs <= 0) return 1;
  return clamp01(ageMs / lifetimeMs);
}

/** Shard opacity over its life: holds full, then fades linearly to 0. */
export function shatterAlpha(progress: number): number {
  const p = clamp01(progress);
  if (p <= ALPHA_HOLD_FRACTION) return 1;
  return 1 - (p - ALPHA_HOLD_FRACTION) / (1 - ALPHA_HOLD_FRACTION);
}

/** Shard scale over its life: a gentle, monotonic shrink. */
export function shatterScale(progress: number): number {
  return 1 - SCALE_SHRINK * clamp01(progress);
}

/**
 * Advance a shard's velocity by one step: apply gravity then linear drag.
 * Pure — returns the new velocity rather than mutating.
 */
export function integratePieceVelocity(
  vx: number,
  vy: number,
  dtSec: number,
  gravity: number = SHATTER_GRAVITY,
  drag: number = SHATTER_DRAG,
): { vx: number; vy: number } {
  const retain = Math.max(0, 1 - drag * dtSec);
  return {
    vx: vx * retain,
    vy: (vy + gravity * dtSec) * retain,
  };
}
