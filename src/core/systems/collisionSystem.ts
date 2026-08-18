import { query } from 'bitecs';
import type { CollisionPair, SpatialHashGrid } from '../collision.js';
import { createSpatialHashGrid } from '../collision.js';
import { Position, Size } from '../components.js';
import { getBodyHalfWidth, getBodyHalfHeight } from '../physics-body.js';
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
  // Post-Slice-1: the grid is a Size-driven index (ADR 0044). Sprite dims are
  // a render concern only. `check:size-coverage` guards that every collision
  // participant carries Size, so entities without one are excluded here.
  const entities = query(world.ecs, [Position, Size]);
  const { position, size } = world.stores;

  grid.clear();

  for (const eid of entities) {
    if (eid === undefined) {
      continue;
    }

    const x = position.x[eid] ?? 0;
    const y = position.y[eid] ?? 0;
    const radius = size.radius[eid] ?? 0;
    const storedHalfWidth = size.halfWidth[eid] ?? 0;
    const storedHalfHeight = size.halfHeight[eid] ?? 0;
    // Mirror getBodyHalfWidth/getBodyHalfHeight's `if (v > 0) return v` fast-accept
    // exactly (not its negation `<= 0`): those differ for NaN, which fails every
    // ordered comparison, so a `<= 0` fallback check would let a malformed NaN
    // half-extent slip through instead of falling back to radius/the
    // shim-warning helper.
    let halfWidth = storedHalfWidth > 0 ? storedHalfWidth : 0;
    if (halfWidth <= 0) {
      halfWidth = radius > 0 ? radius : getBodyHalfWidth(world, eid, 'collisionSystem');
    }
    let halfHeight = storedHalfHeight > 0 ? storedHalfHeight : 0;
    if (halfHeight <= 0) {
      halfHeight = radius > 0 ? radius : getBodyHalfHeight(world, eid, 'collisionSystem');
    }

    grid.insert(eid, x, y, halfWidth, halfHeight);
  }

  return {
    pairs: grid.queryPairs(),
    grid,
  };
}
