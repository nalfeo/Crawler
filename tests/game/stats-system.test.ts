import { describe, it, expect } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { initializeBaseStats } from '../../src/core/systems/equipmentSystem.js';
import { statSystem } from '../../src/core/systems/index.js';
import {
  spendPoints,
  addStatModifier,
  removeStatModifiers,
} from '../../src/game/systems/statsSystem.js';
import { DEFAULT_BASE_STATS, CORE_STAT_TO_SECONDARY, STAT_CLAMPS } from '../../src/shared/stats.js';

function setupPlayerWithStats(seed = 42) {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  initializeBaseStats(world, player);
  return { world, player };
}

describe('core statSystem — EffectiveStats derivation', () => {
  it('computes base secondary stats from DEFAULT_BASE_STATS + base(1) Constitution when no allocation/modifiers', () => {
    const { world, player } = setupPlayerWithStats();
    statSystem(world);
    const baseConMaxHp =
      DEFAULT_BASE_STATS.maxHp + 1 * (CORE_STAT_TO_SECONDARY.constitution.maxHp ?? 0);
    expect(world.stores.effectiveStats.maxHp[player]).toBeCloseTo(baseConMaxHp);
    expect(world.stores.effectiveStats.moveSpeed[player]).toBeCloseTo(DEFAULT_BASE_STATS.moveSpeed);
  });

  it('is idempotent — recomputing without any state change never drifts', () => {
    const { world, player } = setupPlayerWithStats();
    statSystem(world);
    const first = world.stores.effectiveStats.maxHp[player];
    statSystem(world);
    statSystem(world);
    expect(world.stores.effectiveStats.maxHp[player]).toBe(first);
  });

  it('derives maxHp from EFFECTIVE constitution (base 1 + allocated points)', () => {
    const { world, player } = setupPlayerWithStats();
    world.playerLevel.unspentPoints = 3;
    spendPoints(world, { constitution: 3 });
    statSystem(world);
    const effectiveCon = 1 + 3; // base + allocated
    const expected =
      DEFAULT_BASE_STATS.maxHp + effectiveCon * (CORE_STAT_TO_SECONDARY.constitution.maxHp ?? 0);
    expect(world.stores.effectiveStats.maxHp[player]).toBeCloseTo(expected);
  });

  it('strength contributes neither armor nor a flat/percent damage secondary (typed-primary only)', () => {
    const { world, player } = setupPlayerWithStats();
    world.playerLevel.unspentPoints = 5;
    spendPoints(world, { strength: 5 });
    statSystem(world);
    // STR's payoff is the typed-primary physical multiplier applied directly
    // at damage resolution (see shared/stats.ts#computeTypedPrimaryMultiplier),
    // NOT a generic secondary — armor/damageBonus/damagePercent stay at base.
    expect(world.stores.effectiveStats.armor[player]).toBeCloseTo(DEFAULT_BASE_STATS.armor);
    expect(world.stores.effectiveStats.damageBonus[player]).toBeCloseTo(
      DEFAULT_BASE_STATS.damageBonus,
    );
    expect(world.stores.effectiveStats.damagePercent[player]).toBeCloseTo(
      DEFAULT_BASE_STATS.damagePercent,
    );
  });

  it('charisma is visible but has literally zero effect on every OTHER EffectiveStats field', () => {
    const { world, player } = setupPlayerWithStats();
    statSystem(world);
    const before = { ...world.stores.effectiveStats } as Record<string, Float32Array>;
    const snapshot: Record<string, number> = {};
    for (const key of Object.keys(before)) {
      if (key === 'charisma') continue;
      snapshot[key] = before[key]![player] ?? 0;
    }

    // Force-write charisma directly (bypassing spendPoints's non-allocatable
    // guard) to prove the NON-effect is mechanical, not just UI-gated.
    world.stores.coreStatPoints.charisma[player] = 1_000_000;
    statSystem(world);

    for (const [key, value] of Object.entries(snapshot)) {
      expect(
        world.stores.effectiveStats[key as keyof typeof world.stores.effectiveStats][player],
      ).toBeCloseTo(value, 6);
    }
    // Charisma itself still passes through as a visible (base+allocated+gear) value.
    expect(world.stores.effectiveStats.charisma[player]).toBeCloseTo(
      DEFAULT_BASE_STATS.charisma + 1_000_000,
      0,
    );
  });
});

