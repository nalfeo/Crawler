import { describe, expect, it } from 'vitest';
import {
  MATCHUP_COLORS,
  MATCHUP_RANGE_FT,
  matchupTagForMultiplier,
  nearestRivalCompanion,
  resolveCompanionMatchup,
  resolveHeadlineMatchup,
  resolvePartyMatchups,
} from '../../src/engine/floor3-matchup-state.js';
import { resolveFloor3PartyRows } from '../../src/engine/floor3-party-state.js';
import { TeamId } from '../../src/shared/constants.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { spawnTestCompanion } from '../helpers/floor3-party.js';

function floor3World() {
  const world = createTestWorld();
  world.floor = 3;
  world.floorId = 'floor3';
  return world;
}

describe('matchupTagForMultiplier', () => {
  it('maps the three effectiveness multipliers', () => {
    expect(matchupTagForMultiplier(2)).toBe('strong');
    expect(matchupTagForMultiplier(0.5)).toBe('weak');
    expect(matchupTagForMultiplier(1)).toBe('neutral');
  });
});

describe('resolveCompanionMatchup', () => {
  it('reads STRONG when the party Companion beats the rival affinity', () => {
    const world = floor3World();
    const mine = spawnTestCompanion(world, { speciesId: 'ember-charger' });
    spawnTestCompanion(world, {
      speciesId: 'bloom-warden',
      x: 3,
      teamId: TeamId.ENEMY,
      roster: true,
    });

    const matchup = resolveCompanionMatchup(world, mine)!;
    expect(matchup.tag).toBe('strong');
    expect(matchup.multiplier).toBe(2);
    expect(matchup.color).toBe(MATCHUP_COLORS.strong);
    expect(matchup.label).toBe('STRONG');
  });

  it('reads WEAK against a rival that resists it', () => {
    const world = floor3World();
    const mine = spawnTestCompanion(world, { speciesId: 'bloom-warden' });
    spawnTestCompanion(world, {
      speciesId: 'ember-charger',
      x: 2,
      teamId: TeamId.ENEMY,
      roster: true,
    });

    expect(resolveCompanionMatchup(world, mine)!.tag).toBe('weak');
  });

  it('has no read when the nearest rival is out of engagement range', () => {
    const world = floor3World();
    const mine = spawnTestCompanion(world, { speciesId: 'ember-charger' });
    spawnTestCompanion(world, {
      speciesId: 'bloom-warden',
      x: MATCHUP_RANGE_FT + 1,
      teamId: TeamId.ENEMY,
      roster: true,
    });

    expect(resolveCompanionMatchup(world, mine)).toBeUndefined();
  });

  it('ignores knocked-out and dead rivals, and a knocked-out source', () => {
    const world = floor3World();
    const mine = spawnTestCompanion(world, { speciesId: 'ember-charger' });
    spawnTestCompanion(world, {
      speciesId: 'bloom-warden',
      x: 2,
      teamId: TeamId.ENEMY,
      roster: true,
      knockedOut: true,
    });
    const dead = spawnTestCompanion(world, {
      speciesId: 'stone-slinger',
      x: 3,
      teamId: TeamId.ENEMY,
      roster: true,
    });
    world.stores.health.current[dead] = 0;

    expect(resolveCompanionMatchup(world, mine)).toBeUndefined();

    world.stores.companion.knockedOut[mine] = 1;
    expect(resolveCompanionMatchup(world, mine)).toBeUndefined();
  });

  it('breaks equidistant rivals by lowest entity id so the read is reproducible', () => {
    const world = floor3World();
    const mine = spawnTestCompanion(world, { speciesId: 'ember-charger' });
    const first = spawnTestCompanion(world, {
      speciesId: 'bloom-warden',
      x: 4,
      teamId: TeamId.ENEMY,
      roster: true,
    });
    const second = spawnTestCompanion(world, {
      speciesId: 'lumen-warden',
      x: -4,
      teamId: TeamId.ENEMY,
      roster: true,
    });

    expect(first).toBeLessThan(second);
    expect(nearestRivalCompanion(world, mine)!.eid).toBe(first);
    expect(resolveCompanionMatchup(world, mine)!.targetEid).toBe(first);
  });
});

describe('resolvePartyMatchups / resolveHeadlineMatchup', () => {
  it('keys per-row matchups by stable party identity and headlines the closest', () => {
    const world = floor3World();
    spawnTestCompanion(world, { speciesId: 'ember-charger', slot: 0, x: 0 });
    spawnTestCompanion(world, { speciesId: 'bloom-warden', slot: 1, x: 8 });
    spawnTestCompanion(world, {
      speciesId: 'stone-slinger',
      x: 7,
      teamId: TeamId.ENEMY,
      roster: true,
    });

    const rows = resolveFloor3PartyRows(world);
    const matchups = resolvePartyMatchups(world, rows);
    expect(matchups.size).toBe(2);
    expect(matchups.get(rows[0]!.key)!.tag).toBe('strong');

    const headline = resolveHeadlineMatchup(world, rows)!;
    expect(headline.sourceEid).toBe(rows[1]!.eid);
  });

  it('has no headline when nothing is engaged', () => {
    const world = floor3World();
    spawnTestCompanion(world, { speciesId: 'ember-charger', slot: 0 });
    expect(resolveHeadlineMatchup(world, resolveFloor3PartyRows(world))).toBeUndefined();
  });
});
