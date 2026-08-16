import { describe, expect, it } from 'vitest';
import {
  AFFINITY_MATRIX,
  AFFINITY_RING,
  affinityMultiplier,
  isAffinity,
  predatorsOf,
  strongAgainst,
  type Affinity,
} from '../../src/shared/data/floor3/affinity.js';

describe('Floor 3 affinity matrix', () => {
  it('defines seven affinities in ring order', () => {
    expect(AFFINITY_RING).toEqual(['ember', 'bloom', 'stone', 'gale', 'tide', 'gloom', 'lumen']);
  });

  it('defines every ordered pair', () => {
    for (const attacker of AFFINITY_RING) {
      for (const defender of AFFINITY_RING) {
        expect([0.5, 1, 2]).toContain(affinityMultiplier(attacker, defender));
      }
    }
  });

  it('is 2-regular: each row has two x2, two x0.5 and three x1', () => {
    for (const attacker of AFFINITY_RING) {
      const row = AFFINITY_RING.map((defender) => affinityMultiplier(attacker, defender));
      expect(row.filter((m) => m === 2)).toHaveLength(2);
      expect(row.filter((m) => m === 0.5)).toHaveLength(2);
      expect(row.filter((m) => m === 1)).toHaveLength(3);
    }
  });

  it('is 2-regular by column too: every affinity has exactly two predators and two prey', () => {
    for (const defender of AFFINITY_RING) {
      const column = AFFINITY_RING.map((attacker) => affinityMultiplier(attacker, defender));
      expect(column.filter((m) => m === 2)).toHaveLength(2);
      expect(column.filter((m) => m === 0.5)).toHaveLength(2);
    }
  });

  it('is neutral against itself', () => {
    for (const affinity of AFFINITY_RING) {
      expect(affinityMultiplier(affinity, affinity)).toBe(1);
    }
  });

  it('is antisymmetric: strong one way implies weak the other way', () => {
    for (const attacker of AFFINITY_RING) {
      for (const defender of AFFINITY_RING) {
        const forward = affinityMultiplier(attacker, defender);
        const reverse = affinityMultiplier(defender, attacker);
        if (forward === 2) expect(reverse).toBe(0.5);
        if (forward === 0.5) expect(reverse).toBe(2);
        if (attacker !== defender && forward === 1) expect(reverse).toBe(1);
      }
    }
  });

  it('matches the authored per-affinity summary', () => {
    const expected: Record<Affinity, { strong: Affinity[]; weakTo: Affinity[] }> = {
      ember: { strong: ['bloom', 'stone'], weakTo: ['gloom', 'lumen'] },
      bloom: { strong: ['stone', 'gale'], weakTo: ['ember', 'lumen'] },
      stone: { strong: ['gale', 'tide'], weakTo: ['ember', 'bloom'] },
      gale: { strong: ['tide', 'gloom'], weakTo: ['bloom', 'stone'] },
      tide: { strong: ['gloom', 'lumen'], weakTo: ['stone', 'gale'] },
      gloom: { strong: ['lumen', 'ember'], weakTo: ['gale', 'tide'] },
      lumen: { strong: ['ember', 'bloom'], weakTo: ['tide', 'gloom'] },
    };
    for (const affinity of AFFINITY_RING) {
      expect([...strongAgainst(affinity)].sort()).toEqual([...expected[affinity].strong].sort());
      expect([...predatorsOf(affinity)].sort()).toEqual([...expected[affinity].weakTo].sort());
    }
  });

  it('exposes a frozen matrix and a working type guard', () => {
    expect(Object.isFrozen(AFFINITY_MATRIX)).toBe(true);
    expect(Object.isFrozen(AFFINITY_MATRIX.ember)).toBe(true);
    expect(isAffinity('tide')).toBe(true);
    expect(isAffinity('plasma')).toBe(false);
  });
});
