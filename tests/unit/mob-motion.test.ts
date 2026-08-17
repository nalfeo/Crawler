import { describe, expect, it } from 'vitest';
import {
  CONTACT_ATTACK_MOTION_MS,
  HIT_REACTION_MOTION_MS,
  NEUTRAL_MOB_MOTION,
  RANGED_RELEASE_MOTION_MS,
  combineMobMotion,
  getRuntimeMobMotionProfile,
  getRuntimeMobMotionProfiles,
  mobLocomotionStyleForArchetype,
  sampleAttackPreview,
  sampleContactAttackMotion,
  sampleHitReactionMotion,
  sampleMovementMotion,
  sampleRangedReleaseMotion,
  sampleRangedWindupMotion,
  sampleSpawnMotion,
  sampleSpeedStatusMotion,
  sampleStatusPreviewMotion,
  sampleStatusTreatment,
  scaleMobMotion,
  type MobLocomotionStyle,
  type MobMotionTransform,
} from '../../src/shared/mob-motion.js';
import { MINI_SLIME_SPAWN_ANIM_MS } from '../../src/shared/spawn-anim.js';
import { ENEMY_PROJECTILE } from '../../src/shared/constants.js';

const SAMPLE_TRANSFORM: MobMotionTransform = {
  offsetX: 1,
  offsetY: -2,
  scaleX: 1.2,
  scaleY: 0.8,
  rotation: 0.5,
  alpha: 0.5,
  flash: 0.4,
};

function isFiniteTransform(transform: MobMotionTransform): boolean {
  return Object.values(transform).every((value) => Number.isFinite(value));
}

/**
 * Normalize signed zeros so `toEqual` comparisons against `NEUTRAL_MOB_MOTION`
 * are about the motion value, not the sign bit `Math.round(-0.2)` leaves behind.
 */
function normalized(transform: MobMotionTransform): MobMotionTransform {
  return Object.fromEntries(
    Object.entries(transform).map(([key, value]) => [key, value === 0 ? 0 : value]),
  ) as unknown as MobMotionTransform;
}

describe('scaleMobMotion', () => {
  it('returns the neutral transform at zero intensity', () => {
    expect(normalized(scaleMobMotion(SAMPLE_TRANSFORM, 0))).toEqual(NEUTRAL_MOB_MOTION);
  });

  it('treats negative and non-finite intensities as zero', () => {
    expect(normalized(scaleMobMotion(SAMPLE_TRANSFORM, -3))).toEqual(NEUTRAL_MOB_MOTION);
    expect(normalized(scaleMobMotion(SAMPLE_TRANSFORM, Number.NaN))).toEqual(NEUTRAL_MOB_MOTION);
  });

  it('scales offsets and clamps flash at full intensity', () => {
    const scaled = scaleMobMotion(SAMPLE_TRANSFORM, 1);
    expect(scaled.offsetX).toBeCloseTo(SAMPLE_TRANSFORM.offsetX, 1);
    expect(scaled.scaleX).toBeCloseTo(SAMPLE_TRANSFORM.scaleX, 2);
    expect(scaled.flash).toBeCloseTo(SAMPLE_TRANSFORM.flash, 5);
  });

  it('clamps the alpha blend factor so intensities above 1 never over-fade', () => {
    const atOne = scaleMobMotion(SAMPLE_TRANSFORM, 1);
    const aboveOne = scaleMobMotion(SAMPLE_TRANSFORM, 4);
    expect(aboveOne.alpha).toBeCloseTo(atOne.alpha, 5);
    expect(aboveOne.flash).toBeLessThanOrEqual(1);
  });
});

describe('combineMobMotion', () => {
  it('adds offsets/rotation, multiplies scale/alpha and takes the strongest flash', () => {
    const combined = combineMobMotion(SAMPLE_TRANSFORM, {
      offsetX: 2,
      offsetY: 3,
      scaleX: 2,
      scaleY: 0.5,
      rotation: -0.25,
      alpha: 0.5,
      flash: 0.9,
    });
    expect(combined).toEqual({
      offsetX: 3,
      offsetY: 1,
      scaleX: 2.4,
      scaleY: 0.4,
      rotation: 0.25,
      alpha: 0.25,
      flash: 0.9,
    });
  });

  it('is identity when the overlay is neutral', () => {
    expect(combineMobMotion(SAMPLE_TRANSFORM, NEUTRAL_MOB_MOTION)).toEqual(SAMPLE_TRANSFORM);
  });
});

describe('sampleSpawnMotion', () => {
  it('is neutral outside the spawn window', () => {
    expect(sampleSpawnMotion(-1)).toEqual(NEUTRAL_MOB_MOTION);
    expect(sampleSpawnMotion(MINI_SLIME_SPAWN_ANIM_MS)).toEqual(NEUTRAL_MOB_MOTION);
  });

  it('fades in and settles toward neutral across the window', () => {
    const early = sampleSpawnMotion(1);
    const late = sampleSpawnMotion(MINI_SLIME_SPAWN_ANIM_MS - 1);
    expect(early.alpha).toBeLessThan(1);
    expect(late.alpha).toBe(1);
    expect(Math.abs(late.offsetY)).toBeLessThan(Math.abs(early.offsetY));
    expect(isFiniteTransform(early)).toBe(true);
  });
});

