import { describe, expect, it } from 'vitest';
import {
  mergeSpawnZoneWeights,
  mixSpawnZoneWeights,
  normalizeSpawnZoneWeights,
  pickFromSpawnZones,
} from '../../src/game/spawn-zones.js';

describe('spawn-zones', () => {
  it('unions same archetype ids across zones by summing weights', () => {
    const merged = mergeSpawnZoneWeights([
      new Map([
        ['a', 1],
        ['b', 2],
      ]),
      new Map([
        ['a', 3],
        ['c', 4],
      ]),
    ]);
    expect(merged.get('a')).toBe(4);
    expect(merged.get('b')).toBe(2);
    expect(merged.get('c')).toBe(4);
  });

  it('normalizes merged weights to probabilities that sum to ~1', () => {
    const normalized = normalizeSpawnZoneWeights(
      new Map([
        ['a', 2],
        ['b', 3],
      ]),
    );
    const total = [...normalized.values()].reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(normalized.get('a')).toBeCloseTo(0.4, 6);
    expect(normalized.get('b')).toBeCloseTo(0.6, 6);
  });

  it('picks deterministically from normalized union weights based on roll', () => {
    const zones = [
      new Map([
        ['family-melee', 0.74],
        ['family-ranged', 0.25],
        ['family-elite', 0.01],
      ]),
      new Map([['quadrant-trash', 1]]),
      new Map([['global-trash', 1]]),
    ] as const;

    const lowRoll = pickFromSpawnZones(zones, () => 0.0);
    const highRoll = pickFromSpawnZones(zones, () => 0.999);
    expect(lowRoll.pickedId).not.toBeNull();
    expect(highRoll.pickedId).not.toBeNull();
    expect(lowRoll.normalized.size).toBeGreaterThan(0);
    expect(highRoll.normalized.size).toBe(lowRoll.normalized.size);
  });

  it('reserves category shares independently of raw weights', () => {
    const mixed = mixSpawnZoneWeights([
      {
        weights: new Map([
          ['family-a', 100],
          ['family-b', 100],
        ]),
        share: 0.75,
      },
      {
        weights: new Map([
          ['neutral-a', 1],
          ['neutral-b', 3],
        ]),
        share: 0.25,
      },
    ]);

    expect(mixed.get('family-a')).toBeCloseTo(0.375, 6);
    expect(mixed.get('family-b')).toBeCloseTo(0.375, 6);
    expect(mixed.get('neutral-a')).toBeCloseTo(0.0625, 6);
    expect(mixed.get('neutral-b')).toBeCloseTo(0.1875, 6);
  });

  it('renormalizes shares when a category is empty', () => {
    const mixed = mixSpawnZoneWeights([
      { weights: new Map(), share: 0.75 },
      { weights: new Map([['neutral', 1]]), share: 0.25 },
    ]);

    expect(mixed).toEqual(new Map([['neutral', 1]]));
  });
});
