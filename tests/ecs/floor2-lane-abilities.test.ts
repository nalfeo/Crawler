import { addComponent, query } from 'bitecs';
import { describe, expect, it, vi } from 'vitest';
import { Gold, Invincible, Knockback } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer, setEnemyAppearanceKey } from '../../src/core/helpers.js';
import {
  mobAbilitySystem,
  activateMobAbilityEncounter,
  clearMobAbility,
  registerMobAbility,
  setMobAbilitiesEnabled,
} from '../../src/core/mob-abilities/runtime.js';
import {
  createHellfireShiftLineDefinition,
  createHighwayRobberyDefinition,
  createScrapCartStampedeDefinition,
  createUndermineUnionDefinition,
} from '../../src/core/mob-abilities/floor2-lane-abilities.js';
import type { MobAbilityRuntimeDefinition } from '../../src/core/mob-abilities/types.js';
import { GAME } from '../../src/shared/constants.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { makeWalledMap } from '../helpers/map-fixtures.js';
import { runCoreSimulationStep } from '../../src/core/simulation-core-step.js';
import { createInputState } from '../../src/shared/input.js';

const factories = [
  createScrapCartStampedeDefinition,
  createUndermineUnionDefinition,
  createHighwayRobberyDefinition,
  createHellfireShiftLineDefinition,
];

function fixture(create: () => MobAbilityRuntimeDefinition, map = false) {
  const world = createTestWorld({ seed: 42 });
  world.floorId = 'floor2';
  if (map) world.floorMap = makeWalledMap({ tileSizeFt: 4 });
  const caster = spawnEnemy(world, 10, 14, 500);
  const player = spawnPlayer(world, 17, 14);
  world.stores.health.max[player] = 1000;
  world.stores.health.current[player] = 1000;
  const definition = create();
  setEnemyAppearanceKey(world, caster, definition.bossArchetypeKey);
  setMobAbilitiesEnabled(world, true);
  registerMobAbility(world, caster, definition);
  activateMobAbilityEncounter(world);
  return { world, caster, player, definition };
}

function tick(world: ReturnType<typeof createTestWorld>, count: number) {
  for (let n = 0; n < count; n++) {
    world.elapsedMs += GAME.DELTA_MS;
    mobAbilitySystem(world);
  }
}

function telegraph(f: ReturnType<typeof fixture>) {
  tick(f.world, Math.ceil(f.definition.firstEligibleAfterMs / GAME.DELTA_MS));
  return f.world.mobAbilities.byEntity.get(f.caster)!.committedGeometry!;
}

function resolve(f: ReturnType<typeof fixture>) {
  tick(f.world, Math.ceil(f.definition.telegraphDurationMs / GAME.DELTA_MS));
}

