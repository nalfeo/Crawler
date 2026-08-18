import { addComponent, set, setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Position, Projectile, Size, Sprite } from '../../src/core/components.js';
import { createEntity, spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import {
  getBodyHalfHeight,
  getBodyHalfWidth,
  getShimStats,
  resetShimStats,
} from '../../src/core/physics-body.js';
import { SHAPE_BOX, SHAPE_CIRCLE } from '../../src/core/physics-defs.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('collisionSystem', () => {
  it('detects player-enemy collisions', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 1, 0, 25);

    const result = collisionSystem(world);

    expect(result.pairs).toContainEqual({ a: Math.min(player, enemy), b: Math.max(player, enemy) });
  });

  it('detects projectile-enemy collisions', () => {
    const world = createTestWorld();
    const projectile = createEntity(world);
    const enemy = spawnEnemy(world, 1, 0, 25);

    addComponent(world.ecs, projectile, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, projectile, set(Sprite, { textureId: 0, width: 8, height: 8 }));
    addComponent(
      world.ecs,
      projectile,
      set(Size, { radius: 4, halfWidth: 0, halfHeight: 0, shape: SHAPE_CIRCLE }),
    );
    addComponent(world.ecs, projectile, Projectile);

    const result = collisionSystem(world);

    expect(result.pairs).toContainEqual({
      a: Math.min(projectile, enemy),
      b: Math.max(projectile, enemy),
    });
  });

  it('returns no collisions when entities do not overlap', () => {
    const world = createTestWorld();

    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 32, 32, 25);

    expect(collisionSystem(world).pairs).toEqual([]);
  });

  it('rebuilds the grid each frame as entities move', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 25, 0, 25);

    expect(collisionSystem(world).pairs).toEqual([]);

    setComponent(world.ecs, enemy, Position, { x: 1, y: 0 });
    const updatedResult = collisionSystem(world);

    expect(updatedResult.pairs).toContainEqual({
      a: Math.min(player, enemy),
      b: Math.max(player, enemy),
    });
  });

  it('indexes Size extents directly while preserving malformed-size shim behavior', () => {
    resetShimStats();
    const world = createTestWorld();
    const box = createEntity(world);
    const circle = createEntity(world);
    const malformed = createEntity(world);
    const nanExtent = createEntity(world);
    const mixedExtent = createEntity(world);

    addComponent(world.ecs, box, set(Position, { x: 0, y: 0 }));
    addComponent(
      world.ecs,
      box,
      set(Size, { radius: 0, halfWidth: 3, halfHeight: 5, shape: SHAPE_BOX }),
    );
    addComponent(world.ecs, circle, set(Position, { x: 10, y: 0 }));
    addComponent(
      world.ecs,
      circle,
      set(Size, { radius: 2, halfWidth: 0, halfHeight: 0, shape: SHAPE_CIRCLE }),
    );
    addComponent(world.ecs, malformed, set(Position, { x: 20, y: 0 }));
    addComponent(
      world.ecs,
      malformed,
      set(Size, { radius: 0, halfWidth: 0, halfHeight: 0, shape: SHAPE_CIRCLE }),
    );
    addComponent(world.ecs, nanExtent, set(Position, { x: 30, y: 0 }));
    addComponent(
      world.ecs,
      nanExtent,
      set(Size, { radius: 0, halfWidth: Number.NaN, halfHeight: Number.NaN, shape: SHAPE_CIRCLE }),
    );
    addComponent(world.ecs, mixedExtent, set(Position, { x: 40, y: 0 }));
    addComponent(
      world.ecs,
      mixedExtent,
      set(Size, { radius: 2, halfWidth: 3, halfHeight: 0, shape: SHAPE_BOX }),
    );

    const { grid } = collisionSystem(world);

    const collisionFixtures: Array<[number, number, number]> = [
      [box, 0, 0],
      [circle, 10, 0],
      [malformed, 20, 0],
      [nanExtent, 30, 0],
      [mixedExtent, 40, 0],
    ];

    for (const [eid, x, y] of collisionFixtures) {
      const halfWidth = getBodyHalfWidth(world, eid, 'collisionSystem');
      const halfHeight = getBodyHalfHeight(world, eid, 'collisionSystem');

      expect(
        grid.queryRadius(x + Math.max(halfWidth - 0.5, 0), y + Math.max(halfHeight - 0.5, 0), 0),
      ).toContain(eid);
    }
    expect(getShimStats()).toEqual({ count: 8, uniqueEids: 2 });
    resetShimStats();
  });
});
