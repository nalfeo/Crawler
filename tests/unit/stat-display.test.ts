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
    expect(formatStatValue('moveSpeed', 3)).toBe('3.0000');
    expect(formatStatValue('attackSpeed', 1)).toBe('1.00');
  });

  it('formats per-point increments with a leading plus', () => {
    expect(formatStatIncrement('maxHp')).toBe(`+${STAT_POINT_INCREMENT.maxHp.toFixed(0)}`);
    expect(formatStatIncrement('moveSpeed')).toBe('+0.0125');
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

  it('formatCoreStatGains appends derived secondary stats as percentages', () => {
    // Luck → critChance (0.005 → "+0.5% Crit Chance")
    const luckGains = formatCoreStatGains('luck');
    expect(luckGains).toContain('Crit Chance');
    expect(luckGains).toContain('0.5%');
    // Dexterity → dodgeChance (0.003 → "+0.3% Dodge Chance")
    const dexGains = formatCoreStatGains('dexterity');
    expect(dexGains).toContain('Dodge Chance');
    expect(dexGains).toContain('0.3%');
  });

  it('formatCoreStatGains surfaces the Wisdom→mana payoff and the Charisma placeholder', () => {
    // Wisdom now feeds the MP pool (see shared/mana.ts), so it must no longer
    // read "(no effect yet)" — it reports its Max Mana per-point gain.
    const wisdomGains = formatCoreStatGains('wisdom');
    expect(wisdomGains).toContain('Max Mana');
    expect(wisdomGains).not.toBe('(no effect yet)');
    // Charisma stays reserved until its payoff lands.
    expect(formatCoreStatGains('charisma')).toBe('(no effect yet)');
  });
});
