import { describe, expect, it } from 'vitest';
import {
  ALL_ACHIEVEMENTS,
  ACHIEVEMENT_CATALOG_REGISTRY,
  ACHIEVEMENT_ART_BACKLOG,
  ACHIEVEMENT_SCOPES,
  createAchievementCatalog,
  createAchievementCatalogRegistry,
  FLOOR1_ACHIEVEMENT_COUNT,
  FLOOR1_ACHIEVEMENTS,
  FLOOR2_ACHIEVEMENTS,
  getCurrentRunGlobalAchievements,
  LOOT_BOX_TIERS,
  getAchievementCatalogForFloor,
  parseAchievementCatalog,
} from '../../src/shared/achievements.js';

function rawAchievement(
  overrides: Partial<(typeof FLOOR1_ACHIEVEMENTS)[number]> = {},
): Record<string, unknown> {
  return {
    ...FLOOR1_ACHIEVEMENTS[0],
    id: 'test-achievement',
    floor: 2,
    scope: 'floor',
    unlockRules: [],
    ...overrides,
  };
}

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
      expect(ACHIEVEMENT_SCOPES).toContain(achievement.scope);
    }
  });

  it('normalizes legacy Floor 1 entries to explicit floor scope without changing order', () => {
    expect(FLOOR1_ACHIEVEMENTS.every((achievement) => achievement.scope === 'floor')).toBe(true);
    expect(FLOOR1_ACHIEVEMENTS.slice(0, 3).map((achievement) => achievement.id)).toEqual([
      'first-bonk',
      'slime-no-more',
      'rat-retired',
    ]);
  });

  it('looks up deterministic floor catalogs and gates current-run definitions by reached floor', () => {
    expect(getAchievementCatalogForFloor(1)?.all).toBe(FLOOR1_ACHIEVEMENTS);
    expect(getAchievementCatalogForFloor(2)?.all).toEqual(FLOOR2_ACHIEVEMENTS);

    const floor2Catalog = createAchievementCatalog(2, [
      rawAchievement({
        id: 'floor2-local',
      }),
      rawAchievement({
        id: 'run-global-b',
        scope: 'current_run',
      }),
      rawAchievement({
        id: 'run-global-a',
        scope: 'current_run',
      }),
    ]);
    const registry = createAchievementCatalogRegistry([floor2Catalog]);

    expect(getCurrentRunGlobalAchievements([1], registry)).toEqual([]);
    expect(getCurrentRunGlobalAchievements([1, 2], registry).map((entry) => entry.id)).toEqual([
      'run-global-b',
      'run-global-a',
    ]);
  });

  it('rejects cross-floor ownership and duplicate ids', () => {
    expect(() => createAchievementCatalog(2, [rawAchievement({ floor: 1 })])).toThrow(
      /belongs to floor 1/,
    );
    expect(() =>
      createAchievementCatalog(2, [
        rawAchievement({ id: 'duplicate' }),
        rawAchievement({ id: 'duplicate' }),
      ]),
    ).toThrow(/Duplicate achievement id/);
    expect(() =>
      createAchievementCatalogRegistry([
        createAchievementCatalog(1, []),
        createAchievementCatalog(1, []),
      ]),
    ).toThrow(/Duplicate achievement catalog/);
    expect(() =>
      createAchievementCatalog(2, [rawAchievement({ id: 'boss-chest:goblin-clan' })]),
    ).toThrow(/collides with the reserved boss-chest reward-bundle prefix/);
    expect(() =>
      parseAchievementCatalog([rawAchievement({ id: 'boss-chest:goblin-clan' })]),
    ).toThrow(/collides with the reserved boss-chest reward-bundle prefix/);
    expect(ACHIEVEMENT_CATALOG_REGISTRY.byId.size).toBe(
      FLOOR1_ACHIEVEMENT_COUNT + FLOOR2_ACHIEVEMENTS.length,
    );
    expect(ALL_ACHIEVEMENTS).toEqual(
      ACHIEVEMENT_CATALOG_REGISTRY.catalogs.flatMap((catalog) => catalog.all),
    );
  });

  it('keeps floor-aware catalog lookup isolated by floor', () => {
    expect(getAchievementCatalogForFloor(1)?.all).toBe(FLOOR1_ACHIEVEMENTS);
    expect(getAchievementCatalogForFloor(2)?.all).toEqual(FLOOR2_ACHIEVEMENTS);
  });

  it('defaults missing scope to floor for backward compatibility', () => {
    const raw = JSON.parse(JSON.stringify(FLOOR1_ACHIEVEMENTS)) as Array<Record<string, unknown>>;
    delete raw[0]!.scope;
    const parsed = parseAchievementCatalog(raw);
    expect(parsed[0]?.scope).toBe('floor');
  });

  it('rejects floor-scoped facts in current_run-scoped rules', () => {
    const raw = JSON.parse(JSON.stringify(FLOOR1_ACHIEVEMENTS)) as Array<Record<string, unknown>>;
    raw[0]!.scope = 'current_run';
    raw[0]!.unlockRules = [{ type: 'booleanIs', fact: 'staircaseDiscovered', value: true }];
    expect(() => parseAchievementCatalog(raw)).toThrow();
  });

  it('accepts clearedFloorCount in current_run-scoped rules', () => {
    const raw = JSON.parse(JSON.stringify(FLOOR1_ACHIEVEMENTS)) as Array<Record<string, unknown>>;
    raw[0]!.scope = 'current_run';
    raw[0]!.unlockRules = [
      { type: 'numberCompare', fact: 'clearedFloorCount', op: '>=', value: 2 },
    ];

    const parsed = parseAchievementCatalog(raw);

    expect(parsed[0]?.unlockRules).toEqual([
      { type: 'numberCompare', fact: 'clearedFloorCount', op: '>=', value: 2 },
    ]);
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
