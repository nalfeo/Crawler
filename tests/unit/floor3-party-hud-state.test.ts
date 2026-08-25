import { describe, expect, it } from 'vitest';
import {
  AFFINITY_HUD_COLORS,
  STYLE_HUD_GLYPHS,
  abilityDisplayName,
  partyMemberKey,
  resolveFloor3PartyRows,
  resolvePartyMemberEids,
  shouldShowFloor3Party,
  signatureMilestoneLevel,
} from '../../src/engine/floor3-party-state.js';
import { getPetSpecies } from '../../src/shared/data/floor3/species.js';
import { TeamId } from '../../src/shared/constants.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { spawnTestCompanion } from '../helpers/floor3-party.js';

function floor3World() {
  const world = createTestWorld();
  world.floor = 3;
  world.floorId = 'floor3';
  return world;
}

describe('shouldShowFloor3Party', () => {
  it('is hidden off Floor 3', () => {
    const world = createTestWorld();
    expect(shouldShowFloor3Party(world)).toBe(false);
  });

  it('is shown on Floor 3', () => {
    expect(shouldShowFloor3Party(floor3World())).toBe(true);
  });
});

describe('resolveFloor3PartyRows', () => {
  it('returns nothing off Floor 3 even when a party exists', () => {
    const world = createTestWorld();
    spawnTestCompanion(world, { speciesId: 'ember-charger' });
    expect(resolveFloor3PartyRows(world)).toEqual([]);
  });

  it('orders rows by party slot, not by entity id', () => {
    const world = floor3World();
    spawnTestCompanion(world, { speciesId: 'ember-charger', slot: 2 });
    spawnTestCompanion(world, { speciesId: 'bloom-warden', slot: 0 });
    spawnTestCompanion(world, { speciesId: 'stone-slinger', slot: 1 });

    expect(resolveFloor3PartyRows(world).map((row) => row.speciesId)).toEqual([
      'bloom-warden',
      'stone-slinger',
      'ember-charger',
    ]);
  });

  it('excludes rival-team Companions and roster Companions without a PartySlot', () => {
    const world = floor3World();
    spawnTestCompanion(world, { speciesId: 'ember-charger', slot: 0 });
    spawnTestCompanion(world, { speciesId: 'gale-bruiser', slot: 0, teamId: TeamId.ENEMY });
    spawnTestCompanion(world, { speciesId: 'tide-kindler', roster: true });

    expect(resolveFloor3PartyRows(world).map((row) => row.speciesId)).toEqual(['ember-charger']);
    expect(resolvePartyMemberEids(world, TeamId.ENEMY)).toHaveLength(1);
  });

  it('projects health, KO, affinity color and style glyph for a row', () => {
    const world = floor3World();
    spawnTestCompanion(world, {
      speciesId: 'ember-charger',
      slot: 0,
      hp: 30,
      maxHp: 120,
      knockedOut: true,
    });

    const row = resolveFloor3PartyRows(world)[0]!;
    expect(row.hpFraction).toBeCloseTo(0.25);
    expect(row.knockedOut).toBe(true);
    expect(row.affinityColor).toBe(AFFINITY_HUD_COLORS.ember);
    expect(row.styleGlyph).toBe(STYLE_HUD_GLYPHS.charger);
    expect(row.key).toBe(partyMemberKey(0, world.stores.companion.speciesToken[row.eid]!));
  });

  it('derives the form and its name from level, matching formForLevel', () => {
    const world = floor3World();
    spawnTestCompanion(world, { speciesId: 'ember-charger', level: 25 });

    const row = resolveFloor3PartyRows(world)[0]!;
    const species = getPetSpecies('ember-charger')!;
    expect(row.form).toBe(2);
    expect(row.formName).toBe(species.forms[2].name);
    expect(row.learnedAbilityIds).toHaveLength(4);
  });

  it('clamps hpFraction and tolerates a zero max-HP row', () => {
    const world = floor3World();
    const eid = spawnTestCompanion(world, { speciesId: 'ember-charger', hp: 100, maxHp: 100 });
    world.stores.health.current[eid] = 999;
    expect(resolveFloor3PartyRows(world)[0]!.hpFraction).toBe(1);

    world.stores.health.max[eid] = 0;
    expect(resolveFloor3PartyRows(world)[0]!.hpFraction).toBe(0);
  });

  it('skips a Companion whose species token is unknown instead of throwing', () => {
    const world = floor3World();
    const eid = spawnTestCompanion(world, { speciesId: 'ember-charger' });
    world.stores.companion.speciesToken[eid] = 0;
    expect(resolveFloor3PartyRows(world)).toEqual([]);
  });
});

describe('signatureMilestoneLevel', () => {
  it('reports the highest milestone already reached', () => {
    expect(signatureMilestoneLevel(1)).toBe(1);
    expect(signatureMilestoneLevel(7)).toBe(1);
    expect(signatureMilestoneLevel(8)).toBe(8);
    expect(signatureMilestoneLevel(24)).toBe(16);
    expect(signatureMilestoneLevel(25)).toBe(25);
    expect(signatureMilestoneLevel(99)).toBe(34);
  });
});

describe('abilityDisplayName', () => {
  const species = getPetSpecies('ember-charger')!;

  it('uses the authored innate and adult-signature names', () => {
    expect(abilityDisplayName(species, 1)).toBe(species.innateAbilityName);
    expect(abilityDisplayName(species, 25)).toBe(species.adultSignatureAbilityName);
  });

  it('never leaks a raw f3.* id for the unauthored milestones', () => {
    for (const milestone of [8, 16, 34]) {
      const name = abilityDisplayName(species, milestone);
      expect(name).not.toContain('f3.');
      expect(name).toContain(`L${milestone}`);
    }
  });
});
