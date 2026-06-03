import { query } from 'bitecs';
import type { CollisionPair, SpatialHashGrid } from '../collision.js';
import { createSpatialHashGrid } from '../collision.js';
import { Position, Sprite } from '../components.js';
import type { GameWorld } from '../world.js';

export interface CollisionResult {
  pairs: CollisionPair[];
  grid: SpatialHashGrid;
}

const collisionGrids = new WeakMap<GameWorld, SpatialHashGrid>();

function getCollisionGrid(world: GameWorld): SpatialHashGrid {
  let grid = collisionGrids.get(world);

  if (grid === undefined) {
    grid = createSpatialHashGrid();
    collisionGrids.set(world, grid);
  }

  return grid;
}

export function collisionSystem(world: GameWorld): CollisionResult {
  const grid = getCollisionGrid(world);
  const entities = query(world.ecs, [Position, Sprite]);
  const { position, sprite } = world.stores;

  grid.clear();

  for (const eid of entities) {
    if (eid === undefined) {
      continue;
    }

    const x = position.x[eid] ?? 0;
    const y = position.y[eid] ?? 0;
    const halfWidth = (sprite.width[eid] ?? 0) * 0.5;
    const halfHeight = (sprite.height[eid] ?? 0) * 0.5;

    grid.insert(eid, x, y, halfWidth, halfHeight);
  }

  return {
    pairs: grid.queryPairs(),
    grid,
  };
}
