import { describe, expect, it } from 'vitest';
import { computeGoldEconomy } from '../../src/game/ai/headless-runner.js';
import { recoverStolenGoldAt } from '../../src/core/spawners/pickups.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { itemPickupSystem } from '../../src/core/systems/itemPickupSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('robbery balance reconstruction', () => {
  it('subtracts unrecovered theft from both available-balance metrics, without changing earnings', () => {
    const world = createTestWorld({ floor: 2 });
    spawnPlayer(world, 0, 0);
    Object.assign(world.goldLedger, {
      earnedFromDrops: 100,
      spentOnSpell: 20,
      earnedBeforeExit: 90,
    });
    world.playerGold = 80;
    recoverStolenGoldAt(world, 0.5, 0, 10);
    expect(computeGoldEconomy(world)).toMatchObject({
      earnedTotal: 100,
      spentTotal: 20,
      unspentAtExit: 70,
      unspentFraction: 0.7,
      unspentSpendable: 60,
      unspentSpendableFraction: 60 / 90,
    });
    itemPickupSystem(world, collisionSystem(world));
    expect(computeGoldEconomy(world)).toMatchObject({
      earnedTotal: 100,
      spentTotal: 20,
      unspentAtExit: 80,
      unspentFraction: 0.8,
      unspentSpendable: 70,
      unspentSpendableFraction: 70 / 90,
    });
  });
});
