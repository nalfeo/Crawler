import { describe, expect, it } from 'vitest';
import {
  createBloodFootprintSurface,
  createBloodPoolSurface,
  isPointInsideBloodPool,
  mixBloodColors,
} from '../../src/shared/blood-surfaces.js';

describe('blood surface helpers', () => {
  it('mixes two blood colors by averaging their RGB channels', () => {
    expect(mixBloodColors(0xcc0000, 0x00cc66)).toBe(0x666633);
  });

  it('builds deterministic blood pool geometry from world seed + pool id', () => {
    const left = createBloodPoolSurface({
      worldSeed: 42,
      poolId: 7,
      x: 10,
      y: 20,
      color: 0x336699,
      overkill: 8,
      createdAtMs: 1000,
    });
    const right = createBloodPoolSurface({
      worldSeed: 42,
      poolId: 7,
      x: 10,
      y: 20,
      color: 0x336699,
      overkill: 8,
      createdAtMs: 1000,
    });
    const different = createBloodPoolSurface({
      worldSeed: 42,
      poolId: 8,
      x: 10,
      y: 20,
      color: 0x336699,
      overkill: 8,
      createdAtMs: 1000,
    });

    expect(left).toEqual(right);
    expect(different.lobes).not.toEqual(left.lobes);
  });

  it('scales initial pool size from enemy size', () => {
    const smallEnemyPool = createBloodPoolSurface({
      worldSeed: 42,
      poolId: 11,
      x: 0,
      y: 0,
      enemySizeFt: 1,
      createdAtMs: 1000,
    });
    const largeEnemyPool = createBloodPoolSurface({
      worldSeed: 42,
      poolId: 11,
      x: 0,
      y: 0,
      enemySizeFt: 4,
      createdAtMs: 1000,
    });
    const getMaxLobeRadius = (pool: ReturnType<typeof createBloodPoolSurface>): number =>
      Math.max(...pool.lobes.map((lobe) => Math.max(lobe.radiusXFt, lobe.radiusYFt)));

    expect(getMaxLobeRadius(largeEnemyPool)).toBeGreaterThan(getMaxLobeRadius(smallEnemyPool));
    expect(largeEnemyPool.contactRadiusFt).toBeGreaterThan(smallEnemyPool.contactRadiusFt);
  });

  it('varies lobe count and growth timing for irregular spread profiles', () => {
    const pools = [1, 2, 3, 4].map((poolId) =>
      createBloodPoolSurface({
        worldSeed: 42,
        poolId,
        x: 0,
        y: 0,
        createdAtMs: 1000,
      }),
    );
    const lobeCounts = new Set(pools.map((pool) => pool.lobes.length));
    const growthSpreads = pools.map((pool) => {
      const growAtValues = pool.lobes.map((lobe) => lobe.growAt);
      return Math.max(...growAtValues) - Math.min(...growAtValues);
    });

    expect(lobeCounts.size).toBeGreaterThan(1);
    expect(growthSpreads.some((spread) => spread > 0.35)).toBe(true);
  });

  it('alternates footprint placement across the stride direction', () => {
    const left = createBloodFootprintSurface({
      worldSeed: 7,
      footprintId: 1,
      stampId: 0,
      color: 0xcc0000,
      fromX: 0,
      fromY: 0,
      toX: 1,
      toY: 0,
      createdAtMs: 100,
    });
    const right = createBloodFootprintSurface({
      worldSeed: 7,
      footprintId: 2,
      stampId: 1,
      color: 0xcc0000,
      fromX: 0,
      fromY: 0,
      toX: 1,
      toY: 0,
      createdAtMs: 100,
    });

    expect(left.y).toBeLessThan(0);
    expect(right.y).toBeGreaterThan(0);
    expect(left.angleRad).toBeCloseTo(0);
    expect(right.angleRad).toBeCloseTo(0);
  });

  it('uses the original stride distance to strengthen smears for faster movement', () => {
    const shortStride = createBloodFootprintSurface({
      worldSeed: 7,
      footprintId: 1,
      stampId: 2,
      color: 0xcc0000,
      fromX: 0,
      fromY: 0,
      toX: 0.42,
      toY: 0,
      createdAtMs: 100,
      strideDistanceFt: 0.42,
    });
    const longStride = createBloodFootprintSurface({
      worldSeed: 7,
      footprintId: 2,
      stampId: 3,
      color: 0xcc0000,
      fromX: 0,
      fromY: 0,
      toX: 0.42,
      toY: 0,
      createdAtMs: 100,
      strideDistanceFt: 1.4,
    });

    expect(shortStride.smearLengthFt).toBe(0);
    expect(longStride.smearLengthFt).toBeGreaterThan(shortStride.smearLengthFt);
    expect(longStride.toeOffsetFt).toBeGreaterThan(shortStride.toeOffsetFt);
  });

  it('only activates pool contact once the visibly grown blood reaches the point', () => {
    const pool = createBloodPoolSurface({
      worldSeed: 42,
      poolId: 1,
      x: 10,
      y: 20,
      createdAtMs: 1000,
    });
    const pointX = pool.x + pool.renderOffsetXFt + pool.lobes[0]!.radiusXFt * 0.6;
    const pointY = pool.y + pool.renderOffsetYFt;

    expect(isPointInsideBloodPool(pool, pointX, pointY, 1000)).toBe(false);
    expect(isPointInsideBloodPool(pool, pointX, pointY, 1000 + 12_000)).toBe(true);
  });
});
