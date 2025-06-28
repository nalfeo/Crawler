import { DEFAULT_BLOOD_COLOR } from './constants.js';
import { SeededRandom, hashStringToSeed } from './random.js';

const BLOOD_POOL_LIFETIME_MS = 30_000;
export const BLOODY_FOOTPRINT_SOURCE_LIFETIME_MS = 5_000;
const BLOODY_FOOTPRINT_LIFETIME_MS = 5_000;
export const BLOODY_FOOTPRINT_EMIT_DISTANCE_FT = 0.42;
export const MAX_BLOOD_POOLS = 150;
export const MAX_BLOODY_FOOTPRINTS = 160;
export const MAX_BLOODY_FOOTPRINT_EMITS_PER_FRAME = 24;

const BLOOD_POOL_BASE_RADIUS_FT = 1.0;
const BLOOD_POOL_MAX_EXTRA_RADIUS_FT = 2.25;
const BLOOD_POOL_INITIAL_SCALE = 0.25;
const BLOOD_POOL_EXPAND_PHASE = 0.7;
export const BLOOD_POOL_FINAL_VERTICAL_SCALE = 0.5;
const BLOOD_POOL_LOBE_COUNT = 5;
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
  } = params;
  const rng = new SeededRandom(hashStringToSeed(`${worldSeed}:blood-pool:${poolId}`));
  const radiusFt =
    BLOOD_POOL_BASE_RADIUS_FT +
    Math.min(BLOOD_POOL_MAX_EXTRA_RADIUS_FT, Math.max(0, overkill) * 0.0625);
  const sizeVariance = 0.6 + rng.next() * 0.9;
  const scaleX = (0.8 + rng.next() * 0.5) * sizeVariance;
  const scaleY = (0.6 + rng.next() * 0.4) * sizeVariance;
  const baseRxFt = radiusFt * scaleX;
  const baseRyFt = radiusFt * scaleY;
  const lobes: BloodPoolLobeShape[] = [];
  let maxReachFt = Math.max(baseRxFt, baseRyFt);
  for (let i = 0; i < BLOOD_POOL_LOBE_COUNT; i += 1) {
    const isCore = i === 0;
    const lobeAngle = rng.next() * Math.PI * 2;
    const lobeRadiusFt = isCore ? 0 : (0.25 + rng.next() * 0.55) * Math.min(baseRxFt, baseRyFt);
    const radiusXFt = baseRxFt * (isCore ? 1 : 0.55 + rng.next() * 0.5);
    const radiusYFt = baseRyFt * (isCore ? 1 : 0.55 + rng.next() * 0.5);
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
      growAt: isCore ? 0.35 : 0.55 + rng.next() * 0.45,
      initialScale: isCore ? BLOOD_POOL_INITIAL_SCALE : 0,
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
  const lateralOffsetFt = 0.13 + rng.next() * 0.05;
  const forwardJitterFt = (rng.next() - 0.5) * 0.06;
  const lateralJitterFt = (rng.next() - 0.5) * 0.03;
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
    heelRadiusXFt: 0.14 + rng.next() * 0.03,
    heelRadiusYFt: 0.1 + rng.next() * 0.02,
    toeRadiusXFt: 0.18 + rng.next() * 0.04 + smearFactor * 0.06,
    toeRadiusYFt: 0.11 + rng.next() * 0.03,
    toeOffsetFt: 0.2 + rng.next() * 0.05 + smearFactor * 0.12,
    smearLengthFt: smearFactor > 0 ? 0.18 + smearFactor * (0.18 + rng.next() * 0.1) : 0,
    smearWidthFt: 0.07 + rng.next() * 0.03,
  };
}
