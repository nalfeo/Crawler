import { CORPSE, ENEMY_PROJECTILE } from '../../shared/constants.js';
import { computeCorpseDecay, type CorpseDecay } from '../../engine/corpse-decay.js';
import { computeSpawnPopScale, MINI_SLIME_SPAWN_ANIM_MS } from '../../shared/spawn-anim.js';
import {
  parseGeneratedManifest,
  type GeneratedManifest,
  type ManifestEntry,
} from '../../shared/generated-assets.js';

export type MobMotionState = 'spawn' | 'movement' | 'attack' | 'hit' | 'death' | 'status';
export type MobLocomotionStyle = 'stride' | 'hop' | 'hover' | 'slither' | 'stomp';
export type MobStatusTreatment = 'freeze' | 'burn' | 'stun';

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

export interface MobMotionOptions {
  readonly intensity?: number;
  readonly movementStyle?: MobLocomotionStyle;
  readonly attack?: {
    readonly hasProjectile: boolean;
    readonly telegraphMs: number;
  };
}

export interface AttackPreviewSample {
  readonly phaseMs: number;
  readonly telegraphActive: boolean;
  readonly telegraphPulse: number;
  readonly projectileVisible: boolean;
  readonly projectileProgress: number;
}

export interface DeathPreviewSample {
  readonly phaseMs: number;
  readonly remainingMs: number;
  readonly corpse: CorpseDecay;
  readonly deathPopProgress: number;
  readonly bloodPoolProgress: number;
  readonly knockbackProgress: number;
}

// These enemy-typed manifest entries are structures, so movement transforms
// would misrepresent them as mobile mobs.
const STATIONARY_ENEMY_BRIEFS = new Set(['rat-nest', 'rats-nest-v1', 'slime-pool']);
const TAU = Math.PI * 2;
const SPAWN_CYCLE_MS = 1_300;
const MELEE_ATTACK_CYCLE_MS = 900;
const HIT_CYCLE_MS = 1_000;
const DEATH_RESET_MS = 600;
const DEATH_POP_MS = 500;
const DEATH_KNOCKBACK_MS = 220;
const BLOOD_POOL_LIFETIME_MS = 30_000;
const BLOOD_POOL_EXPAND_FRACTION = 0.7;
const STATUS_TREATMENT_MS = 800;
const PROJECTILE_TRAVEL_MS = 500;
const PROJECTILE_RECOVERY_MS = 120;

const NEUTRAL_TRANSFORM: MobMotionTransform = {
  offsetX: 0,
  offsetY: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  alpha: 1,
  flash: 0,
};

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
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function smoothstep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function quantize(value: number, step: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value / step) * step;
}

function elapsedWithin(elapsedMs: number, periodMs: number): number {
  const safeElapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0;
  return ((safeElapsed % periodMs) + periodMs) % periodMs;
}

function normalizedPhase(elapsedMs: number, periodMs: number): number {
  return elapsedWithin(elapsedMs, periodMs) / periodMs;
}

function scaleTransform(transform: MobMotionTransform, intensity: number): MobMotionTransform {
  const amount = Math.max(0, Number.isFinite(intensity) ? intensity : 0);
  return {
    offsetX: quantize(transform.offsetX * amount, 0.5),
    offsetY: quantize(transform.offsetY * amount, 0.5),
    scaleX: quantize(1 + (transform.scaleX - 1) * amount, 0.005),
    scaleY: quantize(1 + (transform.scaleY - 1) * amount, 0.005),
    rotation: quantize(transform.rotation * amount, 0.005),
    alpha: quantize(1 + (transform.alpha - 1) * Math.min(1, amount), 0.05),
    flash: clamp01(transform.flash * amount),
  };
}

function sampleSpawn(elapsedMs: number): MobMotionTransform {
  const phaseMs = elapsedWithin(elapsedMs, SPAWN_CYCLE_MS);
  if (phaseMs >= MINI_SLIME_SPAWN_ANIM_MS) {
    return NEUTRAL_TRANSFORM;
  }

  const progress = phaseMs / MINI_SLIME_SPAWN_ANIM_MS;
  const scale = computeSpawnPopScale(progress);
  return {
    offsetX: 0,
    offsetY: quantize((1 - progress) * 6, 0.5),
    scaleX: quantize(scale.x, 0.005),
    scaleY: quantize(scale.y, 0.005),
    rotation: quantize(Math.sin(progress * Math.PI * 3) * 0.04 * (1 - progress), 0.005),
    alpha: quantize(clamp01(progress * 3), 0.05),
    flash: 0,
  };
}

