/**
 * progressionEffects — `applyCatalogEffect` branch coverage.
 *
 * The existing `ability-system.test.ts` covers `stat_add` (via milestone
 * grants) and `spell_heal`.  These tests fill the remaining uncovered switch
 * cases in `applyCatalogEffect`:
 *
 *  1. `stat_multiply` → adds a multiply stat modifier.
 *  2. `extra_projectile` → adds an additive projectileCount modifier.
 *  3. `aura` → adds a zero-value damage modifier (placeholder registration).
 *  4. All 8 spell cases without `holderEid` → safely no-op (no error, no modifiers, no VFX).
 */
import { describe, it, expect } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { applyCatalogEffect } from '../../src/game/systems/progressionEffects.js';
import type { CatalogEffect } from '../../src/shared/progression-effects.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('applyCatalogEffect — stat_multiply', () => {
  it('adds a multiply modifier to world.statModifiers', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);

    applyCatalogEffect(world, {
      sourceType: 'skill',
      sourceId: 'test:stat_multiply',
      effect: { type: 'stat_multiply', stat: 'damage', value: 0.2 },
    });

    const modifier = world.statModifiers.find((m) => m.sourceId === 'test:stat_multiply');
    expect(modifier).toBeDefined();
    expect(modifier!.op).toBe('multiply');
    expect(modifier!.stat).toBe('damage');
    expect(modifier!.value).toBeCloseTo(0.2);
  });

  it('respects the expiresFrame field', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);

    applyCatalogEffect(world, {
      sourceType: 'ability',
      sourceId: 'test:stat_multiply_expires',
      effect: { type: 'stat_multiply', stat: 'armor', value: 0.5 },
      expiresFrame: 999,
    });

    const modifier = world.statModifiers.find((m) => m.sourceId === 'test:stat_multiply_expires');
    expect(modifier).toBeDefined();
    expect(modifier!.expiresFrame).toBe(999);
    expect(modifier!.op).toBe('multiply');
  });
});

describe('applyCatalogEffect — extra_projectile', () => {
  it('adds an additive projectileCount modifier', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);

    applyCatalogEffect(world, {
      sourceType: 'skill',
      sourceId: 'test:extra_projectile',
      effect: { type: 'extra_projectile', count: 2 },
    });

    const modifier = world.statModifiers.find((m) => m.sourceId === 'test:extra_projectile');
    expect(modifier).toBeDefined();
    expect(modifier!.stat).toBe('projectileCount');
    expect(modifier!.op).toBe('add');
    expect(modifier!.value).toBe(2);
  });
});

describe('applyCatalogEffect — aura (placeholder)', () => {
  it('registers a zero-value damage modifier so future aura system can query active auras', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);

    applyCatalogEffect(world, {
      sourceType: 'ability',
      sourceId: 'test:aura',
      effect: { type: 'aura', radius: 2, dpsPercentOfDamage: 0.1 },
    });

    const modifier = world.statModifiers.find((m) => m.sourceId === 'test:aura');
    expect(modifier).toBeDefined();
    // Value is intentionally 0 — placeholder for future aura system.
    expect(modifier!.value).toBe(0);
    expect(modifier!.stat).toBe('damage');
    expect(modifier!.op).toBe('add');
  });
});

describe('applyCatalogEffect — spell cases with no holderEid are safe no-ops', () => {
  // All 8 spell branches from the applyCatalogEffect switch, using the real CatalogEffect
  // shapes with proper ScalableOutput { base, scalesWithIntelligence } values.
  const SPELL_CASES: Array<{ id: string; effect: CatalogEffect }> = [
    {
      id: 'spell_fireball',
      effect: {
        type: 'spell_fireball',
        damage: { base: 10, scalesWithIntelligence: false },
        radiusTiles: { base: 2, scalesWithIntelligence: false },
      },
    },
    {
      id: 'spell_heal',
      effect: {
        type: 'spell_heal',
        heal: { base: 20, scalesWithIntelligence: false },
      },
    },
    {
      id: 'spell_pulse_shield',
      effect: {
        type: 'spell_pulse_shield',
        knockbackForce: { base: 10, scalesWithIntelligence: false },
        radiusTiles: { base: 2, scalesWithIntelligence: false },
      },
    },
    {
      id: 'spell_magic_missile',
      effect: {
        type: 'spell_magic_missile',
        damage: { base: 15, scalesWithIntelligence: false },
        rangeTiles: { base: 5, scalesWithIntelligence: false },
      },
    },
    {
      id: 'spell_frost_nova',
      effect: {
        type: 'spell_frost_nova',
        damage: { base: 8, scalesWithIntelligence: false },
        radiusTiles: { base: 2, scalesWithIntelligence: false },
        slowMultiplier: { base: 0.5, scalesWithIntelligence: false },
        slowDurationMs: { base: 1000, scalesWithIntelligence: false },
      },
    },
    {
      id: 'spell_timed_buff',
      effect: {
        type: 'spell_timed_buff',
        durationFrames: { base: 120, scalesWithIntelligence: false },
        modifiers: [
          { stat: 'armor', op: 'add', value: { base: 5, scalesWithIntelligence: false } },
        ],
      },
    },
    {
      id: 'spell_enemy_slow_burst',
      effect: {
        type: 'spell_enemy_slow_burst',
        radiusTiles: { base: 3, scalesWithIntelligence: false },
        slowMultiplier: { base: 0.5, scalesWithIntelligence: false },
        slowDurationMs: { base: 1500, scalesWithIntelligence: false },
      },
    },
    {
      id: 'spell_life_drain',
      effect: {
        type: 'spell_life_drain',
        damage: { base: 10, scalesWithIntelligence: false },
        rangeTiles: { base: 4, scalesWithIntelligence: false },
        heal: { base: 5, scalesWithIntelligence: false },
      },
    },
  ];

  for (const { id, effect } of SPELL_CASES) {
    it(`does not throw and adds no stat modifiers or VFX when holderEid is absent for ${id}`, () => {
      const world = createTestWorld();
      const beforeMods = world.statModifiers.length;
      const beforeVfx = world.vfxEvents.length;

      expect(() =>
        applyCatalogEffect(world, {
          sourceType: 'ability',
          sourceId: `test:${id}:no-holder`,
          effect,
          // holderEid intentionally omitted
        }),
      ).not.toThrow();

      // No new modifiers or VFX should have been emitted (all spell effects are holder-scoped).
      expect(world.statModifiers.length).toBe(beforeMods);
      expect(world.vfxEvents.length).toBe(beforeVfx);
    });
  }
});
