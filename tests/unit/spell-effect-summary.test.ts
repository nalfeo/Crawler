import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TILE_SIZE_FT,
  formatSpellEffectSummary,
} from '../../src/shared/spell-effect-summary.js';
import { getAbilityEffectSummary } from '../../src/game/abilities/effect-summary.js';
import { getAbilityDefinition } from '../../src/game/abilities/registry.js';
import { FLOOR1_BOSS_REWARD_SPELL_IDS } from '../../src/shared/abilities.js';

describe('formatSpellEffectSummary', () => {
  it('returns undefined when no effect is a spell', () => {
    expect(
      formatSpellEffectSummary([
        { type: 'stat_add', stat: 'armor', value: 3 },
        { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      ]),
    ).toBeUndefined();
    expect(formatSpellEffectSummary([])).toBeUndefined();
  });

  it('reports damage and the shared target/blast reach for an area spell', () => {
    expect(
      formatSpellEffectSummary([
        {
          type: 'spell_fireball',
          damage: { base: 15, scalesWithIntelligence: true },
          radiusTiles: { base: 3, scalesWithIntelligence: false },
        },
      ]),
    ).toBe('Damage 15 • Target & blast radius 12 ft • Base — scales with INT & mastery');
  });

  it('reports damage and range for a single-target spell', () => {
    expect(
      formatSpellEffectSummary([
        {
          type: 'spell_magic_missile',
          damage: { base: 11, scalesWithIntelligence: true },
          rangeTiles: { base: 4, scalesWithIntelligence: false },
        },
      ]),
    ).toBe('Damage 11 • Range 16 ft • Base — scales with INT & mastery');
  });

  it('converts a speed multiplier into a slow percentage and seconds', () => {
    expect(
      formatSpellEffectSummary([
        {
          type: 'spell_frost_nova',
          damage: { base: 10, scalesWithIntelligence: true },
          radiusTiles: { base: 3, scalesWithIntelligence: false },
          slowMultiplier: { base: 0.55, scalesWithIntelligence: false },
          slowDurationMs: { base: 3_000, scalesWithIntelligence: false },
        },
      ]),
    ).toBe('Damage 10 • Radius 12 ft • Slow 45% for 3s • Base — scales with INT & mastery');
  });

  it('reports damage, range and healing for a life-drain spell', () => {
    expect(
      formatSpellEffectSummary([
        {
          type: 'spell_life_drain',
          damage: { base: 12, scalesWithIntelligence: true },
          rangeTiles: { base: 3, scalesWithIntelligence: false },
          heal: { base: 9, scalesWithIntelligence: true },
        },
      ]),
    ).toBe('Damage 12 • Range 12 ft • Heals 9 • Base — scales with INT & mastery');
  });

  it('omits the Intelligence note when nothing in the spell scales with it', () => {
    expect(
      formatSpellEffectSummary([
        {
          type: 'spell_enemy_slow_burst',
          radiusTiles: { base: 4, scalesWithIntelligence: false },
          slowMultiplier: { base: 0.4, scalesWithIntelligence: false },
          slowDurationMs: { base: 3_600, scalesWithIntelligence: false },
        },
      ]),
    ).toBe('Radius 16 ft • Slow 60% for 3.6s • Base — scales with mastery');
  });

  it('formats timed-buff modifiers by their stat lane and the duration in seconds', () => {
    expect(
      formatSpellEffectSummary([
        {
          type: 'spell_timed_buff',
          durationFrames: { base: 900, scalesWithIntelligence: false },
          modifiers: [
            { stat: 'damage', op: 'add', value: { base: 4, scalesWithIntelligence: false } },
            { stat: 'damage', op: 'multiply', value: { base: 0.1, scalesWithIntelligence: false } },
            { stat: 'accuracy', op: 'add', value: { base: 0.1, scalesWithIntelligence: false } },
            { stat: 'moveSpeed', op: 'add', value: { base: 0.05, scalesWithIntelligence: false } },
          ],
        },
      ]),
    ).toBe(
      'Damage +4 • Damage +10% • Accuracy +0.1 • Move Speed +5% • Duration 15s • Base — scales with mastery',
    );
  });

  it('scales tile-based reach with the floor tile size', () => {
    const effects = [
      {
        type: 'spell_pulse_shield',
        knockbackForce: { base: 1, scalesWithIntelligence: false },
        radiusTiles: { base: 4, scalesWithIntelligence: false },
      },
    ] as const;
    expect(formatSpellEffectSummary(effects, { tileSizeFt: 8 })).toContain('Radius 32 ft');
    expect(formatSpellEffectSummary(effects, { tileSizeFt: DEFAULT_TILE_SIZE_FT })).toContain(
      'Radius 16 ft',
    );
  });
});

describe('getAbilityEffectSummary', () => {
  it('returns undefined for passives and unknown ability ids', () => {
    expect(getAbilityEffectSummary('combat-flow')).toBeUndefined();
    expect(getAbilityEffectSummary('no-such-ability')).toBeUndefined();
  });

  it('gives every offerable Floor 1 spell a numeric summary derived from the registry', () => {
    for (const spellId of FLOOR1_BOSS_REWARD_SPELL_IDS) {
      const definition = getAbilityDefinition(spellId);
      expect(definition).toBeDefined();
      const summary = getAbilityEffectSummary(spellId);
      expect(summary, `${spellId} has no stat summary`).toBeDefined();
      expect(summary).toBe(formatSpellEffectSummary(definition!.effects));
    }
  });

  it('states damage and reach for every spell that targets other entities', () => {
    const targetsOthers = [
      'fireball',
      'magic-missile',
      'frost-nova',
      'vampiric-touch',
      'curse',
      'pulse-shield',
    ] as const;
    for (const spellId of targetsOthers) {
      const summary = getAbilityEffectSummary(spellId)!;
      expect(summary, `${spellId} never states its reach`).toMatch(/\d+(\.\d+)? ft/);
    }
    for (const spellId of ['fireball', 'magic-missile', 'frost-nova', 'vampiric-touch'] as const) {
      expect(getAbilityEffectSummary(spellId), `${spellId} never states its damage`).toMatch(
        /Damage \d/,
      );
    }
  });
});
