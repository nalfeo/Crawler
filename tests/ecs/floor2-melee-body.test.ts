import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { MeleeSwing } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { spawnMeleeSwing } from '../../src/core/spawners/melee.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { meleeSwingSystem } from '../../src/core/systems/meleeSwingSystem.js';
import {
  setActiveWeapon,
  setPreferredWeaponTarget,
  weaponSystem,
} from '../../src/game/weaponSystem.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { GAME } from '../../src/shared/constants.js';
import { createInputState } from '../../src/shared/input.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('Floor 2 player melee body contact', () => {
  it('lands surface hits through the live simulation pipeline with grid/full-scan replay parity', () => {
    const simulate = (floorId: 'floor1' | 'floor2', meleeBroadPhase: boolean) => {
      const world = createTestWorld({ seed: 42 });
      world.floorId = floorId;
      const player = spawnPlayer(world, 0, 0);
      const enemy = spawnEnemy(world, 10, 0, 100);
      world.stores.size.radius[enemy] = 6;
      world.stores.size.halfWidth[enemy] = 0;
      world.stores.size.halfHeight[enemy] = 0;
      const def = getWeaponDef('sword')!;
      setActiveWeapon(world, def);
      world.elapsedMs = def.cooldownMs;
      const initialPlayerHp = world.stores.health.current[player];
      const input = createInputState();
      for (let frame = 0; frame < 20; frame += 1) {
        runSimulationStep(world, input, GAME.DELTA_MS, {
          preSystems: [weaponSystem],
          meleeBroadPhase,
        });
      }
      // The player never needs to enter the boss body to make the attack land.
      expect(world.stores.health.current[player]).toBe(initialPlayerHp);
      expect(world.stores.position.x[player]).toBe(0);
      return {
        hp: world.stores.health.current[enemy],
        x: world.stores.position.x[enemy],
        y: world.stores.position.y[enemy],
        frame: world.frameCount,
        rng: world.rng.next(),
      };
    };
    const grid = simulate('floor2', true);
    expect(grid.hp).toBeLessThan(100);
    expect(simulate('floor2', false)).toEqual(grid);
    expect(simulate('floor2', true)).toEqual(grid);
    expect(simulate('floor1', true).hp).toBe(100);
  });

  function run(floor: 'floor1' | 'floor2', grid: boolean, box = false, y = 0) {
    const world = createTestWorld({ seed: 42 });
    world.floorId = floor;
    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 10, y, 100);
    world.stores.size.radius[enemy] = box ? 0 : 6;
    world.stores.size.halfWidth[enemy] = box ? 6 : 0;
    world.stores.size.halfHeight[enemy] = box ? 0.25 : 0;
    spawnMeleeSwing(world, 0, 0, player, 10, 5, 100, 1, 0, 90, 0);
    world.elapsedMs = 50;
    meleeSwingSystem(world, grid ? collisionSystem(world) : undefined);
    return { hp: world.stores.health.current[enemy], rng: world.rng.next() };
  }

  it('hits a large circular body whose center is beyond blade reach, in both broad-phase paths', () => {
    const full = run('floor2', false);
    expect(full.hp).toBeLessThan(100);
    expect(run('floor2', true)).toEqual(full);
    expect(run('floor1', false).hp).toBe(100);
  });

  it('uses actual box edges, not a radius that fills empty space beside a thin box', () => {
    expect(run('floor2', false, true).hp).toBeLessThan(100);
    expect(run('floor2', true, true)).toEqual(run('floor2', false, true));
    expect(run('floor2', false, true, 3).hp).toBe(100);
    expect(run('floor2', true, true, 3).hp).toBe(100);
  });

  it('does not increase enemy-owned melee reach against the player', () => {
    const world = createTestWorld();
    world.floorId = 'floor2';
    const player = spawnPlayer(world, 10, 0);
    world.stores.size.radius[player] = 6;
    const enemy = spawnEnemy(world, 0, 0, 100);
    const hp = world.stores.health.current[player];
    spawnMeleeSwing(world, 0, 0, enemy, 10, 5, 100, 1, 0, 90, 1);
    world.elapsedMs = 50;
    meleeSwingSystem(world);
    expect(world.stores.health.current[player]).toBe(hp);
  });

  it('auto-fires at the large enemy surface even with an unreachable nearer add', () => {
    const world = createTestWorld();
    world.floorId = 'floor2';
    spawnPlayer(world, 0, 0);
    const def = getWeaponDef('sword')!;
    const gate = Math.max(def.range, def.aoeRadius) * 1.5;
    spawnEnemy(world, gate + 3, 0, 100);
    const boss = spawnEnemy(world, gate + 5, 0, 100);
    world.stores.size.radius[boss] = 8;
    world.stores.size.halfWidth[boss] = 0;
    world.stores.size.halfHeight[boss] = 0;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;
    weaponSystem(world);
    expect(query(world.ecs, [MeleeSwing])).toHaveLength(1);
  });

  it.each(['boss', 'preferred'] as const)(
    'preserves %s aim priority at body-aware reach',
    (mode) => {
      const world = createTestWorld();
      world.floorId = 'floor2';
      spawnPlayer(world, 0, 0);
      spawnEnemy(world, 3, 0, 100);
      const def = getWeaponDef('sword')!;
      const boss = spawnEnemy(world, 0, Math.max(def.range, def.aoeRadius) * 1.5 + 4, 100);
      world.stores.size.radius[boss] = 8;
      world.stores.size.halfWidth[boss] = 0;
      world.stores.size.halfHeight[boss] = 0;
      if (mode === 'boss') world.stores.enemyBehavior.aggroedPermanently[boss] = 1;
      else setPreferredWeaponTarget(world, boss);
      setActiveWeapon(world, def);
      world.elapsedMs = def.cooldownMs;
      weaponSystem(world);
      const swing = query(world.ecs, [MeleeSwing])[0]!;
      expect(swing).toBeDefined();
      expect(world.stores.meleeSwing.arcCenterRad[swing]).toBeCloseTo(Math.PI / 2);
    },
  );
});
