import { query, setComponent } from 'bitecs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { BroadcastRelayRaider, BuildCurrencyPickup, Health, Player } from '../../src/core/index.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { createSpatialHashGrid } from '../../src/core/collision.js';
import { itemPickupSystem } from '../../src/core/systems/itemPickupSystem.js';
import {
  floor6DefenseDirectorSystem,
  getFloor6DefenseRunStats,
  getFloor6UpgradeOffers,
  purchaseFloor6UpgradeOffer,
} from '../../src/game/floor6Scenario.js';
import { floor6Manifest } from '../../src/shared/floor-manifest.js';
import { createTestWorld } from '../helpers/world-factory.js';

function initFloor6(seed = 606) {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  createFloorMainSceneOptions('floor6').configureWorld!(world, player);
  return { world, player };
}

function tickDirector(world: ReturnType<typeof createTestWorld>, ticks = 1): void {
  for (let i = 0; i < ticks; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += 16;
    floor6DefenseDirectorSystem(world);
  }
}

function defenseState(world: ReturnType<typeof createTestWorld>) {
  const state = world.floorExtendedState?.floor6Defense;
  if (!state) throw new Error('Floor 6 state missing');
  return state;
}

function releaseFirstWave(world: ReturnType<typeof createTestWorld>): void {
  tickDirector(world);
  const state = defenseState(world);
  const lastOpeningRelease =
    state.waveManifest?.filter((entry) => entry.waveIndex === 0).at(-1)?.releaseTick ?? 180;
  while (world.frameCount <= lastOpeningRelease) {
    tickDirector(world);
  }
}

function killRaidersForWave(world: ReturnType<typeof createTestWorld>, waveIndex: number): void {
  const state = defenseState(world);
  for (const eid of query(world.ecs, [BroadcastRelayRaider, Health])) {
    const manifestIndex = world.stores.broadcastRelayRaider.manifestIndex[eid] ?? -1;
    if (state.waveManifest?.[manifestIndex]?.waveIndex === waveIndex) {
      setComponent(world.ecs, eid, Health, {
        current: 0,
        max: world.stores.health.max[eid] ?? 1,
      });
    }
  }
  tickDirector(world);
}

