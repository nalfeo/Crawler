import { describe, expect, it } from 'vitest';
import {
  detailLines,
  MAX_DETAIL_LINES,
  resolveAbilityTrack,
  resolveCompanionDetail,
  resolveFormTrack,
  resolveRosterEntries,
  wrapRosterIndex,
} from '../../src/engine/floor3-companion-detail-state.js';
import { getPetSpecies } from '../../src/shared/data/floor3/species.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { spawnTestCompanion } from '../helpers/floor3-party.js';

function floor3World() {
  const world = createTestWorld();
  world.floor = 3;
  world.floorId = 'floor3';
  return world;
}

const emberCharger = getPetSpecies('ember-charger')!;

describe('resolveFormTrack', () => {
  it('marks reached forms and the current one at level 1', () => {
    const track = resolveFormTrack(emberCharger, 1);
    expect(track.map((step) => step.reached)).toEqual([true, false, false]);
    expect(track.filter((step) => step.current)).toHaveLength(1);
    expect(track[0]!.current).toBe(true);
  });

  it('advances the current form at the L10 and L25 thresholds', () => {
    expect(resolveFormTrack(emberCharger, 9).findIndex((s) => s.current)).toBe(0);
    expect(resolveFormTrack(emberCharger, 10).findIndex((s) => s.current)).toBe(1);
    expect(resolveFormTrack(emberCharger, 24).findIndex((s) => s.current)).toBe(1);
    expect(resolveFormTrack(emberCharger, 25).findIndex((s) => s.current)).toBe(2);
  });
});

describe('resolveAbilityTrack', () => {
  it('lists all five milestones with learned flags at the exact thresholds', () => {
    const track = resolveAbilityTrack(emberCharger, 16);
    expect(track.map((step) => step.level)).toEqual([1, 8, 16, 25, 34]);
    expect(track.map((step) => step.learned)).toEqual([true, true, true, false, false]);
    expect(track[0]!.abilityId).toBe(emberCharger.abilityIdsByLevel['1']);
    expect(track[0]!.name).toBe(emberCharger.innateAbilityName);
  });
});

describe('resolveCompanionDetail', () => {
  it('projects level, form, persona, and the affinity strong/weak read', () => {
    const world = floor3World();
    const eid = spawnTestCompanion(world, {
      speciesId: 'ember-charger',
      slot: 1,
      level: 12,
      hp: 55,
      maxHp: 90,
    });

    const detail = resolveCompanionDetail(world, eid)!;
    expect(detail.slot).toBe(1);
    expect(detail.level).toBe(12);
    expect(detail.form).toBe(1);
    expect(detail.displayName).toBe(emberCharger.forms[1].name);
    expect(detail.hpCurrent).toBe(55);
    expect(detail.hpMax).toBe(90);
    expect(detail.persona.aiType).toBe('CHASE');
    expect(detail.strongAgainst).toEqual(['bloom', 'stone']);
    expect(detail.weakTo).toEqual(['gloom', 'lumen']);
  });

  it('reports the next form and next ability milestone, and clears them when maxed', () => {
    const world = floor3World();
    const young = spawnTestCompanion(world, { speciesId: 'ember-charger', slot: 0, level: 5 });
    const maxed = spawnTestCompanion(world, { speciesId: 'bloom-warden', slot: 1, level: 40 });

    const youngDetail = resolveCompanionDetail(world, young)!;
    expect(youngDetail.nextForm!.minLevel).toBe(10);
    expect(youngDetail.nextAbility!.level).toBe(8);

    const maxedDetail = resolveCompanionDetail(world, maxed)!;
    expect(maxedDetail.nextForm).toBeUndefined();
    expect(maxedDetail.nextAbility).toBeUndefined();
  });

  it('returns undefined for an unknown species token', () => {
    const world = floor3World();
    const eid = spawnTestCompanion(world, { speciesId: 'ember-charger' });
    world.stores.companion.speciesToken[eid] = 0;
    expect(resolveCompanionDetail(world, eid)).toBeUndefined();
  });
});

describe('resolveRosterEntries', () => {
  it('returns the party in slot order', () => {
    const world = floor3World();
    spawnTestCompanion(world, { speciesId: 'ember-charger', slot: 1 });
    spawnTestCompanion(world, { speciesId: 'bloom-warden', slot: 0 });

    expect(resolveRosterEntries(world).map((entry) => entry.slot)).toEqual([0, 1]);
  });
});

describe('wrapRosterIndex', () => {
  it('wraps at both ends and tolerates an empty roster', () => {
    expect(wrapRosterIndex(0, 3)).toBe(0);
    expect(wrapRosterIndex(3, 3)).toBe(0);
    expect(wrapRosterIndex(-1, 3)).toBe(2);
    expect(wrapRosterIndex(5, 0)).toBe(0);
  });
});

describe('detailLines', () => {
  it('explains the empty roster instead of rendering a blank column', () => {
    expect(detailLines(undefined)).toEqual(['No companions recruited yet.']);
  });

  it('renders identity, matchup spread, and both progression tracks', () => {
    const world = floor3World();
    spawnTestCompanion(world, { speciesId: 'ember-charger', slot: 0, level: 12 });
    const detail = resolveCompanionDetail(world, resolveRosterEntries(world)[0]!.eid)!;

    const lines = detailLines(detail);
    expect(lines[0]).toContain(detail.displayName);
    expect(lines[0]).toContain('L12');
    expect(lines).toContain('FORMS');
    expect(lines).toContain('ABILITIES');
    expect(lines.some((line) => line.startsWith('Strong vs'))).toBe(true);
    expect(lines.some((line) => line.startsWith('Weak to'))).toBe(true);
    // Every authored milestone stays visible inside the rendered budget.
    expect(detail.abilityTrack).toHaveLength(5);
    expect(lines.length).toBeLessThanOrEqual(MAX_DETAIL_LINES);
    for (const step of detail.abilityTrack) {
      expect(lines.some((line) => line.includes(step.name))).toBe(true);
    }
  });

  it('never leaks a raw f3.* ability id into player-facing copy', () => {
    const world = floor3World();
    spawnTestCompanion(world, { speciesId: 'ember-charger', slot: 0, level: 34 });
    const detail = resolveCompanionDetail(world, resolveRosterEntries(world)[0]!.eid)!;
    for (const line of detailLines(detail)) {
      expect(line).not.toContain('f3.');
    }
  });

  it('flags a knocked-out companion in the header line', () => {
    const world = floor3World();
    spawnTestCompanion(world, { speciesId: 'ember-charger', slot: 0, level: 5, knockedOut: true });
    const detail = resolveCompanionDetail(world, resolveRosterEntries(world)[0]!.eid)!;
    expect(detailLines(detail)[0]).toContain('[KO]');
  });
});
