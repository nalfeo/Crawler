import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CORPSE, ENEMY_PROJECTILE } from '../../src/shared/constants.js';
import {
  sampleAttackPreview,
  sampleDeathPreview,
  sampleMobMotion,
  sampleStatusTreatment,
  selectMobSprites,
  type MobLocomotionStyle,
  type MobMotionState,
} from '../../src/labs/mob-motion-lab/model.js';
import {
  availableMobPreviewSpecs,
  buildMobPreviewSpecs,
  resolveEnemyProjectileFrame,
} from '../../src/labs/mob-motion-lab/preview-spec.js';

function manifestEntry(briefId: string, variantIndex: number, type: 'enemy' | 'item' | null) {
  return {
    briefId,
    spriteName: `${briefId}-var-${variantIndex}`,
    assetPath: `generated/${briefId}-var-${variantIndex}.png`,
    approvedAt: '2026-07-17T00:00:00.000Z',
    sourceRun: 'test-run',
    variantIndex,
    anchor: { x: 31, y: 60, source: 'manual' as const },
    anchors: {
      hold: { x: 31, y: 60, source: 'manual' as const },
      centerOfGravity: { x: 30, y: 35, source: 'manual' as const },
    },
    sensorScore: '7/7',
    judgeScore: '2',
    type,
    facingDirection: 'right' as const,
  };
}

