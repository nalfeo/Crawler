import { addComponent, set, setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Position, Projectile, Size, Sprite } from '../../src/core/components.js';
import { createEntity, spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { SHAPE_CIRCLE } from '../../src/core/physics-defs.js';
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

  it('falls back to radius for a malformed NaN halfWidth/halfHeight instead of inserting NaN', () => {
    // Regression: a naive `if (stored <= 0) fallback` check does not catch NaN
    // (every ordered comparison with NaN is false), which would silently
    // insert NaN bounds into the spatial grid and drop the entity from
    // collision queries. getBodyHalfWidth/getBodyHalfHeight guard against this
    // with `if (v > 0) return v`, so the fast path must match that exactly.
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const malformed = createEntity(world);

    addComponent(world.ecs, malformed, set(Position, { x: 1, y: 0 }));
    addComponent(world.ecs, malformed, set(Sprite, { textureId: 0, width: 8, height: 8 }));
    addComponent(
      world.ecs,
      malformed,
      set(Size, { radius: 25, halfWidth: NaN, halfHeight: NaN, shape: SHAPE_CIRCLE }),
    );

    const result = collisionSystem(world);

    expect(result.pairs).toContainEqual({
      a: Math.min(player, malformed),
      b: Math.max(player, malformed),
    });
  });
});
