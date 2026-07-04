import { describe, expect, it } from 'vitest';
import { getEnemyDropConfig, getLootTable } from '../../src/shared/loot-tables.js';

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
