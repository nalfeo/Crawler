/**
 * Benchmarks for core ECS systems and data structures.
 *
 * Run with: npm run bench
 * Or:       npx vitest bench
 *
 * Results are compared against docs/knowledge/metrics/bench-baseline.json
 * by scripts/agent/health/bench-regression.ts (weekly test-health loop).
 */

import { addComponent, addEntity, set } from 'bitecs';
import { bench, describe } from 'vitest';
import { Position, Velocity } from '../../src/core/components.js';
import { createSpatialHashGrid } from '../../src/core/collision.js';
import { movementSystem } from '../../src/core/systems/movementSystem.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { createGameWorld } from '../../src/core/world.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';

// ---------------------------------------------------------------------------
// SpatialHashGrid benchmarks
// ---------------------------------------------------------------------------

describe('SpatialHashGrid', () => {
  bench('insert + queryPairs — 50 entities', () => {
    const grid = createSpatialHashGrid();
    for (let i = 0; i < 50; i++) {
      grid.insert(i, (i % 10) * 32, Math.floor(i / 10) * 32, 8, 8);
    }
    grid.queryPairs();
    grid.clear();
  });

  bench('insert + queryPairs — 200 entities', () => {
    const grid = createSpatialHashGrid();
    for (let i = 0; i < 200; i++) {
      grid.insert(i, (i % 20) * 16, Math.floor(i / 20) * 16, 8, 8);
    }
    grid.queryPairs();
    grid.clear();
  });

  bench('queryRadius — 200 entities, radius 64', () => {
    const grid = createSpatialHashGrid();
    for (let i = 0; i < 200; i++) {
      grid.insert(i, (i % 20) * 16, Math.floor(i / 20) * 16, 8, 8);
    }
    grid.queryRadius(160, 80, 64);
  });
});

// ---------------------------------------------------------------------------
// movementSystem benchmarks
// ---------------------------------------------------------------------------

describe('movementSystem', () => {
  bench('100 entities — no floor map', () => {
    const world = createGameWorld({ seed: 1, floor: 1 });
    for (let i = 0; i < 100; i++) {
      const eid = addEntity(world.ecs);
      addComponent(world.ecs, eid, set(Position, { x: i * 4, y: 0 }));
      addComponent(world.ecs, eid, set(Velocity, { x: 1, y: 0.5 }));
    }
    movementSystem(world);
  });
});

// ---------------------------------------------------------------------------
// collisionSystem benchmarks
// ---------------------------------------------------------------------------

describe('collisionSystem', () => {
  bench('1 player + 20 enemies — queryPairs', () => {
    const world = createGameWorld({ seed: 1, floor: 1 });
    spawnPlayer(world, 0, 0);
    for (let i = 0; i < 20; i++) {
      spawnEnemy(world, i * 24, 0, 10);
    }
    collisionSystem(world);
  });
});
