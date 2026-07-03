import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../../src/shared/random.js';
import { loadFamilies } from '../../src/shared/data/families.js';
import { loadResources } from '../../src/shared/data/resources.js';
import { selectFloor2Roster } from '../../src/core/faction-relations.js';

/**
 * Deterministic selection contract for Floor 2 (ADR 0040 · D3):
 *   - same seed ⇒ identical roster
 *   - present count is exactly 3 or 4
 *   - families are unique
 *   - contested resource is in the resource pool
 */

describe('selectFloor2Roster', () => {
  const families = loadFamilies();
  const resources = loadResources();

  it('is deterministic for a given seed', () => {
    const a = selectFloor2Roster(new SeededRandom(12345), families, resources);
    const b = selectFloor2Roster(new SeededRandom(12345), families, resources);
    expect(a).toEqual(b);
  });

  it('yields a present count of 3 or 4', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const roster = selectFloor2Roster(new SeededRandom(seed), families, resources);
      expect([3, 4]).toContain(roster.presentFamilies.length);
    }
  });

  it('yields families with unique ids drawn from the roster', () => {
    const knownIds = new Set(families.map((f) => f.id));
    for (let seed = 1; seed <= 20; seed++) {
      const roster = selectFloor2Roster(new SeededRandom(seed), families, resources);
      const set = new Set(roster.presentFamilies);
      expect(set.size).toBe(roster.presentFamilies.length);
      for (const id of roster.presentFamilies) {
        expect(knownIds.has(id)).toBe(true);
      }
    }
  });

  it('picks a contested resource from the resource pool', () => {
    const resIds = new Set(resources.map((r) => r.id));
    for (let seed = 1; seed <= 20; seed++) {
      const roster = selectFloor2Roster(new SeededRandom(seed), families, resources);
      expect(resIds.has(roster.contestedResource)).toBe(true);
    }
  });

  it('honors an explicit presentCountFourProbability override (0 → always 3)', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const roster = selectFloor2Roster(new SeededRandom(seed), families, resources, {
        presentCountFourProbability: 0,
      });
      expect(roster.presentFamilies).toHaveLength(3);
    }
  });

  it('honors 1 → always 4', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const roster = selectFloor2Roster(new SeededRandom(seed), families, resources, {
        presentCountFourProbability: 1,
      });
      expect(roster.presentFamilies).toHaveLength(4);
    }
  });

  it('throws when the family pool is too small', () => {
    expect(() =>
      selectFloor2Roster(new SeededRandom(1), families.slice(0, 3), resources),
    ).toThrow();
  });

  it('throws when the resource pool is empty', () => {
    expect(() => selectFloor2Roster(new SeededRandom(1), families, [])).toThrow();
  });
});
