import { query, setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import {
  BroadcastRelayRaider,
  Floor6Tower,
  Floor6TowerEffect,
  Health,
  Position,
} from '../../src/core/index.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  buildFloor6Tower,
  floor6DefenseDirectorSystem,
  floor6TowerSystem,
  getFloor6DefenseRunStats,
  getFloor6TowerRoster,
  purchaseFloor6UpgradeOffer,
  sellFloor6Tower,
  upgradeFloor6Tower,
} from '../../src/game/floor6Scenario.js';
import type { FloorMap } from '../../src/core/map/FloorMap.js';
import { createTestWorld } from '../helpers/world-factory.js';

function initFloor6(seed = 606) {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  createFloorMainSceneOptions('floor6').configureWorld!(world, player);
  tickDirector(world);
  return { world, player };
}

function tickDirector(world: ReturnType<typeof createTestWorld>, ticks = 1): void {
  for (let i = 0; i < ticks; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += 16;
    floor6DefenseDirectorSystem(world);
  }
}

function releaseFirstWave(world: ReturnType<typeof createTestWorld>): void {
  const state = floor6State(world);
  const lastOpeningRelease =
    state.waveManifest?.filter((entry) => entry.waveIndex === 0).at(-1)?.releaseTick ?? 180;
  while (world.frameCount <= lastOpeningRelease) {
    tickDirector(world);
  }
}

function floor6State(world: ReturnType<typeof createTestWorld>) {
  const state = world.floorExtendedState?.floor6Defense;
  if (!state) throw new Error('Floor 6 state missing');
  return state;
}

function grantBuildCurrency(world: ReturnType<typeof createTestWorld>, amount = 999): void {
  const state = floor6State(world);
  state.economy.balance = amount;
  state.economy.totalEarned = Math.max(state.economy.totalEarned, amount);
}

function buildStarterRoster(world: ReturnType<typeof createTestWorld>): void {
  grantBuildCurrency(world);
  const state = floor6State(world);
  for (const [index, tower] of getFloor6TowerRoster(world).entries()) {
    expect(buildFloor6Tower(world, state.towers.sites[index]!.siteId, tower.id)).toEqual({
      ok: true,
      reason: 'built',
    });
  }
}

function setRaiderPosition(
  world: ReturnType<typeof createTestWorld>,
  eid: number,
  x: number,
  y: number,
): void {
  setComponent(world.ecs, eid, Position, { x, y });
}

function findBlockedPointWithinRange(map: FloorMap, x: number, y: number, rangeFt: number) {
  const origin = map.worldToTile(x, y);
  const rangeTiles = Math.floor(rangeFt / map.config.tileSizeFt);
  for (let dy = -rangeTiles; dy <= rangeTiles; dy += 1) {
    for (let dx = -rangeTiles; dx <= rangeTiles; dx += 1) {
      const tx = origin.x + dx;
      const ty = origin.y + dy;
      if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) continue;
      const point = map.tileToWorld(tx, ty);
      if (Math.hypot(point.x - x, point.y - y) > rangeFt) continue;
      if (!map.hasLineOfSight(x, y, point.x, point.y)) return point;
    }
  }
  throw new Error('No blocked point found inside tower range');
}