function sampleMovement(elapsedMs: number, style: MobLocomotionStyle): MobMotionTransform {
  if (style === 'hop') {
    const phase = normalizedPhase(elapsedMs, 720);
    const arc = Math.sin(phase * Math.PI);
    const lean = Math.sin(phase * TAU);
    return {
      offsetX: lean * 0.75,
      offsetY: -arc * 5,
      scaleX: 1 - arc * 0.05,
      scaleY: 1 + arc * 0.08,
      rotation: lean * 0.035,
      alpha: 1,
      flash: 0,
    };
  }

  if (style === 'hover') {
    const phase = normalizedPhase(elapsedMs, 1_100);
    const wave = Math.sin(phase * TAU);
    return {
      offsetX: Math.cos(phase * TAU) * 0.75,
      offsetY: -2.5 - wave * 2,
      scaleX: 1 + wave * 0.015,
      scaleY: 1 - wave * 0.015,
      rotation: wave * 0.025,
      alpha: 1,
      flash: 0,
    };
  }

  if (style === 'slither') {
    const phase = normalizedPhase(elapsedMs, 640);
    const sway = Math.sin(phase * TAU);
    const compression = Math.abs(Math.cos(phase * TAU));
    return {
      offsetX: sway * 1.5,
      offsetY: -Math.abs(sway) * 0.5,
      scaleX: 1 + compression * 0.06,
      scaleY: 1 - compression * 0.04,
      rotation: sway * 0.055,
      alpha: 1,
      flash: 0,
    };
  }

  if (style === 'stomp') {
    const phase = normalizedPhase(elapsedMs, 900);
    const lift = phase < 0.35 ? Math.sin((phase / 0.35) * Math.PI) : 0;
    const impact = phase >= 0.35 && phase < 0.52 ? 1 - (phase - 0.35) / 0.17 : 0;
    return {
      offsetX: 0,
      offsetY: -lift * 2.5,
      scaleX: 1 + impact * 0.11,
      scaleY: 1 - impact * 0.13,
      rotation: Math.sin(phase * TAU) * 0.01,
      alpha: 1,
      flash: 0,
    };
  }

  const phase = normalizedPhase(elapsedMs, 560);
  const stride = Math.sin(phase * TAU);
  const lift = Math.abs(stride);
  return {
    offsetX: stride,
    offsetY: -lift * 2,
    scaleX: 1 + lift * 0.04,
    scaleY: 1 - lift * 0.06,
    rotation: stride * 0.025,
    alpha: 1,
    flash: 0,
  };
}

export function sampleAttackPreview(
  elapsedMs: number,
  hasProjectile: boolean,
  telegraphMs: number,
): AttackPreviewSample {
  const phaseMs = elapsedWithin(elapsedMs, ENEMY_PROJECTILE.FIRE_COOLDOWN_MS);
  if (!hasProjectile) {
    return {
      phaseMs,
      telegraphActive: false,
      telegraphPulse: 0,
      projectileVisible: false,
      projectileProgress: 0,
    };
  }

  const delayMs = Math.min(
    Math.max(0, Number.isFinite(telegraphMs) ? telegraphMs : 0),
    ENEMY_PROJECTILE.FIRE_COOLDOWN_MS - PROJECTILE_RECOVERY_MS,
  );
  const telegraphActive = delayMs > 0 && phaseMs < delayMs;
  const travelEndMs = Math.min(
    ENEMY_PROJECTILE.FIRE_COOLDOWN_MS - PROJECTILE_RECOVERY_MS,
    delayMs + PROJECTILE_TRAVEL_MS,
  );
  const projectileVisible = phaseMs >= delayMs && phaseMs < travelEndMs;
  const travelDurationMs = Math.max(1, travelEndMs - delayMs);

  return {
    phaseMs,
    telegraphActive,
    telegraphPulse: telegraphActive
      ? quantize(0.55 + Math.sin((phaseMs / Math.max(1, delayMs)) * Math.PI * 4) * 0.2, 0.05)
      : 0,
    projectileVisible,
    projectileProgress: projectileVisible ? clamp01((phaseMs - delayMs) / travelDurationMs) : 0,
  };
}

function sampleMeleeAttack(elapsedMs: number): MobMotionTransform {
  const phase = normalizedPhase(elapsedMs, MELEE_ATTACK_CYCLE_MS);
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
    offsetX,
    offsetY,
    scaleX,
    scaleY,
    rotation,
    alpha: 1,
    flash: 0,
  };
}

function sampleRangedAttack(elapsedMs: number, telegraphMs: number): MobMotionTransform {
  const preview = sampleAttackPreview(elapsedMs, true, telegraphMs);
  const delayMs = Math.max(0, telegraphMs);

  if (preview.telegraphActive) {
    const windup = smoothstep(preview.phaseMs / Math.max(1, delayMs));
    return {
      offsetX: -2.5 * windup,
      offsetY: windup,
      scaleX: 1 - 0.05 * windup,
      scaleY: 1 + 0.06 * windup,
      rotation: -0.06 * windup,
      alpha: 1,
      flash: 0,
    };
  }

  if (preview.projectileVisible) {
    const recoil = 1 - smoothstep(Math.min(1, preview.projectileProgress * 3));
    return {
      offsetX: 4 * recoil,
      offsetY: -recoil,
      scaleX: 1 + recoil * 0.08,
      scaleY: 1 - recoil * 0.05,
      rotation: 0.08 * recoil,
      alpha: 1,
      flash: recoil,
    };
  }

  return NEUTRAL_TRANSFORM;
}

