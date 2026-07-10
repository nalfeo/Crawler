import { describe, it, expect, beforeEach } from 'vitest';
import { addEntity } from 'bitecs';
import { createTestWorld } from '../helpers/world-factory.js';
import type { GameWorld } from '../../src/core/world.js';
import { initializeBaseStats, getEffectiveStats } from '../../src/core/systems/equipmentSystem.js';
import { statSystem } from '../../src/core/systems/statSystem.js';
import { CORE_STAT_TO_SECONDARY, DEFAULT_BASE_STATS } from '../../src/shared/stats.js';

/**
 * The ITEM 5 bridge: level-up core-stat allocation must flow through
 * EffectiveStats into the secondary stats the combat damage path reads
 * (critChance from Luck, dodgeChance from Dexterity).
 */
describe('effective-stats secondary derivation (level-up bridge)', () => {
  let world: GameWorld;
  let entity: number;

  beforeEach(() => {
    world = createTestWorld();
    world.state = 'safe_room';
    entity = addEntity(world.ecs);
    initializeBaseStats(world, entity);
  });

  const LUCK_TO_CRIT = CORE_STAT_TO_SECONDARY.luck.critChance!;
  const DEX_TO_DODGE = CORE_STAT_TO_SECONDARY.dexterity.dodgeChance!;
  const STR_TO_DAMAGE_PERCENT = CORE_STAT_TO_SECONDARY.strength.damagePercent!;
  const WIS_TO_COOLDOWN = CORE_STAT_TO_SECONDARY.wisdom.cooldownReduction!;

  it('derives baseline crit/dodge from base primaries (Luck 1, Dexterity 1)', () => {
    statSystem(world);
    const stats = getEffectiveStats(world, entity);
    // critChance = base 0.05 + effective luck (1) * rate
    expect(stats.critChance).toBeCloseTo(DEFAULT_BASE_STATS.critChance + 1 * LUCK_TO_CRIT, 6);
    // dodgeChance = base 0 + effective dexterity (1) * rate
    expect(stats.dodgeChance).toBeCloseTo(DEFAULT_BASE_STATS.dodgeChance + 1 * DEX_TO_DODGE, 6);
    expect(stats.damagePercent).toBeCloseTo(
      DEFAULT_BASE_STATS.damagePercent + 1 * STR_TO_DAMAGE_PERCENT,
      6,
    );
    expect(stats.cooldownReduction).toBeCloseTo(
      DEFAULT_BASE_STATS.cooldownReduction + 1 * WIS_TO_COOLDOWN,
      6,
    );
  });

  it('raises critChance as Luck core points are allocated', () => {
    statSystem(world);
    const before = getEffectiveStats(world, entity).critChance;

    world.stores.coreStatPoints.luck[entity] = 10;
    statSystem(world);
    const after = getEffectiveStats(world, entity).critChance;

    expect(after).toBeCloseTo(before + 10 * LUCK_TO_CRIT, 6);
  });

  it('raises dodgeChance as Dexterity core points are allocated', () => {
    statSystem(world);
    const before = getEffectiveStats(world, entity).dodgeChance;

    world.stores.coreStatPoints.dexterity[entity] = 10;
    statSystem(world);
    const after = getEffectiveStats(world, entity).dodgeChance;

    expect(after).toBeCloseTo(before + 10 * DEX_TO_DODGE, 6);
  });

  it('raises damagePercent as Strength core points are allocated', () => {
    statSystem(world);
    const before = getEffectiveStats(world, entity).damagePercent;

    world.stores.coreStatPoints.strength[entity] = 10;
    statSystem(world);
    const after = getEffectiveStats(world, entity).damagePercent;

    expect(after).toBeCloseTo(before + 10 * STR_TO_DAMAGE_PERCENT, 6);
  });

  it('raises cooldownReduction as Wisdom core points are allocated', () => {
    statSystem(world);
    const before = getEffectiveStats(world, entity).cooldownReduction;

    world.stores.coreStatPoints.wisdom[entity] = 10;
    statSystem(world);
    const after = getEffectiveStats(world, entity).cooldownReduction;

    expect(after).toBeCloseTo(before + 10 * WIS_TO_COOLDOWN, 6);
  });

  it('clamps derived crit/dodge to their configured maxima under huge allocation', () => {
    world.stores.coreStatPoints.luck[entity] = 100000;
    world.stores.coreStatPoints.dexterity[entity] = 100000;
    statSystem(world);
    const stats = getEffectiveStats(world, entity);
    expect(stats.critChance).toBe(1);
    expect(stats.dodgeChance).toBe(0.75);
  });
});