describe('Floor 6 authored-site tower contracts', () => {
  it('loads the approved starter tower roster as validated manifest data', () => {
    const { world } = initFloor6();

    expect(getFloor6TowerRoster(world).map((tower) => tower.id)).toEqual([
      'spotlight-lancer',
      'cable-snare',
      'ratings-mortar',
    ]);
    expect(getFloor6TowerRoster(world).map((tower) => tower.stableIndex)).toEqual([0, 1, 2]);
    expect(getFloor6DefenseRunStats(world)?.towers.sites.map((site) => site.siteId)).toEqual(
      floor6State(world).geometry.buildSites.map((site) => site.id),
    );
  });

  it('builds every starter tower on authored sites without changing route topology', () => {
    const { world } = initFloor6();
    const routeFlagsBefore = [...world.floorMap!.tileMap.flags];

    buildStarterRoster(world);

    expect(query(world.ecs, [Floor6Tower]).length).toBe(getFloor6TowerRoster(world).length);
    expect([...world.floorMap!.tileMap.flags]).toEqual(routeFlagsBefore);
    expect(getFloor6DefenseRunStats(world)?.towers.builds).toBe(getFloor6TowerRoster(world).length);
  });

  it('rejects illegal, unaffordable, and double-occupancy builds atomically', () => {
    const { world } = initFloor6();
    const state = floor6State(world);
    const site = state.towers.sites[0]!;
    const tower = getFloor6TowerRoster(world)[0]!;

    expect(buildFloor6Tower(world, 'missing-site', tower.id)).toEqual({
      ok: false,
      reason: 'unknown-site',
    });
    expect(buildFloor6Tower(world, site.siteId, 'missing-tower')).toEqual({
      ok: false,
      reason: 'unknown-tower',
    });
    expect(buildFloor6Tower(world, site.siteId, tower.id)).toEqual({
      ok: false,
      reason: 'unaffordable',
    });
    expect(state.economy.balance).toBe(0);
    expect(query(world.ecs, [Floor6Tower])).toEqual([]);

    grantBuildCurrency(world, tower.cost);
    expect(buildFloor6Tower(world, site.siteId, tower.id)).toEqual({ ok: true, reason: 'built' });
    const balanceAfterBuild = state.economy.balance;
    expect(buildFloor6Tower(world, site.siteId, getFloor6TowerRoster(world)[1]!.id)).toEqual({
      ok: false,
      reason: 'occupied',
    });
    expect(state.economy.balance).toBe(balanceAfterBuild);
    expect(site.towerId).toBe(tower.id);
    expect(query(world.ecs, [Floor6Tower]).length).toBe(1);
  });

  it('applies each tower site upgrade exactly once and rejects extra upgrades', () => {
    const { world } = initFloor6();
    buildStarterRoster(world);
    const state = floor6State(world);
    let expectedUpgrades = 0;

    for (const [index, tower] of getFloor6TowerRoster(world).entries()) {
      const site = state.towers.sites[index]!;
      for (const _upgrade of tower.upgrades) {
        expect(upgradeFloor6Tower(world, site.siteId)).toEqual({ ok: true, reason: 'upgraded' });
        expectedUpgrades += 1;
      }
      expect(upgradeFloor6Tower(world, site.siteId)).toEqual({
        ok: false,
        reason: 'max-upgrade',
      });
      expect(site.upgradeLevel).toBe(tower.upgrades.length);
    }

    expect(getFloor6DefenseRunStats(world)?.towers.upgrades).toBe(expectedUpgrades);
  });

  it('applies purchased global upgrade effects exactly once', () => {
    const { world } = initFloor6();
    grantBuildCurrency(world);
    const state = floor6State(world);

    for (const offer of state.upgradeOfferManifest ?? []) {
      expect(purchaseFloor6UpgradeOffer(world, offer.offerId)).toEqual({
        ok: true,
        reason: 'purchased',
      });
      expect(purchaseFloor6UpgradeOffer(world, offer.offerId)).toEqual({
        ok: false,
        reason: 'duplicate',
      });
    }

    const stats = getFloor6DefenseRunStats(world)!.towers;
    expect(stats.appliedUpgradeOfferIds).toEqual(state.economy.selectedOfferIds);
    expect(new Set(stats.appliedUpgradeOfferIds).size).toBe(stats.appliedUpgradeOfferIds.length);
    expect(
      stats.towerDamageBonus +
        stats.towerFireRateBonus +
        stats.relayMaxHpBonus +
        stats.raiderSlowBonus,
    ).toBeGreaterThan(0);
  });

  it('chooses a stable legal target under distance ties', () => {
    const { world } = initFloor6();
    releaseFirstWave(world);
    buildStarterRoster(world);
    const state = floor6State(world);
    const site = state.towers.sites[0]!;
    const towerEid = site.towerEid;
    const tx = world.stores.position.x[towerEid] ?? 0;
    const ty = world.stores.position.y[towerEid] ?? 0;
    const raiders = Array.from(query(world.ecs, [BroadcastRelayRaider, Health]));
    setRaiderPosition(world, raiders[0]!, tx - 4, ty);
    setRaiderPosition(world, raiders[1]!, tx + 4, ty);
    setComponent(world.ecs, raiders[2]!, Health, { current: 0, max: 1 });

    floor6TowerSystem(world);

    expect(getFloor6DefenseRunStats(world)?.towers.combatTrace.at(-1)).toMatchObject({
      siteId: site.siteId,
      targetManifestIndex: 0,
    });
  });

  it('skips blocked line-of-sight targets even when they are first in the tie order', () => {
    const { world } = initFloor6();
    releaseFirstWave(world);
    buildStarterRoster(world);
    const state = floor6State(world);
    const site = state.towers.sites[2]!;
    const towerEid = site.towerEid;
    const tx = world.stores.position.x[towerEid] ?? 0;
    const ty = world.stores.position.y[towerEid] ?? 0;
    const tower = getFloor6TowerRoster(world)[2]!;
    const blocked = findBlockedPointWithinRange(world.floorMap!, tx, ty, tower.rangeFt);
    const raiders = Array.from(query(world.ecs, [BroadcastRelayRaider, Health]));
    setRaiderPosition(world, raiders[0]!, blocked.x, blocked.y);
    setRaiderPosition(world, raiders[1]!, tx + 4, ty);
    setComponent(world.ecs, raiders[2]!, Health, { current: 0, max: 1 });

    floor6TowerSystem(world);

    expect(getFloor6DefenseRunStats(world)?.towers.combatTrace.at(-1)).toMatchObject({
      siteId: site.siteId,
      targetManifestIndex: 1,
    });
  });

  it('bounds tower shot effects and clears all floor-scoped tower entities on terminal teardown', () => {
    const { world, player } = initFloor6();
    releaseFirstWave(world);
    buildStarterRoster(world);
    const towerEid = floor6State(world).towers.sites[2]!.towerEid;
    const target = Array.from(query(world.ecs, [BroadcastRelayRaider, Health]))[0]!;
    setComponent(world.ecs, target, Health, { current: 999, max: 999 });
    setRaiderPosition(
      world,
      target,
      (world.stores.position.x[towerEid] ?? 0) + 4,
      world.stores.position.y[towerEid] ?? 0,
    );

    for (let i = 0; i < 5; i += 1) {
      world.elapsedMs += 1_000;
      floor6TowerSystem(world);
    }

    const statsBeforeTerminal = getFloor6DefenseRunStats(world)!.towers;
    expect(query(world.ecs, [Floor6TowerEffect]).length).toBeLessThanOrEqual(
      getFloor6TowerRoster(world)[2]!.effectLimit,
    );
    expect(statsBeforeTerminal.effectsDeniedByCap).toBeGreaterThan(0);

    setComponent(world.ecs, player, Health, { current: 0, max: 100 });
    tickDirector(world);

    expect(query(world.ecs, [Floor6Tower])).toEqual([]);
    expect(query(world.ecs, [Floor6TowerEffect])).toEqual([]);
    expect(
      getFloor6DefenseRunStats(world)?.towers.sites.every((site) => site.towerId === null),
    ).toBe(true);
  });

  it('sells built towers through an atomic floor-scoped transaction', () => {
    const { world } = initFloor6();
    const siteId = floor6State(world).towers.sites[0]!.siteId;
    const tower = getFloor6TowerRoster(world)[0]!;
    grantBuildCurrency(world, tower.cost);
    expect(buildFloor6Tower(world, siteId, tower.id)).toEqual({ ok: true, reason: 'built' });

    expect(sellFloor6Tower(world, siteId)).toEqual({ ok: true, reason: 'sold' });
    expect(query(world.ecs, [Floor6Tower])).toEqual([]);
    expect(floor6State(world).economy.balance).toBe(Math.floor(tower.cost / 2));
    expect(sellFloor6Tower(world, siteId)).toEqual({ ok: false, reason: 'empty-site' });
  });
});
