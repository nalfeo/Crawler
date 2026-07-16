import { describe, expect, it } from 'vitest';
import {
  STAT_DISPLAY,
  PRIMARY_STAT_DISPLAY,
  formatStatValue,
  formatCoreStatGains,
} from '../../src/shared/stat-display.js';
import { STAT_KEYS, PRIMARY_STATS } from '../../src/shared/stats.js';

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

  it('does not include weight in the primary stat set', () => {
    expect(PRIMARY_STATS).not.toContain('weight');
    expect((PRIMARY_STAT_DISPLAY as Record<string, unknown>).weight).toBeUndefined();
  });

  it('formatCoreStatGains reports the typed-primary rates for Strength and Intelligence', () => {
    // Strength → +1.0% physical damage only (no armor, no flat damage — see
    // shared/stats.ts#STR_PHYSICAL_DAMAGE_RATE and CORE_STAT_TO_SECONDARY.strength).
    expect(formatCoreStatGains('strength')).toBe('+1.0% Physical Damage');
    // Intelligence → +1.0% magic strength only.
    expect(formatCoreStatGains('intelligence')).toBe('+1.0% Magic Strength');
  });

  it('formatCoreStatGains reports Constitution max HP and Wisdom cooldown reduction', () => {
    // Constitution → +10 Max HP per effective point.
    expect(formatCoreStatGains('constitution')).toBe('+10 Max HP');
    // Wisdom → +0.5pp cooldown reduction per effective point.
    expect(formatCoreStatGains('wisdom')).toBe('+0.50% Cooldown Reduction');
  });

  it('formatCoreStatGains reports Luck crit chance and Dexterity multi-stat spread', () => {
    // Luck → +0.25pp crit chance per effective point.
    expect(formatCoreStatGains('luck')).toBe('+0.25% Crit Chance');
    // Dexterity → attack speed, move speed, accuracy, and dodge chance (exact
    // 1/300 ≈ 0.33pp) all per effective point.
    const dexGains = formatCoreStatGains('dexterity');
    expect(dexGains).toContain('+1.00% Attack Speed');
    expect(dexGains).toContain('+0.25% Move Speed');
    expect(dexGains).toContain('+0.25% Accuracy');
    expect(dexGains).toContain('+0.33% Dodge Chance');
  });

  it('formatCoreStatGains reports the Charisma placeholder', () => {
    // Charisma stays visible with zero gameplay effect and is non-allocatable.
    expect(formatCoreStatGains('charisma')).toBe('(no effect yet)');
  });
});
