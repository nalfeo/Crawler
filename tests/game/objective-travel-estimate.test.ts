import { describe, expect, it } from 'vitest';
import {
  estimateObjectiveTravelMs,
  type ObjectiveTravelAdapters,
  type ObjectiveTravelEstimatorParams,
} from '../../src/game/ai/objective-travel-estimate.js';

const PARAMS: ObjectiveTravelEstimatorParams = {
  moveSpeedFtPerMs: 0.12,
  wallSafetyFactor: 1.5,
  wallSafetyBufferMs: 750,
};

function makeAdaptersFromTiles(
  tiles: readonly { x: number; y: number }[],
): ObjectiveTravelAdapters {
  return {
    tileSizeFt: 4,
    worldToTile: (x, y) => ({ x: Math.floor(x / 4), y: Math.floor(y / 4) }),
    findTilePath: () => tiles,
  };
}

describe('estimateObjectiveTravelMs', () => {
  it('falls back to straight-line + safety when no adapters are supplied', () => {
    const estimate = estimateObjectiveTravelMs({ x: 0, y: 0 }, { x: 100, y: 0 }, null, PARAMS);
    expect(estimate.usedAStar).toBe(false);
    expect(estimate.distanceFt).toBeCloseTo(100, 6);
    // 100 ft × 1.5 / 0.12 ft-per-ms + 750 ms buffer = 1250 + 750 = 2000 ms.
    expect(estimate.travelMs).toBeCloseTo(2000, 6);
  });

  it('uses A* hop count × tileSize when adapters provide a path', () => {
    // 6 tiles, 5 hops @ 4 ft = 20 ft. At 0.12 ft/ms → 166.666... ms.
    const path = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 4, y: 0 },
      { x: 5, y: 0 },
    ];
    const estimate = estimateObjectiveTravelMs(
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      makeAdaptersFromTiles(path),
      PARAMS,
    );
    expect(estimate.usedAStar).toBe(true);
    expect(estimate.distanceFt).toBeCloseTo(20, 6);
    expect(estimate.travelMs).toBeCloseTo(20 / 0.12, 6);
  });

  it('uses fallback when A* returns an empty path (no route exists)', () => {
    const estimate = estimateObjectiveTravelMs(
      { x: 0, y: 0 },
      { x: 30, y: 40 },
      makeAdaptersFromTiles([]),
      PARAMS,
    );
    expect(estimate.usedAStar).toBe(false);
    // Straight-line distance = 50 ft.
    expect(estimate.distanceFt).toBeCloseTo(50, 6);
  });

  it('is deterministic for identical inputs', () => {
    const adapters = makeAdaptersFromTiles([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ]);
    const a = estimateObjectiveTravelMs({ x: 0, y: 0 }, { x: 8, y: 8 }, adapters, PARAMS);
    const b = estimateObjectiveTravelMs({ x: 0, y: 0 }, { x: 8, y: 8 }, adapters, PARAMS);
    expect(a).toEqual(b);
  });

  it('returns zero travel when start and goal share the same tile (single-tile path)', () => {
    const estimate = estimateObjectiveTravelMs(
      { x: 1, y: 1 },
      { x: 1, y: 1 },
      makeAdaptersFromTiles([{ x: 0, y: 0 }]),
      PARAMS,
    );
    expect(estimate.usedAStar).toBe(true);
    expect(estimate.travelMs).toBe(0);
    expect(estimate.distanceFt).toBe(0);
  });

  it('fallback always exceeds the raw straight-line planner time', () => {
    // The run planner treats straight-line ÷ moveSpeed as the base travel-time
    // estimate. The A*-unavailable fallback must be strictly larger so it
    // captures the wall-safety intent of the estimator.
    const distanceFt = 60;
    const planStraightLineMs = distanceFt / PARAMS.moveSpeedFtPerMs;
    const estimate = estimateObjectiveTravelMs(
      { x: 0, y: 0 },
      { x: distanceFt, y: 0 },
      null,
      PARAMS,
    );
    expect(estimate.travelMs).toBeGreaterThan(planStraightLineMs);
  });
});
