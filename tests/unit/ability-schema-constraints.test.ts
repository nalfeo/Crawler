/**
 * Ability catalog schema — field-specific output constraint tests.
 *
 * Verifies that spell effect schemas reject out-of-range `ScalableOutput.base`
 * values: negative/zero damage|heal|radius|knockback|range, non-integer or
 * zero/negative durations, and slow-multiplier ≤ 0 or > 1.
 */
import { describe, expect, it } from 'vitest';
import { abilityCatalogSchema } from '../../src/game/abilities/types.js';
import type { AbilityDefinition } from '../../src/game/abilities/types.js';

// Minimal valid active-spell wrapper that exercises a given effect.
function wrapSpell(effects: AbilityDefinition['effects']): unknown {
  return [
    {
      id: 'test-spell',
      name: 'Test Spell',
      shortLabel: 'TEST',
      description: 'Test spell for schema validation.',
      category: 'combat',
      kind: 'spell',
      cooldownFrames: 60,
      trigger: { kind: 'enemy_cluster', minEnemies: 1, withinFeet: 6 },
      effects,
    },
  ];
}

function valid(effects: unknown): boolean {
  return abilityCatalogSchema.safeParse(wrapSpell(effects as AbilityDefinition['effects'])).success;
}

describe('ability schema — spell_fireball output constraints', () => {
  it('accepts positive damage and radiusTiles', () => {
    expect(
      valid([
        {
          type: 'spell_fireball',
          damage: { base: 15, scalesWithIntelligence: true },
          radiusTiles: { base: 3, scalesWithIntelligence: false },
        },
      ]),
    ).toBe(true);
  });

  it('rejects zero damage base', () => {
    expect(
      valid([
        {
          type: 'spell_fireball',
          damage: { base: 0, scalesWithIntelligence: false },
          radiusTiles: { base: 3, scalesWithIntelligence: false },
        },
      ]),
    ).toBe(false);
  });

  it('rejects negative damage base', () => {
    expect(
      valid([
        {
          type: 'spell_fireball',
          damage: { base: -5, scalesWithIntelligence: false },
          radiusTiles: { base: 3, scalesWithIntelligence: false },
        },
      ]),
    ).toBe(false);
  });

  it('rejects zero radiusTiles base', () => {
    expect(
      valid([
        {
          type: 'spell_fireball',
          damage: { base: 10, scalesWithIntelligence: false },
          radiusTiles: { base: 0, scalesWithIntelligence: false },
        },
      ]),
    ).toBe(false);
  });
});

describe('ability schema — spell_heal output constraints', () => {
  it('accepts positive heal base', () => {
    expect(valid([{ type: 'spell_heal', heal: { base: 30, scalesWithIntelligence: true } }])).toBe(
      true,
    );
  });

  it('rejects zero heal base', () => {
    expect(valid([{ type: 'spell_heal', heal: { base: 0, scalesWithIntelligence: false } }])).toBe(
      false,
    );
  });

  it('rejects negative heal base', () => {
    expect(valid([{ type: 'spell_heal', heal: { base: -1, scalesWithIntelligence: false } }])).toBe(
      false,
    );
  });
});

describe('ability schema — spell_pulse_shield output constraints', () => {
  it('accepts positive knockbackForce and radiusTiles', () => {
    expect(
      valid([
        {
          type: 'spell_pulse_shield',
          knockbackForce: { base: 1.0, scalesWithIntelligence: false },
          radiusTiles: { base: 4, scalesWithIntelligence: false },
        },
      ]),
    ).toBe(true);
  });

  it('rejects zero knockbackForce', () => {
    expect(
      valid([
        {
          type: 'spell_pulse_shield',
          knockbackForce: { base: 0, scalesWithIntelligence: false },
          radiusTiles: { base: 4, scalesWithIntelligence: false },
        },
      ]),
    ).toBe(false);
  });

  it('rejects negative radiusTiles', () => {
    expect(
      valid([
        {
          type: 'spell_pulse_shield',
          knockbackForce: { base: 1.0, scalesWithIntelligence: false },
          radiusTiles: { base: -2, scalesWithIntelligence: false },
        },
      ]),
    ).toBe(false);
  });
});