describe('Floor 2 committed lane abilities', () => {
  it('moves the cart through the core pipeline without doubling injected velocity', () => {
    const f = fixture(createScrapCartStampedeDefinition, true);
    telegraph(f);
    resolve(f);
    f.world.stores.velocity.x[f.caster] = 4;
    runCoreSimulationStep(f.world, createInputState(), { preSystems: [mobAbilitySystem] });
    expect(f.world.stores.position.x[f.caster]).toBeGreaterThan(10);
    expect(f.world.stores.position.x[f.caster]).toBeLessThan(11);
    expect(f.world.stores.velocity.x[f.caster]).toBe(0);
  });

  it('a wall inserted after lock cancels Grubbs eruption rather than retargeting it', () => {
    const f = fixture(createUndermineUnionDefinition, true);
    telegraph(f);
    f.world.stores.position.x[f.player] = 4;
    resolve(f);
    const map = f.world.floorMap!;
    const original = map.isPassableAt.bind(map);
    vi.spyOn(map, 'isPassableAt').mockImplementation((x, y) => x < 13 && original(x, y));
    tick(f.world, 90);
    expect(f.world.stores.position.x[f.caster]).toBeLessThan(13);
    expect(f.world.stores.health.current[f.player]).toBe(1000);
  });
  it.each(factories)('%s preserves catalog clocks and player-position lock', (create) => {
    const f = fixture(create);
    const geometry = telegraph(f);
    const snapshot = JSON.stringify(geometry);
    f.world.stores.position.y[f.player] = 50;
    resolve(f);
    expect(JSON.stringify(geometry)).toBe(snapshot);
    expect(f.world.mobAbilities.byEntity.get(f.caster)!.resolvedCasts).toBe(1);
    expect(f.world.mobAbilities.byEntity.get(f.caster)!.announcementsEmitted).toBe(1);
    expect(f.definition.cooldownMs).toBe(f.definition.firstEligibleAfterMs);
    expect(f.definition.lockCasterDuringTelegraph).toBe(true);
  });

  it.each([createScrapCartStampedeDefinition, createHighwayRobberyDefinition])(
    '%s travels visibly, hits once, and stops body-safe before the wall',
    (create) => {
      const f = fixture(create, true);
      const geometry = telegraph(f);
      expect(geometry.kind).toBe('lane');
      if (geometry.kind !== 'lane') throw new Error('Expected lane');
      expect(geometry.endX).toBeLessThan(20);
      resolve(f);
      expect(f.world.stores.position.x[f.caster]).toBe(10);
      tick(f.world, 1);
      expect(f.world.stores.position.x[f.caster]).toBeGreaterThan(10);
      expect(f.world.stores.position.x[f.caster]).toBeLessThan(geometry.endX);
      tick(f.world, 90);
      expect(f.world.stores.position.x[f.caster]).toBeCloseTo(geometry.endX);
      expect(f.world.stores.position.y[f.caster]).toBeCloseTo(14);
      expect(f.world.stores.health.current[f.player]).toBe(980);
      expect(f.world.mobAbilities.ownedZones).toHaveLength(0);
    },
  );

  it('Nana applies strong knockback in the committed direction only on a successful hit', () => {
    const f = fixture(createScrapCartStampedeDefinition);
    telegraph(f);
    resolve(f);
    tick(f.world, 20);
    expect(query(f.world.ecs, [Knockback])).toContain(f.player);
    expect(f.world.stores.knockback.dirX[f.player]).toBe(1);
    expect(f.world.stores.knockback.remaining[f.player]).toBe(5);
  });

  it.each([0, 7, 50])(
    'Rocco subtracts and returns exactly min(10,%s) at the endpoint',
    (balance) => {
      const f = fixture(createHighwayRobberyDefinition);
      f.world.playerGold = balance;
      const geometry = telegraph(f);
      if (geometry.kind !== 'lane') throw new Error('Expected lane');
      resolve(f);
      tick(f.world, 60);
      const stolen = Math.min(10, balance);
      expect(f.world.playerGold).toBe(balance - stolen);
      const gold = query(f.world.ecs, [Gold]);
      expect(gold).toHaveLength(stolen ? 1 : 0);
      if (stolen) {
        expect(f.world.stores.gold.value[gold[0]!]).toBe(stolen);
        expect(f.world.stores.position.x[gold[0]!]).toBeCloseTo(geometry.endX);
        expect(f.world.stores.position.y[gold[0]!]).toBeCloseTo(geometry.endY);
      }
    },
  );

  it('Rocco cannot steal from an invulnerable player', () => {
    const f = fixture(createHighwayRobberyDefinition);
    f.world.playerGold = 50;
    addComponent(f.world.ecs, f.player, Invincible);
    telegraph(f);
    resolve(f);
    tick(f.world, 60);
    expect(f.world.playerGold).toBe(50);
    expect(query(f.world.ecs, [Gold])).toHaveLength(0);
  });

  it('recovery gold survives caster cleanup mid-dash', () => {
    const f = fixture(createHighwayRobberyDefinition);
    f.world.playerGold = 50;
    telegraph(f);
    resolve(f);
    tick(f.world, 12);
    expect(f.world.playerGold).toBe(40);
    clearMobAbility(f.world, f.caster);
    tick(f.world, 90);
    expect(query(f.world.ecs, [Gold])).toHaveLength(1);
    expect(f.world.mobAbilities.ownedZones).toHaveLength(0);
  });

  it('Grubbs commits both lane and endpoint warning, clips body at wall, and erupts once', () => {
    const f = fixture(createUndermineUnionDefinition, true);
    f.world.stores.size.radius[f.caster] = 2;
    f.world.stores.size.halfWidth[f.caster] = 0;
    f.world.stores.size.halfHeight[f.caster] = 0;
    f.world.stores.position.x[f.player] = 19;
    const geometry = telegraph(f);
    if (geometry.kind !== 'composite') throw new Error('Expected composite');
    expect(geometry.shapes.map((shape) => shape.kind)).toEqual(['lane', 'circle']);
    const route = geometry.shapes[0]!;
    const circle = geometry.shapes[1]!;
    if (route.kind !== 'lane' || circle.kind !== 'circle') throw new Error('Expected route');
    expect(route.widthFt).toBe(6);
    expect(circle.radiusFt).toBe(8);
    expect(circle.x).toBe(route.endX);
    expect(route.endX).toBeLessThan(19);
    resolve(f);
    const zone = f.world.mobAbilities.ownedZones[0]!;
    const frames = Math.round(zone.durationMs / GAME.DELTA_MS);
    // A telegraph resolution burst may describe the whole route, but an
    // endpoint-circle eruption must not be emitted until travel finishes.
    const eruptions = () =>
      f.world.mobAbilities.pendingBursts.filter(
        (burst) =>
          burst.kind === 'resolution' &&
          burst.abilityId === f.definition.abilityId &&
          burst.geometry.kind === 'circle',
      );
    for (let frame = 0; frame < frames; frame++) {
      const active = f.world.mobAbilities.ownedZones[0]!;
      expect(active.geometry.kind).toBe('composite');
      if (active.geometry.kind !== 'composite') throw new Error('Expected active composite');
      expect(active.geometry.shapes[1]).toEqual(circle);
      expect(eruptions()).toHaveLength(0);
      tick(f.world, 1);
    }
    expect(f.world.mobAbilities.ownedZones).toHaveLength(0);
    expect(eruptions()).toHaveLength(1);
    expect(eruptions()[0]).toMatchObject({ geometry: circle });
    expect(f.world.stores.position.x[f.caster]).toBeCloseTo(route.endX);
    expect(f.world.stores.health.current[f.player]).toBe(980);
    expect(f.world.stores.knockback.dirX[f.player]).toBe(1);
  });

  it('cleans Grubbs endpoint warning on caster cleanup without a delayed eruption', () => {
    const f = fixture(createUndermineUnionDefinition);
    telegraph(f);
    resolve(f);
    tick(f.world, 1);
    expect(f.world.mobAbilities.ownedZones[0]!.geometry.kind).toBe('composite');
    f.world.mobAbilities.pendingBursts.length = 0;
    clearMobAbility(f.world, f.caster);
    tick(f.world, 90);
    expect(f.world.mobAbilities.ownedZones).toHaveLength(0);
    expect(f.world.mobAbilities.pendingBursts).toHaveLength(0);
    expect(f.world.stores.health.current[f.player]).toBe(1000);
  });

  it('Scorch crosses the locked player point in both directions and deals eight 500ms ticks', () => {
    const f = fixture(createHellfireShiftLineDefinition, true);
    const geometry = telegraph(f);
    if (geometry.kind !== 'lane') throw new Error('Expected lane');
    expect(geometry.originX).toBeLessThan(10);
    expect(geometry.endX).toBeGreaterThan(17);
    expect(geometry.widthFt).toBe(6);
    resolve(f);
    expect(f.world.stores.health.current[f.player]).toBe(980);
    tick(f.world, 240);
    expect(f.world.stores.health.current[f.player]).toBe(900);
    expect(f.world.mobAbilities.ownedZones).toHaveLength(0);
    tick(f.world, 30);
    expect(f.world.stores.health.current[f.player]).toBe(900);
  });

  it.each(factories)('%s repeats deterministically and cleanup leaves no effects', (create) => {
    const run = () => {
      const f = fixture(create);
      f.world.playerGold = 50;
      tick(f.world, 1500);
      const trace = {
        casts: f.world.mobAbilities.byEntity.get(f.caster)!.resolvedCasts,
        x: f.world.stores.position.x[f.caster],
        hp: f.world.stores.health.current[f.player],
        gold: f.world.playerGold,
        rng: f.world.rng.next(),
      };
      expect(trace.casts).toBeGreaterThanOrEqual(2);
      clearMobAbility(f.world, f.caster);
      tick(f.world, 1);
      expect(f.world.mobAbilities.ownedZones).toHaveLength(0);
      return trace;
    };
    expect(run()).toEqual(run());
  });
});
