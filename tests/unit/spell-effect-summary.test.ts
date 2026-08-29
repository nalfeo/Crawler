import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TILE_SIZE_FT,
  formatSpellEffectSummary,
} from '../../src/shared/spell-effect-summary.js';
import { getAbilityEffectSummary } from '../../src/game/abilities/effect-summary.js';
import {
  getAbilityDefinition,
  getAllAbilityDefinitions,
} from '../../src/game/abilities/registry.js';
import { FLOOR1_BOSS_REWARD_SPELL_IDS } from '../../src/shared/abilities.js';
import type { CatalogEffect } from '../../src/shared/progression-effects.js';

/**
 * How each catalog effect behaves toward other entities, keyed exhaustively by
 * effect type. Declared as a `Record` over `CatalogEffect['type']` so adding a
 * new effect to the union is a **compile error** here rather than a silent
 * `false` from a hand-maintained `||` chain — the previous shape let a new
 * spell ship with no summary at all while these predicates quietly returned
 * `false` and the coverage assertions below never ran for it.
 */
const EFFECT_BEHAVIOUR: Record<
  CatalogEffect['type'],
  { targetsOthers: boolean; damagesOthers: boolean }
> = {
  stat_add: { targetsOthers: false, damagesOthers: false },
  stat_multiply: { targetsOthers: false, damagesOthers: false },
  extra_projectile: { targetsOthers: false, damagesOthers: false },
  aura: { targetsOthers: false, damagesOthers: false },
  spell_fireball: { targetsOthers: true, damagesOthers: true },
  spell_heal: { targetsOthers: false, damagesOthers: false },
  spell_pulse_shield: { targetsOthers: true, damagesOthers: false },
  spell_magic_missile: { targetsOthers: true, damagesOthers: true },
  spell_frost_nova: { targetsOthers: true, damagesOthers: true },
  spell_timed_buff: { targetsOthers: false, damagesOthers: false },
  spell_enemy_slow_burst: { targetsOthers: true, damagesOthers: false },
  spell_life_drain: { targetsOthers: true, damagesOthers: true },
};

type SpellEffectType = Extract<CatalogEffect['type'], `spell_${string}`>;

const scalable = (base: number) => ({ base, scalesWithIntelligence: false });

/**
 * One representative effect per spell type, again keyed exhaustively so a new
 * `spell_*` variant cannot be added without supplying a sample. The sample is
 * fed through `formatSpellEffectSummary` below, which turns
 * {@link summarizeEffect}'s `default: return []` arm from a silent no-summary
 * into a failing test.
 */
const SPELL_EFFECT_SAMPLES: {
  [K in SpellEffectType]: Extract<CatalogEffect, { type: K }>;
} = {
  spell_fireball: {
    type: 'spell_fireball',
    damage: scalable(15),
    radiusTiles: scalable(3),
  },
  spell_heal: { type: 'spell_heal', heal: scalable(20) },
  spell_pulse_shield: {
    type: 'spell_pulse_shield',
    knockbackForce: scalable(1),
    radiusTiles: scalable(4),
  },
  spell_magic_missile: {
    type: 'spell_magic_missile',
    damage: scalable(9),
    rangeTiles: scalable(6),
  },
  spell_frost_nova: {
    type: 'spell_frost_nova',
    damage: scalable(8),
    radiusTiles: scalable(3),
    slowMultiplier: scalable(0.5),
    slowDurationMs: scalable(2000),
  },
  spell_timed_buff: {
    type: 'spell_timed_buff',
    durationFrames: scalable(300),
    modifiers: [{ stat: 'damage', op: 'add', value: scalable(5) }],
  },
  spell_enemy_slow_burst: {
    type: 'spell_enemy_slow_burst',
    radiusTiles: scalable(4),
    slowMultiplier: scalable(0.6),
    slowDurationMs: scalable(1500),
  },
  spell_life_drain: {
    type: 'spell_life_drain',
    damage: scalable(7),
    rangeTiles: scalable(5),
    heal: scalable(4),
  },
};

function effectTargetsOtherEntities(effect: CatalogEffect): boolean {
  return EFFECT_BEHAVIOUR[effect.type].targetsOthers;
}

function effectDamagesOtherEntities(effect: CatalogEffect): boolean {
  return EFFECT_BEHAVIOUR[effect.type].damagesOthers;
}

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

  it('formats non-damage multiply modifiers with their additive stat lane semantics', () => {
    expect(
      formatSpellEffectSummary([
        {
          type: 'spell_timed_buff',
          durationFrames: { base: 900, scalesWithIntelligence: false },
          modifiers: [
            { stat: 'armor', op: 'multiply', value: { base: 0.1, scalesWithIntelligence: false } },
            {
              stat: 'projectileSpeed',
              op: 'multiply',
              value: { base: 0.1, scalesWithIntelligence: false },
            },
          ],
        },
      ]),
    ).toBe('Armor +0.1 • Projectile Speed +0.1 • Duration 15s • Base — scales with mastery');
  });

  it('reports Intelligence scaling when any independently scalable output opts in', () => {
    expect(
      formatSpellEffectSummary([
        {
          type: 'spell_fireball',
          damage: { base: 15, scalesWithIntelligence: false },
          radiusTiles: { base: 3, scalesWithIntelligence: true },
        },
      ]),
    ).toContain('Base — scales with INT & mastery');
    expect(
      formatSpellEffectSummary([
        {
          type: 'spell_frost_nova',
          damage: { base: 10, scalesWithIntelligence: false },
          radiusTiles: { base: 3, scalesWithIntelligence: false },
          slowMultiplier: { base: 0.55, scalesWithIntelligence: true },
          slowDurationMs: { base: 3_000, scalesWithIntelligence: true },
        },
      ]),
    ).toContain('Base — scales with INT & mastery');
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

  it('summarises every spell effect type in the catalog', () => {
    for (const [type, effect] of Object.entries(SPELL_EFFECT_SAMPLES)) {
      const summary = formatSpellEffectSummary([effect]);
      expect(summary, `${type} produces no summary`).toBeDefined();
      expect(summary, `${type} produces an empty summary`).not.toBe('');
      const behaviour = EFFECT_BEHAVIOUR[type as SpellEffectType];
      if (behaviour.targetsOthers) {
        expect(summary, `${type} never states its reach`).toMatch(/\d+(\.\d+)? ft/);
      }
      if (behaviour.damagesOthers) {
        expect(summary, `${type} never states its damage`).toMatch(/Damage \d/);
      }
    }
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

  it('states reach for targeting spells and damage for damaging spells', () => {
    for (const definition of getAllAbilityDefinitions()) {
      if (definition.kind !== 'spell') continue;
      const summary = getAbilityEffectSummary(definition.id);
      if (definition.effects.some(effectTargetsOtherEntities)) {
        expect(summary, `${definition.id} never states its reach`).toMatch(/\d+(\.\d+)? ft/);
      }
      if (definition.effects.some(effectDamagesOtherEntities)) {
        expect(summary, `${definition.id} never states its damage`).toMatch(/Damage \d/);
      }
    }
  });
});