describe('ability schema — spell_frost_nova slowMultiplier and duration constraints', () => {
  const validFrostNova = {
    type: 'spell_frost_nova',
    damage: { base: 10, scalesWithIntelligence: true },
    radiusTiles: { base: 3, scalesWithIntelligence: false },
    slowMultiplier: { base: 0.55, scalesWithIntelligence: false },
    slowDurationMs: { base: 3000, scalesWithIntelligence: false },
  };

  it('accepts valid frost nova', () => {
    expect(valid([validFrostNova])).toBe(true);
  });

  it('rejects slowMultiplier base of 0 (no-op multiplier is invalid)', () => {
    expect(
      valid([{ ...validFrostNova, slowMultiplier: { base: 0, scalesWithIntelligence: false } }]),
    ).toBe(false);
  });

  it('rejects slowMultiplier base > 1 (speeds up instead of slowing)', () => {
    expect(
      valid([{ ...validFrostNova, slowMultiplier: { base: 1.1, scalesWithIntelligence: false } }]),
    ).toBe(false);
  });

  it('accepts slowMultiplier base of exactly 1 (boundary: technically no-slow but valid)', () => {
    expect(
      valid([{ ...validFrostNova, slowMultiplier: { base: 1, scalesWithIntelligence: false } }]),
    ).toBe(true);
  });

  it('rejects negative slowMultiplier base', () => {
    expect(
      valid([{ ...validFrostNova, slowMultiplier: { base: -0.5, scalesWithIntelligence: false } }]),
    ).toBe(false);
  });

  it('rejects non-integer slowDurationMs base', () => {
    expect(
      valid([
        { ...validFrostNova, slowDurationMs: { base: 1500.5, scalesWithIntelligence: false } },
      ]),
    ).toBe(false);
  });

  it('rejects zero slowDurationMs base', () => {
    expect(
      valid([{ ...validFrostNova, slowDurationMs: { base: 0, scalesWithIntelligence: false } }]),
    ).toBe(false);
  });

  it('rejects negative slowDurationMs base', () => {
    expect(
      valid([
        { ...validFrostNova, slowDurationMs: { base: -1000, scalesWithIntelligence: false } },
      ]),
    ).toBe(false);
  });
});

describe('ability schema — spell_timed_buff durationFrames constraints', () => {
  const validTimedBuff = {
    type: 'spell_timed_buff',
    durationFrames: { base: 900, scalesWithIntelligence: false },
    modifiers: [{ stat: 'damage', op: 'add', value: { base: 4, scalesWithIntelligence: false } }],
  };

  it('accepts positive integer durationFrames', () => {
    expect(valid([validTimedBuff])).toBe(true);
  });

  it('rejects non-integer durationFrames base', () => {
    expect(
      valid([{ ...validTimedBuff, durationFrames: { base: 60.5, scalesWithIntelligence: false } }]),
    ).toBe(false);
  });

  it('rejects zero durationFrames base', () => {
    expect(
      valid([{ ...validTimedBuff, durationFrames: { base: 0, scalesWithIntelligence: false } }]),
    ).toBe(false);
  });

  it('rejects negative durationFrames base', () => {
    expect(
      valid([{ ...validTimedBuff, durationFrames: { base: -60, scalesWithIntelligence: false } }]),
    ).toBe(false);
  });

  it('rejects bare numeric timed-buff modifier values', () => {
    expect(
      valid([
        {
          ...validTimedBuff,
          modifiers: [{ stat: 'damage', op: 'add', value: 4 }],
        },
      ]),
    ).toBe(false);
  });
});

describe('ability schema — spell_enemy_slow_burst output constraints', () => {
  const validSlowBurst = {
    type: 'spell_enemy_slow_burst',
    radiusTiles: { base: 4, scalesWithIntelligence: false },
    slowMultiplier: { base: 0.4, scalesWithIntelligence: false },
    slowDurationMs: { base: 3600, scalesWithIntelligence: false },
  };

  it('accepts valid slow burst', () => {
    expect(valid([validSlowBurst])).toBe(true);
  });

  it('rejects slowMultiplier base > 1', () => {
    expect(
      valid([{ ...validSlowBurst, slowMultiplier: { base: 1.5, scalesWithIntelligence: false } }]),
    ).toBe(false);
  });

  it('rejects non-integer slowDurationMs', () => {
    expect(
      valid([
        { ...validSlowBurst, slowDurationMs: { base: 3600.1, scalesWithIntelligence: false } },
      ]),
    ).toBe(false);
  });

  it('rejects zero radiusTiles', () => {
    expect(
      valid([{ ...validSlowBurst, radiusTiles: { base: 0, scalesWithIntelligence: false } }]),
    ).toBe(false);
  });
});

describe('ability schema — spell_life_drain output constraints', () => {
  const validLifeDrain = {
    type: 'spell_life_drain',
    damage: { base: 12, scalesWithIntelligence: true },
    rangeTiles: { base: 3, scalesWithIntelligence: false },
    heal: { base: 9, scalesWithIntelligence: true },
  };

  it('accepts valid life drain', () => {
    expect(valid([validLifeDrain])).toBe(true);
  });

  it('rejects zero damage base', () => {
    expect(valid([{ ...validLifeDrain, damage: { base: 0, scalesWithIntelligence: false } }])).toBe(
      false,
    );
  });

  it('rejects negative heal base', () => {
    expect(valid([{ ...validLifeDrain, heal: { base: -1, scalesWithIntelligence: false } }])).toBe(
      false,
    );
  });

  it('rejects zero rangeTiles base', () => {
    expect(
      valid([{ ...validLifeDrain, rangeTiles: { base: 0, scalesWithIntelligence: false } }]),
    ).toBe(false);
  });
});
