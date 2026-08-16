import { describe, expect, it } from 'vitest';
import { AFFINITY_RING } from '../../src/shared/data/floor3/affinity.js';
import {
  FIGHTING_STYLES,
  STAT_BAND_SCALE,
  STYLE_PERSONAS,
  isFightingStyle,
  stylePersona,
} from '../../src/shared/data/floor3/styles.js';
import {
  ABILITY_MILESTONE_LEVELS,
  FORM_MIN_LEVELS,
  _resetPetSpeciesCache,
  formForLevel,
  getPetSpecies,
  learnedAbilityIds,
  loadPetSpecies,
  petSpeciesByAffinity,
  petSpeciesByStyle,
} from '../../src/shared/data/floor3/species.js';

describe('Floor 3 style personas', () => {
  it('defines a persona for all seven styles', () => {
    expect(FIGHTING_STYLES).toHaveLength(7);
    for (const style of FIGHTING_STYLES) {
      const persona = stylePersona(style);
      expect(persona.cadence).toBeGreaterThan(0);
      expect(STAT_BAND_SCALE[persona.hpProfile]).toBeGreaterThan(0);
      expect(STAT_BAND_SCALE[persona.dmgProfile]).toBeGreaterThan(0);
      expect(STAT_BAND_SCALE[persona.speedProfile]).toBeGreaterThan(0);
    }
  });

  it('maps styles onto the bounded persona set with only two net-new personas', () => {
    expect(STYLE_PERSONAS.charger.aiType).toBe('CHASE');
    expect(STYLE_PERSONAS.bruiser.aiType).toBe('CHASE');
    expect(STYLE_PERSONAS.slinger.aiType).toBe('RANGED');
    expect(STYLE_PERSONAS.burster.aiType).toBe('RANGED');
    expect(STYLE_PERSONAS.pouncer.aiType).toBe('LEAPER');
    expect(STYLE_PERSONAS.warden.aiType).toBe('GUARDIAN');
    expect(STYLE_PERSONAS.kindler.aiType).toBe('SUPPORT');
    const netNew = FIGHTING_STYLES.map((s) => STYLE_PERSONAS[s].aiType).filter(
      (aiType) => aiType === 'GUARDIAN' || aiType === 'SUPPORT',
    );
    expect(netNew).toHaveLength(2);
  });

  it('gives only the AoE style an area payload', () => {
    for (const style of FIGHTING_STYLES) {
      expect(STYLE_PERSONAS[style].aoeShape).toBe(style === 'burster' ? 'circle' : undefined);
    }
  });

  it('guards unknown style strings', () => {
    expect(isFightingStyle('warden')).toBe(true);
    expect(isFightingStyle('healer')).toBe(false);
  });
});

describe('Floor 3 species roster', () => {
  it('loads 52 species (49 grid + 3 signature) and caches the result', () => {
    _resetPetSpeciesCache();
    const roster = loadPetSpecies();
    expect(roster).toHaveLength(52);
    expect(roster.filter((s) => s.signature === true)).toHaveLength(3);
    expect(loadPetSpecies()).toBe(roster);
  });

  it('covers every affinity x style grid cell exactly once', () => {
    const grid = loadPetSpecies().filter((s) => s.signature !== true);
    expect(grid).toHaveLength(49);
    for (const affinity of AFFINITY_RING) {
      for (const style of FIGHTING_STYLES) {
        const cell = grid.filter((s) => s.affinity === affinity && s.fightingStyle === style);
        expect(cell).toHaveLength(1);
      }
    }
    for (const affinity of AFFINITY_RING) {
      expect(petSpeciesByAffinity(affinity).length).toBeGreaterThanOrEqual(7);
    }
    for (const style of FIGHTING_STYLES) {
      expect(petSpeciesByStyle(style).length).toBeGreaterThanOrEqual(7);
    }
  });

  it('gives every species three ordered forms with unique names', () => {
    const names = new Set<string>();
    for (const species of loadPetSpecies()) {
      expect(species.forms).toHaveLength(3);
      species.forms.forEach((form, index) => {
        expect(form.form).toBe(index);
        expect(form.minLevel).toBe(FORM_MIN_LEVELS[index]);
        names.add(form.name);
      });
    }
    expect(names.size).toBe(52 * 3);
  });

  it('gives every species a unique ability id at every milestone level', () => {
    const abilityIds = new Set<string>();
    for (const species of loadPetSpecies()) {
      for (const level of ABILITY_MILESTONE_LEVELS) {
        const id = species.abilityIdsByLevel[String(level) as '1' | '8' | '16' | '25' | '34'];
        expect(id).toBeTruthy();
        abilityIds.add(id);
      }
    }
    expect(abilityIds.size).toBe(52 * ABILITY_MILESTONE_LEVELS.length);
  });

  it('resolves the form for a level at the evolution milestones', () => {
    const species = getPetSpecies('ember-charger');
    expect(species).toBeDefined();
    expect(formForLevel(species!, 1).form).toBe(0);
    expect(formForLevel(species!, 9).form).toBe(0);
    expect(formForLevel(species!, 10).form).toBe(1);
    expect(formForLevel(species!, 24).form).toBe(1);
    expect(formForLevel(species!, 25).form).toBe(2);
    expect(formForLevel(species!, 40).form).toBe(2);
  });

  it('unlocks abilities at L1/8/16/25/34', () => {
    const species = getPetSpecies('tide-kindler');
    expect(species).toBeDefined();
    expect(learnedAbilityIds(species!, 1)).toHaveLength(1);
    expect(learnedAbilityIds(species!, 7)).toHaveLength(1);
    expect(learnedAbilityIds(species!, 8)).toHaveLength(2);
    expect(learnedAbilityIds(species!, 16)).toHaveLength(3);
    expect(learnedAbilityIds(species!, 25)).toHaveLength(4);
    expect(learnedAbilityIds(species!, 34)).toHaveLength(5);
    expect(learnedAbilityIds(species!, 40)).toHaveLength(5);
  });

  it('returns undefined for an unknown species id', () => {
    expect(getPetSpecies('nope')).toBeUndefined();
  });
});
