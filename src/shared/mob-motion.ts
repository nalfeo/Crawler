import { ENEMY_PROJECTILE } from './constants.js';
import { floor1EnemyPack, floor2EnemyPack, type EnemyArchetypeDef } from './enemy-packs.js';
import { computeSpawnPopScale, MINI_SLIME_SPAWN_ANIM_MS } from './spawn-anim.js';

export type MobLocomotionStyle = 'stride' | 'hop' | 'hover' | 'slither' | 'stomp';
export type MobStatusTreatment = 'freeze' | 'burn' | 'stun';

export interface MobMotionTransform {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotation: number;
  readonly alpha: number;
  readonly flash: number;
}

export interface AttackPreviewSample {
  readonly phaseMs: number;
  readonly telegraphActive: boolean;
  readonly telegraphPulse: number;
  readonly projectileVisible: boolean;
  readonly projectileProgress: number;
}

export interface RuntimeMobMotionProfile {
  readonly archetypeId: string;
  readonly name: string;
  readonly floor: 1 | 2;
  readonly aiType: EnemyArchetypeDef['aiType'];
  readonly movementStyle: MobLocomotionStyle;
  readonly hasProjectile: boolean;
  readonly isBoss: boolean;
  readonly spriteTexture: number;
}

// Shared motion is authored in feet (ADR 0023). These constants keep the prior
// visual tuning by expressing legacy pixel amplitudes in feet.
const MOTION_RENDER_PIXELS_PER_FOOT = 8;
const MOTION_OFFSET_STEP_FT = 0.5 / MOTION_RENDER_PIXELS_PER_FOOT;

function legacyPixelsToFeet(pixels: number): number {
  return pixels / MOTION_RENDER_PIXELS_PER_FOOT;
}

const FAMILY_MOVEMENT_STYLES: Readonly<Partial<Record<string, MobLocomotionStyle>>> = {
  batfolk: 'hover',
  faeries: 'hover',
  toadkin: 'hop',
  snailfolk: 'slither',
  beetlefolk: 'stomp',
  crabfolk: 'stomp',
  molefolk: 'stomp',
  pandas: 'stomp',
};

const ARCHETYPE_MOVEMENT_STYLES: Readonly<Partial<Record<string, MobLocomotionStyle>>> = {
  slime: 'hop',
  'slime-mini': 'hop',
  'cave-slime': 'hop',
  'cave-bat-swarm': 'hover',
  'glow-worm': 'slither',
  'blind-cave-newt': 'slither',
  'fungal-husk': 'stomp',
};

const TAU = Math.PI * 2;
export const CONTACT_ATTACK_MOTION_MS = 260;
export const HIT_REACTION_MOTION_MS = 320;
const STATUS_TREATMENT_MS = 800;
const PROJECTILE_TRAVEL_MS = 500;
export const RANGED_RELEASE_MOTION_MS = 120;

export const NEUTRAL_MOB_MOTION: MobMotionTransform = {
  offsetX: 0,
  offsetY: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  alpha: 1,
  flash: 0,
};

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

export function scaleMobMotion(
  transform: MobMotionTransform,
  intensity: number,
): MobMotionTransform {
  const amount = Math.max(0, Number.isFinite(intensity) ? intensity : 0);
  return {
    offsetX: quantize(transform.offsetX * amount, MOTION_OFFSET_STEP_FT),
    offsetY: quantize(transform.offsetY * amount, MOTION_OFFSET_STEP_FT),
    scaleX: quantize(1 + (transform.scaleX - 1) * amount, 0.005),
    scaleY: quantize(1 + (transform.scaleY - 1) * amount, 0.005),
    rotation: quantize(transform.rotation * amount, 0.005),
    alpha: quantize(1 + (transform.alpha - 1) * Math.min(1, amount), 0.05),
    flash: clamp01(transform.flash * amount),
  };
}

export function combineMobMotion(
  base: MobMotionTransform,
  overlay: MobMotionTransform,
): MobMotionTransform {
  return {
    offsetX: base.offsetX + overlay.offsetX,
    offsetY: base.offsetY + overlay.offsetY,
    scaleX: base.scaleX * overlay.scaleX,
    scaleY: base.scaleY * overlay.scaleY,
    rotation: base.rotation + overlay.rotation,
    alpha: base.alpha * overlay.alpha,
    flash: Math.max(base.flash, overlay.flash),
  };
}

export function sampleSpawnMotion(elapsedMs: number): MobMotionTransform {
  if (elapsedMs < 0 || elapsedMs >= MINI_SLIME_SPAWN_ANIM_MS) {
    return NEUTRAL_MOB_MOTION;
  }
  const progress = elapsedMs / MINI_SLIME_SPAWN_ANIM_MS;
  const scale = computeSpawnPopScale(progress);
  return {
    offsetX: 0,
    offsetY: quantize(legacyPixelsToFeet((1 - progress) * 6), MOTION_OFFSET_STEP_FT),
    scaleX: quantize(scale.x, 0.005),
    scaleY: quantize(scale.y, 0.005),
    rotation: quantize(Math.sin(progress * Math.PI * 3) * 0.04 * (1 - progress), 0.005),
    alpha: quantize(clamp01(progress * 3), 0.05),
    flash: 0,
  };
}

