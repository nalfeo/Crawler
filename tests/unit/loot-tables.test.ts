import { describe, expect, it } from 'vitest';
import { getEnemyDropConfig } from '../../src/shared/loot-tables.js';

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
