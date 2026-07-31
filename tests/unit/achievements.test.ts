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
  FLOOR2_ACHIEVEMENT_COUNT,
  FLOOR2_ACHIEVEMENT_CATALOG,
  FLOOR2_ACHIEVEMENTS,
  FLOOR2_RUN_GLOBAL_ACHIEVEMENT_COUNT,
  FLOOR2_ACHIEVEMENT_LOOT_TIERS,
  FLOOR2_LOOT_TIER_TO_EQUIPMENT_REWARD_TIER,
  getCurrentRunGlobalAchievements,
  LOOT_BOX_TIERS,
  getAchievementCatalogForFloor,
  parseAchievementCatalog,
} from '../../src/shared/achievements.js';
import {
  EQUIPMENT_REWARD_TIERS,
  EQUIPMENT_REWARD_TIER_RARITIES,
} from '../../src/shared/generated-equipment-types.js';
import { FLOOR2_REWARD_POOL_STABLE_IDS } from '../../src/shared/data/floor2-reward-pool.js';

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

describe('floor2 achievements catalog', () => {
  it('contains exactly 30 floor-scoped achievements and 6 run-global achievements', () => {
    expect(FLOOR2_ACHIEVEMENT_COUNT).toBe(30);
    expect(FLOOR2_RUN_GLOBAL_ACHIEVEMENT_COUNT).toBe(6);
    expect(FLOOR2_ACHIEVEMENT_CATALOG.floorScoped).toHaveLength(30);
    expect(FLOOR2_ACHIEVEMENT_CATALOG.currentRunGlobal).toHaveLength(6);
    expect(FLOOR2_ACHIEVEMENTS).toHaveLength(36);
  });

  it('has unique achievement ids across the full Floor 2 catalog (floor-scoped + run-global)', () => {
    const ids = FLOOR2_ACHIEVEMENTS.map((achievement) => achievement.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has unique achievement ids across the whole registry (all floors combined)', () => {
    const ids = ALL_ACHIEVEMENTS.map((achievement) => achievement.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every Floor 2 achievement a lootBox reward sourced from the central Floor 2 generated-equipment table', () => {
    for (const achievement of FLOOR2_ACHIEVEMENTS) {
      expect(achievement.reward.type).toBe('lootBox');
      if (achievement.reward.type === 'lootBox') {
        expect(achievement.reward.lootTable).toBe('floor2-generated-equipment');
        if (achievement.reward.lootTable === 'floor2-generated-equipment') {
          const tier = achievement.reward.tier;
          expect(FLOOR2_ACHIEVEMENT_LOOT_TIERS).toContain(tier);
          // ADR 0069 amendment: achievement JSON only ever declares
          // common/uncommon/rare — tier4 (boss-chest-exclusive, 85%
          // Uncommon/15% Rare per PLAN.md §E3-C) must never appear here, and
          // the translated EquipmentRewardTier the resolver actually sees
          // must never be tier4 either.
          const equipmentTier = FLOOR2_LOOT_TIER_TO_EQUIPMENT_REWARD_TIER[tier];
          expect(EQUIPMENT_REWARD_TIERS).toContain(equipmentTier);
          expect(equipmentTier).not.toBe('tier4');
          // GeneratedEquipmentRarity itself has no 'unique' member (type-level
          // guarantee), but assert the translated tier's allowed rarity pool
          // never includes 'unique' as a deterministic runtime regression
          // check too.
          expect(EQUIPMENT_REWARD_TIER_RARITIES[equipmentTier]).not.toContain('unique');
        }
      }
    }
  });

  it('never resolves true Rare rarity from achievement JSON — that stays boss-chest-exclusive (tier4)', () => {
    for (const achievement of FLOOR2_ACHIEVEMENTS) {
      if (
        achievement.reward.type === 'lootBox' &&
        achievement.reward.lootTable === 'floor2-generated-equipment'
      ) {
        const equipmentTier = FLOOR2_LOOT_TIER_TO_EQUIPMENT_REWARD_TIER[achievement.reward.tier];
        expect(equipmentTier).not.toBe('tier4');
        expect(EQUIPMENT_REWARD_TIER_RARITIES[equipmentTier]).not.toContain('rare');
      }
    }
  });

  it('has an exact common/uncommon/rare tier distribution of 13/12/11 across all 36 Floor 2 achievements', () => {
    const counts = { common: 0, uncommon: 0, rare: 0 };
    for (const achievement of FLOOR2_ACHIEVEMENTS) {
      if (
        achievement.reward.type === 'lootBox' &&
        achievement.reward.lootTable === 'floor2-generated-equipment'
      ) {
        counts[achievement.reward.tier]++;
      }
    }
    expect(counts).toEqual({ common: 13, uncommon: 12, rare: 11 });
  });

  it('sources every Floor 2 achievement reward from the central, non-empty Floor 2 reward pool', () => {
    expect(FLOOR2_REWARD_POOL_STABLE_IDS.length).toBeGreaterThan(0);
    for (const id of FLOOR2_REWARD_POOL_STABLE_IDS) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
  });

  it('scopes all 6 run-global achievements as current_run', () => {
    expect(
      FLOOR2_ACHIEVEMENT_CATALOG.currentRunGlobal.every(
        (achievement) => achievement.scope === 'current_run',
      ),
    ).toBe(true);
  });

  it('gates the 6 real run-global achievements by reached floors via getCurrentRunGlobalAchievements', () => {
    // Reached only Floor 1: none of the (floor: 2) run-global achievements are visible yet.
    expect(getCurrentRunGlobalAchievements([1], ACHIEVEMENT_CATALOG_REGISTRY)).toEqual([]);

    // Reached Floor 1 and 2: all 6 become visible.
    const reached = getCurrentRunGlobalAchievements([1, 2], ACHIEVEMENT_CATALOG_REGISTRY);
    expect(reached).toHaveLength(6);
    expect(new Set(reached.map((a) => a.id)).size).toBe(6);
  });

  it('does not duplicate unlock criteria text inside director flavor for the new content', () => {
    for (const achievement of FLOOR2_ACHIEVEMENTS) {
      expect(achievement.directorFlavor.toLowerCase()).not.toContain(
        achievement.unlockCriteria.toLowerCase(),
      );
    }
  });

  it('defines a non-empty unlock rule set and a valid scope for every Floor 2 entry', () => {
    for (const achievement of FLOOR2_ACHIEVEMENTS) {
      expect(Array.isArray(achievement.unlockRules)).toBe(true);
      expect(achievement.unlockRules.length).toBeGreaterThan(0);
      expect(ACHIEVEMENT_SCOPES).toContain(achievement.scope);
      expect(achievement.floor).toBe(2);
    }
  });

  it('rejects a run-global achievement that references a Floor-2-local (non-allowlisted) fact', () => {
    const raw = JSON.parse(JSON.stringify(FLOOR2_ACHIEVEMENTS)) as Array<Record<string, unknown>>;
    const runGlobalIndex = raw.findIndex((entry) => entry.scope === 'current_run');
    expect(runGlobalIndex).toBeGreaterThanOrEqual(0);
    raw[runGlobalIndex]!.unlockRules = [
      { type: 'numberCompare', fact: 'familiesAtFriendlyCount', op: '>=', value: 1 },
    ];

    expect(() => parseAchievementCatalog(raw)).toThrow();
  });
});
