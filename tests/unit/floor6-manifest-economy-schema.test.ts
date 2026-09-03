import { describe, expect, it } from 'vitest';
import { floor6Manifest, floorManifestDefSchema } from '../../src/shared/floor-manifest.js';

type ManifestWithFloor6 = typeof floor6Manifest & {
  floor6: NonNullable<typeof floor6Manifest.floor6>;
};

function cloneFloor6Manifest(): ManifestWithFloor6 {
  return structuredClone(floor6Manifest) as ManifestWithFloor6;
}

/**
 * Negative-case coverage for the Floor 6 economy `superRefine` rules in
 * `floor-manifest.ts` (duplicate ids, reward archetype/wave references, and
 * offer-count bounds). The authored manifest alone only proves the schema
 * accepts valid data — it never exercises the rejection branches, so a
 * regression that silently dropped one of these checks would leave the suite
 * green. Each case mutates a single field on a clone of the real, otherwise
 * valid manifest so only the targeted rule can fail.
 */
describe('floor6 manifest economy schema validation', () => {
  it('accepts the authored floor6 manifest', () => {
    expect(floorManifestDefSchema.safeParse(cloneFloor6Manifest()).success).toBe(true);
  });

  it('rejects a duplicate wave waveIndex', () => {
    const bad = cloneFloor6Manifest();
    const waves = bad.floor6.waves;
    if (!waves || waves.length < 2) {
      throw new Error('authored floor6 manifest must have at least 2 waves for this test');
    }
    waves[1] = { ...waves[1]!, waveIndex: waves[0]!.waveIndex };
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a duplicate enemy reward archetypeId', () => {
    const bad = cloneFloor6Manifest();
    const rewards = bad.floor6.economy!.enemyRewards;
    if (rewards.length < 2) {
      throw new Error('authored floor6 manifest must have at least 2 enemy rewards for this test');
    }
    rewards[1] = { ...rewards[1]!, archetypeId: rewards[0]!.archetypeId };
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an enemy reward referencing an unknown archetype', () => {
    const bad = cloneFloor6Manifest();
    const rewards = bad.floor6.economy!.enemyRewards;
    rewards[0] = { ...rewards[0]!, archetypeId: 'not-a-real-archetype' };
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a wave entry referencing an unknown archetype', () => {
    const bad = cloneFloor6Manifest();
    bad.floor6.waves![0]!.entries[0] = {
      ...bad.floor6.waves![0]!.entries[0]!,
      archetypeId: 'not-a-real-wave-raider',
    };
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a duplicate wave reward waveIndex', () => {
    const bad = cloneFloor6Manifest();
    const waveRewards = bad.floor6.economy!.waveRewards;
    if (waveRewards.length < 2) {
      throw new Error('authored floor6 manifest must have at least 2 wave rewards for this test');
    }
    waveRewards[1] = { ...waveRewards[1]!, waveIndex: waveRewards[0]!.waveIndex };
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a wave reward referencing an unknown waveIndex', () => {
    const bad = cloneFloor6Manifest();
    const waveRewards = bad.floor6.economy!.waveRewards;
    const unknownWaveIndex = Math.max(...bad.floor6.waves!.map((wave) => wave.waveIndex)) + 1;
    waveRewards[0] = { ...waveRewards[0]!, waveIndex: unknownWaveIndex };
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an offerCount that exceeds the authored offers', () => {
    const bad = cloneFloor6Manifest();
    bad.floor6.upgrades!.offerCount = bad.floor6.upgrades!.offers.length + 1;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a duplicate upgrade offer id', () => {
    const bad = cloneFloor6Manifest();
    const offers = bad.floor6.upgrades!.offers;
    if (offers.length < 2) {
      throw new Error('authored floor6 manifest must have at least 2 upgrade offers for this test');
    }
    offers[1] = { ...offers[1]!, id: offers[0]!.id };
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a finale boss referencing an unknown archetype', () => {
    const bad = cloneFloor6Manifest();
    bad.floor6.finale!.boss = {
      ...bad.floor6.finale!.boss,
      archetypeId: 'not-a-real-deadline',
    };
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a finale add referencing an unknown route', () => {
    const bad = cloneFloor6Manifest();
    bad.floor6.finale!.adds[0] = {
      ...bad.floor6.finale!.adds[0]!,
      routeIndex: 99,
    };
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a duplicate finale add id', () => {
    const bad = cloneFloor6Manifest();
    if (bad.floor6.finale!.adds.length < 2) {
      throw new Error('authored floor6 manifest must have at least 2 finale adds for this test');
    }
    bad.floor6.finale!.adds[1] = {
      ...bad.floor6.finale!.adds[1]!,
      id: bad.floor6.finale!.adds[0]!.id,
    };
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });
});
