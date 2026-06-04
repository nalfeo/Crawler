import { describe, it, expect } from 'vitest';
import { getAllSkillDefinitions, getSkillDefinition } from '../../src/game/skills/registry.js';
import { SKILL_HARD_CAP } from '../../src/game/skills/types.js';

describe('skill registry', () => {
  it('returns undefined for unknown skill id', () => {
    expect(getSkillDefinition('nonexistent')).toBeUndefined();
  });

  it('returns skill definition by id', () => {
    const def = getSkillDefinition('swordsmanship');
    expect(def).toBeDefined();
    expect(def!.id).toBe('swordsmanship');
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
});
