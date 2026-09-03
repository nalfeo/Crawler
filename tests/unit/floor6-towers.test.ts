import { addComponent, entityExists, hasComponent, set, setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { BroadcastRelayRaider, Floor6Tower, Health, Position, Team } from '../../src/core/index.js';
import { applyDamage, createEntity, spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import {
  _getFloor6TowerRoster,
  _sellFloor6Tower,
  buildFloor6Tower,
  floor6CombatContributionSystem,
  floor6DefenseDirectorSystem,
  floor6TowerSystem,
  getFloor6DefenseRunStats,
  purchaseFloor6UpgradeOffer,
} from '../../src/game/floor6Scenario.js';
import { memorizeSpell } from '../../src/game/systems/abilitySystem.js';
import { runSimulationStep } from '../../src/engine/sim/simulation-step.js';
import { TeamId } from '../../src/shared/constants.js';
import { floor6Manifest } from '../../src/shared/floor-manifest.js';
import { createInputState } from '../../src/shared/input.js';
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
    const towers = _getFloor6TowerRoster();

    for (const [index, tower] of [...towers].reverse().entries()) {
      expect(
        buildFloor6Tower(
          world,
          defense.geometry.buildSites[towers.length - index - 1]!.id,
          tower.id,
        ),
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
    expect(defense.towerInstances.map(({ siteId }) => siteId)).toEqual(
      defense.geometry.buildSites.slice(0, towers.length).map(({ id }) => id),
    );
    expect([...world.floorMap!.tileMap.flags]).toEqual(routeFlags);
  });

  it('selects stable legal targets and applies tower damage through the combat primitive', () => {
    const { world, player, defense } = initFloor6();
    defense.economy.balance = 10;
    const built = buildFloor6Tower(world, defense.geometry.buildSites[4]!.id, 'signal-slinger');
    expect(built.ok).toBe(true);
    const first = createEntity(world);
    const second = createEntity(world);
    for (const eid of [first, second]) {
      addComponent(world.ecs, eid, set(BroadcastRelayRaider, { manifestIndex: 0 }));
      addComponent(world.ecs, eid, set(Health, { current: 20, max: 20 }));
      addComponent(world.ecs, eid, set(Position, { x: 178, y: 102 }));
    }
    floor6TowerSystem(world);
    floor6CombatContributionSystem(world);
    const target = Math.min(first, second);
    expect(world.stores.health.current[target]).toBeLessThan(20);
    expect(world.stores.health.current[Math.max(first, second)]).toBe(20);
    expect(getFloor6DefenseRunStats(world)?.towerDamageDealt).toBeGreaterThan(0);
    expect(getFloor6DefenseRunStats(world)?.heroDamageDealt).toBe(0);

    world.combatEvents.length = 0;
    applyDamage(world, Math.max(first, second), 3, 178, 102, {
      origin: 'player',
      affinity: 'physical',
      scaleWithPrimary: false,
      canCrit: false,
      sourceEid: player,
    });
    floor6CombatContributionSystem(world);
    expect(getFloor6DefenseRunStats(world)?.heroDamageDealt).toBe(3);
  });

  it('records same-step hero contribution before the visual combat queue drain', () => {
    const { world, player, defense } = initFloor6();
    defense.phase = { kind: 'DEFEND' };
    const raider = createEntity(world);
    addComponent(world.ecs, raider, set(BroadcastRelayRaider, { manifestIndex: 0 }));
    addComponent(world.ecs, raider, set(Health, { current: 20, max: 20 }));
    addComponent(world.ecs, raider, set(Position, { x: 178, y: 102 }));

    runSimulationStep(world, createInputState(), {
      preSystems: [floor6DefenseDirectorSystem],
      afterInput: () => {
        applyDamage(world, raider, 4, 178, 102, {
          origin: 'player',
          affinity: 'physical',
          scaleWithPrimary: false,
          canCrit: false,
          sourceEid: player,
        });
      },
      postSystems: [floor6CombatContributionSystem],
    });
    world.combatEvents.length = 0;

    expect(getFloor6DefenseRunStats(world)?.heroDamageDealt).toBe(4);
  });

  it('records same-frame ability damage after abilitySystem runs', () => {
    const { world, player, defense } = initFloor6();
    defense.phase = { kind: 'DEFEND' };
    world.featureUnlocks.spells = true;
    memorizeSpell(world, player, 'fireball');
    world.frameCount = 100;
    const playerX = world.stores.position.x[player] ?? 0;
    const playerY = world.stores.position.y[player] ?? 0;

    for (const [index, offset] of [1, 1.5, 1.75].entries()) {
      const raider = spawnEnemy(
        world,
        playerX + offset,
        playerY + (index === 2 ? -0.5 : 0.5 * index),
        100,
      );
      addComponent(world.ecs, raider, set(BroadcastRelayRaider, { manifestIndex: index }));
      addComponent(world.ecs, raider, set(Team, { id: TeamId.ENEMY }));
    }

    for (const system of createFloorMainSceneOptions('floor6').postSystems ?? []) {
      system(world);
    }
    world.combatEvents.length = 0;

    expect(getFloor6DefenseRunStats(world)?.heroDamageDealt).toBeGreaterThan(0);
  });

  it('sells and terminally tears down all tower entities exactly once', () => {
    const { world, player, defense } = initFloor6();
    defense.economy.balance = 20;
    const siteA = defense.geometry.buildSites[0]!.id;
    const siteB = defense.geometry.buildSites[1]!.id;
    const a = buildFloor6Tower(world, siteA, 'signal-slinger').eid!;
    const b = buildFloor6Tower(world, siteB, 'relay-riveter').eid!;
    expect(_sellFloor6Tower(world, siteA)).toEqual({ ok: true, reason: 'sold' });
    expect(hasComponent(world.ecs, a, Floor6Tower)).toBe(false);
    setComponent(world.ecs, player, Health, { current: 0, max: 100 });
    floor6DefenseDirectorSystem(world);
    expect(entityExists(world.ecs, b)).toBe(false);
    expect(defense.towerInstances).toEqual([]);
    expect(defense.towersTornDown).toBe(2);
  });

  it('enforces the manifest allowlist during breaks', () => {
    const { world, defense } = initFloor6();
    const finale = floor6Manifest.floor6!.finale!;
    const allowedActions = [...finale.breakAllowedActions];
    defense.economy.balance = 100;
    const occupiedSite = defense.geometry.buildSites[0]!.id;
    const openSite = defense.geometry.buildSites[1]!.id;
    expect(buildFloor6Tower(world, occupiedSite, 'signal-slinger').ok).toBe(true);
    const offer = defense.upgradeOfferManifest![0]!;
    defense.phase = { kind: 'BREAK' };

    try {
      finale.breakAllowedActions = ['tower-build'];

      expect(buildFloor6Tower(world, openSite, 'signal-slinger').ok).toBe(true);
      expect(_sellFloor6Tower(world, occupiedSite)).toEqual({
        ok: false,
        reason: 'phase-locked',
      });
      expect(purchaseFloor6UpgradeOffer(world, offer.offerId)).toEqual({
        ok: false,
        reason: 'phase-locked',
      });
      expect(defense.towerInstances.some((tower) => tower.siteId === occupiedSite)).toBe(true);
      expect(defense.economy.selectedOfferIds).toEqual([]);
    } finally {
      finale.breakAllowedActions = allowedActions;
    }
  });

  it('keeps same-step tower hits attributed when terminal teardown removes towers', () => {
    const { world, player, defense } = initFloor6();
    defense.phase = { kind: 'DEFEND' };
    defense.economy.balance = 10;
    expect(buildFloor6Tower(world, defense.geometry.buildSites[4]!.id, 'signal-slinger').ok).toBe(
      true,
    );
    const raider = createEntity(world);
    addComponent(world.ecs, raider, set(BroadcastRelayRaider, { manifestIndex: 0 }));
    addComponent(world.ecs, raider, set(Health, { current: 20, max: 20 }));
    addComponent(world.ecs, raider, set(Position, { x: 178, y: 102 }));

    floor6TowerSystem(world);
    setComponent(world.ecs, player, Health, { current: 0, max: 100 });
    floor6DefenseDirectorSystem(world);
    floor6CombatContributionSystem(world);

    expect(getFloor6DefenseRunStats(world)?.towerDamageDealt).toBeGreaterThan(0);
    expect(getFloor6DefenseRunStats(world)?.heroDamageDealt).toBe(0);
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