describe('sampleMovementMotion', () => {
  const styles: readonly MobLocomotionStyle[] = ['stride', 'hop', 'hover', 'slither', 'stomp'];

  it('produces finite, fully opaque transforms for every locomotion style', () => {
    for (const style of styles) {
      for (const elapsed of [0, 137, 480, 901, 1_500]) {
        const motion = sampleMovementMotion(elapsed, style);
        expect(isFiniteTransform(motion)).toBe(true);
        expect(motion.alpha).toBe(1);
        expect(motion.flash).toBe(0);
      }
    }
  });

  it('is periodic and handles negative / non-finite elapsed times', () => {
    for (const style of styles) {
      const period = { stride: 560, hop: 720, hover: 1_100, slither: 640, stomp: 900 }[style];
      expect(sampleMovementMotion(123 + period, style)).toEqual(sampleMovementMotion(123, style));
      expect(sampleMovementMotion(-period + 123, style)).toEqual(sampleMovementMotion(123, style));
      expect(sampleMovementMotion(Number.NaN, style)).toEqual(sampleMovementMotion(0, style));
    }
  });

  it('gives each style a distinct signature at the same time', () => {
    const signatures = new Set(
      styles.map((style) => JSON.stringify(sampleMovementMotion(210, style))),
    );
    expect(signatures.size).toBe(styles.length);
  });

  it('drops the stomp impact squash after the impact window', () => {
    // 0.4 of the 900ms period lands inside the 0.35–0.52 impact band.
    const impact = sampleMovementMotion(900 * 0.4, 'stomp');
    const settled = sampleMovementMotion(900 * 0.8, 'stomp');
    expect(impact.scaleX).toBeGreaterThan(1);
    expect(settled.scaleX).toBe(1);
    expect(settled.offsetY).toBeCloseTo(0, 10);
  });
});

describe('ranged and contact attack motion', () => {
  it('ramps the windup monotonically with progress and clamps out of range', () => {
    expect(normalized(sampleRangedWindupMotion(0))).toEqual(NEUTRAL_MOB_MOTION);
    const mid = sampleRangedWindupMotion(0.5);
    const full = sampleRangedWindupMotion(1);
    expect(Math.abs(mid.offsetX)).toBeLessThan(Math.abs(full.offsetX));
    expect(sampleRangedWindupMotion(5)).toEqual(full);
    expect(normalized(sampleRangedWindupMotion(Number.NaN))).toEqual(NEUTRAL_MOB_MOTION);
  });

  it('recoils on release and returns to neutral outside the window', () => {
    expect(sampleRangedReleaseMotion(-1)).toEqual(NEUTRAL_MOB_MOTION);
    expect(sampleRangedReleaseMotion(RANGED_RELEASE_MOTION_MS)).toEqual(NEUTRAL_MOB_MOTION);
    const start = sampleRangedReleaseMotion(0);
    const end = sampleRangedReleaseMotion(RANGED_RELEASE_MOTION_MS - 1);
    expect(start.flash).toBeGreaterThan(end.flash);
    expect(start.offsetX).toBeGreaterThan(end.offsetX);
  });

  it('lunges on contact attack and decays back to neutral', () => {
    expect(sampleContactAttackMotion(-1)).toEqual(NEUTRAL_MOB_MOTION);
    expect(sampleContactAttackMotion(CONTACT_ATTACK_MOTION_MS)).toEqual(NEUTRAL_MOB_MOTION);
    const start = sampleContactAttackMotion(0);
    const end = sampleContactAttackMotion(CONTACT_ATTACK_MOTION_MS - 1);
    expect(start.offsetX).toBeGreaterThan(end.offsetX);
    expect(start.rotation).toBeGreaterThan(end.rotation);
  });

  it('flashes and shakes on hit reaction, then returns to neutral', () => {
    expect(sampleHitReactionMotion(-1)).toEqual(NEUTRAL_MOB_MOTION);
    expect(sampleHitReactionMotion(HIT_REACTION_MOTION_MS)).toEqual(NEUTRAL_MOB_MOTION);
    const start = sampleHitReactionMotion(0);
    const end = sampleHitReactionMotion(HIT_REACTION_MOTION_MS - 1);
    expect(start.flash).toBeGreaterThan(end.flash);
    expect(start.alpha).toBeLessThan(1);
    // The 21ms shake alternates direction between adjacent shake buckets.
    expect(sampleHitReactionMotion(0).offsetX).not.toBe(sampleHitReactionMotion(21).offsetX);
  });
});

