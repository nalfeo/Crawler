import { addComponent, entityExists, query, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { AreaDamage, Health, Position, Sprite, Team, Trap } from '../../src/core/components.js';
import { createEntity, spawnEnemy, spawnPlayer, spawnTrap } from '../../src/core/helpers.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { trapSystem } from '../../src/core/systems/trapSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { makeMapWithSafeRoom } from '../helpers/map-fixtures.js';

describe('trapSystem', () => {
  it('does not trigger when no candidates are inside trigger radius', () => {
    const world = createTestWorld();
    const owner = spawnPlayer(world, 0, 0);
    spawnTrap(world, 0, 0, 20, 12, 24, 0, owner, 1);
    spawnEnemy(world, 200, 200, 30);

    trapSystem(world, collisionSystem(world));

    expect(query(world.ecs, [Trap])).toHaveLength(1);
    expect(query(world.ecs, [AreaDamage])).toHaveLength(0);
  });

  it('skips non-Health and non-Enemy targets in range', () => {
    const world = createTestWorld();
    const owner = spawnPlayer(world, 0, 0);
    spawnTrap(world, 0, 0, 20, 16, 24, 0, owner, 1);

    const prop = createEntity(world);
    addComponent(world.ecs, prop, set(Position, { x: 2, y: 0 }));
    addComponent(world.ecs, prop, set(Sprite, { textureId: 0, width: 8, height: 8 }));

    const nonEnemy = createEntity(world);
    addComponent(world.ecs, nonEnemy, set(Position, { x: 4, y: 0 }));
    addComponent(world.ecs, nonEnemy, set(Sprite, { textureId: 0, width: 8, height: 8 }));
    addComponent(world.ecs, nonEnemy, set(Health, { current: 10, max: 10 }));

    trapSystem(world, collisionSystem(world));

    expect(query(world.ecs, [Trap])).toHaveLength(1);
    expect(query(world.ecs, [AreaDamage])).toHaveLength(0);
  });

  it('does not trigger on same-team enemies', () => {
    const world = createTestWorld();
    const owner = spawnPlayer(world, 0, 0);
    spawnTrap(world, 0, 0, 20, 16, 24, 0, owner, 3);

    const allyEnemy = spawnEnemy(world, 5, 0, 30);
    addComponent(world.ecs, allyEnemy, set(Team, { id: 3 }));

    trapSystem(world, collisionSystem(world));

    expect(query(world.ecs, [Trap])).toHaveLength(1);
    expect(query(world.ecs, [AreaDamage])).toHaveLength(0);
  });

  it('triggers on opposing-team enemies and clears trap stores on cleanup', () => {
    const world = createTestWorld();
    const owner = spawnPlayer(world, 0, 0);
    const trap = spawnTrap(world, 0, 0, 25, 16, 30, 0, owner, 2);

    const enemy = spawnEnemy(world, 5, 0, 30);
    addComponent(world.ecs, enemy, set(Team, { id: 4 }));

    trapSystem(world, collisionSystem(world));

    expect(entityExists(world.ecs, trap)).toBe(false);
    expect(query(world.ecs, [Trap])).toHaveLength(0);
    expect(query(world.ecs, [AreaDamage])).toHaveLength(1);
    expect(world.stores.trap.triggerRadius[trap]).toBe(0);
    expect(world.stores.trap.explosionRadius[trap]).toBe(0);
    expect(world.stores.trap.explosionDamage[trap]).toBe(0);
    expect(world.stores.trap.armAtMs[trap]).toBe(0);
  });

  it('uses defensive defaults when trap store slots are missing', () => {
    const world = createTestWorld();
    const trap = createEntity(world);
    addComponent(world.ecs, trap, Trap);
    addComponent(world.ecs, trap, Position);

    const enemy = spawnEnemy(world, 0, 0, 20);
    addComponent(world.ecs, enemy, set(Team, { id: 1 }));

    world.stores.position.x = new Float32Array(new ArrayBuffer(0));
    world.stores.position.y = new Float32Array(new ArrayBuffer(0));
    world.stores.trap.armAtMs = new Float32Array(new ArrayBuffer(0));
    world.stores.trap.triggerRadius = new Float32Array(new ArrayBuffer(0));
    world.stores.trap.explosionRadius = new Float32Array(new ArrayBuffer(0));
    world.stores.trap.explosionDamage = new Float32Array(new ArrayBuffer(0));
    world.stores.team.id = new Uint8Array(new ArrayBuffer(0));
    world.stores.owner.eid = new Uint16Array(new ArrayBuffer(0));

    trapSystem(world, collisionSystem(world));

    expect(query(world.ecs, [Trap])).toHaveLength(0);
    expect(query(world.ecs, [AreaDamage])).toHaveLength(1);
  });

  it('skips triggering when the player owner is inside a safe room', () => {
    const world = createTestWorld();
    // Safe room tiles (1,1)–(4,4) with tileSizeFt=32.
    // Tile 2 centre = 2*32+16 = 80 ft.
    const safeMap = makeMapWithSafeRoom({ tileSizeFt: 32, widthTiles: 20, heightTiles: 20 });
    world.floorMap = safeMap;

    // Place the player at the centre of tile (2,2) — inside the safe room.
    const playerX = 2 * 32 + 16;
    const playerY = 2 * 32 + 16;
    const owner = spawnPlayer(world, playerX, playerY);

    // Trap co-located with the player-owner
    spawnTrap(world, playerX, playerY, 25, 16, 30, 0, owner, 2);

    // Enemy right next to the trap (within trigger radius)
    const enemy = spawnEnemy(world, playerX + 5, playerY, 30);
    addComponent(world.ecs, enemy, set(Team, { id: 4 }));

    trapSystem(world, collisionSystem(world));

    // Trap should NOT trigger because the owner (player) is in a safe room
    expect(query(world.ecs, [Trap])).toHaveLength(1);
    expect(query(world.ecs, [AreaDamage])).toHaveLength(0);
  });
});
