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
import { EffectiveStats, Position, Velocity } from '../../src/core/components.js';
import { createSpatialHashGrid } from '../../src/core/collision.js';
import { movementSystem } from '../../src/core/systems/movementSystem.js';
import { collisionSystem, type CollisionResult } from '../../src/core/systems/collisionSystem.js';
import { clearMeleeSwingHits, meleeSwingSystem } from '../../src/core/systems/meleeSwingSystem.js';
import { spawnMeleeSwing } from '../../src/core/spawners/melee.js';
import { MeleeStyle } from '../../src/shared/constants.js';
import { createGameWorld, type GameWorld } from '../../src/core/world.js';
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

// ---------------------------------------------------------------------------
// meleeSwingSystem benchmarks — legacy full-scan vs spatial-hash broad-phase
//
// The system was converted from a full [Health, Position] scan (per swing) to a
// grid queryRadius broad-phase. These A/B benches drive both code paths of the
// SAME production function over IDENTICAL static scenes:
//   - "full scan (legacy)": meleeSwingSystem(world)          — no grid arg
//   - "grid broad-phase":   meleeSwingSystem(world, collision) — grid threaded in
// The grid is built ONCE outside the measured loop: in production collisionSystem
// runs once per frame and is shared by collision/area/trap, so its cost is not
// attributable to melee. Each iteration only clears the per-swing hit-sets and the
// event buffers, so every iteration performs the same candidate work.
// ---------------------------------------------------------------------------

interface MeleeScene {
  world: GameWorld;
  swings: number[];
  collision: CollisionResult;
}

/**
 * Build a static melee scene. Enemies are given enormous HP so no iteration
 * depletes them (every hit does full work), and the player carries EffectiveStats
 * so each enemy hit exercises the crit roll — matching the real hot path.
 */
function buildMeleeScene(enemyCount: number, spreadFt: number, swingCount: number): MeleeScene {
  const world = createGameWorld({ seed: 1, floor: 1, entityCapacityMode: 'test' });
  const player = spawnPlayer(world, spreadFt / 2, spreadFt / 2);
  addComponent(world.ecs, player, EffectiveStats);
  world.stores.effectiveStats.critChance[player] = 0.25;
  world.stores.effectiveStats.critMultiplier[player] = 2;

  // Deterministic pseudo-scatter (no RNG) across a spreadFt square.
  for (let i = 0; i < enemyCount; i++) {
    const x = ((i * 73) % spreadFt) + 0.5;
    const y = ((i * 149) % spreadFt) + 0.5;
    spawnEnemy(world, x, y, 1_000_000);
  }

  // Swings scattered across the field, each with a wide arc + head circle so it
  // engages a local cluster. In the legacy path every swing still scans all
  // enemies; in the grid path each swing only examines nearby candidates.
  const swings: number[] = [];
  for (let s = 0; s < swingCount; s++) {
    const sx = ((s * 97) % spreadFt) + 0.5;
    const sy = ((s * 53) % spreadFt) + 0.5;
    swings.push(
      spawnMeleeSwing(world, sx, sy, player, 5, 4, 1000, 1, 0, 360, 0, MeleeStyle.SLASH, 12, 1, 0),
    );
  }

  const collision = collisionSystem(world);
  return { world, swings, collision };
}

/** Cheap per-iteration reset so each measured run repeats the same candidate work. */
function resetMeleeScene(scene: MeleeScene): void {
  for (const swing of scene.swings) {
    clearMeleeSwingHits(scene.world, swing);
  }
  scene.world.combatEvents.length = 0;
  scene.world.skillUsageEvents.length = 0;
}

describe('meleeSwingSystem — Floor-2 scale (180 enemies spread, 6 swings)', () => {
  const legacyScene = buildMeleeScene(180, 320, 6);
  bench('full scan (legacy)', () => {
    resetMeleeScene(legacyScene);
    meleeSwingSystem(legacyScene.world);
  });

  const gridScene = buildMeleeScene(180, 320, 6);
  bench('grid broad-phase', () => {
    resetMeleeScene(gridScene);
    meleeSwingSystem(gridScene.world, gridScene.collision);
  });
});

describe('meleeSwingSystem — dense worst-case (180 enemies clustered, 6 swings)', () => {
  const legacyScene = buildMeleeScene(180, 24, 6);
  bench('full scan (legacy)', () => {
    resetMeleeScene(legacyScene);
    meleeSwingSystem(legacyScene.world);
  });

  const gridScene = buildMeleeScene(180, 24, 6);
  bench('grid broad-phase', () => {
    resetMeleeScene(gridScene);
    meleeSwingSystem(gridScene.world, gridScene.collision);
  });
});
