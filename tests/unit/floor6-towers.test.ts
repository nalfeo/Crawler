import { addComponent, entityExists, hasComponent, set, setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { BroadcastRelayRaider, Floor6Tower, Health, Position } from '../../src/core/index.js';
import { createEntity, spawnPlayer } from '../../src/core/helpers.js';
import {
  buildFloor6Tower,
  floor6DefenseDirectorSystem,
  floor6TowerSystem,
  getFloor6TowerRoster,
  purchaseFloor6UpgradeOffer,
  selectFloor6TowerTarget,
  sellFloor6Tower,
} from '../../src/game/floor6Scenario.js';
import { createTestWorld } from '../helpers/world-factory.js';

function initFloor6() {
  const world = createTestWorld({ seed: 606 });
  const player = spawnPlayer(world, 0, 0);
  createFloorMainSceneOptions('floor6').configureWorld!(world, player);
  world.frameCount += 1;
  world.elapsedMs += 16;
  floor6DefenseDirectorSystem(world);
  const defense = world.floorExtendedState?.floor6Defense;
  if (!defense) throw new Error('Floor 6 state missing');
  return { world, player, defense };
}

describe('Floor 6 authored tower construction', () => {
  it('builds every starter tower only on vacant authored sites without changing routes', () => {
    const { world, defense } = initFloor6();
    defense.economy.balance = 100;
    defense.economy.totalEarned = 100;
    const routeFlags = [...world.floorMap!.tileMap.flags];
    const towers = getFloor6TowerRoster();

    for (const [index, tower] of towers.entries()) {
      expect(
        buildFloor6Tower(world, defense.geometry.buildSites[index]!.id, tower.id),
      ).toMatchObject({
        ok: true,
        reason: 'built',
      });
    }
    const firstSite = defense.geometry.buildSites[0]!.id;
    const balance = defense.economy.balance;
    expect(buildFloor6Tower(world, firstSite, towers[0]!.id)).toEqual({
      ok: false,
      reason: 'occupied',
    });
    expect(buildFloor6Tower(world, 'not-a-site', towers[0]!.id)).toEqual({
      ok: false,
      reason: 'invalid-site',
    });
    expect(defense.economy.balance).toBe(balance);
    expect(defense.towerInstances).toHaveLength(towers.length);
    expect([...world.floorMap!.tileMap.flags]).toEqual(routeFlags);
  });

  it('selects stable legal targets and applies tower damage through the combat primitive', () => {
    const { world, defense } = initFloor6();
    defense.economy.balance = 10;
    const built = buildFloor6Tower(world, defense.geometry.buildSites[4]!.id, 'signal-slinger');
    expect(built.ok).toBe(true);
    const towerEid = built.eid!;
    const first = createEntity(world);
    const second = createEntity(world);
    for (const eid of [first, second]) {
      addComponent(world.ecs, eid, set(BroadcastRelayRaider, { manifestIndex: 0 }));
      addComponent(world.ecs, eid, set(Health, { current: 20, max: 20 }));
      addComponent(world.ecs, eid, set(Position, { x: 178, y: 102 }));
    }
    expect(selectFloor6TowerTarget(world, towerEid, 36)).toBe(Math.min(first, second));
    floor6TowerSystem(world);
    const target = Math.min(first, second);
    expect(world.stores.health.current[target]).toBeLessThan(20);
    expect(world.stores.health.current[Math.max(first, second)]).toBe(20);
  });

  it('sells and terminally tears down all tower entities exactly once', () => {
    const { world, player, defense } = initFloor6();
    defense.economy.balance = 20;
    const siteA = defense.geometry.buildSites[0]!.id;
    const siteB = defense.geometry.buildSites[1]!.id;
    const a = buildFloor6Tower(world, siteA, 'signal-slinger').eid!;
    const b = buildFloor6Tower(world, siteB, 'relay-riveter').eid!;
    expect(sellFloor6Tower(world, siteA)).toEqual({ ok: true, reason: 'sold' });
    expect(hasComponent(world.ecs, a, Floor6Tower)).toBe(false);
    setComponent(world.ecs, player, Health, { current: 0, max: 100 });
    floor6DefenseDirectorSystem(world);
    expect(entityExists(world.ecs, b)).toBe(false);
    expect(defense.towerInstances).toEqual([]);
    expect(defense.towersTornDown).toBe(2);
  });

  it('applies each selected upgrade once and preserves an identical tower combat trace', () => {
    const run = () => {
      const { world, defense } = initFloor6();
      defense.economy.balance = 100;
      defense.economy.totalEarned = 100;
      defense.upgradeOfferManifest = [
        {
          offerId: 'relay-bracing',
          stableIndex: 0,
          cost: 3,
          effect: { kind: 'relayMaxHpBonus', value: 10 },
        },
        {
          offerId: 'spare-batteries',
          stableIndex: 1,
          cost: 6,
          effect: { kind: 'relayRepair', value: 8 },
        },
        {
          offerId: 'route-sweeper',
          stableIndex: 2,
          cost: 5,
          effect: { kind: 'towerDamageBonus', value: 1 },
        },
        {
          offerId: 'faster-loader',
          stableIndex: 3,
          cost: 4,
          effect: { kind: 'towerFireRateBonus', value: 0.1 },
        },
        {
          offerId: 'contractor-decoys',
          stableIndex: 4,
          cost: 7,
          effect: { kind: 'raiderSlowBonus', value: 0.08 },
        },
      ];
      defense.relayHp = 90;
      for (const offer of defense.upgradeOfferManifest) {
        expect(purchaseFloor6UpgradeOffer(world, offer.offerId)).toEqual({
          ok: true,
          reason: 'purchased',
        });
      }
      expect(purchaseFloor6UpgradeOffer(world, 'route-sweeper')).toEqual({
        ok: false,
        reason: 'duplicate',
      });
      expect(buildFloor6Tower(world, defense.geometry.buildSites[4]!.id, 'signal-slinger').ok).toBe(
        true,
      );
      const enemy = createEntity(world);
      addComponent(world.ecs, enemy, set(BroadcastRelayRaider, { manifestIndex: 0 }));
      addComponent(world.ecs, enemy, set(Health, { current: 20, max: 20 }));
      addComponent(world.ecs, enemy, set(Position, { x: 178, y: 102 }));
      floor6TowerSystem(world);
      return {
        relayHp: defense.relayHp,
        targetHp: world.stores.health.current[enemy],
        selected: [...defense.economy.selectedOfferIds],
        events: world.combatEvents.map((event) => ({ ...event })),
      };
    };

    const first = run();
    const second = run();
    expect(first.relayHp).toBe(98);
    expect(first.targetHp).toBe(15);
    expect(first.selected).toHaveLength(5);
    expect(first).toEqual(second);
  });
});
