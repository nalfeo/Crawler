import { DEFAULT_BLOOD_COLOR } from './constants.js';
import { SeededRandom, hashStringToSeed } from './random.js';

const BLOOD_POOL_LIFETIME_MS = 30_000;
export const BLOODY_FOOTPRINT_SOURCE_LIFETIME_MS = 5_000;
const BLOODY_FOOTPRINT_LIFETIME_MS = 5_000;
/**
 * Along-path distance between consecutive prints, i.e. one walking step.
 *
 * Calibrated to the shipping `rhea-vale-v1` player sprite, whose drawn content
 * is 58 px tall at scale 0.72 → 5.22 ft (see `entity-sprite-mappings.json`).
 * A human's walking step length is ~0.41 x height → 5.22 x 0.41 ≈ 2.1 ft.
 *
 * MUST stay at least 2x the longest unsmeared print (~1.00 ft, asserted by
 * `blood-surfaces.test.ts`) or consecutive prints overlap and the trail reads
 * as a continuous streak rather than discrete alternating steps. The previous
 * 0.42 ft was tuned for the retired 3.2 ft Kenney knight sprite and left the
 * spacing SHORTER than a single print.
 */
export const BLOODY_FOOTPRINT_EMIT_DISTANCE_FT = 2.1;
export const MAX_BLOOD_POOLS = 150;
export const MAX_BLOODY_FOOTPRINTS = 160;
/**
 * Per-frame emit cap. Also sets the teleport-detection threshold
 * (`MAX_CONTINUOUS_FOOTPRINT_GAP_FT = this x EMIT_DISTANCE`), so it moves
 * inversely with the stride to hold that threshold at ~10 ft:
 * 5 x 2.1 = 10.5 ft (previously 24 x 0.42 = 10.08 ft).
 */
export const MAX_BLOODY_FOOTPRINT_EMITS_PER_FRAME = 5;

const BLOOD_POOL_BASE_RADIUS_FT = 1.0;
const BLOOD_POOL_MAX_EXTRA_RADIUS_FT = 2.25;
const BLOOD_POOL_REFERENCE_ENEMY_SIZE_FT = 2.0;
const BLOOD_POOL_MIN_ENEMY_SIZE_SCALE = 0.65;
const BLOOD_POOL_MAX_ENEMY_SIZE_SCALE = 1.85;
const BLOOD_POOL_INITIAL_SCALE = 0.25;
const BLOOD_POOL_EXPAND_PHASE = 0.7;
export const BLOOD_POOL_FINAL_VERTICAL_SCALE = 0.5;
const BLOOD_POOL_LOBE_MIN_COUNT = 5;
const BLOOD_POOL_LOBE_MAX_COUNT = 8;
const BLOOD_POOL_COLOR_SCALE = 0.83;

export interface BloodPoolLobeShape {
  offsetXFt: number;
  offsetYFt: number;
  radiusXFt: number;
  radiusYFt: number;
  growAt: number;
  initialScale: number;
}

export interface BloodPoolSurface {
  id: number;
  x: number;
  y: number;
  color: number;
  createdAtMs: number;
  expiresAtMs: number;
  renderOffsetXFt: number;
  renderOffsetYFt: number;
  contactRadiusFt: number;
  lobes: BloodPoolLobeShape[];
}

export interface BloodFootprintSurface {
  id: number;
  x: number;
  y: number;
  color: number;
  createdAtMs: number;
  expiresAtMs: number;
  angleRad: number;
  heelRadiusXFt: number;
  heelRadiusYFt: number;
  toeRadiusXFt: number;
  toeRadiusYFt: number;
  toeOffsetFt: number;
  smearLengthFt: number;
  smearWidthFt: number;
}

export interface BloodyFootprintSourceState {
  color: number;
  expiresAtMs: number;
  lastEmitX: number | null;
  lastEmitY: number | null;
}

export interface BloodyFootprintState {
  source: BloodyFootprintSourceState | null;
  overlappingPoolIds: Set<number>;
  nextOverlappingPoolIds: Set<number>;
  nextPoolId: number;
  nextFootprintId: number;
  nextStampId: number;
}