describe('status motion', () => {
  it('cycles freeze → burn → stun over the treatment period', () => {
    expect(sampleStatusTreatment(0)).toBe('freeze');
    expect(sampleStatusTreatment(900)).toBe('burn');
    expect(sampleStatusTreatment(1_700)).toBe('stun');
    expect(sampleStatusTreatment(2_400)).toBe('freeze');
    expect(sampleStatusTreatment(Number.NaN)).toBe('freeze');
  });

  it('uses the speed-status shake for freeze and distinct motion per treatment', () => {
    expect(sampleStatusPreviewMotion(100)).toEqual(sampleSpeedStatusMotion(100));
    const burn = sampleStatusPreviewMotion(1_000);
    const stun = sampleStatusPreviewMotion(1_900);
    expect(burn.flash).toBeGreaterThan(0);
    expect(burn).not.toEqual(stun);
    expect(isFiniteTransform(stun)).toBe(true);
  });

  it('alternates the speed-status shake direction within the period', () => {
    const offsets = new Set([0, 60, 120, 180].map((ms) => sampleSpeedStatusMotion(ms).offsetX));
    expect(offsets.size).toBe(2);
  });
});

describe('sampleAttackPreview', () => {
  it('reports no projectile activity for melee mobs', () => {
    const sample = sampleAttackPreview(300, false, 400);
    expect(sample).toMatchObject({
      telegraphActive: false,
      telegraphPulse: 0,
      projectileVisible: false,
      projectileProgress: 0,
    });
    expect(sample.phaseMs).toBe(300);
  });

  it('telegraphs before the shot, then shows the projectile travelling', () => {
    const telegraphing = sampleAttackPreview(100, true, 400);
    expect(telegraphing.telegraphActive).toBe(true);
    expect(telegraphing.telegraphPulse).toBeGreaterThan(0);
    expect(telegraphing.projectileVisible).toBe(false);

    const travelling = sampleAttackPreview(500, true, 400);
    expect(travelling.telegraphActive).toBe(false);
    expect(travelling.projectileVisible).toBe(true);
    expect(travelling.projectileProgress).toBeGreaterThan(0);
    expect(travelling.projectileProgress).toBeLessThanOrEqual(1);
  });

  it('skips the telegraph phase when the telegraph is zero or invalid', () => {
    for (const telegraphMs of [0, -50, Number.NaN]) {
      const sample = sampleAttackPreview(10, true, telegraphMs);
      expect(sample.telegraphActive).toBe(false);
      expect(sample.projectileVisible).toBe(true);
    }
  });

  it('clamps the telegraph so the release animation always fits in the cooldown', () => {
    const sample = sampleAttackPreview(
      ENEMY_PROJECTILE.FIRE_COOLDOWN_MS - RANGED_RELEASE_MOTION_MS,
      true,
      ENEMY_PROJECTILE.FIRE_COOLDOWN_MS * 4,
    );
    expect(sample.telegraphActive).toBe(false);
    expect(sample.projectileVisible).toBe(false);
  });

  it('wraps the phase across the fire cooldown', () => {
    expect(sampleAttackPreview(ENEMY_PROJECTILE.FIRE_COOLDOWN_MS + 250, true, 400)).toEqual(
      sampleAttackPreview(250, true, 400),
    );
  });
});

describe('mobLocomotionStyleForArchetype', () => {
  it('prefers an explicit archetype style over the family style', () => {
    expect(mobLocomotionStyleForArchetype({ id: 'slime', familyId: 'pandas' })).toBe('hop');
  });

  it('falls back to the family style, then boss stomp, then stride', () => {
    expect(mobLocomotionStyleForArchetype({ id: 'unknown-mob', familyId: 'batfolk' })).toBe(
      'hover',
    );
    expect(mobLocomotionStyleForArchetype({ id: 'unknown-mob', familyId: 'nonexistent' })).toBe(
      'stride',
    );
    expect(mobLocomotionStyleForArchetype({ id: 'unknown-boss', isBoss: true })).toBe('stomp');
    expect(mobLocomotionStyleForArchetype({ id: 'unknown-mob' })).toBe('stride');
  });
});

describe('runtime mob motion profiles', () => {
  it('includes special and spawner-only Floor 1 variants and is sorted by floor then name', () => {
    const profiles = getRuntimeMobMotionProfiles();
    const ids = profiles.map((profile) => profile.archetypeId);
    for (const id of ['slime-mini', 'slime-rat', 'rat-slime', 'rat-brute', 'mama-slime']) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(profiles.some((profile) => profile.floor === 2)).toBe(true);
    const sorted = [...profiles].sort(
      (a, b) =>
        a.floor - b.floor ||
        a.name.localeCompare(b.name) ||
        a.archetypeId.localeCompare(b.archetypeId),
    );
    expect(profiles).toEqual(sorted);
  });

  it('marks the Floor 1 bosses as projectile-capable stompers', () => {
    for (const bossId of ['slime-rat', 'rat-slime']) {
      expect(getRuntimeMobMotionProfile(bossId)).toMatchObject({
        isBoss: true,
        hasProjectile: true,
        movementStyle: 'stomp',
      });
    }
  });

  it('caches the profile list and looks profiles up by id', () => {
    expect(getRuntimeMobMotionProfiles()).toBe(getRuntimeMobMotionProfiles());
    expect(getRuntimeMobMotionProfile('rat')?.archetypeId).toBe('rat');
    expect(getRuntimeMobMotionProfile('not-a-mob')).toBeUndefined();
    expect(getRuntimeMobMotionProfile(undefined)).toBeUndefined();
  });
});
