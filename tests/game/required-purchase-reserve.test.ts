/**
 * Required-purchase reserve — the AI must not spend gold it still owes the
 * *required* shopkeeper charm on an *optional* purchase.
 *
 * Regression for issue #3275 item 1 ("the player kept going back and forth to
 * the merchants"). Root cause on seed 42: the optional Spell Broker purchase
 * fired at 148.4s and drained the run to 32 gold; the AI arrived at the
 * merchant 0.4s later holding 32 of the 60 gold charm price, recorded an
 * `unaffordable` decision, farmed, and walked the same route back at 202.9s.
 *
 * Requirements validated:
 *  1. The reserve is live for every shop stage in which the charm is unpaid —
 *     `not-met` included, because the broker unlocks while the errand can still
 *     be mid-fetch.
 *  2. The reserve releases the moment the charm is paid for.
 *  3. The broker intent nets the reserve out of its own affordability view, so
 *     it stays `farming` instead of flip-flopping to `returning` for a purchase
 *     the executor would refuse to fund.
 */

import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { addItem } from '../../src/shared/inventory.js';
import {
  SHOPKEEPER_EQUIPMENT_COST,
  getShopkeeperStage,
  initializeFloor1Scenario,
  meetShopkeeper,
  purchaseShopkeeperEquipment,
  returnShopkeeperPrize,
  selectFloor1StarterWeapon,
} from '../../src/game/floorScenario.js';
import { questSystem } from '../../src/core/systems/questSystem.js';
import { SHOPKEEPER_FETCH_ITEM_ID } from '../../src/shared/quest-types.js';
import { requiredShopPurchaseReserve } from '../../src/game/ai/required-purchase-reserve.js';
import {
  configureSpellBrokerPurchase,
  ensureSpellBrokerDecision,
  updateSpellBrokerIntent,
} from '../../src/game/ai/spell-broker-intent.js';
import { createTestWorld } from '../helpers/world-factory.js';
import type { GameWorld } from '../../src/core/world.js';

function startFloor1(): { world: GameWorld; player: number } {
  const world = createTestWorld({ seed: 5 });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor1Scenario(world, player);
  selectFloor1StarterWeapon(world, 0);
  world.playerLevel.level = 2;
  world.goalFlags.set('floor1-leveling-quest-complete', true);
  return { world, player };
}

describe('requiredShopPurchaseReserve — unpaid stages', () => {
  it('reserves the charm price before the merchant has even been met', () => {
    const { world } = startFloor1();
    expect(getShopkeeperStage(world)).toBe('not-met');
    expect(requiredShopPurchaseReserve(world)).toBe(SHOPKEEPER_EQUIPMENT_COST);
  });

  it('reserves the charm price while the fetch errand is outstanding', () => {
    const { world } = startFloor1();
    meetShopkeeper(world);
    questSystem(world);
    expect(getShopkeeperStage(world)).toBe('awaiting-prize');
    expect(requiredShopPurchaseReserve(world)).toBe(SHOPKEEPER_EQUIPMENT_COST);
  });

  it('reserves the charm price while the run is standing at the counter', () => {
    const { world, player } = startFloor1();
    meetShopkeeper(world);
    questSystem(world);
    addItem(world.inventories.get(player)!, SHOPKEEPER_FETCH_ITEM_ID, 1);
    questSystem(world);
    returnShopkeeperPrize(world, player);
    questSystem(world);
    expect(getShopkeeperStage(world)).toBe('ready-to-buy');
    expect(requiredShopPurchaseReserve(world)).toBe(SHOPKEEPER_EQUIPMENT_COST);
  });
});

describe('requiredShopPurchaseReserve — released once paid', () => {
  it('drops to zero after the charm is bought', () => {
    const { world, player } = startFloor1();
    world.playerGold = SHOPKEEPER_EQUIPMENT_COST + 10;
    meetShopkeeper(world);
    questSystem(world);
    addItem(world.inventories.get(player)!, SHOPKEEPER_FETCH_ITEM_ID, 1);
    questSystem(world);
    returnShopkeeperPrize(world, player);
    questSystem(world);
    expect(purchaseShopkeeperEquipment(world, player)).toBe(true);
    questSystem(world);
    expect(requiredShopPurchaseReserve(world)).toBe(0);
  });
});

describe('spell-broker intent — respects the required reserve', () => {
  it('keeps farming while the spendable gold is short once the charm is reserved', () => {
    const { world } = startFloor1();
    configureSpellBrokerPurchase(world, true);
    const decided = ensureSpellBrokerDecision(world);
    expect(decided.shouldBuy).toBe(true);
    world.featureUnlocks.spells = true;
    // Exactly enough for the spell — but not for the spell AND the charm the
    // run still owes. Pre-fix this flipped to `returning` and burned the trip.
    world.playerGold = decided.cost;
    expect(updateSpellBrokerIntent(world, null, 0).purchaseStatus).toBe('farming');
  });

  it('returns to the broker once both the spell and the reserved charm are covered', () => {
    const { world } = startFloor1();
    configureSpellBrokerPurchase(world, true);
    const decided = ensureSpellBrokerDecision(world);
    world.featureUnlocks.spells = true;
    world.playerGold = decided.cost + SHOPKEEPER_EQUIPMENT_COST;
    expect(updateSpellBrokerIntent(world, null, 0).purchaseStatus).toBe('returning');
  });
});
