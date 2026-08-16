import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/spawners/combatants.js';
import { getActiveWeaponDef } from '../../src/core/active-weapon.js';
import { equip } from '../../src/core/systems/equipmentSystem.js';
import {
  getEquipmentDefForItem,
  getEquipmentDefForStarterWeapon,
} from '../../src/shared/equipmentDefs.js';
import { SeededRandom } from '../../src/shared/random.js';
import { getShopkeeperPostQuestStock } from '../../src/game/floorScenario.js';
import {
  configureMerchantWeaponPurchase,
  executeMerchantWeaponPurchase,
  getMerchantWeaponIntent,
  selectMerchantWeapon,
  updateMerchantWeaponIntent,
} from '../../src/game/ai/merchant-weapon-intent.js';
import type { Floor1RunPlan } from '../../src/game/ai/run-planner.js';
import { createTestWorld } from '../helpers/world-factory.js';

const GOLD_FARM_MS = 3_000;

function plan(slackMs: number): Floor1RunPlan {
  return {
    criticalPathObjective: 'Floor clear',
    remainingMs: 600_000,
    estimatedRequiredMs: 600_000 - slackMs,
    estimatedTravelMs: 0,
    safetyBufferMs: 20_000,
    slackMs,
    urgency: 0,
    segments: [],
    routeHeadId: null,
    nextActionableGoalId: null,
    includedOptionalBundleIds: [],
    droppedOptionalBundleIds: [],
  };
}

function completedMerchantWorld(seed: number) {
  const world = createTestWorld({ seed });
  world.goalFlags.set('floor1-shop-quest-complete', true);
  return world;
}

