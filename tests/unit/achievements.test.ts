import { describe, expect, it } from 'vitest';
import {
  ACHIEVEMENT_ART_BACKLOG,
  FLOOR1_ACHIEVEMENT_COUNT,
  FLOOR1_ACHIEVEMENTS,
  LOOT_BOX_TIERS,
  parseAchievementCatalog,
} from '../../src/shared/achievements.js';

describe('floor1 achievements catalog', () => {
  it('contains exactly 103 achievements', () => {
    expect(FLOOR1_ACHIEVEMENT_COUNT).toBe(103);
    expect(FLOOR1_ACHIEVEMENTS).toHaveLength(103);
  });

  it('has unique achievement ids', () => {
    const ids = FLOOR1_ACHIEVEMENTS.map((achievement) => achievement.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses progressively longer Director flavor text for higher difficulty bands', () => {
    const basic = FLOOR1_ACHIEVEMENTS.filter((achievement) => achievement.difficulty === 'basic');
    const standard = FLOOR1_ACHIEVEMENTS.filter(
      (achievement) => achievement.difficulty === 'standard',
    );
    const hard = FLOOR1_ACHIEVEMENTS.filter((achievement) => achievement.difficulty === 'hard');
    const brutal = FLOOR1_ACHIEVEMENTS.filter((achievement) => achievement.difficulty === 'brutal');

    const avg = (items: typeof FLOOR1_ACHIEVEMENTS) =>
      items.reduce((sum, achievement) => sum + achievement.directorFlavor.length, 0) / items.length;

    expect(avg(standard)).toBeGreaterThan(avg(basic));
    expect(avg(hard)).toBeGreaterThan(avg(standard));
    expect(avg(brutal)).toBeGreaterThan(avg(hard));
  });

  it('does not duplicate unlock criteria text inside director flavor', () => {
    for (const achievement of FLOOR1_ACHIEVEMENTS) {
      expect(achievement.directorFlavor.toLowerCase()).not.toContain(
        achievement.unlockCriteria.toLowerCase(),
      );
    }
  });

  it('defines unlock rules for each achievement entry', () => {
    for (const achievement of FLOOR1_ACHIEVEMENTS) {
      expect(Array.isArray(achievement.unlockRules)).toBe(true);
    }
  });

  it('tracks placeholder art backlog for all icon packs and loot-box tiers', () => {
    const iconEntries = ACHIEVEMENT_ART_BACKLOG.filter((entry) => entry.kind === 'icon');
    const lootEntries = ACHIEVEMENT_ART_BACKLOG.filter((entry) => entry.kind === 'lootBox');

    expect(iconEntries.length).toBeGreaterThanOrEqual(6);
    expect(lootEntries.map((entry) => entry.id).sort()).toEqual(
      LOOT_BOX_TIERS.map((tier) => `lootBox:${tier}`).sort(),
    );
  });

  it('rejects unknown unlock rule types during catalog validation', () => {
    const raw = JSON.parse(JSON.stringify(FLOOR1_ACHIEVEMENTS)) as Array<Record<string, unknown>>;
    raw[0]!.unlockRules = [
      {
        type: 'script',
      },
    ];

    expect(() => parseAchievementCatalog(raw)).toThrow();
  });

  it('rejects entries without unlockRules during catalog validation', () => {
    const raw = JSON.parse(JSON.stringify(FLOOR1_ACHIEVEMENTS)) as Array<Record<string, unknown>>;
    delete raw[0]!.unlockRules;

    expect(() => parseAchievementCatalog(raw)).toThrow();
  });
});
