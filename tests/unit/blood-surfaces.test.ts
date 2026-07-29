import { describe, expect, it } from 'vitest';
import {
  BLOODY_FOOTPRINT_EMIT_DISTANCE_FT,
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
      toX: BLOODY_FOOTPRINT_EMIT_DISTANCE_FT,
      toY: 0,
      createdAtMs: 100,
      strideDistanceFt: BLOODY_FOOTPRINT_EMIT_DISTANCE_FT,
    });
    const longStride = createBloodFootprintSurface({
      worldSeed: 7,
      footprintId: 2,
      stampId: 3,
      color: 0xcc0000,
      fromX: 0,
      fromY: 0,
      toX: BLOODY_FOOTPRINT_EMIT_DISTANCE_FT,
      toY: 0,
      createdAtMs: 100,
      strideDistanceFt: BLOODY_FOOTPRINT_EMIT_DISTANCE_FT * 3.33,
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

  // ─── Shape variance profile: deterministic before/after evidence ─────────
  //
  // Before this PR the authoritative blood-pool model used:
  //   • Fixed lobe count: BLOOD_POOL_LOBE_COUNT = 5 (constant, never varied)
  //   • Growth timing: 0.55 + rng.next() * 0.45  →  range [0.55, 1.00], max spread 0.45
  //   • Non-core initial scale: always 0 (lobes appeared only after core expanded)
  //   • No dominant-axis bias (offsets uniformly distributed around origin)
  //
  // After this PR (measured against seeds 42, pools 1-20):
  //   • Lobe counts: 5, 6, 7, 8 across the sample (four distinct values)
  //   • Max growth spread observed: 0.697  (was capped at 0.45)
  //   • Non-core initial scales: 0.009–0.179  (were always 0)

  describe('shape variance profile (before/after evidence)', () => {
    // Stable sample — 20 pools with a fixed seed gives reproducible metrics.
    const SAMPLE_POOLS = Array.from({ length: 20 }, (_, i) =>
      createBloodPoolSurface({ worldSeed: 42, poolId: i + 1, x: 0, y: 0, createdAtMs: 0 }),
    );

    it('lobe count varies across pools (was fixed at 5 before)', () => {
      const lobeCounts = SAMPLE_POOLS.map((p) => p.lobes.length);
      const uniqueCounts = new Set(lobeCounts);
      // Before: single value {5}.  After: measured {5, 6, 7, 8}.
      expect(uniqueCounts.size).toBeGreaterThanOrEqual(3);
      expect(Math.max(...lobeCounts)).toBeGreaterThanOrEqual(7);
    });

    it('growth timing spreads wider than the old 0.45 ceiling', () => {
      const growthSpreads = SAMPLE_POOLS.map((p) => {
        const vals = p.lobes.map((l) => l.growAt);
        return Math.max(...vals) - Math.min(...vals);
      });
      const maxSpread = Math.max(...growthSpreads);
      // Before: max possible spread was 0.45 (range [0.55, 1.00]).
      // After: measured max spread 0.697 (range [0.30, 1.00]).
      expect(maxSpread).toBeGreaterThan(0.45);
    });

    it('non-core lobes have non-zero initial scale (was always 0 before)', () => {
      const nonCoreInitialScales = SAMPLE_POOLS.flatMap((p) =>
        p.lobes.slice(1).map((l) => l.initialScale),
      );
      // Before: every value was 0 → lobes only appeared after core finished.
      // After: measured values span 0.009–0.179.
      const positiveCount = nonCoreInitialScales.filter((s) => s > 0).length;
      expect(positiveCount).toBeGreaterThan(0);
      expect(Math.max(...nonCoreInitialScales)).toBeGreaterThan(0.05);
    });
  });

  // ─── Player-sprite calibration gate ─────────────────────────────────────
  //
  // The footprint constants must track the shipping player sprite. When
  // #2254 swapped the player from the 3.2 ft Kenney knight to the 5.22 ft
  // `rhea-vale-v1` sprite, these were left behind: stride spacing (0.42 ft)
  // was SHORTER than one print (0.52-0.64 ft), so the trail rendered as a
  // continuous streak instead of discrete alternating steps.
  describe('player-sprite calibration', () => {
    // Deterministic sample across stamp ids so both L/R sides and the full
    // rng range of every radius are represented.
    const SAMPLE = Array.from({ length: 200 }, (_, i) =>
      createBloodFootprintSurface({
        worldSeed: 1234,
        footprintId: i + 1,
        stampId: i,
        color: 0xcc0000,
        fromX: 0,
        fromY: 0,
        toX: BLOODY_FOOTPRINT_EMIT_DISTANCE_FT,
        toY: 0,
        createdAtMs: 0,
        strideDistanceFt: BLOODY_FOOTPRINT_EMIT_DISTANCE_FT,
      }),
    );

    /** Along-heading extent: heel sits behind the origin, toe ahead of it. */
    const printLengthFt = (f: (typeof SAMPLE)[number]): number =>
      f.heelRadiusXFt + f.toeOffsetFt + f.toeRadiusXFt;
    const printWidthFt = (f: (typeof SAMPLE)[number]): number =>
      2 * Math.max(f.heelRadiusYFt, f.toeRadiusYFt);

    it('spaces strides at least twice the longest print so prints never overlap', () => {
      const longestPrintFt = Math.max(...SAMPLE.map(printLengthFt));

      // Hard gate. Before recalibration this ratio was 0.42 / 0.64 = 0.66.
      expect(BLOODY_FOOTPRINT_EMIT_DISTANCE_FT / longestPrintFt).toBeGreaterThanOrEqual(2);
    });

    it('sizes prints to the 5.2 ft player sprite rather than the retired 3.2 ft knight', () => {
      const lengths = SAMPLE.map(printLengthFt);
      const widths = SAMPLE.map(printWidthFt);

      // Band matches the sprite's drawn boots; the old constants produced
      // 0.52-0.64 ft, well below this floor.
      expect(Math.min(...lengths)).toBeGreaterThanOrEqual(0.85);
      expect(Math.max(...lengths)).toBeLessThanOrEqual(1.05);
      // Keep a foot-like silhouette rather than a circular blob.
      const aspectRatios = SAMPLE.map((f) => printLengthFt(f) / printWidthFt(f));
      expect(Math.min(...aspectRatios)).toBeGreaterThan(1.8);
      expect(Math.max(...widths)).toBeLessThanOrEqual(0.46);
    });

    it('offsets left/right prints into a track that reads as two separate feet', () => {
      const leftPrints = SAMPLE.filter((_, i) => i % 2 === 0);
      const rightPrints = SAMPLE.filter((_, i) => i % 2 === 1);

      expect(leftPrints.every((f) => f.y < 0)).toBe(true);
      expect(rightPrints.every((f) => f.y > 0)).toBe(true);

      // The two rows must not merge into one centre line: the lateral gap
      // between opposing centerlines must exceed the SUM of both half-widths
      // so that no edge of a left print overlaps an edge of a right print.
      const nearestLeftFt = Math.max(...leftPrints.map((f) => f.y));
      const nearestRightFt = Math.min(...rightPrints.map((f) => f.y));
      const widestHalfWidthFt = Math.max(...SAMPLE.map(printWidthFt)) / 2;
      expect(nearestRightFt - nearestLeftFt).toBeGreaterThan(2 * widestHalfWidthFt);
    });
  });
});
