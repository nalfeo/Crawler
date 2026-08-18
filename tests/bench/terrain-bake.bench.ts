/**
 * Benchmarks for `buildTerrainLayer` — the single most expensive step of floor
 * load (see `game:terrain-bake` in `MainGameScene`).
 *
 * Run with: npm run bench
 * Or:       npx vitest bench
 *
 * These benchmarks measure the CPU half of the bake (tile iteration, mask
 * computation, pool selection, command-buffer construction) against a counting
 * RenderTexture. They deliberately do NOT measure GPU time — there is no GL
 * context here. The GPU half is proportional to the COMMAND COUNTS asserted in
 * `tests/unit/terrain-bake-commands.test.ts`, which is the deterministic gate;
 * the ms figures here are advisory.
 *
 * Both real floors are covered because they exercise different halves of the
 * renderer: Floor 1 is pure wall/floor/corridor pack stamping, while Floor 2
 * additionally runs the wall-accent, ground-decal and industrial-linework
 * passes.
 */

import { bench, describe } from 'vitest';
import { buildTerrainLayer } from '../../src/engine/terrain-renderer.js';
import {
  FLOOR1_BAKE_CONFIG,
  FLOOR2_BAKE_CONFIG,
  createPackBakeScene,
  generateBakeFloorMap,
} from '../helpers/terrain-bake-harness.js';

// Map generation is itself expensive and is NOT what we are measuring, so both
// maps are generated once at module scope and re-baked per iteration.
const floor1Map = generateBakeFloorMap(FLOOR1_BAKE_CONFIG);
const floor2Map = generateBakeFloorMap(FLOOR2_BAKE_CONFIG);

describe('buildTerrainLayer', () => {
  bench('Floor 1 bake — 240x140 (33,600 tiles), dungeon + cave packs', () => {
    const { scene } = createPackBakeScene(['floor1-dungeon', 'floor1-cave']);
    buildTerrainLayer(scene, floor1Map, {
      terrainPacks: { stone: 'floor1-dungeon', cave: 'floor1-cave' },
    });
  });

  bench('Floor 2 bake — 200x200 (40,000 tiles), industrial-cave pack', () => {
    const { scene } = createPackBakeScene(['industrial-cave']);
    buildTerrainLayer(scene, floor2Map, { terrainPackId: 'industrial-cave' });
  });
});
