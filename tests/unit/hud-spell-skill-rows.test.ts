import { describe, expect, it } from 'vitest';
import {
  countMatchingSpellSkills,
  selectSpellSkillRows,
} from '../../src/engine/hud-spell-skill-rows.js';
import { SPELL_SKILL_ID_BY_SPELL_ID } from '../../src/shared/spell-skills.js';

describe('selectSpellSkillRows', () => {
  it('returns an empty array when no abilities are equipped', () => {
    expect(selectSpellSkillRows([], 2)).toEqual([]);
  });

  it('returns an empty array when maxRows is zero or negative', () => {
    expect(selectSpellSkillRows(['fireball', 'heal'], 0)).toEqual([]);
    expect(selectSpellSkillRows(['fireball', 'heal'], -1)).toEqual([]);
  });

  it('skips equipped abilities that have no matching spell skill', () => {
    expect(selectSpellSkillRows(['some-passive-ability'], 2)).toEqual([]);
  });

  it('maps equipped spells to their spell skill id, preserving equip order', () => {
    expect(selectSpellSkillRows(['fireball', 'heal'], 2)).toEqual([
      { spellId: 'fireball', skillId: SPELL_SKILL_ID_BY_SPELL_ID.fireball },
      { spellId: 'heal', skillId: SPELL_SKILL_ID_BY_SPELL_ID.heal },
    ]);
  });

  it('interleaves non-spell abilities without breaking order or count', () => {
    expect(selectSpellSkillRows(['some-passive-ability', 'fireball', 'haste'], 2)).toEqual([
      { spellId: 'fireball', skillId: SPELL_SKILL_ID_BY_SPELL_ID.fireball },
      { spellId: 'haste', skillId: SPELL_SKILL_ID_BY_SPELL_ID.haste },
    ]);
  });

  it('caps the result at maxRows even when more equipped spells exist', () => {
    const equipped = ['fireball', 'heal', 'haste', 'bless'];
    expect(selectSpellSkillRows(equipped, 2)).toEqual([
      { spellId: 'fireball', skillId: SPELL_SKILL_ID_BY_SPELL_ID.fireball },
      { spellId: 'heal', skillId: SPELL_SKILL_ID_BY_SPELL_ID.heal },
    ]);
  });
});

describe('countMatchingSpellSkills', () => {
  it('returns 0 for no equipped abilities', () => {
    expect(countMatchingSpellSkills([])).toBe(0);
  });

  it('counts only abilities that map to a spell skill', () => {
    expect(countMatchingSpellSkills(['some-passive-ability', 'fireball', 'haste'])).toBe(2);
  });

  it('counts every matching spell, uncapped (unlike selectSpellSkillRows)', () => {
    const equipped = ['fireball', 'heal', 'haste', 'bless'];
    expect(countMatchingSpellSkills(equipped)).toBe(4);
    expect(selectSpellSkillRows(equipped, 2)).toHaveLength(2);
  });
});
