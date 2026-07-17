import { CORPSE } from '../../shared/constants.js';
import { computeCorpseDecay, type CorpseDecay } from '../../engine/corpse-decay.js';
import {
  CONTACT_ATTACK_MOTION_MS,
  NEUTRAL_MOB_MOTION,
  sampleAttackPreview,
  sampleContactAttackMotion,
  sampleHitReactionMotion,
  sampleMovementMotion,
  sampleRangedReleaseMotion,
  sampleRangedWindupMotion,
  sampleSpawnMotion,
  sampleStatusPreviewMotion,
  scaleMobMotion,
  type MobLocomotionStyle,
  type MobMotionTransform,
} from '../../shared/mob-motion.js';
import {
  parseGeneratedManifest,
  type GeneratedManifest,
  type ManifestEntry,
} from '../../shared/generated-assets.js';

export type MobMotionState = 'spawn' | 'movement' | 'attack' | 'hit' | 'death' | 'status';
export {
  sampleAttackPreview,
  sampleStatusTreatment,
  type AttackPreviewSample,
  type MobLocomotionStyle,
  type MobMotionTransform,
  type MobStatusTreatment,
} from '../../shared/mob-motion.js';

export interface MobSpriteOption {
  readonly textureKey: string;
  readonly briefId: string;
  readonly label: string;
  readonly assetPath: string;
  readonly variantIndex: number;
  readonly anchor: { readonly x: number; readonly y: number } | null;
  readonly centerOfGravity: { readonly x: number; readonly y: number } | null;
}

export interface MobMotionOptions {
  readonly intensity?: number;
  readonly movementStyle?: MobLocomotionStyle;
  readonly attack?: {
    readonly hasProjectile: boolean;
    readonly telegraphMs: number;
  };
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
const STATIONARY_ENEMY_BRIEFS = new Set(['rat-nest-v2', 'rats-nest-v1', 'slime-pool-v1']);
const SPAWN_CYCLE_MS = 1_300;
const MELEE_ATTACK_CYCLE_MS = 900;
const HIT_CYCLE_MS = 1_000;
const DEATH_RESET_MS = 600;
const DEATH_POP_MS = 500;
const DEATH_KNOCKBACK_MS = 220;
const BLOOD_POOL_LIFETIME_MS = 30_000;
const BLOOD_POOL_EXPAND_FRACTION = 0.7;

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

function elapsedWithin(elapsedMs: number, periodMs: number): number {
  const safeElapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0;
  return ((safeElapsed % periodMs) + periodMs) % periodMs;
}

function sampleSpawn(elapsedMs: number): MobMotionTransform {
  return sampleSpawnMotion(elapsedWithin(elapsedMs, SPAWN_CYCLE_MS));
}

function sampleMovement(elapsedMs: number, style: MobLocomotionStyle): MobMotionTransform {
  return sampleMovementMotion(elapsedMs, style);
}

function sampleMeleeAttack(elapsedMs: number): MobMotionTransform {
  const phaseMs = elapsedWithin(elapsedMs, MELEE_ATTACK_CYCLE_MS);
  const windupMs = 320;
  const strikeMs = 220;
  const recoveryMs = MELEE_ATTACK_CYCLE_MS - windupMs - strikeMs;

  if (phaseMs < windupMs) {
    const progress = phaseMs / windupMs;
    return {
      offsetX: -0.18 * progress,
      offsetY: 0.04 * progress,
      scaleX: 1 - 0.06 * progress,
      scaleY: 1 + 0.07 * progress,
      rotation: -0.09 * progress,
      alpha: 1,
      flash: 0,
    };
  }

  if (phaseMs < windupMs + strikeMs) {
    return sampleContactAttackMotion((phaseMs - windupMs) * (CONTACT_ATTACK_MOTION_MS / strikeMs));
  }

  const recoveryElapsedMs = phaseMs - windupMs - strikeMs;
  const contactElapsedMs =
    CONTACT_ATTACK_MOTION_MS -
    recoveryElapsedMs * (CONTACT_ATTACK_MOTION_MS / Math.max(1, recoveryMs));
  return sampleContactAttackMotion(Math.max(0, contactElapsedMs));
}

function sampleRangedAttack(elapsedMs: number, telegraphMs: number): MobMotionTransform {
  const preview = sampleAttackPreview(elapsedMs, true, telegraphMs);
  const delayMs = Math.max(0, telegraphMs);

  if (preview.telegraphActive) {
    return sampleRangedWindupMotion(preview.phaseMs / Math.max(1, delayMs));
  }

  if (preview.projectileVisible) {
    return sampleRangedReleaseMotion(preview.phaseMs - delayMs);
  }

  return NEUTRAL_MOB_MOTION;
}

function sampleHit(elapsedMs: number): MobMotionTransform {
  return sampleHitReactionMotion(elapsedWithin(elapsedMs, HIT_CYCLE_MS));
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

function sampleStatus(elapsedMs: number): MobMotionTransform {
  return sampleStatusPreviewMotion(elapsedMs);
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

  return scaleMobMotion(transform, intensity);
}
