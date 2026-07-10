import { describe, expect, it } from 'vitest';
import {
  mergeSpawnZoneWeights,
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
});
