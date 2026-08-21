import { describe, it, expect } from 'vitest';
import {
  getAllSkillDefinitions,
  getSkillDefinition,
  parseSkillCatalog,
} from '../../src/game/skills/registry.js';
import { SKILL_HARD_CAP } from '../../src/game/skills/types.js';
import {
  SPELL_SKILL_ID_BY_SPELL_ID,
  SPELL_SKILL_THRESHOLDS,
} from '../../src/shared/spell-skills.js';

describe('skill registry', () => {
  it('returns undefined for unknown skill id', () => {
    expect(getSkillDefinition('nonexistent')).toBeUndefined();
  });

  it('returns skill definition by id', () => {
    const def = getSkillDefinition('slashing');
    expect(def).toBeDefined();
    expect(def!.id).toBe('slashing');
  });

  it('all skills have usageThresholds of length SKILL_HARD_CAP', () => {
    for (const skill of getAllSkillDefinitions()) {
      expect(skill.usageThresholds).toHaveLength(SKILL_HARD_CAP);
    }
  });

  it('all skills have strictly increasing usageThresholds', () => {
    for (const skill of getAllSkillDefinitions()) {
      for (let i = 1; i < skill.usageThresholds.length; i++) {
        expect(skill.usageThresholds[i]).toBeGreaterThan(skill.usageThresholds[i - 1]!);
      }
    }
  });

  it('all milestones are at levels 5, 10, 15, or 20', () => {
    for (const skill of getAllSkillDefinitions()) {
      for (const m of skill.milestones) {
        expect([5, 10, 15, 20]).toContain(m.level);
      }
    }
  });

  it('each skill has exactly 4 milestones', () => {
    for (const skill of getAllSkillDefinitions()) {
      expect(skill.milestones).toHaveLength(4);
    }
  });

  it('skill categories are valid enum values', () => {
    const validCategories = new Set(['combat', 'defense', 'utility']);
    for (const skill of getAllSkillDefinitions()) {
      expect(validCategories.has(skill.category)).toBe(true);
    }
  });

  it('covers all three categories (combat, defense, utility)', () => {
    const categories = new Set(getAllSkillDefinitions().map((s) => s.category));
    expect(categories.has('combat')).toBe(true);
    expect(categories.has('defense')).toBe(true);
    expect(categories.has('utility')).toBe(true);
  });

  it('all usageThresholds are positive integers', () => {
    for (const skill of getAllSkillDefinitions()) {
      for (const threshold of skill.usageThresholds) {
        expect(threshold).toBeGreaterThan(0);
        expect(Number.isInteger(threshold)).toBe(true);
      }
    }
  });

  it('rejects duplicate skill IDs', () => {
    const base = getAllSkillDefinitions()[0]!;
    expect(() =>
      parseSkillCatalog([
        base,
        {
          ...base,
          name: 'Duplicate Name',
        },
      ]),
    ).toThrow(/duplicate/i);
  });

  it('rejects usageThresholds with the wrong number of entries', () => {
    const base = getAllSkillDefinitions()[0]!;
    expect(() =>
      parseSkillCatalog([
        {
          ...base,
          usageThresholds: base.usageThresholds.slice(0, -1),
        },
      ]),
    ).toThrow(/usageThresholds must have exactly/i);
  });

  it('rejects usageThresholds that are not strictly increasing', () => {
    const base = getAllSkillDefinitions()[0]!;
    const broken = [...base.usageThresholds];
    broken[1] = broken[0]!; // equal -> not strictly increasing
    expect(() =>
      parseSkillCatalog([
        {
          ...base,
          usageThresholds: broken,
        },
      ]),
    ).toThrow(/strictly increasing/i);
  });

  it('rejects milestones that do not cover levels 5, 10, 15, 20 exactly', () => {
    const base = getAllSkillDefinitions()[0]!;
    const milestones = base.milestones.map((m) => ({ ...m }));
    // Duplicate level 5, dropping the level-20 milestone.
    milestones[milestones.length - 1] = {
      ...milestones[0]!,
      name: 'Dup',
      description: 'Dup level.',
    };
    expect(() =>
      parseSkillCatalog([
        {
          ...base,
          milestones,
        },
      ]),
    ).toThrow(/milestones must contain levels/i);
  });

  it('every spell skill uses the shared SPELL_SKILL_THRESHOLDS curve (HudSkillTracker invariant)', () => {
    // HudSkillTracker (engine layer) computes spell-skill progress against
    // SPELL_SKILL_THRESHOLDS directly, since it cannot import this game-layer
    // registry. If a future spell skill ever needs a divergent curve, this
    // test must be updated alongside the HUD to avoid silently wrong progress
    // bars.
    for (const spellId of Object.keys(SPELL_SKILL_ID_BY_SPELL_ID)) {
      const skillId =
        SPELL_SKILL_ID_BY_SPELL_ID[spellId as keyof typeof SPELL_SKILL_ID_BY_SPELL_ID];
      const def = getSkillDefinition(skillId);
      expect(def).toBeDefined();
      expect(def!.usageThresholds).toEqual(SPELL_SKILL_THRESHOLDS);
    }
  });
});