describe('Floor 6 run-scoped economy and upgrade offers', () => {
  it('loads authored enemy, wave, and upgrade economy data from the validated manifest', () => {
    const floor6 = floor6Manifest.floor6;
    expect(floor6?.economy?.buildCurrencyId).toBe('requisition');
    expect(floor6?.economy?.enemyRewards.map((reward) => reward.archetypeId)).toEqual([
      'floor6-site-prep',
      'floor6-demo-lead',
      'floor6-cable-crew',
    ]);
    expect(floor6?.economy?.waveRewards.map((reward) => reward.waveIndex)).toEqual([0, 1, 2]);
    expect(floor6?.upgrades?.offers.every((offer) => offer.effect.kind.length > 0)).toBe(true);
  });

  it('generates deterministic without-replacement offers from the isolated upgrades stream', () => {
    const { world: a } = initFloor6(606);
    const { world: b } = initFloor6(606);
    const { world: combatRngPerturbed } = initFloor6(606);

    combatRngPerturbed.rng.next();
    combatRngPerturbed.rng.next();
    tickDirector(a);
    tickDirector(b);
    tickDirector(combatRngPerturbed);

    const offersA = getFloor6UpgradeOffers(a);
    expect(offersA).toEqual(getFloor6UpgradeOffers(b));
    expect(offersA).toEqual(getFloor6UpgradeOffers(combatRngPerturbed));
    expect(new Set(offersA.map((offer) => offer.offerId)).size).toBe(offersA.length);
    expect(offersA).toHaveLength(floor6Manifest.floor6?.upgrades?.offerCount ?? 0);
  });

  it('keeps rejected, duplicate, and unaffordable purchase attempts atomic no-ops', () => {
    const { world } = initFloor6(606);
    tickDirector(world);
    const state = defenseState(world);
    const offer = getFloor6UpgradeOffers(world)[0]!;

    expect(purchaseFloor6UpgradeOffer(world, 'missing-offer')).toEqual({
      ok: false,
      reason: 'unknown-offer',
    });
    expect(state.economy.balance).toBe(0);
    expect(state.economy.totalSpent).toBe(0);

    expect(purchaseFloor6UpgradeOffer(world, offer.offerId)).toEqual({
      ok: false,
      reason: 'unaffordable',
    });
    expect(state.economy.balance).toBe(0);
    expect(state.economy.totalSpent).toBe(0);

    state.economy.balance = offer.cost;
    state.economy.totalEarned = offer.cost;
    expect(purchaseFloor6UpgradeOffer(world, offer.offerId)).toEqual({
      ok: true,
      reason: 'purchased',
    });
    expect(state.economy.balance).toBe(0);
    expect(state.economy.totalSpent).toBe(offer.cost);
    expect(state.economy.selectedOfferIds).toEqual([offer.offerId]);

    expect(purchaseFloor6UpgradeOffer(world, offer.offerId)).toEqual({
      ok: false,
      reason: 'duplicate',
    });
    expect(state.economy.balance).toBe(0);
    expect(state.economy.totalSpent).toBe(offer.cost);
    expect(state.economy.selectedOfferIds).toEqual([offer.offerId]);
  });

  it('wave-clear rewards unlock an upgrade even when enemy build-currency pickups are missed', () => {
    const { world } = initFloor6(606);
    releaseFirstWave(world);
    killRaidersForWave(world, 0);

    const stats = getFloor6DefenseRunStats(world);
    expect(stats?.buildCurrencyEarnedFromPickups).toBe(0);
    expect(stats?.buildCurrencyPickupsSpawned).toBe(3);
    expect(stats?.buildCurrencyBalance).toBe(4);
    expect(stats?.unlockedOfferIds.length).toBeGreaterThanOrEqual(1);
  });

  it('does not credit wave-clear currency for stalled raiders that are still alive', () => {
    const { world } = initFloor6(606);
    releaseFirstWave(world);
    const state = defenseState(world);
    for (const record of state.liveEnemies) {
      record.stallResolved = true;
    }
    tickDirector(world);

    expect(query(world.ecs, [BroadcastRelayRaider, Health]).length).toBe(3);
    expect(getFloor6DefenseRunStats(world)?.buildCurrencyEarnedFromWaves).toBe(0);
    expect(getFloor6DefenseRunStats(world)?.buildCurrencyBalance).toBe(0);
  });

  it('rewards a stalled raider if it later dies', () => {
    const { world } = initFloor6(606);
    releaseFirstWave(world);
    const state = defenseState(world);
    const firstRaider = Array.from(query(world.ecs, [BroadcastRelayRaider, Health]))[0]!;
    const manifestIndex = world.stores.broadcastRelayRaider.manifestIndex[firstRaider] ?? 0;
    state.liveEnemies[manifestIndex]!.stallResolved = true;

    setComponent(world.ecs, firstRaider, Health, {
      current: 0,
      max: world.stores.health.max[firstRaider] ?? 1,
    });
    tickDirector(world);

    expect(query(world.ecs, [BuildCurrencyPickup]).length).toBe(1);
    expect(state.liveEnemies[manifestIndex]?.defeated).toBe(true);
  });

  it('collects build currency separately from ordinary gold', () => {
    const { world, player } = initFloor6(606);
    releaseFirstWave(world);
    const firstRaider = Array.from(query(world.ecs, [BroadcastRelayRaider, Health]))[0]!;
    const manifestIndex = world.stores.broadcastRelayRaider.manifestIndex[firstRaider] ?? 0;
    const expectedValue =
      defenseState(world).waveManifest?.[manifestIndex]?.buildCurrencyReward ?? 0;

    setComponent(world.ecs, firstRaider, Health, {
      current: 0,
      max: world.stores.health.max[firstRaider] ?? 1,
    });
    tickDirector(world);
    const pickup = Array.from(query(world.ecs, [BuildCurrencyPickup]))[0]!;
    itemPickupSystem(world, {
      pairs: [{ a: player, b: pickup }],
      grid: createSpatialHashGrid(),
    });

    expect(world.playerGold).toBe(0);
    expect(defenseState(world).economy.balance).toBe(expectedValue);
    expect(defenseState(world).economy.earnedFromPickups).toBe(expectedValue);
    expect(query(world.ecs, [BuildCurrencyPickup])).toEqual([]);
    expect(world.stores.buildCurrencyPickup.value[pickup]).toBe(0);
  });

  it('terminal cleanup clears floor-scoped currency, offers, and pickups once', () => {
    const { world, player } = initFloor6(606);
    releaseFirstWave(world);
    killRaidersForWave(world, 0);
    expect(query(world.ecs, [BuildCurrencyPickup]).length).toBeGreaterThan(0);

    setComponent(world.ecs, player, Health, { current: 0, max: 100 });
    tickDirector(world);

    const stats = getFloor6DefenseRunStats(world);
    expect(stats?.phase.kind).toBe('DEFEAT');
    expect(stats?.terminalResetCount).toBe(1);
    expect(stats?.buildCurrencyBalance).toBe(0);
    expect(stats?.selectedOfferIds).toEqual([]);
    expect(stats?.upgradeOffers).toEqual([]);
    expect(query(world.ecs, [BuildCurrencyPickup])).toEqual([]);
  });

  it('preserves terminal reset telemetry across a new SETUP transition in the same world', () => {
    const { world, player } = initFloor6(606);
    tickDirector(world);
    setComponent(world.ecs, player, Health, { current: 0, max: 100 });
    tickDirector(world);
    const state = defenseState(world);
    expect(state.economy.terminalResetCount).toBe(1);

    state.phase = { kind: 'SETUP' };
    setComponent(world.ecs, player, Health, { current: 100, max: 100 });
    tickDirector(world);

    expect(getFloor6DefenseRunStats(world)?.terminalResetCount).toBe(1);
  });

  it('clears stale defeated liveEnemies records on a same-world SETUP restart', () => {
    const { world, player } = initFloor6(606);
    releaseFirstWave(world);
    killRaidersForWave(world, 0);
    const stateBeforeRestart = defenseState(world);
    // Sanity: killing the wave really did mark manifestIndex 0 defeated —
    // otherwise this test would pass vacuously.
    expect(stateBeforeRestart.liveEnemies[0]?.defeated).toBe(true);

    setComponent(world.ecs, player, Health, { current: 0, max: 100 });
    tickDirector(world);
    expect(defenseState(world).phase.kind).toBe('DEFEAT');

    defenseState(world).phase = { kind: 'SETUP' };
    setComponent(world.ecs, player, Health, { current: 100, max: 100 });
    tickDirector(world);

    const restartedState = defenseState(world);
    expect(restartedState.phase.kind).toBe('DEFEND');
    expect(restartedState.liveEnemies).toEqual([]);

    // Release the new run's opening wave and confirm the manifestIndex-0
    // raider is tracked fresh: a stale `defeated: true` record would make
    // reconciliation skip it, award wave currency immediately, and never
    // spawn its death pickup.
    releaseFirstWave(world);
    const record = defenseState(world).liveEnemies[0];
    expect(record?.defeated).toBe(false);
    expect(record?.eid).toBeGreaterThan(0);
    expect(defenseState(world).economy.rewardedWaveIndexes).toEqual([]);
  });

  it('preserves conservation and non-negative balances across arbitrary purchase traces', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30 }),
        fc.array(
          fc.constantFrom('faster-loader', 'route-sweeper', 'spare-batteries', 'missing-offer'),
          { maxLength: 12 },
        ),
        (startingBalance, offerIds) => {
          const { world } = initFloor6(606);
          tickDirector(world);
          const state = defenseState(world);
          state.economy.balance = startingBalance;
          state.economy.totalEarned = startingBalance;

          for (const offerId of offerIds) {
            purchaseFloor6UpgradeOffer(world, offerId);
            expect(state.economy.balance).toBeGreaterThanOrEqual(0);
            expect(state.economy.totalSpent).toBeGreaterThanOrEqual(0);
          }

          expect(state.economy.totalEarned).toBe(state.economy.balance + state.economy.totalSpent);
        },
      ),
    );
  });

  it('caps upgrade selection telemetry while preserving atomic balances', () => {
    const { world } = initFloor6(606);
    tickDirector(world);
    const state = defenseState(world);
    for (let i = 0; i < 80; i += 1) {
      purchaseFloor6UpgradeOffer(world, 'missing-offer');
    }

    expect(state.economy.selectionTrace).toHaveLength(64);
    expect(state.economy.balance).toBe(0);
    expect(state.economy.totalSpent).toBe(0);
  });

  it('returns an atomic no-op outside Floor 6', () => {
    const world = createTestWorld({ seed: 42 });
    spawnPlayer(world, 0, 0);

    expect(query(world.ecs, [Player])).toHaveLength(1);
    expect(purchaseFloor6UpgradeOffer(world, 'faster-loader')).toEqual({
      ok: false,
      reason: 'not-floor6',
    });
  });
});
