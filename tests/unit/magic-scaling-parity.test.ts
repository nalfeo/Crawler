import { describe, it, expect } from 'vitest';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { initializeBaseStats } from '../../src/core/systems/equipmentSystem.js';
import { statSystem } from '../../src/core/systems/statSystem.js';
import { applyDamage, type DamageOptions } from '../../src/core/apply-damage.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { spendPoints } from '../../src/game/systems/statsSystem.js';
import { resolveScalableOutputRounded, INT_MAGIC_STRENGTH_RATE } from '../../src/shared/stats.js';

/**
 * Plan resolution #6 parity guard: "Add parity test that magic weapon and
 * spell use same post-gear effective INT rate."
 *
 * A magic WEAPON hit (`weaponSystem.dispatchAttackInner` → `applyDamage` with
 * `affinity: 'magic', scaleWithPrimary: true`) and a spell's numeric output
 * (`resolveScalableOutput(Rounded)` with `scalesWithIntelligence: true`) are
 * two textually-independent code paths. They must nonetheless apply the
 * EXACT SAME post-gear effective-Intelligence rate
 * (`INT_MAGIC_STRENGTH_RATE`, +1%/point) — otherwise a player's Intelligence
 * investment would silently pay off differently for weapons vs spells.
 *
 * This drives BOTH real code paths (not a shared helper called twice) against
 * the SAME effective Intelligence and the SAME base amount, and asserts they
 * land on byte-identical output.
 */
describe('magic weapon vs spell — same effective-Intelligence scaling rate', () => {
  function setupPlayerWithIntelligence(allocatedInt: number) {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    initializeBaseStats(world, player);
    world.playerLevel.unspentPoints = allocatedInt;
    spendPoints(world, { intelligence: allocatedInt });
    statSystem(world);
    return { world, player };
  }

  const MAGIC_WEAPON_HIT_OPTIONS: DamageOptions = {
    origin: 'player',
    affinity: 'magic',
    scaleWithPrimary: true,
    canCrit: false, // isolate the typed-primary multiplier from crit RNG
  };

  it('scales an identical base amount by the identical factor via applyDamage (weapon) and resolveScalableOutputRounded (spell)', () => {
    // Effective INT = base(1) + allocated(24) = 25 -> +25% (a "clean" rate
    // that lands on an exact integer for base=100, avoiding rounding noise).
    const { world, player } = setupPlayerWithIntelligence(24);
    // statSystem was called after initializeBaseStats in setupPlayerWithIntelligence;
    // the store slot is guaranteed populated — non-null assertion is safe.
    const effectiveIntelligence = world.stores.effectiveStats.intelligence[player]!;
    expect(effectiveIntelligence).toBe(25);

    const baseAmount = 100;

    // Weapon path: a real applyDamage call against a live enemy target.
    const enemy = spawnEnemy(world, 5, 0, 100_000);
    const dealt = applyDamage(world, enemy, baseAmount, 5, 0, MAGIC_WEAPON_HIT_OPTIONS);

    // Spell path: the shared scalable-output resolver spells use directly.
    const spellOutput = resolveScalableOutputRounded(
      { base: baseAmount, scalesWithIntelligence: true },
      effectiveIntelligence,
    );

    const expectedRate = 1 + effectiveIntelligence * INT_MAGIC_STRENGTH_RATE;
    expect(dealt).toBe(baseAmount * expectedRate);
    expect(spellOutput).toBe(baseAmount * expectedRate);
    expect(dealt).toBe(spellOutput);
  });

  it('holds across a range of effective Intelligence values (not just one coincidental match)', () => {
    for (const allocatedInt of [0, 4, 9, 49, 99]) {
      const { world, player } = setupPlayerWithIntelligence(allocatedInt);
      const effectiveIntelligence = world.stores.effectiveStats.intelligence[player]!;
      const baseAmount = 100;

      const enemy = spawnEnemy(world, 5, 0, 1_000_000);
      const dealt = applyDamage(world, enemy, baseAmount, 5, 0, MAGIC_WEAPON_HIT_OPTIONS);
      const expectedRate = 1 + effectiveIntelligence * INT_MAGIC_STRENGTH_RATE;

      // Weapon damage is intentionally left unrounded (crit multipliers already
      // produce fractional HP in this game, e.g. 15*1.5=22.5), so compare
      // against the UNROUNDED spell expression — the same rate, not the
      // separate (and deliberately different) integer-rounding behaviour
      // spell damage applies via resolveScalableOutputRounded.
      expect(dealt).toBeCloseTo(baseAmount * expectedRate, 9);
    }
  });

  it('does NOT scale magic weapon damage with Strength, and does NOT scale a spell output with Strength either', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    initializeBaseStats(world, player);
    world.playerLevel.unspentPoints = 50;
    spendPoints(world, { strength: 50 }); // pile on Strength, not Intelligence
    statSystem(world);

    const baseAmount = 100;
    const enemy = spawnEnemy(world, 5, 0, 1_000_000);
    const dealt = applyDamage(world, enemy, baseAmount, 5, 0, MAGIC_WEAPON_HIT_OPTIONS);
    const spellOutput = resolveScalableOutputRounded(
      { base: baseAmount, scalesWithIntelligence: true },
      world.stores.effectiveStats.intelligence[player]!,
    );

    // Effective INT is still just the base (1, no allocation), so both paths
    // apply only the tiny baseline +1% rate — Strength contributes nothing.
    expect(dealt).toBe(baseAmount * 1.01);
    expect(spellOutput).toBe(baseAmount * 1.01);
  });
});
