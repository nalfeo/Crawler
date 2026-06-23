import { describe, expect, it } from 'vitest';
import {
  STAT_DISPLAY,
  PRIMARY_STAT_DISPLAY,
  formatStatIncrement,
  formatStatValue,
  formatCoreStatGains,
} from '../../src/shared/stat-display.js';
import { STAT_KEYS, STAT_POINT_INCREMENT, PRIMARY_STATS } from '../../src/shared/stats.js';

describe('stat display metadata', () => {
  it('provides display info for every gameplay stat key', () => {
    for (const stat of STAT_KEYS) {
      const info = STAT_DISPLAY[stat];
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(0);
      expect(info.decimals).toBeGreaterThanOrEqual(0);
    }
  });

  it('formats values using the configured precision', () => {
    expect(formatStatValue('maxHp', 120)).toBe('120');
    expect(formatStatValue('moveSpeed', 3)).toBe('3.0');
    expect(formatStatValue('attackSpeed', 1)).toBe('1.00');
  });

  it('formats per-point increments with a leading plus', () => {
    expect(formatStatIncrement('maxHp')).toBe(`+${STAT_POINT_INCREMENT.maxHp.toFixed(0)}`);
    expect(formatStatIncrement('moveSpeed')).toBe('+0.1');
    expect(formatStatIncrement('attackSpeed')).toBe('+0.05');
  });
});

describe('primary stat display metadata', () => {
  it('provides display info for every PRIMARY_STAT', () => {
    for (const stat of PRIMARY_STATS) {
      const info = PRIMARY_STAT_DISPLAY[stat];
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(0);
      expect(info.decimals).toBe(0);
    }
  });

  it('formatCoreStatGains returns a non-empty string for stats with gains', () => {
    // Strength → damage + armor
    const strengthGains = formatCoreStatGains('strength');
    expect(strengthGains).toContain('Damage');
    expect(strengthGains).toContain('Armor');
    // Constitution → maxHp
    expect(formatCoreStatGains('constitution')).toContain('Max HP');
  });

  it('formatCoreStatGains returns placeholder for stats with no current gains', () => {
    expect(formatCoreStatGains('wisdom')).toBe('(no effect yet)');
    expect(formatCoreStatGains('charisma')).toBe('(no effect yet)');
  });
});