export function sampleMovementMotion(
  elapsedMs: number,
  style: MobLocomotionStyle,
): MobMotionTransform {
  if (style === 'hop') {
    const phase = normalizedPhase(elapsedMs, 720);
    const arc = Math.sin(phase * Math.PI);
    const lean = Math.sin(phase * TAU);
    return {
      offsetX: legacyPixelsToFeet(lean * 0.75),
      offsetY: legacyPixelsToFeet(-arc * 5),
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
      offsetX: legacyPixelsToFeet(Math.cos(phase * TAU) * 0.75),
      offsetY: legacyPixelsToFeet(-2.5 - wave * 2),
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
      offsetX: legacyPixelsToFeet(sway * 1.5),
      offsetY: legacyPixelsToFeet(-Math.abs(sway) * 0.5),
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
      offsetY: legacyPixelsToFeet(-lift * 2.5),
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
    offsetX: legacyPixelsToFeet(stride),
    offsetY: legacyPixelsToFeet(-lift * 2),
    scaleX: 1 + lift * 0.04,
    scaleY: 1 - lift * 0.06,
    rotation: stride * 0.025,
    alpha: 1,
    flash: 0,
  };
}

export function sampleRangedWindupMotion(progress: number): MobMotionTransform {
  const windup = smoothstep(progress);
  return {
    offsetX: legacyPixelsToFeet(-2.5 * windup),
    offsetY: legacyPixelsToFeet(windup),
    scaleX: 1 - 0.05 * windup,
    scaleY: 1 + 0.06 * windup,
    rotation: -0.06 * windup,
    alpha: 1,
    flash: 0,
  };
}

export function sampleRangedReleaseMotion(elapsedMs: number): MobMotionTransform {
  if (elapsedMs < 0 || elapsedMs >= RANGED_RELEASE_MOTION_MS) {
    return NEUTRAL_MOB_MOTION;
  }
  const recoil = 1 - smoothstep(elapsedMs / RANGED_RELEASE_MOTION_MS);
  return {
    offsetX: legacyPixelsToFeet(4 * recoil),
    offsetY: legacyPixelsToFeet(-recoil),
    scaleX: 1 + recoil * 0.08,
    scaleY: 1 - recoil * 0.05,
    rotation: 0.08 * recoil,
    alpha: 1,
    flash: recoil,
  };
}

export function sampleContactAttackMotion(elapsedMs: number): MobMotionTransform {
  if (elapsedMs < 0 || elapsedMs >= CONTACT_ATTACK_MOTION_MS) {
    return NEUTRAL_MOB_MOTION;
  }
  const progress = smoothstep(elapsedMs / CONTACT_ATTACK_MOTION_MS);
  const active = 1 - progress;
  return {
    offsetX: legacyPixelsToFeet(8 * active),
    offsetY: legacyPixelsToFeet(-Math.sin(progress * Math.PI)),
    scaleX: 1 + active * 0.1,
    scaleY: 1 - active * 0.06,
    rotation: 0.12 * active,
    alpha: 1,
    flash: 0,
  };
}

export function sampleHitReactionMotion(elapsedMs: number): MobMotionTransform {
  if (elapsedMs < 0 || elapsedMs >= HIT_REACTION_MOTION_MS) {
    return NEUTRAL_MOB_MOTION;
  }
  const active = 1 - elapsedMs / HIT_REACTION_MOTION_MS;
  const shake = Math.floor(elapsedMs / 21) % 2 === 0 ? -1 : 1;
  return {
    offsetX: legacyPixelsToFeet(-6 * active + shake * 1.5 * active),
    offsetY: legacyPixelsToFeet(-active),
    scaleX: 1 + active * 0.08,
    scaleY: 1 - active * 0.08,
    rotation: -active * 0.07,
    alpha: 1 - active * 0.25,
    flash: active,
  };
}

export function sampleSpeedStatusMotion(elapsedMs: number): MobMotionTransform {
  const phase = normalizedPhase(elapsedMs, STATUS_TREATMENT_MS);
  const shake = Math.floor(phase * 16) % 2 === 0 ? -1 : 1;
  return {
    offsetX: legacyPixelsToFeet(shake * 0.75),
    offsetY: 0,
    scaleX: 0.98,
    scaleY: 1.02,
    rotation: shake * 0.01,
    alpha: 0.9,
    flash: 0.15,
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
    ENEMY_PROJECTILE.FIRE_COOLDOWN_MS - RANGED_RELEASE_MOTION_MS,
  );
  const telegraphActive = delayMs > 0 && phaseMs < delayMs;
  const travelEndMs = Math.min(
    ENEMY_PROJECTILE.FIRE_COOLDOWN_MS - RANGED_RELEASE_MOTION_MS,
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

export function sampleStatusTreatment(elapsedMs: number): MobStatusTreatment {
  const index = Math.floor(elapsedWithin(elapsedMs, STATUS_TREATMENT_MS * 3) / STATUS_TREATMENT_MS);
  return (['freeze', 'burn', 'stun'] as const)[index] ?? 'freeze';
}

export function sampleStatusPreviewMotion(elapsedMs: number): MobMotionTransform {
  const treatment = sampleStatusTreatment(elapsedMs);
  const localPhase = normalizedPhase(
    elapsedWithin(elapsedMs, STATUS_TREATMENT_MS),
    STATUS_TREATMENT_MS,
  );
  if (treatment === 'freeze') {
    return sampleSpeedStatusMotion(elapsedMs);
  }
  if (treatment === 'burn') {
    const flicker = Math.abs(Math.sin(localPhase * TAU * 3));
    return {
      offsetX: 0,
      offsetY: legacyPixelsToFeet(-flicker),
      scaleX: 1 + flicker * 0.04,
      scaleY: 1 - flicker * 0.03,
      rotation: Math.sin(localPhase * TAU * 2) * 0.015,
      alpha: 0.85 + flicker * 0.15,
      flash: flicker * 0.3,
    };
  }
  const wobble = Math.sin(localPhase * TAU * 2);
  return {
    offsetX: legacyPixelsToFeet(wobble),
    offsetY: legacyPixelsToFeet(-Math.abs(wobble)),
    scaleX: 1,
    scaleY: 1,
    rotation: wobble * 0.12,
    alpha: 1,
    flash: Math.max(0, wobble) * 0.2,
  };
}

export function mobLocomotionStyleForArchetype(
  archetype: Pick<EnemyArchetypeDef, 'id' | 'familyId' | 'isBoss'>,
): MobLocomotionStyle {
  const explicit = ARCHETYPE_MOVEMENT_STYLES[archetype.id];
  if (explicit) return explicit;
  if (archetype.familyId) {
    const familyStyle = FAMILY_MOVEMENT_STYLES[archetype.familyId];
    if (familyStyle) return familyStyle;
  }
  return archetype.isBoss === true ? 'stomp' : 'stride';
}

function profileFromPack(archetype: EnemyArchetypeDef, floor: 1 | 2): RuntimeMobMotionProfile {
  return {
    archetypeId: archetype.id,
    name: archetype.name,
    floor,
    aiType: archetype.aiType,
    movementStyle: mobLocomotionStyleForArchetype(archetype),
    hasProjectile: archetype.aiType === 'ranged',
    isBoss: archetype.isBoss === true,
    spriteTexture: archetype.spriteTexture,
  };
}

const floor1Slime = floor1EnemyPack.archetypes.find((archetype) => archetype.id === 'slime');
if (!floor1Slime) {
  throw new Error('Floor 1 slime archetype is required for special mob-motion profiles.');
}

const SPECIAL_FLOOR_1_PROFILES: readonly RuntimeMobMotionProfile[] = [
  {
    ...profileFromPack(floor1Slime, 1),
    archetypeId: 'slime-mini',
    name: 'Mini Slime',
  },
  {
    ...profileFromPack(floor1Slime, 1),
    archetypeId: 'slime-rat',
    name: 'Slime Rat',
    movementStyle: 'stomp',
    hasProjectile: true,
    isBoss: true,
  },
  {
    ...profileFromPack(floor1Slime, 1),
    archetypeId: 'rat-slime',
    name: 'Rat Slime',
    movementStyle: 'stomp',
    hasProjectile: true,
    isBoss: true,
  },
];

export const RUNTIME_MOB_MOTION_PROFILES: readonly RuntimeMobMotionProfile[] = [
  ...floor1EnemyPack.archetypes.map((archetype) => profileFromPack(archetype, 1)),
  ...SPECIAL_FLOOR_1_PROFILES,
  ...floor2EnemyPack.archetypes.map((archetype) => profileFromPack(archetype, 2)),
].sort(
  (a, b) =>
    a.floor - b.floor || a.name.localeCompare(b.name) || a.archetypeId.localeCompare(b.archetypeId),
);

const RUNTIME_MOB_MOTION_PROFILE_BY_ID = new Map(
  RUNTIME_MOB_MOTION_PROFILES.map((profile) => [profile.archetypeId, profile]),
);

export function getRuntimeMobMotionProfile(
  archetypeId: string | undefined,
): RuntimeMobMotionProfile | undefined {
  return archetypeId === undefined ? undefined : RUNTIME_MOB_MOTION_PROFILE_BY_ID.get(archetypeId);
}