describe('mob motion lab model', () => {
  it('selects approved mobile enemy variants and preserves their pivots', () => {
    const sprites = selectMobSprites({
      version: 1,
      entries: {
        'rat-var-3': manifestEntry('rat', 3, 'enemy'),
        'rat-var-1': manifestEntry('rat', 1, 'enemy'),
        'rat-nest-var-0': manifestEntry('rat-nest', 0, 'enemy'),
        'sword-var-0': manifestEntry('sword', 0, 'item'),
        'legacy-rat-var-0': manifestEntry('legacy-rat', 0, null),
      },
    });

    expect(sprites.map((sprite) => sprite.textureKey)).toEqual(['rat-var-1', 'rat-var-3']);
    expect(sprites[0]).toMatchObject({
      assetPath: 'generated/rat-var-1.png',
      anchor: { x: 31, y: 60 },
      centerOfGravity: { x: 30, y: 35 },
    });
  });

  it('produces six distinct deterministic effect clips', () => {
    const states: readonly MobMotionState[] = [
      'spawn',
      'movement',
      'attack',
      'hit',
      'death',
      'status',
    ];
    const sampleTimes: Readonly<Record<MobMotionState, number>> = {
      spawn: 100,
      movement: 140,
      attack: 300,
      hit: 100,
      death: 500,
      status: 1_700,
    };
    const samples = states.map((state) =>
      sampleMobMotion(state, sampleTimes[state], {
        movementStyle: 'hop',
        attack: { hasProjectile: true, telegraphMs: ENEMY_PROJECTILE.TELEGRAPH_MS },
      }),
    );

    expect(
      sampleMobMotion('attack', 300, {
        attack: { hasProjectile: true, telegraphMs: ENEMY_PROJECTILE.TELEGRAPH_MS },
      }),
    ).toEqual(samples[2]);
    expect(new Set(samples.map((sample) => JSON.stringify(sample))).size).toBe(states.length);
  });

  it('gives every locomotion family a distinct deterministic silhouette', () => {
    const styles: readonly MobLocomotionStyle[] = ['stride', 'hop', 'hover', 'slither', 'stomp'];
    const samples = styles.map((movementStyle) =>
      sampleMobMotion('movement', 180, { movementStyle }),
    );

    expect(new Set(samples.map((sample) => JSON.stringify(sample))).size).toBe(styles.length);
    expect(sampleMobMotion('movement', 180, { movementStyle: 'hover' })).toEqual(samples[2]);
  });

  it('returns to neutral poses outside the spawn and hit windows', () => {
    const neutral = {
      offsetX: 0,
      offsetY: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      alpha: 1,
      flash: 0,
    };

    expect(sampleMobMotion('spawn', 500)).toEqual(neutral);
    expect(sampleMobMotion('hit', 700)).toEqual(neutral);
  });

  it('mirrors the runtime death-to-corpse linger without collapsing the body', () => {
    const fresh = sampleDeathPreview(0);
    const midpoint = sampleDeathPreview(CORPSE.LINGER_MS / 2);
    const late = sampleDeathPreview(CORPSE.LINGER_MS * 0.75);
    const expired = sampleDeathPreview(CORPSE.LINGER_MS);
    const corpsePose = sampleMobMotion('death', CORPSE.LINGER_MS / 2);

    expect(fresh).toMatchObject({
      remainingMs: CORPSE.LINGER_MS,
      corpse: {
        corpseAlpha: 1,
        desaturation: 0,
      },
    });
    expect(fresh.corpse.skullAlpha).toBeGreaterThan(0);
    expect(midpoint.corpse).toMatchObject({
      corpseAlpha: 1,
      desaturation: 1,
      skullAlpha: 0,
    });
    expect(late.corpse.corpseAlpha).toBeCloseTo(0.5);
    expect(expired.corpse.corpseAlpha).toBe(0);
    expect(corpsePose).toMatchObject({
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      alpha: 1,
    });
    expect(corpsePose.offsetX).toBeGreaterThan(0);
  });

  it('cycles status concepts deterministically for scrubbed capture', () => {
    expect(sampleStatusTreatment(0)).toBe('freeze');
    expect(sampleStatusTreatment(800)).toBe('burn');
    expect(sampleStatusTreatment(1_600)).toBe('stun');
    expect(sampleStatusTreatment(2_400)).toBe('freeze');
  });

  it('uses the configured telegraph window and supports the runtime 0ms path', () => {
    const telegraph = sampleAttackPreview(100, true, ENEMY_PROJECTILE.TELEGRAPH_MS);
    const fired = sampleAttackPreview(
      ENEMY_PROJECTILE.TELEGRAPH_MS + 50,
      true,
      ENEMY_PROJECTILE.TELEGRAPH_MS,
    );
    const immediate = sampleAttackPreview(0, true, 0);
    const melee = sampleAttackPreview(300, false, ENEMY_PROJECTILE.TELEGRAPH_MS);

    expect(telegraph).toMatchObject({
      telegraphActive: true,
      projectileVisible: false,
    });
    expect(fired.telegraphActive).toBe(false);
    expect(fired.projectileVisible).toBe(true);
    expect(fired.projectileProgress).toBeGreaterThan(0);
    expect(immediate).toMatchObject({
      telegraphActive: false,
      projectileVisible: true,
      projectileProgress: 0,
    });
    expect(melee).toMatchObject({
      telegraphActive: false,
      projectileVisible: false,
    });
  });

  it('keeps shared art archetypes semantically distinct', () => {
    const specs = buildMobPreviewSpecs();
    const grunt = specs.find((spec) => spec.archetypeId === 'goblin-grunt');
    const junkshot = specs.find((spec) => spec.archetypeId === 'goblin-junkshot');

    expect(grunt).toMatchObject({
      briefId: 'goblin-grunt',
      hasProjectile: false,
      movementStyle: 'stride',
    });
    expect(junkshot).toMatchObject({
      briefId: 'goblin-grunt',
      hasProjectile: true,
      telegraphMs: ENEMY_PROJECTILE.TELEGRAPH_MS,
    });
  });

  it('assigns representative family locomotion styles', () => {
    const specs = buildMobPreviewSpecs();
    const style = (archetypeId: string) =>
      specs.find((spec) => spec.archetypeId === archetypeId)?.movementStyle;

    expect(style('slime')).toBe('hop');
    expect(style('faerie-spark-caster')).toBe('hover');
    expect(style('snailfolk-slimer')).toBe('slither');
    expect(style('panda-boss')).toBe('stomp');
    expect(style('rat')).toBe('stride');
  });

  it('retains every archetype sharing an available brief instead of merging behavior', () => {
    const sprites = selectMobSprites({
      version: 1,
      entries: {
        'goblin-grunt-var-0': manifestEntry('goblin-grunt', 0, 'enemy'),
      },
    });
    const available = availableMobPreviewSpecs(sprites);
    const shared = available.filter((spec) => spec.briefId === 'goblin-grunt');

    expect(shared.map((spec) => spec.archetypeId).sort()).toEqual([
      'goblin-elite-joyrider',
      'goblin-grunt',
      'goblin-junkshot',
    ]);
    expect(shared.filter((spec) => spec.hasProjectile).map((spec) => spec.archetypeId)).toEqual([
      'goblin-junkshot',
    ]);
  });

  it('resolves the actual hostile AoE projectile through runtime render mappings', () => {
    expect(resolveEnemyProjectileFrame()).toMatchObject({
      renderKind: 'enemy_aoe_proj',
      spriteId: 'effect.enemy_aoe',
      frameWidth: 16,
      frameHeight: 16,
      displayScale: 1.4,
    });
  });

  it('is discoverable through the lazy lab loader', () => {
    const source = readFileSync('src/lab-main.ts', 'utf8');
    expect(source).toContain("'mob-motion-lab': '/src/labs/mob-motion-lab/index.ts'");
  });
});
