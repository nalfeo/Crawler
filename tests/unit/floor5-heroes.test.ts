import { describe, expect, it } from 'vitest';
import {
  FLOOR5_FIELD_HERO_ROSTER,
  buildFloor5FieldHeroCard,
  floor5FieldHeroSlotId,
  floor5FieldHeroStreamKey,
} from '../../src/shared/floor5-heroes.js';
import type { Floor5FieldHeroPoolEntry } from '../../src/shared/floor-types.js';

describe('FLOOR5_FIELD_HERO_ROSTER', () => {
  it('is the append-only 8-entry design-bible roster in declared order', () => {
    expect(
      FLOOR5_FIELD_HERO_ROSTER.map((entry) => [entry.order, entry.heroId, entry.role]),
    ).toEqual([
      [1, 'turnaround-consultant', 'counter-push'],
      [2, 'proxy-fighter', 'counter-push'],
      [3, 'compliance-officer-vex', 'checkpoint-defense'],
      [4, 'the-notary', 'checkpoint-defense'],
      [5, 'the-union-rep', 'engine-disruption'],
      [6, 'risk-assessment-karen', 'engine-disruption'],
      [7, 'the-middle-manager', 'minion-support'],
      [8, 'the-activist-investor', 'artillery'],
    ]);
  });

  it('covers every role in the closed role set', () => {
    expect(new Set(FLOOR5_FIELD_HERO_ROSTER.map((entry) => entry.role))).toEqual(
      new Set([
        'counter-push',
        'checkpoint-defense',
        'engine-disruption',
        'minion-support',
        'artillery',
      ]),
    );
  });

  it('gives every Hero a leash no shorter than its engage range', () => {
    for (const entry of FLOOR5_FIELD_HERO_ROSTER) {
      expect(entry.hp).toBeGreaterThan(0);
      expect(entry.attackDamage).toBeGreaterThan(0);
      expect(entry.speedFtPerFrame).toBeGreaterThan(0);
      expect(entry.leashRadiusFt).toBeGreaterThanOrEqual(entry.engageRangeFt);
      expect(entry.aggroRadiusFt).toBeGreaterThanOrEqual(entry.engageRangeFt);
    }
  });
});

describe('buildFloor5FieldHeroCard', () => {
  it('is reproducible for a given stream key', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const key = floor5FieldHeroStreamKey(seed);
      const first = buildFloor5FieldHeroCard(FLOOR5_FIELD_HERO_ROSTER, key);
      const second = buildFloor5FieldHeroCard(FLOOR5_FIELD_HERO_ROSTER, key);
      expect(second.map((entry) => entry.heroId)).toEqual(first.map((entry) => entry.heroId));
    }
  });

  it('draws the whole roster without replacement, exactly once each', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const card = buildFloor5FieldHeroCard(
        FLOOR5_FIELD_HERO_ROSTER,
        floor5FieldHeroStreamKey(seed),
      );
      expect(card).toHaveLength(FLOOR5_FIELD_HERO_ROSTER.length);
      expect(new Set(card.map((entry) => entry.heroId)).size).toBe(FLOOR5_FIELD_HERO_ROSTER.length);
      expect([...card].map((entry) => entry.order).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
    }
  });

  it('numbers slots densely from zero and carries the roster tuning forward', () => {
    const card = buildFloor5FieldHeroCard(FLOOR5_FIELD_HERO_ROSTER, floor5FieldHeroStreamKey(505));
    card.forEach((entry, index) => {
      expect(entry.slotIndex).toBe(index);
      expect(entry.slotId).toBe(floor5FieldHeroSlotId(index));
      const roster = FLOOR5_FIELD_HERO_ROSTER.find(
        (candidate) => candidate.heroId === entry.heroId,
      );
      expect(entry.role).toBe(roster?.role);
      expect(entry.hp).toBe(roster?.hp);
      expect(entry.displayName).toBe(roster?.displayName);
    });
  });

  it('produces different orders across seeds rather than a fixed sequence', () => {
    const orders = new Set(
      Array.from({ length: 40 }, (_unused, seed) =>
        buildFloor5FieldHeroCard(FLOOR5_FIELD_HERO_ROSTER, floor5FieldHeroStreamKey(seed))
          .map((entry) => entry.heroId)
          .join(','),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
  });

  it('rejects a roster with duplicate hero ids or duplicate orders', () => {
    const [first, second] = FLOOR5_FIELD_HERO_ROSTER;
    const duplicateId: Floor5FieldHeroPoolEntry[] = [first!, { ...second!, heroId: first!.heroId }];
    const duplicateOrder: Floor5FieldHeroPoolEntry[] = [
      first!,
      { ...second!, order: first!.order },
    ];
    expect(() => buildFloor5FieldHeroCard(duplicateId, 'x')).toThrow(/heroId/i);
    expect(() => buildFloor5FieldHeroCard(duplicateOrder, 'x')).toThrow(/order/i);
  });

  it('namespaces the stream key onto the manifest-reserved `heroes` stream', () => {
    expect(floor5FieldHeroStreamKey(505)).toBe('505:floor5:heroes');
  });
});