export function createBloodyFootprintState(): BloodyFootprintState {
  return {
    source: null,
    overlappingPoolIds: new Set<number>(),
    nextOverlappingPoolIds: new Set<number>(),
    nextPoolId: 1,
    nextFootprintId: 1,
    nextStampId: 0,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function packRgb(r: number, g: number, b: number): number {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

function unpackRgb(color: number): { r: number; g: number; b: number } {
  return {
    r: (color >> 16) & 0xff,
    g: (color >> 8) & 0xff,
    b: color & 0xff,
  };
}

export function mixBloodColors(a: number, b: number): number {
  const left = unpackRgb(a);
  const right = unpackRgb(b);
  return packRgb(
    Math.round((left.r + right.r) / 2),
    Math.round((left.g + right.g) / 2),
    Math.round((left.b + right.b) / 2),
  );
}

export function getBloodPoolRenderColor(baseColor: number): number {
  const { r, g, b } = unpackRgb(baseColor);
  return packRgb(
    Math.round(r * BLOOD_POOL_COLOR_SCALE),
    Math.round(g * BLOOD_POOL_COLOR_SCALE),
    Math.round(b * BLOOD_POOL_COLOR_SCALE),
  );
}

export function getBloodPoolLifetimeProgress(
  pool: Pick<BloodPoolSurface, 'createdAtMs' | 'expiresAtMs'>,
  nowMs: number,
): number {
  const lifetimeMs = Math.max(1, pool.expiresAtMs - pool.createdAtMs);
  return clamp01((nowMs - pool.createdAtMs) / lifetimeMs);
}

export function evaluateBloodPoolVerticalScale(progress: number): number {
  return 1 - (1 - BLOOD_POOL_FINAL_VERTICAL_SCALE) * clamp01(progress);
}

export function evaluateBloodPoolLobeScale(progress: number, lobe: BloodPoolLobeShape): number {
  const expandProgress = Math.min(1, progress / BLOOD_POOL_EXPAND_PHASE);
  const lobeProgress = Math.min(1, expandProgress / Math.max(lobe.growAt, 0.001));
  return lobe.initialScale + (1 - lobe.initialScale) * (1 - (1 - lobeProgress) ** 3);
}

export function isPointInsideBloodPool(
  pool: BloodPoolSurface,
  pointX: number,
  pointY: number,
  nowMs: number,
): boolean {
  const progress = getBloodPoolLifetimeProgress(pool, nowMs);
  const verticalScale = evaluateBloodPoolVerticalScale(progress);
  for (const lobe of pool.lobes) {
    const lobeScale = evaluateBloodPoolLobeScale(progress, lobe);
    const radiusXFt = lobe.radiusXFt * lobeScale;
    const radiusYFt = lobe.radiusYFt * lobeScale * verticalScale;
    if (radiusXFt <= 0 || radiusYFt <= 0) {
      continue;
    }
    const centerX = pool.x + pool.renderOffsetXFt + lobe.offsetXFt;
    const centerY = pool.y + pool.renderOffsetYFt + lobe.offsetYFt * verticalScale;
    const dx = (pointX - centerX) / radiusXFt;
    const dy = (pointY - centerY) / radiusYFt;
    if (dx * dx + dy * dy <= 1) {
      return true;
    }
  }
  return false;
}

export function isBloodyFootprintSourceActive(
  source: BloodyFootprintSourceState | null,
  nowMs: number,
): source is BloodyFootprintSourceState {
  return source !== null && source.expiresAtMs > nowMs;
}

export function createBloodPoolSurface(params: {
  worldSeed: number;
  poolId: number;
  x: number;
  y: number;
  color?: number;
  overkill?: number;
  enemySizeFt?: number;
  createdAtMs: number;
}): BloodPoolSurface {
  const {
    worldSeed,
    poolId,
    x,
    y,
    createdAtMs,
    color = DEFAULT_BLOOD_COLOR,
    overkill = 0,
    enemySizeFt = BLOOD_POOL_REFERENCE_ENEMY_SIZE_FT,
  } = params;
  const rng = new SeededRandom(hashStringToSeed(`${worldSeed}:blood-pool:${poolId}`));
  const enemySizeScale = Math.max(
    BLOOD_POOL_MIN_ENEMY_SIZE_SCALE,
    Math.min(BLOOD_POOL_MAX_ENEMY_SIZE_SCALE, enemySizeFt / BLOOD_POOL_REFERENCE_ENEMY_SIZE_FT),
  );
  const radiusFt =
    (BLOOD_POOL_BASE_RADIUS_FT +
      Math.min(BLOOD_POOL_MAX_EXTRA_RADIUS_FT, Math.max(0, overkill) * 0.0625)) *
    enemySizeScale;
  const sizeVariance = 0.6 + rng.next() * 0.9;
  const scaleX = (0.65 + rng.next() * 0.8) * sizeVariance;
  const scaleY = (0.5 + rng.next() * 0.7) * sizeVariance;
  const baseRxFt = radiusFt * scaleX;
  const baseRyFt = radiusFt * scaleY;
  const lobeCount =
    BLOOD_POOL_LOBE_MIN_COUNT +
    Math.floor(rng.next() * (BLOOD_POOL_LOBE_MAX_COUNT - BLOOD_POOL_LOBE_MIN_COUNT + 1));
  const lobes: BloodPoolLobeShape[] = [];
  const dominantAngle = rng.next() * Math.PI * 2;
  let maxReachFt = Math.max(baseRxFt, baseRyFt);
  for (let i = 0; i < lobeCount; i += 1) {
    const isCore = i === 0;
    const lobeAngle = rng.next() * Math.PI * 2;
    const alongDominantAxis = (Math.cos(lobeAngle - dominantAngle) + 1) * 0.5;
    const lobeRadiusFt = isCore
      ? 0
      : (0.1 + rng.next() * 0.9 + alongDominantAxis * 0.35) * Math.min(baseRxFt, baseRyFt);
    const radiusXFt = baseRxFt * (isCore ? 1 : 0.35 + rng.next() * 0.95);
    const radiusYFt = baseRyFt * (isCore ? 1 : 0.35 + rng.next() * 0.95);
    const offsetXFt = Math.cos(lobeAngle) * lobeRadiusFt;
    const offsetYFt = Math.sin(lobeAngle) * lobeRadiusFt;
    maxReachFt = Math.max(
      maxReachFt,
      Math.hypot(offsetXFt, offsetYFt) + Math.max(radiusXFt, radiusYFt),
    );
    lobes.push({
      offsetXFt,
      offsetYFt,
      radiusXFt,
      radiusYFt,
      growAt: isCore ? 0.3 : 0.3 + rng.next() * 0.7,
      initialScale: isCore ? BLOOD_POOL_INITIAL_SCALE : rng.next() * 0.18,
    });
  }

  return {
    id: poolId,
    x,
    y,
    color,
    createdAtMs,
    expiresAtMs: createdAtMs + BLOOD_POOL_LIFETIME_MS,
    renderOffsetXFt: 0,
    renderOffsetYFt: 0,
    contactRadiusFt: maxReachFt + 0.45,
    lobes,
  };
}

/**
 * Builds one deterministic blood footprint stamp.
 *
 * Geometry is calibrated to the shipping `rhea-vale-v1` player sprite (5.22 ft
 * drawn). The renderer (`PlayerTrailVfx`) draws a heel ellipse at the origin
 * plus a toe ellipse offset forward, both rotated to `angleRad`, so along the
 * heading a print spans
 * `[-heelRadiusXFt, toeOffsetFt + toeRadiusXFt]`:
 *
 * * length 0.85-1.00 ft (unsmeared) — matches the sprite's drawn boots
 * * width  0.36-0.44 ft — keeps a foot-like ~2.3:1 length:width ratio
 * * lateral offset ±0.35-0.45 ft — a 0.70-0.90 ft track, so left/right prints
 *   read as two distinct feet under the sprite's wide boot stance
 *
 * These were previously ~1.63x smaller (tuned for the retired 3.2 ft Kenney
 * knight). `blood-surfaces.test.ts` pins the length band and asserts the
 * spacing invariant against `BLOODY_FOOTPRINT_EMIT_DISTANCE_FT`.
 */
export function createBloodFootprintSurface(params: {
  worldSeed: number;
  footprintId: number;
  stampId: number;
  color: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  createdAtMs: number;
  strideDistanceFt?: number;
}): BloodFootprintSurface {
  const { worldSeed, footprintId, stampId, color, fromX, fromY, toX, toY, createdAtMs } = params;
  const rng = new SeededRandom(hashStringToSeed(`${worldSeed}:bloody-footprint:${stampId}`));
  const dx = toX - fromX;
  const dy = toY - fromY;
  const distanceFt = Math.hypot(dx, dy);
  const strideDistanceFt = params.strideDistanceFt ?? distanceFt;
  const angleRad = distanceFt > 0.0001 ? Math.atan2(dy, dx) : 0;
  const perpX = -Math.sin(angleRad);
  const perpY = Math.cos(angleRad);
  const side = stampId % 2 === 0 ? -1 : 1;
  const lateralOffsetFt = 0.35 + rng.next() * 0.1;
  const forwardJitterFt = (rng.next() - 0.5) * 0.1;
  const lateralJitterFt = (rng.next() - 0.5) * 0.05;
  const smearFactor = clamp01(
    (strideDistanceFt - BLOODY_FOOTPRINT_EMIT_DISTANCE_FT) /
      (BLOODY_FOOTPRINT_EMIT_DISTANCE_FT * 1.5),
  );
  const forwardX = distanceFt > 0.0001 ? dx / distanceFt : 1;
  const forwardY = distanceFt > 0.0001 ? dy / distanceFt : 0;

  return {
    id: footprintId,
    x: toX + perpX * (side * lateralOffsetFt + lateralJitterFt) + forwardX * forwardJitterFt,
    y: toY + perpY * (side * lateralOffsetFt + lateralJitterFt) + forwardY * forwardJitterFt,
    color,
    createdAtMs,
    expiresAtMs: createdAtMs + BLOODY_FOOTPRINT_LIFETIME_MS,
    angleRad,
    heelRadiusXFt: 0.23 + rng.next() * 0.04,
    heelRadiusYFt: 0.16 + rng.next() * 0.03,
    toeRadiusXFt: 0.29 + rng.next() * 0.05 + smearFactor * 0.1,
    toeRadiusYFt: 0.18 + rng.next() * 0.04,
    toeOffsetFt: 0.33 + rng.next() * 0.06 + smearFactor * 0.2,
    smearLengthFt: smearFactor > 0 ? 0.29 + smearFactor * (0.29 + rng.next() * 0.16) : 0,
    smearWidthFt: 0.11 + rng.next() * 0.05,
  };
}
