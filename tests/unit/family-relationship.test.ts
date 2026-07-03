import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RELATION,
  RELATION_MAX,
  RELATION_MIN,
  adjustFactionRelation,
  asFamilyId,
  bandFor,
  clampRelation,
  effectiveSpeedForHate,
  getRelation,
  initializeFactionRelations,
} from '../../src/core/index.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * Unit coverage for the pure/helper surface of the Floor 2 Slice 1
 * faction-relationship model:
 *   - `bandFor` boundary math (FR8, inclusive)
 *   - `clampRelation` and `adjustFactionRelation` clamping / event emission
 *   - `effectiveSpeedForHate` corners (FR9)
 *
 * The `familyRelationshipSystem` (a `src/core` ECS system) is exercised under
 * `tests/ecs/familyRelationshipSystem.test.ts` per the tests-layer convention.
 */

const goblins = asFamilyId('goblins');

describe('bandFor — inclusive boundaries per FR8', () => {
  it('classifies hate (0..24)', () => {
    expect(bandFor(0)).toBe('hate');
    expect(bandFor(1)).toBe('hate');
    expect(bandFor(24)).toBe('hate');
  });

  it('classifies hostile (25..49)', () => {
    expect(bandFor(25)).toBe('hostile');
    expect(bandFor(49)).toBe('hostile');
  });

  it('classifies neutral (50..75)', () => {
    expect(bandFor(50)).toBe('neutral');
    expect(bandFor(75)).toBe('neutral');
  });

  it('classifies friendly (76..100)', () => {
    expect(bandFor(76)).toBe('friendly');
    expect(bandFor(100)).toBe('friendly');
  });

  it('clamps out-of-range values before classifying', () => {
    expect(bandFor(-999)).toBe('hate');
    expect(bandFor(9999)).toBe('friendly');
    expect(bandFor(Number.NaN)).toBe('hate');
  });
});

describe('clampRelation', () => {
  it('clamps to [0, 100] and coerces non-finite to 0', () => {
    expect(clampRelation(-1)).toBe(RELATION_MIN);
    expect(clampRelation(0)).toBe(0);
    expect(clampRelation(100)).toBe(RELATION_MAX);
    expect(clampRelation(101)).toBe(100);
    expect(clampRelation(Number.NaN)).toBe(0);
    expect(clampRelation(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('adjustFactionRelation', () => {
  it('reads the default relation for an unseeded family', () => {
    const world = createTestWorld();
    expect(getRelation(world, goblins)).toBe(DEFAULT_RELATION);
  });

  it('clamps at the upper bound and emits an event', () => {
    const world = createTestWorld();
    initializeFactionRelations(world, [goblins]);
    world.factionRelationEvents.length = 0;
    adjustFactionRelation(world, goblins, 999);
    expect(getRelation(world, goblins)).toBe(RELATION_MAX);
    expect(world.factionRelationEvents).toHaveLength(1);
    const evt = world.factionRelationEvents[0]!;
    expect(evt).toMatchObject({
      familyId: goblins,
      before: DEFAULT_RELATION,
      after: RELATION_MAX,
      band: 'friendly',
      previousBand: 'hostile',
    });
  });

  it('clamps at the lower bound', () => {
    const world = createTestWorld();
    initializeFactionRelations(world, [goblins]);
    adjustFactionRelation(world, goblins, -999);
    expect(getRelation(world, goblins)).toBe(RELATION_MIN);
    const evt = world.factionRelationEvents.at(-1)!;
    expect(evt.after).toBe(RELATION_MIN);
    expect(evt.band).toBe('hate');
  });

  it('records both bands on a boundary crossing', () => {
    const world = createTestWorld();
    initializeFactionRelations(world, [goblins]);
    // Start at 45 (hostile); +5 -> 50 (neutral)
    adjustFactionRelation(world, goblins, 5);
    const evt = world.factionRelationEvents.at(-1)!;
    expect(evt.before).toBe(45);
    expect(evt.after).toBe(50);
    expect(evt.previousBand).toBe('hostile');
    expect(evt.band).toBe('neutral');
  });
});

describe('effectiveSpeedForHate — FR9 corners', () => {
  it('returns baseSpeed at r=25 (top of hate band)', () => {
    expect(effectiveSpeedForHate(25, 1, 3)).toBe(1);
  });

  it('matches player speed at r=0', () => {
    expect(effectiveSpeedForHate(0, 1, 3)).toBe(3);
  });

  it('interpolates linearly between r=0 and r=25', () => {
    // r=12.5 → boost = 0.5 → 1 + 0.5*(3-1) = 2
    expect(effectiveSpeedForHate(12.5, 1, 3)).toBe(2);
  });

  it('never lowers a mob whose base speed already exceeds the player', () => {
    expect(effectiveSpeedForHate(0, 5, 3)).toBe(5);
  });

  it('never exceeds the player speed', () => {
    const s = effectiveSpeedForHate(0, 1, 3);
    expect(s).toBeLessThanOrEqual(3);
  });

  it('is a noop outside the hate band', () => {
    expect(effectiveSpeedForHate(45, 2, 4)).toBe(2);
    expect(effectiveSpeedForHate(76, 2, 4)).toBe(2);
  });

  it('is monotonically non-increasing in relation between 0 and 25', () => {
    let prev = effectiveSpeedForHate(0, 1, 3);
    for (let r = 1; r <= 25; r++) {
      const s = effectiveSpeedForHate(r, 1, 3);
      expect(s).toBeLessThanOrEqual(prev + 1e-9);
      prev = s;
    }
  });
});
