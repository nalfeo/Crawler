import { describe, expect, it } from 'vitest';
import { createEntity } from '../../src/core/helpers.js';
import {
  FAIL_CLOSED_DAMAGE_META,
  readDamageMeta,
  tagDamageMeta,
} from '../../src/core/damage-meta.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('damage-meta', () => {
  it('fails closed (including fromActiveAbility=false) for an untagged entity', () => {
    const world = createTestWorld();
    const eid = createEntity(world);

    expect(readDamageMeta(world, eid)).toEqual(FAIL_CLOSED_DAMAGE_META);
  });

  it('round-trips fromActiveAbility:true through tagDamageMeta/readDamageMeta', () => {
    const world = createTestWorld();
    const eid = createEntity(world);

    tagDamageMeta(world, eid, {
      origin: 'player',
      affinity: 'magic',
      scaleWithPrimary: false,
      canCrit: true,
      fromActiveAbility: true,
    });

    expect(readDamageMeta(world, eid)).toEqual({
      origin: 'player',
      affinity: 'magic',
      scaleWithPrimary: false,
      canCrit: true,
      fromActiveAbility: true,
    });
  });

  it('defaults fromActiveAbility to false when the caller omits it', () => {
    const world = createTestWorld();
    const eid = createEntity(world);

    // Existing callers (e.g. weaponSystem, enemyAISystem) tag damage-meta
    // without a `fromActiveAbility` field at all — this must not throw and
    // must decode back to false, not undefined, so ability-vs-weapon damage
    // attribution telemetry never sees an ambiguous value.
    tagDamageMeta(world, eid, {
      origin: 'player',
      affinity: 'physical',
      scaleWithPrimary: true,
      canCrit: true,
    });

    expect(readDamageMeta(world, eid).fromActiveAbility).toBe(false);
  });
});
