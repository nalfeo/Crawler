import { describe, it, expect } from 'vitest';
import { addComponent } from 'bitecs';
import { Stats } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  statsSystem,
  spendPoints,
  addStatModifier,
  removeStatModifiers,
} from '../../src/game/systems/statsSystem.js';
import { STAT_BASE, STAT_POINT_INCREMENT, STAT_MIN } from '../../src/shared/stats.js';

function setupPlayerWithStats(seed = 42) {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  addComponent(world.ecs, player, Stats);
  world.statsDirty = true;
  return { world, player };
}

describe('statsSystem', () => {
  it('does not run if statsDirty is false', () => {
    const { world, player } = setupPlayerWithStats();
    statsSystem(world); // initial compute
    world.stores.stats.maxHp[player] = 999; // manually corrupt
    world.statsDirty = false;
    statsSystem(world); // should not recompute
    expect(world.stores.stats.maxHp[player]).toBe(999);
  });

  it('does nothing when no player with Stats component exists', () => {
    const world = createTestWorld();
    world.statsDirty = true;
    expect(() => statsSystem(world)).not.toThrow();
  });

  it('computes base stats from STAT_BASE when no points or modifiers', () => {
    const { world, player } = setupPlayerWithStats();
    statsSystem(world);
    expect(world.stores.stats.maxHp[player]).toBeCloseTo(STAT_BASE.maxHp);
    expect(world.stores.stats.moveSpeed[player]).toBeCloseTo(STAT_BASE.moveSpeed);
    expect(world.stores.stats.damage[player]).toBeCloseTo(STAT_BASE.damage);
  });

  it('clears dirty flag after compute', () => {
    const { world } = setupPlayerWithStats();
    statsSystem(world);
    expect(world.statsDirty).toBe(false);
  });
});

describe('spendPoints', () => {
  it('adds point bonuses and marks dirty', () => {
    const { world, player } = setupPlayerWithStats();
    statsSystem(world); // initial
    world.playerLevel.unspentPoints = 5;
    spendPoints(world, { maxHp: 2, damage: 1 });
    expect(world.playerLevel.unspentPoints).toBe(2);
    expect(world.statsDirty).toBe(true);

    statsSystem(world); // recompute
    const expectedMaxHp = STAT_BASE.maxHp + 2 * STAT_POINT_INCREMENT.maxHp;
    const expectedDamage = STAT_BASE.damage + 1 * STAT_POINT_INCREMENT.damage;
    expect(world.stores.stats.maxHp[player]).toBeCloseTo(expectedMaxHp);
    expect(world.stores.stats.damage[player]).toBeCloseTo(expectedDamage);
  });

  it('throws when spending more points than available', () => {
    const { world } = setupPlayerWithStats();
    world.playerLevel.unspentPoints = 2;
    expect(() => spendPoints(world, { maxHp: 3 })).toThrow();
  });
});

describe('addStatModifier / removeStatModifiers', () => {
  it('add modifier increases stat on recompute', () => {
    const { world, player } = setupPlayerWithStats();
    statsSystem(world); // initial
    addStatModifier(world, {
      sourceType: 'buff',
      sourceId: 'test',
      stat: 'damage',
      op: 'add',
      value: 10,
    });
    statsSystem(world);
    expect(world.stores.stats.damage[player]).toBeCloseTo(STAT_BASE.damage + 10);
  });

  it('multiply modifier scales stat', () => {
    const { world, player } = setupPlayerWithStats();
    statsSystem(world);
    addStatModifier(world, {
      sourceType: 'buff',
      sourceId: 'test2',
      stat: 'damage',
      op: 'multiply',
      value: 0.5,
    });
    statsSystem(world);
    expect(world.stores.stats.damage[player]).toBeCloseTo(STAT_BASE.damage * 1.5);
  });

  it('removeStatModifiers removes by source', () => {
    const { world, player } = setupPlayerWithStats();
    statsSystem(world);
    addStatModifier(world, {
      sourceType: 'buff',
      sourceId: 'removable',
      stat: 'armor',
      op: 'add',
      value: 5,
    });
    statsSystem(world);
    const withMod = world.stores.stats.armor[player] ?? 0;

    removeStatModifiers(world, 'buff', 'removable');
    statsSystem(world);
    const withoutMod = world.stores.stats.armor[player] ?? 0;

    expect(withMod).toBeGreaterThan(withoutMod);
    expect(withoutMod).toBeCloseTo(STAT_BASE.armor);
  });

  it('expired modifiers are filtered out', () => {
    const { world, player } = setupPlayerWithStats();
    statsSystem(world);
    world.frameCount = 100;
    addStatModifier(world, {
      sourceType: 'buff',
      sourceId: 'expiring',
      stat: 'damage',
      op: 'add',
      value: 20,
      expiresFrame: 50, // already expired
    });
    statsSystem(world);
    expect(world.stores.stats.damage[player]).toBeCloseTo(STAT_BASE.damage);
  });

  it('clamps stats to STAT_MIN', () => {
    const { world, player } = setupPlayerWithStats();
    addStatModifier(world, {
      sourceType: 'buff',
      sourceId: 'neg',
      stat: 'moveSpeed',
      op: 'add',
      value: -9999,
    });
    statsSystem(world);
    expect(world.stores.stats.moveSpeed[player]).toBeGreaterThanOrEqual(STAT_MIN.moveSpeed);
  });
});
