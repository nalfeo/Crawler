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
  _MERCHANT_WEAPON_SWITCH_CHANCE,
  configureMerchantWeaponPurchase,
  executeMerchantWeaponPurchase,
  getMerchantWeaponIntent,
  _rollsMerchantWeaponSwitch,
  selectMerchantWeapon,
  updateMerchantWeaponIntent,
} from '../../src/game/ai/merchant-weapon-intent.js';
import type { Floor1RunPlan } from '../../src/game/ai/run-planner.js';
import { createTestWorld } from '../helpers/world-factory.js';

const GOLD_FARM_MS = 3_000;

function firstSeedWhere(predicate: (seed: number) => boolean): number {
  for (let seed = 1; seed <= 1_000; seed++) {
    if (predicate(seed)) return seed;
  }
  throw new Error('no seed satisfied the weapon-switch predicate within 1..1000');
}

/** A seed whose run is willing to switch weapon class, and one that is not. */
const SWITCH_SEED = firstSeedWhere(_rollsMerchantWeaponSwitch);
const DECLINE_SEED = firstSeedWhere((seed) => !_rollsMerchantWeaponSwitch(seed));

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
    const world = completedMerchantWorld(SWITCH_SEED);
    const untouched = new SeededRandom(SWITCH_SEED);

    updateMerchantWeaponIntent(world, plan(1_000_000), GOLD_FARM_MS);

    expect(getMerchantWeaponIntent(world)).toMatchObject({
      enabled: false,
      decisionMade: false,
      status: 'pending',
    });
    expect(world.rng.next()).toBe(untouched.next());
  });

  it('makes one stable decision per world and consumes no RNG', () => {
    // Switching weapon class is a run-defining pivot, so willingness is a
    // per-seed roll drawn from a dedicated stream: the same seed always decides
    // the same way, and the roll never perturbs the gameplay RNG stream. Once a
    // run is willing, the weapon itself is still budget-ranked, not random.
    const world = completedMerchantWorld(SWITCH_SEED);
    configureMerchantWeaponPurchase(world, true);
    updateMerchantWeaponIntent(world, plan(1_000_000), GOLD_FARM_MS);
    const firstIntent = getMerchantWeaponIntent(world);
    expect(firstIntent.decisionMade).toBe(true);
    expect(firstIntent.status).not.toBe('declined');
    updateMerchantWeaponIntent(world, plan(1_000_000), GOLD_FARM_MS);
    expect(getMerchantWeaponIntent(world)).toEqual(firstIntent);

    expect(world.rng.next()).toBe(new SeededRandom(SWITCH_SEED).next());
  });

  it('declines the switch entirely on a run that did not roll for it', () => {
    const world = completedMerchantWorld(DECLINE_SEED);
    const playerEid = spawnPlayer(world, 0, 0);
    configureMerchantWeaponPurchase(world, true);
    world.playerGold = 10_000;

    updateMerchantWeaponIntent(world, plan(1_000_000), GOLD_FARM_MS);

    const intent = getMerchantWeaponIntent(world);
    expect(intent.decisionMade).toBe(true);
    expect(intent.status).toBe('declined');
    expect(intent.itemId).toBeNull();
    // A declined run never buys, no matter how rich it gets later.
    expect(executeMerchantWeaponPurchase(world, playerEid)).toBe(false);
    updateMerchantWeaponIntent(world, plan(1_000_000), GOLD_FARM_MS);
    expect(getMerchantWeaponIntent(world).status).toBe('declined');
    // The decline is recorded as a vendor decision, not silently dropped.
    expect(world.vendorLedger.decisions).toContainEqual(
      expect.objectContaining({
        vendorId: 'floor1-merchant',
        outcome: 'declined',
        reason: 'no-weapon-class-switch-this-run',
      }),
    );
    // ...and it consumes no gameplay RNG.
    expect(world.rng.next()).toBe(new SeededRandom(DECLINE_SEED).next());
  });

  it('rolls willingness deterministically at roughly the configured rate', () => {
    const seeds = Array.from({ length: 1_000 }, (_, i) => i + 1);
    const willing = seeds.filter((seed) => _rollsMerchantWeaponSwitch(seed));
    const rate = willing.length / seeds.length;
    expect(Math.abs(rate - _MERCHANT_WEAPON_SWITCH_CHANCE)).toBeLessThanOrEqual(0.05);
    // The switch must stay a choice, never a certainty, and the designer set a
    // hard ceiling of 50%: at most half the runs may be willing to re-class.
    // Raising this is a design decision, not a tuning fix for a failing gate.
    expect(_MERCHANT_WEAPON_SWITCH_CHANCE).toBeGreaterThan(0);
    expect(_MERCHANT_WEAPON_SWITCH_CHANCE).toBeLessThanOrEqual(0.5);
    // Both outcomes must be reachable on the contiguous low-seed prefix the
    // headless gates sample, not only far out in the seed space.
    const prefix = seeds.slice(0, 25).filter((seed) => _rollsMerchantWeaponSwitch(seed));
    expect(prefix.length).toBeGreaterThan(0);
    expect(prefix.length).toBeLessThan(25);
    // Stable across calls.
    expect(seeds.filter((seed) => _rollsMerchantWeaponSwitch(seed))).toEqual(willing);
  });

  it('ranks stock by value within budget and never picks above it', () => {
    const stock = [
      { itemId: 'throwing-knife', cost: 140 },
      { itemId: 'plasma-pistol', cost: 250 },
      { itemId: 'iron-sword', cost: 185 },
    ] as const;

    const rich = completedMerchantWorld(SWITCH_SEED);
    rich.playerGold = 1_000;
    expect(selectMerchantWeapon(rich, stock)?.itemId).toBe('plasma-pistol');

    // Budget between two tiers: takes the best it can actually afford.
    const midway = completedMerchantWorld(SWITCH_SEED);
    midway.playerGold = 200;
    expect(selectMerchantWeapon(midway, stock)?.itemId).toBe('iron-sword');

    // Broke: targets the cheapest item, i.e. the smallest deficit to farm.
    const broke = completedMerchantWorld(SWITCH_SEED);
    broke.playerGold = 0;
    expect(selectMerchantWeapon(broke, stock)?.itemId).toBe('throwing-knife');

    // Stock order must not matter.
    const reversed = [...stock].reverse();
    expect(selectMerchantWeapon(midway, reversed)?.itemId).toBe('iron-sword');
    expect(selectMerchantWeapon(rich, [])).toBeNull();
  });

  it('farms only while canonical planner slack covers the selected deficit', () => {
    const enoughSlack = completedMerchantWorld(SWITCH_SEED);
    configureMerchantWeaponPurchase(enoughSlack, true);
    updateMerchantWeaponIntent(enoughSlack, plan(1_000_000), GOLD_FARM_MS);
    const selected = getMerchantWeaponIntent(enoughSlack);
    expect(selected.status).toBe('farming');
    const deficit = selected.cost - enoughSlack.playerGold;

    updateMerchantWeaponIntent(enoughSlack, plan(deficit * GOLD_FARM_MS - 1), GOLD_FARM_MS);
    expect(getMerchantWeaponIntent(enoughSlack).status).toBe('abandoned');

    const noSlack = completedMerchantWorld(SWITCH_SEED);
    configureMerchantWeaponPurchase(noSlack, true);
    updateMerchantWeaponIntent(noSlack, plan(0), GOLD_FARM_MS);
    expect(getMerchantWeaponIntent(noSlack).status).toBe('abandoned');
  });

  it('uses the planner bundle verdict without charging its work against slack twice', () => {
    const includedWorld = completedMerchantWorld(SWITCH_SEED);
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

    const droppedWorld = completedMerchantWorld(SWITCH_SEED);
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
    const world = completedMerchantWorld(SWITCH_SEED);
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
    const world = completedMerchantWorld(SWITCH_SEED);
    configureMerchantWeaponPurchase(world, true);
    world.playerGold = 1_000;

    updateMerchantWeaponIntent(world, plan(0), GOLD_FARM_MS);

    const intent = getMerchantWeaponIntent(world);
    expect(intent.status).toBe('returning');
    expect(getShopkeeperPostQuestStock(world).some((entry) => entry.itemId === intent.itemId)).toBe(
      true,
    );
  });

  it('abandons on a hard purchase failure but stays retryable when merely short on gold', () => {
    const world = completedMerchantWorld(SWITCH_SEED);
    const playerEid = spawnPlayer(world, 0, 0);
    configureMerchantWeaponPurchase(world, true);
    world.playerGold = 1_000;
    updateMerchantWeaponIntent(world, plan(1_000_000), GOLD_FARM_MS);
    expect(getMerchantWeaponIntent(world).status).toBe('returning');

    // Being short on gold is a *temporary* condition — gold only ever grows
    // during a run, so the intent must stay live and buy once it can afford the
    // weapon on top of any reserve held for the higher-value spell.
    world.playerGold = 0;
    expect(executeMerchantWeaponPurchase(world, playerEid)).toBe(false);
    expect(getMerchantWeaponIntent(world).status).toBe('returning');

    // A hard failure (no inventory to receive the item) cannot resolve by
    // waiting, so it abandons instead of retrying forever.
    world.playerGold = 1_000;
    expect(executeMerchantWeaponPurchase(world, playerEid + 999)).toBe(false);
    expect(getMerchantWeaponIntent(world).status).toBe('abandoned');
  });

  it('configure off preserves latched decision, does not consume RNG or execute purchase, and re-enable resumes without a second decision', () => {
    const world = completedMerchantWorld(SWITCH_SEED);
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

    // The intent consumes no RNG at all, enabled or not: the stream position is
    // still exactly where a fresh seeded stream would be.
    updateMerchantWeaponIntent(world, plan(1_000_000), GOLD_FARM_MS); // must be inert
    expect(world.rng.next()).toBe(new SeededRandom(SWITCH_SEED).next());

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
