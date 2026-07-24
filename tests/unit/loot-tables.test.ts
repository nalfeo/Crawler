import { describe, expect, it } from 'vitest';
import { LOOT_TABLES, getEnemyDropConfig, getLootTable } from '../../src/shared/loot-tables.js';
import { isEquippableItem } from '../../src/shared/equipmentDefs.js';

describe('getEnemyDropConfig', () => {
  it('returns the configured no-drop override for baby slimes', () => {
    expect(getEnemyDropConfig('slime-mini')).toEqual({ dropsEnabled: false });
  });

  it('returns undefined for unknown archetypes', () => {
    expect(getEnemyDropConfig('slime')).toBeUndefined();
  });

  it('returns undefined when no archetype is provided', () => {
    expect(getEnemyDropConfig(undefined)).toBeUndefined();
  });
});

describe('getLootTable', () => {
  it('returns the table when the id matches', () => {
    const table = getLootTable('basic_melee');
    expect(table).toBeDefined();
    expect(table!.id).toBe('basic_melee');
    expect(table!.entries.length).toBeGreaterThan(0);
  });

  it('returns undefined for an unknown id', () => {
    expect(getLootTable('nonexistent_table')).toBeUndefined();
  });

  it('returns another known table by id', () => {
    const table = getLootTable('basic_ranged');
    expect(table).toBeDefined();
    expect(table!.id).toBe('basic_ranged');
  });
});

describe('Floor 1 boss loot tables exclude equipment (ADR 0070 hard gate)', () => {
  // Floor 1 must never drop equipment directly through boss loot — Floor 2's
  // boss-chest reward policy is the second (deterministic) equipment source,
  // and the first is the achievement reward-bundle system. Any 'item' entry
  // in the Floor-1-only boss tables that resolves to an equippable item would
  // silently violate that boundary, so assert it structurally against the
  // live equipment registry rather than relying on code review to catch it.
  it.each(['BOSS_MINOR', 'BOSS'] as const)(
    'LOOT_TABLES.%s contains no equippable item entries',
    (tableKey) => {
      const table = LOOT_TABLES[tableKey];
      const itemEntries = table.entries.filter((entry) => entry.type === 'item');
      expect(itemEntries.length).toBeGreaterThan(0);
      for (const entry of itemEntries) {
        expect(isEquippableItem(entry.itemId!)).toBe(false);
      }
    },
  );
});
