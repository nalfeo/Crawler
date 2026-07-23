import { describe, expect, it } from 'vitest';
import {
  isWeaponClassSkillId,
  isWeaponTypeSkillId,
  WEAPON_CLASS_SKILL_IDS,
  WEAPON_TYPE_SKILL_IDS,
  CLASS_SKILL_THRESHOLDS,
  TYPE_SKILL_THRESHOLDS,
  weaponSkillPrerequisiteMatches,
} from '../../src/shared/weapon-skills.js';

describe('isWeaponClassSkillId', () => {
  it('returns true for every canonical class skill id', () => {
    for (const id of WEAPON_CLASS_SKILL_IDS) {
      expect(isWeaponClassSkillId(id)).toBe(true);
    }
  });

  it('returns false for a type skill id', () => {
    expect(isWeaponClassSkillId('sword')).toBe(false);
    expect(isWeaponClassSkillId('bow')).toBe(false);
  });

  it('returns false for arbitrary strings', () => {
    expect(isWeaponClassSkillId('')).toBe(false);
    expect(isWeaponClassSkillId('unknown')).toBe(false);
  });
});

describe('isWeaponTypeSkillId', () => {
  it('returns true for every canonical type skill id', () => {
    for (const id of WEAPON_TYPE_SKILL_IDS) {
      expect(isWeaponTypeSkillId(id)).toBe(true);
    }
  });

  it('returns false for a class skill id', () => {
    expect(isWeaponTypeSkillId('slashing')).toBe(false);
    expect(isWeaponTypeSkillId('arcane')).toBe(false);
  });

  it('returns false for arbitrary strings', () => {
    expect(isWeaponTypeSkillId('')).toBe(false);
    expect(isWeaponTypeSkillId('unknown')).toBe(false);
  });
});

describe('CLASS_SKILL_THRESHOLDS', () => {
  it('has exactly 20 entries (SKILL_HARD_CAP)', () => {
    expect(CLASS_SKILL_THRESHOLDS.length).toBe(20);
  });

  it('is strictly ascending', () => {
    for (let i = 1; i < CLASS_SKILL_THRESHOLDS.length; i++) {
      expect(CLASS_SKILL_THRESHOLDS[i]).toBeGreaterThan(CLASS_SKILL_THRESHOLDS[i - 1]!);
    }
  });
});

describe('TYPE_SKILL_THRESHOLDS', () => {
  it('has exactly 20 entries (SKILL_HARD_CAP)', () => {
    expect(TYPE_SKILL_THRESHOLDS.length).toBe(20);
  });

  it('is strictly ascending', () => {
    for (let i = 1; i < TYPE_SKILL_THRESHOLDS.length; i++) {
      expect(TYPE_SKILL_THRESHOLDS[i]).toBeGreaterThan(TYPE_SKILL_THRESHOLDS[i - 1]!);
    }
  });

  it('type thresholds are lower than class thresholds (faster leveling)', () => {
    // First threshold for types is lower than for classes
    expect(TYPE_SKILL_THRESHOLDS[0]).toBeLessThan(CLASS_SKILL_THRESHOLDS[0]!);
  });
});

describe('weaponSkillPrerequisiteMatches', () => {
  it('matches either the weapon class or weapon type prerequisite', () => {
    expect(weaponSkillPrerequisiteMatches('ranged', 'ranged', 'pistol')).toBe(true);
    expect(weaponSkillPrerequisiteMatches('pistol', 'ranged', 'pistol')).toBe(true);
  });

  it('rejects a prerequisite absent from both weapon skill identities', () => {
    expect(weaponSkillPrerequisiteMatches('spellcraft', 'ranged', 'pistol')).toBe(false);
  });
});
