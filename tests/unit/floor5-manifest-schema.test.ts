import { describe, expect, it } from 'vitest';
import { floor5Manifest, floorManifestDefSchema } from '../../src/shared/floor-manifest.js';

type ManifestWithFloor5 = typeof floor5Manifest & {
  floor5: NonNullable<typeof floor5Manifest.floor5>;
};

function cloneFloor5Manifest(): ManifestWithFloor5 {
  return structuredClone(floor5Manifest) as ManifestWithFloor5;
}

describe('floor5 manifest Ratings Ram rules', () => {
  it('accepts the authored outer-wall exchange', () => {
    expect(floorManifestDefSchema.safeParse(cloneFloor5Manifest()).success).toBe(true);
  });

  it('rejects ram strike damage that exceeds outer-wall health', () => {
    const bad = cloneFloor5Manifest();
    bad.floor5.ram.strike.damage = bad.floor5.outerWall.health + 1;

    const result = floorManifestDefSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['floor5', 'ram', 'strike', 'damage'],
          }),
        ]),
      );
    }
  });

  it('rejects duplicate route landmarks', () => {
    const bad = cloneFloor5Manifest();
    bad.floor5.ram.routeLandmarks[1] = bad.floor5.ram.routeLandmarks[0]!;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a route that does not start at the build site', () => {
    const bad = cloneFloor5Manifest();
    bad.floor5.ram.routeLandmarks[0] = 'siege-yard-junction';
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a route that does not end at the breach approach', () => {
    const bad = cloneFloor5Manifest();
    bad.floor5.ram.routeLandmarks[bad.floor5.ram.routeLandmarks.length - 1] = 'checkpoint-junction';
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects strike range that cannot reach the wall from the attack anchor', () => {
    const bad = cloneFloor5Manifest();
    bad.floor5.ram.strike.rangeFt = 11;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
    expect(floorManifestDefSchema.safeParse(cloneFloor5Manifest()).success).toBe(true);
  });

  it('rejects an arrival tolerance smaller than one advance step', () => {
    const bad = cloneFloor5Manifest();
    bad.floor5.ram.arrivalToleranceFt = bad.floor5.ram.advanceSpeedFtPerFrame / 2;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an exchange that breaches before the first ram is destroyed', () => {
    const bad = cloneFloor5Manifest();
    bad.floor5.ram.health = 1000;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an exchange that destroys more than one ram before breach', () => {
    const bad = cloneFloor5Manifest();
    bad.floor5.ram.health = 20;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });
});

describe('floor5 manifest courtyard/throne finale rules', () => {
  it('accepts the authored finale block', () => {
    expect(floorManifestDefSchema.safeParse(cloneFloor5Manifest()).success).toBe(true);
  });

  it('rejects summon health triggers that are not strictly descending', () => {
    const bad = cloneFloor5Manifest();
    bad.floor5.finale.summons.healthFractionTriggers = [0.33, 0.66];
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a summon cap smaller than the authored triggers can release', () => {
    const bad = cloneFloor5Manifest();
    bad.floor5.finale.summons.maxTotal =
      bad.floor5.finale.summons.perTriggerCount *
        bad.floor5.finale.summons.healthFractionTriggers.length -
      1;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a summon trigger at full or zero Regent health', () => {
    for (const fraction of [1, 0]) {
      const bad = cloneFloor5Manifest();
      bad.floor5.finale.summons.healthFractionTriggers = [fraction];
      expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects a non-positive throne capture interaction radius', () => {
    const bad = cloneFloor5Manifest();
    bad.floor5.finale.capture.interactionRadiusFt = 0;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });
});
