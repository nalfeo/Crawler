import { describe, expect, it } from 'vitest';
import {
  FLOOR3_INTRO_ACKNOWLEDGE_ID,
  FLOOR3_INTRO_PICKER_KIND,
  FLOOR3_INTRO_RULES,
  FLOOR3_POACH_PICKER_KIND,
  FLOOR3_STARTER_PICKER_KIND,
  buildFloor3IntroModel,
  buildFloor3PoachPickerModel,
  buildFloor3StarterPickerModel,
} from '../../src/shared/floor3-ux.js';
import {
  formForLevel,
  getPetSpecies,
  loadPetSpecies,
} from '../../src/shared/data/floor3/species.js';

const [FIRST_SPECIES, SECOND_SPECIES, THIRD_SPECIES] = loadPetSpecies().map((s) => s.speciesId) as [
  string,
  string,
  string,
];

describe('floor3 UX surface #1 — welcome + rules briefing', () => {
  it('teaches the four rules the onboarding screen owns', () => {
    const model = buildFloor3IntroModel();
    const body = model.body ?? '';
    expect(model.kind).toBe(FLOOR3_INTRO_PICKER_KIND);
    // Show format, "you don't fight", recruit + lock rules, win condition.
    expect(body).toContain('Companion League');
    expect(body).toContain('never fight');
    expect(body).toContain('poach');
    expect(body).toContain('The lock:');
    expect(body).toContain('Best in Show');
    expect(FLOOR3_INTRO_RULES.length).toBeGreaterThanOrEqual(4);
  });

  it('is a single non-cancellable acknowledgement so the briefing cannot be skipped', () => {
    const model = buildFloor3IntroModel();
    expect(model.allowCancel).toBe(false);
    expect(model.options).toHaveLength(1);
    expect(model.options[0]?.id).toBe(FLOOR3_INTRO_ACKNOWLEDGE_ID);
    expect(model.initialSelectedId).toBe(FLOOR3_INTRO_ACKNOWLEDGE_ID);
  });

  it('is deterministic — the same copy every call', () => {
    expect(buildFloor3IntroModel()).toEqual(buildFloor3IntroModel());
  });
});

describe('floor3 UX surface #2 — starter picker', () => {
  it('shows each candidate as name + affinity, style, and innate ability', () => {
    const model = buildFloor3StarterPickerModel([FIRST_SPECIES, SECOND_SPECIES]);
    const species = getPetSpecies(FIRST_SPECIES)!;
    expect(model.kind).toBe(FLOOR3_STARTER_PICKER_KIND);
    expect(model.options).toHaveLength(2);
    expect(model.options[0]?.id).toBe(FIRST_SPECIES);
    expect(model.options[0]?.label).toBe(formForLevel(species, 1).name);
    expect(model.options[0]?.description).toContain(species.innateAbilityName);
    expect(model.options[0]?.description?.toLowerCase()).toContain(species.affinity);
    expect(model.options[0]?.description?.toLowerCase()).toContain(species.fightingStyle);
  });

  it('preselects the first offer entry and preserves offer order', () => {
    const model = buildFloor3StarterPickerModel([SECOND_SPECIES, FIRST_SPECIES]);
    expect(model.initialSelectedId).toBe(SECOND_SPECIES);
    expect(model.options.map((option) => option.id)).toEqual([SECOND_SPECIES, FIRST_SPECIES]);
  });

  it('degrades to a labelled placeholder row for an unknown species id', () => {
    const model = buildFloor3StarterPickerModel(['not-a-species']);
    expect(model.options[0]).toEqual({
      id: 'not-a-species',
      label: 'Option 1',
      description: 'not-a-species',
    });
  });

  it('omits the preselection on an empty offer instead of selecting nothing-as-something', () => {
    const model = buildFloor3StarterPickerModel([]);
    expect(model.options).toHaveLength(0);
    expect(model.initialSelectedId).toBeUndefined();
  });
});

describe('floor3 UX surface #3 — poach picker', () => {
  it('shows the defeated trainer, the roster, and the remaining recruit slots', () => {
    const model = buildFloor3PoachPickerModel({
      candidates: [
        { speciesId: FIRST_SPECIES, level: 12 },
        { speciesId: SECOND_SPECIES, level: 12 },
        { speciesId: THIRD_SPECIES, level: 12 },
      ],
      slotsRemaining: 4,
      trainerName: 'Studio Ember',
    });
    expect(model.kind).toBe(FLOOR3_POACH_PICKER_KIND);
    expect(model.subtitle).toContain('Studio Ember');
    expect(model.options).toHaveLength(3);
    expect(model.body).toContain('4 recruit slots remaining');
    expect(model.body).not.toContain('signs your roster');
  });

  it('shows the roster level on the offered Companions', () => {
    const model = buildFloor3PoachPickerModel({
      candidates: [{ speciesId: FIRST_SPECIES, level: 12 }],
      slotsRemaining: 3,
    });
    const species = getPetSpecies(FIRST_SPECIES)!;
    expect(model.options[0]?.label).toBe(formForLevel(species, 12).name);
    expect(model.options[0]?.description).toContain('Lv 12');
  });

  it("renders each candidate at its own level, not the first candidate's", () => {
    const model = buildFloor3PoachPickerModel({
      candidates: [
        { speciesId: FIRST_SPECIES, level: 12 },
        { speciesId: SECOND_SPECIES, level: 3 },
      ],
      slotsRemaining: 4,
    });
    const first = getPetSpecies(FIRST_SPECIES)!;
    const second = getPetSpecies(SECOND_SPECIES)!;
    expect(model.options[0]?.label).toBe(formForLevel(first, 12).name);
    expect(model.options[0]?.description).toContain('Lv 12');
    expect(model.options[1]?.label).toBe(formForLevel(second, 3).name);
    expect(model.options[1]?.description).toContain('Lv 3');
  });

  it('warns that the final recruit signs the roster for the season (§6.3 party lock)', () => {
    const model = buildFloor3PoachPickerModel({
      candidates: [{ speciesId: FIRST_SPECIES, level: 1 }],
      slotsRemaining: 1,
    });
    expect(model.body).toContain('final recruit slot');
    expect(model.body).toContain('signs your roster for the season');
  });

  it('falls back to a generic trainer subtitle when no name is known', () => {
    const model = buildFloor3PoachPickerModel({
      candidates: [{ speciesId: FIRST_SPECIES, level: 1 }],
      slotsRemaining: 2,
    });
    expect(model.subtitle).toContain('Trainer beaten');
  });
});