describe('spendPoints', () => {
  it('adds core-stat points and reduces unspent', () => {
    const { world, player } = setupPlayerWithStats();
    world.playerLevel.unspentPoints = 5;
    spendPoints(world, { constitution: 2, strength: 1 });
    expect(world.playerLevel.unspentPoints).toBe(2);

    statSystem(world);
    const effectiveCon = 1 + 2;
    const expectedMaxHp =
      DEFAULT_BASE_STATS.maxHp + effectiveCon * (CORE_STAT_TO_SECONDARY.constitution.maxHp ?? 0);
    expect(world.stores.effectiveStats.maxHp[player]).toBeCloseTo(expectedMaxHp);
  });

  it('throws when spending more points than available', () => {
    const { world } = setupPlayerWithStats();
    world.playerLevel.unspentPoints = 2;
    expect(() => spendPoints(world, { constitution: 3 })).toThrow();
  });

  it('throws for unknown allocation keys', () => {
    const { world } = setupPlayerWithStats();
    world.playerLevel.unspentPoints = 10;
    expect(() =>
      spendPoints(world, { lucky: 1 } as unknown as Parameters<typeof spendPoints>[1]),
    ).toThrow();
  });

  it('throws for non-allocatable primary stats (charisma)', () => {
    const { world } = setupPlayerWithStats();
    world.playerLevel.unspentPoints = 10;
    expect(() => spendPoints(world, { charisma: 1 })).toThrow(/cannot be allocated/i);
  });
});

describe('addStatModifier / removeStatModifiers — folded into EffectiveStats', () => {
  it('additive "damage" modifier folds into flat damageBonus', () => {
    const { world, player } = setupPlayerWithStats();
    addStatModifier(world, {
      sourceType: 'buff',
      sourceId: 'test',
      stat: 'damage',
      op: 'add',
      value: 10,
    });
    statSystem(world);
    expect(world.stores.effectiveStats.damageBonus[player]).toBeCloseTo(
      DEFAULT_BASE_STATS.damageBonus + 10,
    );
  });

  it('multiplicative "damage" modifier folds into generic damagePercent', () => {
    const { world, player } = setupPlayerWithStats();
    addStatModifier(world, {
      sourceType: 'buff',
      sourceId: 'test2',
      stat: 'damage',
      op: 'multiply',
      value: 0.5,
    });
    statSystem(world);
    expect(world.stores.effectiveStats.damagePercent[player]).toBeCloseTo(
      DEFAULT_BASE_STATS.damagePercent + 0.5,
    );
  });

  it('removeStatModifiers removes by source', () => {
    const { world, player } = setupPlayerWithStats();
    addStatModifier(world, {
      sourceType: 'buff',
      sourceId: 'removable',
      stat: 'armor',
      op: 'add',
      value: 5,
    });
    statSystem(world);
    const withMod = world.stores.effectiveStats.armor[player] ?? 0;

    removeStatModifiers(world, 'buff', 'removable');
    statSystem(world);
    const withoutMod = world.stores.effectiveStats.armor[player] ?? 0;

    expect(withMod).toBeGreaterThan(withoutMod);
    expect(withoutMod).toBeCloseTo(DEFAULT_BASE_STATS.armor);
  });

  it('expired modifiers are filtered out', () => {
    const { world, player } = setupPlayerWithStats();
    world.frameCount = 100;
    addStatModifier(world, {
      sourceType: 'buff',
      sourceId: 'expiring',
      stat: 'damage',
      op: 'add',
      value: 20,
      expiresFrame: 50, // already expired
    });
    statSystem(world);
    expect(world.stores.effectiveStats.damageBonus[player]).toBeCloseTo(
      DEFAULT_BASE_STATS.damageBonus,
    );
  });

  it('drops expired modifiers on the next statSystem tick (no dirty-flag gating — always recomputes)', () => {
    const { world, player } = setupPlayerWithStats();
    addStatModifier(world, {
      sourceType: 'buff',
      sourceId: 'short-buff',
      stat: 'damage',
      op: 'add',
      value: 5,
      expiresFrame: 10,
    });
    statSystem(world);
    expect(world.stores.effectiveStats.damageBonus[player]).toBeCloseTo(
      DEFAULT_BASE_STATS.damageBonus + 5,
    );

    world.frameCount = 11;
    statSystem(world);
    expect(world.stores.effectiveStats.damageBonus[player]).toBeCloseTo(
      DEFAULT_BASE_STATS.damageBonus,
    );
  });

  it('clamps stats to their configured range', () => {
    const { world, player } = setupPlayerWithStats();
    addStatModifier(world, {
      sourceType: 'buff',
      sourceId: 'neg',
      stat: 'moveSpeed',
      op: 'add',
      value: -9999,
    });
    statSystem(world);
    expect(world.stores.effectiveStats.moveSpeed[player]).toBeGreaterThanOrEqual(
      STAT_CLAMPS.moveSpeed.min ?? 0,
    );
  });
});
