import { entityExists } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { spawnAreaAttack, spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { areaDamageSystem } from '../../src/core/systems/areaDamageSystem.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { lifetimeSystem } from '../../src/core/systems/lifetimeSystem.js';
import { TeamId } from '../../src/shared/constants.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('lifetimeSystem', () => {
  it('removes entities past their expiry time', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.elapsedMs = 100;
    const aoe = spawnAreaAttack(world, 0, 0, player, 10, 40, 200, TeamId.PLAYER);
    // expiresAtMs = 100 + 200 = 300

    world.elapsedMs = 299;
    lifetimeSystem(world);
    expect(entityExists(world.ecs, aoe)).toBe(true);

    world.elapsedMs = 300;
    lifetimeSystem(world);
    expect(entityExists(world.ecs, aoe)).toBe(false);
  });
});

describe('areaDamageSystem', () => {
  it('damages enemies within radius', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 100, 100);
    const enemy = spawnEnemy(world, 110, 100, 50);
    world.elapsedMs = 100;
    spawnAreaAttack(world, 100, 100, player, 15, 40, 200, TeamId.PLAYER);

    const collision = collisionSystem(world);
    areaDamageSystem(world, collision);

    expect(world.stores.health.current[enemy]).toBe(35);
  });

  it('does not damage the owner', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 100, 100);
    world.elapsedMs = 100;
    spawnAreaAttack(world, 100, 100, player, 15, 40, 200, TeamId.PLAYER);

    const collision = collisionSystem(world);
    areaDamageSystem(world, collision);

    expect(world.stores.health.current[player]).toBe(100);
  });

  it('hit-once prevents re-damaging same target', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 100, 100);
    const enemy = spawnEnemy(world, 110, 100, 50);
    world.elapsedMs = 100;
    spawnAreaAttack(world, 100, 100, player, 15, 40, 200, TeamId.PLAYER);

    // Apply twice
    const collision1 = collisionSystem(world);
    areaDamageSystem(world, collision1);
    const collision2 = collisionSystem(world);
    areaDamageSystem(world, collision2);

    // Should only be hit once
    expect(world.stores.health.current[enemy]).toBe(35);
  });

  it('does not damage enemies outside radius', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 100, 100);
    const farEnemy = spawnEnemy(world, 500, 500, 50);
    world.elapsedMs = 100;
    spawnAreaAttack(world, 100, 100, player, 15, 40, 200, TeamId.PLAYER);

    const collision = collisionSystem(world);
    areaDamageSystem(world, collision);

    expect(world.stores.health.current[farEnemy]).toBe(50);
  });
});