describe('merchant weapon purchase intent', () => {
  it('is flag-off inert and consumes no RNG', () => {
    const world = completedMerchantWorld(1);
    const untouched = new SeededRandom(1);

    updateMerchantWeaponIntent(world, plan(1_000_000), GOLD_FARM_MS);

    expect(getMerchantWeaponIntent(world)).toMatchObject({
      enabled: false,
      decisionMade: false,
      status: 'pending',
    });
    expect(world.rng.next()).toBe(untouched.next());
  });

  it('makes one seeded decision per world and consumes selection RNG only on buy', () => {
    const buyWorld = completedMerchantWorld(1);
    configureMerchantWeaponPurchase(buyWorld, true);
    updateMerchantWeaponIntent(buyWorld, plan(1_000_000), GOLD_FARM_MS);
    const firstIntent = getMerchantWeaponIntent(buyWorld);
    updateMerchantWeaponIntent(buyWorld, plan(1_000_000), GOLD_FARM_MS);
    expect(getMerchantWeaponIntent(buyWorld)).toEqual(firstIntent);
    const buyControl = new SeededRandom(1);
    buyControl.next();
    buyControl.next();
    expect(buyWorld.rng.next()).toBe(buyControl.next());

    const declineWorld = completedMerchantWorld(2);
    configureMerchantWeaponPurchase(declineWorld, true);
    updateMerchantWeaponIntent(declineWorld, plan(1_000_000), GOLD_FARM_MS);
    updateMerchantWeaponIntent(declineWorld, plan(1_000_000), GOLD_FARM_MS);
    expect(getMerchantWeaponIntent(declineWorld).status).toBe('declined');
    const declineControl = new SeededRandom(2);
    declineControl.next();
    expect(declineWorld.rng.next()).toBe(declineControl.next());
  });

  it('implements a deterministic 50% branch and uniform seeded stock selection', () => {
    let buys = 0;
    const selectedCounts = [0, 0];
    const stock = [
      { itemId: 'iron-sword', cost: 20 },
      { itemId: 'frost-bow', cost: 20 },
    ] as const;

    for (let seed = 1; seed <= 1_000; seed += 1) {
      const rng = new SeededRandom(seed);
      if (rng.next() >= 0.5) continue;
      buys += 1;
      const world = createTestWorld({ seed });
      world.rng.next();
      const selected = selectMerchantWeapon(world, stock);
      if (selected?.itemId === stock[0].itemId) {
        selectedCounts[0]! += 1;
      } else if (selected?.itemId === stock[1].itemId) {
        selectedCounts[1]! += 1;
      }
    }

    expect(buys / 1_000).toBeGreaterThanOrEqual(0.49);
    expect(buys / 1_000).toBeLessThanOrEqual(0.51);
    expect(selectedCounts[0]! / buys).toBeGreaterThanOrEqual(0.45);
    expect(selectedCounts[0]! / buys).toBeLessThanOrEqual(0.55);
    expect(selectedCounts.reduce((sum, count) => sum + count, 0)).toBe(buys);
  });

  it('farms only while canonical planner slack covers the selected deficit', () => {
    const enoughSlack = completedMerchantWorld(1);
    configureMerchantWeaponPurchase(enoughSlack, true);
    updateMerchantWeaponIntent(enoughSlack, plan(1_000_000), GOLD_FARM_MS);
    const selected = getMerchantWeaponIntent(enoughSlack);
    expect(selected.status).toBe('farming');
    const deficit = selected.cost - enoughSlack.playerGold;

    updateMerchantWeaponIntent(enoughSlack, plan(deficit * GOLD_FARM_MS - 1), GOLD_FARM_MS);
    expect(getMerchantWeaponIntent(enoughSlack).status).toBe('abandoned');

    const noSlack = completedMerchantWorld(1);
    configureMerchantWeaponPurchase(noSlack, true);
    updateMerchantWeaponIntent(noSlack, plan(0), GOLD_FARM_MS);
    expect(getMerchantWeaponIntent(noSlack).status).toBe('abandoned');
  });

  it('uses the planner bundle verdict without charging its work against slack twice', () => {
    const includedWorld = completedMerchantWorld(1);
    configureMerchantWeaponPurchase(includedWorld, true);
    updateMerchantWeaponIntent(includedWorld, plan(1_000_000), GOLD_FARM_MS);
    updateMerchantWeaponIntent(
      includedWorld,
      {
        ...plan(0),
        includedOptionalBundleIds: ['merchant-weapon-purchase'],
      },
      GOLD_FARM_MS,
    );
    expect(getMerchantWeaponIntent(includedWorld).status).toBe('farming');

    const droppedWorld = completedMerchantWorld(1);
    configureMerchantWeaponPurchase(droppedWorld, true);
    updateMerchantWeaponIntent(droppedWorld, plan(1_000_000), GOLD_FARM_MS);
    updateMerchantWeaponIntent(
      droppedWorld,
      {
        ...plan(1_000_000),
        droppedOptionalBundleIds: ['merchant-weapon-purchase'],
      },
      GOLD_FARM_MS,
    );
    expect(getMerchantWeaponIntent(droppedWorld).status).toBe('abandoned');
  });

  it('buys once affordable and equips the selected weapon over the starter', () => {
    const world = completedMerchantWorld(1);
    // The AI equips through the same safe-context gate as the human equipment
    // panel; the shopkeeper stands in the safe welcome room.
    world.playerInSafeRoom = true;
    const playerEid = spawnPlayer(world, 0, 0);
    const starter = getEquipmentDefForStarterWeapon('baseball-bat')!;
    expect(equip(world, playerEid, starter, { force: true }).ok).toBe(true);

    configureMerchantWeaponPurchase(world, true);
    world.playerGold = 1_000;
    updateMerchantWeaponIntent(world, plan(1_000_000), GOLD_FARM_MS);
    const intent = getMerchantWeaponIntent(world);
    expect(intent.status).toBe('returning');
    expect(intent.itemId).toBeTruthy();
    const selectedWeaponId = getEquipmentDefForItem(intent.itemId!)?.weaponId;
    const goldBefore = world.playerGold;

    expect(executeMerchantWeaponPurchase(world, playerEid)).toBe(true);
    expect(getMerchantWeaponIntent(world).status).toBe('purchased');
    expect(getActiveWeaponDef(world)?.id).toBe(selectedWeaponId);
    expect(world.playerGold).toBe(goldBefore - intent.cost);
    expect(executeMerchantWeaponPurchase(world, playerEid)).toBe(false);
  });

  it('latches a bought-but-unequippable weapon and completes it on the next safe-room entry', () => {
    // Parity regression: equipping is safe-context gated, so a purchase
    // completed outside a safe room cannot equip on the spot. It must NOT be
    // abandoned — the gold is already spent and the weapon is in the bag.
    const world = completedMerchantWorld(1);
    world.playerInSafeRoom = false;
    const playerEid = spawnPlayer(world, 0, 0);
    configureMerchantWeaponPurchase(world, true);
    world.playerGold = 1_000;
    updateMerchantWeaponIntent(world, plan(1_000_000), GOLD_FARM_MS);
    const intent = getMerchantWeaponIntent(world);
    expect(intent.status).toBe('returning');
    const selectedWeaponId = getEquipmentDefForItem(intent.itemId!)?.weaponId;
    const goldBefore = world.playerGold;

    expect(executeMerchantWeaponPurchase(world, playerEid)).toBe(false);
    expect(getMerchantWeaponIntent(world).status).toBe('awaiting-equip');
    // Paid for, and not re-decided or abandoned.
    expect(world.playerGold).toBe(goldBefore - intent.cost);

    // A re-evaluation while awaiting the equip must not re-farm or abandon it.
    updateMerchantWeaponIntent(world, plan(1_000_000), GOLD_FARM_MS);
    expect(getMerchantWeaponIntent(world).status).toBe('awaiting-equip');

    // Walk into a safe room: the deferred equip completes without buying twice.
    world.playerInSafeRoom = true;
    expect(executeMerchantWeaponPurchase(world, playerEid)).toBe(true);
    expect(getMerchantWeaponIntent(world).status).toBe('purchased');
    expect(getActiveWeaponDef(world)?.id).toBe(selectedWeaponId);
    expect(world.playerGold).toBe(goldBefore - intent.cost);
  });

  it('uses the world seed stock and returns immediately when already affordable', () => {
    const world = completedMerchantWorld(1);
    configureMerchantWeaponPurchase(world, true);
    world.playerGold = 1_000;

    updateMerchantWeaponIntent(world, plan(0), GOLD_FARM_MS);

    const intent = getMerchantWeaponIntent(world);
    expect(intent.status).toBe('returning');
    expect(getShopkeeperPostQuestStock(world).some((entry) => entry.itemId === intent.itemId)).toBe(
      true,
    );
  });

  it('abandons the purchase intent after a hard purchase failure so it cannot loop forever', () => {
    const world = completedMerchantWorld(1);
    const playerEid = spawnPlayer(world, 0, 0);
    configureMerchantWeaponPurchase(world, true);
    world.playerGold = 1_000;
    updateMerchantWeaponIntent(world, plan(1_000_000), GOLD_FARM_MS);
    expect(getMerchantWeaponIntent(world).status).toBe('returning');

    // Simulate spending gold after intent latches returning so purchase can fail.
    world.playerGold = 0;
    expect(executeMerchantWeaponPurchase(world, playerEid)).toBe(false);
    expect(getMerchantWeaponIntent(world).status).toBe('abandoned');
    expect(executeMerchantWeaponPurchase(world, playerEid)).toBe(false);
  });

  it('configure off preserves latched decision, does not consume RNG or execute purchase, and re-enable resumes without a second decision', () => {
    // Seed 1 → buys (rng.next() < 0.5) and selects a weapon (one more rng step).
    const world = completedMerchantWorld(1);
    configureMerchantWeaponPurchase(world, true);
    updateMerchantWeaponIntent(world, plan(1_000_000), GOLD_FARM_MS);

    const decided = getMerchantWeaponIntent(world);
    expect(decided.decisionMade).toBe(true);
    const { itemId, cost, status } = decided;

    // Disable the toggle.
    configureMerchantWeaponPurchase(world, false);

    // Decision, item, and cost must be preserved even when disabled.
    expect(getMerchantWeaponIntent(world)).toMatchObject({
      enabled: false,
      decisionMade: true,
      itemId,
      cost,
      status,
    });

    // updateMerchantWeaponIntent while disabled must not consume RNG.
    // Seed 1 consumed exactly 2 RNG steps so far (buy/decline + stock selection).
    // Build a control that mirrors that and verify the next step matches.
    const control = new SeededRandom(1);
    control.next(); // buy/decline (seed 1 → buy)
    control.next(); // stock selection
    updateMerchantWeaponIntent(world, plan(1_000_000), GOLD_FARM_MS); // must be inert
    expect(world.rng.next()).toBe(control.next()); // positions are in sync → no extra steps consumed

    // executeMerchantWeaponPurchase must return false while disabled.
    const playerEid = spawnPlayer(world, 0, 0);
    world.playerGold = 10_000;
    expect(executeMerchantWeaponPurchase(world, playerEid)).toBe(false);

    // Re-enabling resumes the existing decision without making a new one.
    configureMerchantWeaponPurchase(world, true);
    const resumed = getMerchantWeaponIntent(world);
    expect(resumed.enabled).toBe(true);
    expect(resumed.decisionMade).toBe(true);
    expect(resumed.itemId).toBe(itemId);
    expect(resumed.cost).toBe(cost);

    // A further update must not change itemId or cost (decisionMade is already true).
    world.playerGold = 0;
    updateMerchantWeaponIntent(world, plan(1_000_000), GOLD_FARM_MS);
    const afterResume = getMerchantWeaponIntent(world);
    expect(afterResume.itemId).toBe(itemId);
    expect(afterResume.cost).toBe(cost);
  });
});