function sampleHit(elapsedMs: number): MobMotionTransform {
  const phase = normalizedPhase(elapsedMs, HIT_CYCLE_MS);
  const active = phase < 0.32 ? 1 - phase / 0.32 : 0;
  if (active === 0) {
    return NEUTRAL_TRANSFORM;
  }
  const shake = Math.floor(phase * 48) % 2 === 0 ? -1 : 1;
  return {
    offsetX: -6 * active + shake * 1.5 * active,
    offsetY: -active,
    scaleX: 1 + active * 0.08,
    scaleY: 1 - active * 0.08,
    rotation: -active * 0.07,
    alpha: 1 - active * 0.25,
    flash: active,
  };
}

export function sampleDeathPreview(elapsedMs: number): DeathPreviewSample {
  const phaseMs = elapsedWithin(elapsedMs, CORPSE.LINGER_MS + DEATH_RESET_MS);
  const remainingMs = Math.max(0, CORPSE.LINGER_MS - phaseMs);
  const deathPopProgress = clamp01(phaseMs / DEATH_POP_MS);
  const knockbackProgress = smoothstep(clamp01(phaseMs / DEATH_KNOCKBACK_MS));
  const bloodPoolProgress = clamp01(
    phaseMs / (BLOOD_POOL_LIFETIME_MS * BLOOD_POOL_EXPAND_FRACTION),
  );

  return {
    phaseMs,
    remainingMs,
    corpse: computeCorpseDecay(remainingMs, CORPSE.LINGER_MS),
    deathPopProgress,
    bloodPoolProgress,
    knockbackProgress,
  };
}

function sampleDeath(elapsedMs: number): MobMotionTransform {
  const preview = sampleDeathPreview(elapsedMs);
  const impactFlash = 1 - clamp01(preview.phaseMs / 100);
  return {
    offsetX: 7 * preview.knockbackProgress,
    offsetY: preview.knockbackProgress,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    alpha: preview.corpse.corpseAlpha,
    flash: impactFlash,
  };
}

export function sampleStatusTreatment(elapsedMs: number): MobStatusTreatment {
  const index = Math.floor(elapsedWithin(elapsedMs, STATUS_TREATMENT_MS * 3) / STATUS_TREATMENT_MS);
  return (['freeze', 'burn', 'stun'] as const)[index] ?? 'freeze';
}

function sampleStatus(elapsedMs: number): MobMotionTransform {
  const treatment = sampleStatusTreatment(elapsedMs);
  const localPhase = normalizedPhase(
    elapsedWithin(elapsedMs, STATUS_TREATMENT_MS),
    STATUS_TREATMENT_MS,
  );

  if (treatment === 'freeze') {
    const shake = Math.floor(localPhase * 16) % 2 === 0 ? -1 : 1;
    return {
      offsetX: shake * 0.75,
      offsetY: 0,
      scaleX: 0.98,
      scaleY: 1.02,
      rotation: shake * 0.01,
      alpha: 0.9,
      flash: 0.15,
    };
  }

  if (treatment === 'burn') {
    const flicker = Math.abs(Math.sin(localPhase * TAU * 3));
    return {
      offsetX: 0,
      offsetY: -flicker,
      scaleX: 1 + flicker * 0.04,
      scaleY: 1 - flicker * 0.03,
      rotation: Math.sin(localPhase * TAU * 2) * 0.015,
      alpha: 0.85 + flicker * 0.15,
      flash: flicker * 0.3,
    };
  }

  const wobble = Math.sin(localPhase * TAU * 2);
  return {
    offsetX: wobble,
    offsetY: -Math.abs(wobble),
    scaleX: 1,
    scaleY: 1,
    rotation: wobble * 0.12,
    alpha: 1,
    flash: Math.max(0, wobble) * 0.2,
  };
}

export function sampleMobMotion(
  state: MobMotionState,
  elapsedMs: number,
  options: MobMotionOptions = {},
): MobMotionTransform {
  const intensity = options.intensity ?? 1;
  let transform: MobMotionTransform;

  switch (state) {
    case 'spawn':
      transform = sampleSpawn(elapsedMs);
      break;
    case 'movement':
      transform = sampleMovement(elapsedMs, options.movementStyle ?? 'stride');
      break;
    case 'attack':
      transform = options.attack?.hasProjectile
        ? sampleRangedAttack(elapsedMs, options.attack.telegraphMs)
        : sampleMeleeAttack(elapsedMs);
      break;
    case 'hit':
      transform = sampleHit(elapsedMs);
      break;
    case 'death':
      transform = sampleDeath(elapsedMs);
      break;
    case 'status':
      transform = sampleStatus(elapsedMs);
      break;
  }

  return scaleTransform(transform, intensity);
}
