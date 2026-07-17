import {
  parseGeneratedManifest,
  type GeneratedManifest,
  type ManifestEntry,
} from '../../shared/generated-assets.js';

export type MobMotionState = 'movement' | 'attack' | 'hit';

export interface MobSpriteOption {
  readonly textureKey: string;
  readonly briefId: string;
  readonly label: string;
  readonly assetPath: string;
  readonly variantIndex: number;
  readonly anchor: { readonly x: number; readonly y: number } | null;
  readonly centerOfGravity: { readonly x: number; readonly y: number } | null;
}

export interface MobMotionTransform {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotation: number;
  readonly alpha: number;
  readonly flash: number;
}

const STATIONARY_ENEMY_BRIEFS = new Set(['rat-nest-v2', 'rats-nest-v1', 'slime-pool-v1']);
const TAU = Math.PI * 2;

function anchorPoint(
  entry: ManifestEntry,
  key: 'hold' | 'centerOfGravity',
): { readonly x: number; readonly y: number } | null {
  const point = entry.anchors?.[key] ?? (key === 'hold' ? entry.anchor : null);
  return point ? { x: point.x, y: point.y } : null;
}

export function selectMobSprites(rawManifest: unknown): readonly MobSpriteOption[] {
  const manifest: GeneratedManifest = parseGeneratedManifest(rawManifest);
  return Object.entries(manifest.entries)
    .filter(([, entry]) => entry.type === 'enemy' && !STATIONARY_ENEMY_BRIEFS.has(entry.briefId))
    .map(([textureKey, entry]) => ({
      textureKey,
      briefId: entry.briefId,
      label: `${entry.briefId} · variant ${entry.variantIndex}`,
      assetPath: entry.assetPath,
      variantIndex: entry.variantIndex,
      anchor: anchorPoint(entry, 'hold'),
      centerOfGravity: anchorPoint(entry, 'centerOfGravity') ?? anchorPoint(entry, 'hold'),
    }))
    .sort(
      (a, b) =>
        a.briefId.localeCompare(b.briefId) ||
        a.variantIndex - b.variantIndex ||
        a.textureKey.localeCompare(b.textureKey),
    );
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function quantize(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function normalizedPhase(elapsedMs: number, periodMs: number): number {
  return (((elapsedMs % periodMs) + periodMs) % periodMs) / periodMs;
}

export function sampleMobMotion(
  state: MobMotionState,
  elapsedMs: number,
  intensity = 1,
): MobMotionTransform {
  const amount = Math.max(0, intensity);

  if (state === 'movement') {
    const phase = normalizedPhase(elapsedMs, 560);
    const stride = Math.sin(phase * TAU);
    const lift = Math.abs(stride);
    return {
      offsetX: quantize(stride * amount, 0.5),
      offsetY: quantize(-lift * 2 * amount, 0.5),
      scaleX: quantize(1 + lift * 0.04 * amount, 0.005),
      scaleY: quantize(1 - lift * 0.06 * amount, 0.005),
      rotation: quantize(stride * 0.025 * amount, 0.005),
      alpha: 1,
      flash: 0,
    };
  }

  if (state === 'attack') {
    const phase = normalizedPhase(elapsedMs, 900);
    let offsetX: number;
    let offsetY: number;
    let scaleX: number;
    let scaleY: number;
    let rotation: number;

    if (phase < 0.32) {
      const windup = smoothstep(phase / 0.32);
      offsetX = -3 * windup;
      offsetY = windup;
      scaleX = 1 - 0.04 * windup;
      scaleY = 1 + 0.05 * windup;
      rotation = -0.08 * windup;
    } else if (phase < 0.5) {
      const strike = smoothstep((phase - 0.32) / 0.18);
      offsetX = -3 + 11 * strike;
      offsetY = 1 - 2 * Math.sin(strike * Math.PI);
      scaleX = 0.96 + 0.14 * strike;
      scaleY = 1.05 - 0.11 * strike;
      rotation = -0.08 + 0.2 * strike;
    } else {
      const recover = smoothstep((phase - 0.5) / 0.5);
      offsetX = 8 * (1 - recover);
      offsetY = -Math.sin(recover * Math.PI);
      scaleX = 1 + 0.1 * (1 - recover);
      scaleY = 1 - 0.06 * (1 - recover);
      rotation = 0.12 * (1 - recover);
    }

    return {
      offsetX: quantize(offsetX * amount, 0.5),
      offsetY: quantize(offsetY * amount, 0.5),
      scaleX: quantize(1 + (scaleX - 1) * amount, 0.005),
      scaleY: quantize(1 + (scaleY - 1) * amount, 0.005),
      rotation: quantize(rotation * amount, 0.005),
      alpha: 1,
      flash: 0,
    };
  }

  const phase = normalizedPhase(elapsedMs, 1_000);
  const active = phase < 0.32 ? 1 - phase / 0.32 : 0;
  if (active === 0) {
    return {
      offsetX: 0,
      offsetY: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      alpha: 1,
      flash: 0,
    };
  }
  const shake = active > 0 ? (Math.floor(phase * 48) % 2 === 0 ? -1 : 1) : 0;
  return {
    offsetX: quantize((-6 * active + shake * 1.5 * active) * amount, 0.5),
    offsetY: quantize(-active * amount, 0.5),
    scaleX: quantize(1 + active * 0.08 * amount, 0.005),
    scaleY: quantize(1 - active * 0.08 * amount, 0.005),
    rotation: quantize(-active * 0.07 * amount, 0.005),
    alpha: quantize(1 - active * 0.25, 0.05),
    flash: clamp01(active * amount),
  };
}
