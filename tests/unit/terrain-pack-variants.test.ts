/**
 * Tests for deterministic terrain-pack variant selection
 * (`src/shared/terrain-pack-variants.ts`) — pool variant picking and the
 * pure door-state resolver (reviewed-design refinements #3, #5).
 */
import { describe, expect, it } from 'vitest';
import {
  buildWeightedCombos,
  buildGroundDecalStampConfig,
  buildPoolStampConfig,
  deriveTileVariantSeed,
  pickPoolCombo,
  pickPoolVariant,
  pickWallAccentSelection,
  pickGroundDecal,
  GROUND_DECAL_DENSITY,
  groundDecalHalfExtentPx,
  resolveDoorOrientationFromFlanks,
  WALL_ACCENT_DENSITY,
} from '../../src/shared/terrain-pack-variants.js';
import type {
  PoolVariantDef,
  TransformId,
  WallAccentDef,
} from '../../src/shared/terrain-pack-types.js';

function pool(count: number, allowedTransforms: TransformId[] = ['none']): PoolVariantDef[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `variant-${i}`,
    imagePath: `assets/variant-${i}.png`,
    textureKey: `variant-${i}`,
    allowedTransforms,
  }));
}

/**
 * An 8-source pool matching the shipped industrial-cave contract's shape:
 * every source allows 'none' + at least one more transform (6 sources allow
 * all 4, 2 sources are deliberately restricted to 2 — mirroring the real
 * pack's directionally-unsafe gradient variants).
 */
function eightSourcePool(): PoolVariantDef[] {
  const all4: TransformId[] = ['none', 'flipH', 'flipV', 'flipHV'];
  const restricted: TransformId[] = ['none', 'flipH'];
  return Array.from({ length: 8 }, (_, i) => ({
    id: `source-${i}`,
    imagePath: `assets/source-${i}.png`,
    textureKey: `source-${i}`,
    allowedTransforms: i === 6 || i === 5 ? restricted : all4,
  }));
}

/**
 * The shipped weighting shape: a dominant plain base, a high-weight quiet
 * variant, and six sparse detail variants (10 : 8 : 1x6, total 24).
 */
function weightedPool(): PoolVariantDef[] {
  return eightSourcePool().map((v, i) => ({
    ...v,
    weight: i === 0 ? 10 : i === 1 ? 8 : 1,
  }));
}

const accents: WallAccentDef[] = ['crack', 'mineral-vein', 'rust-brace', 'damp-stain'].map(
  (id) => ({
    id,
    imagePath: `assets/accent-${id}.png`,
    textureKey: `accent-${id}`,
  }),
);

describe('deriveTileVariantSeed', () => {
  it('is a pure function of (floorSeed, tx, ty): same inputs -> same output', () => {
    expect(deriveTileVariantSeed(42, 3, 5)).toBe(deriveTileVariantSeed(42, 3, 5));
  });

  it('varies with tile coordinates for a fixed floor seed', () => {
    const a = deriveTileVariantSeed(42, 3, 5);
    const b = deriveTileVariantSeed(42, 3, 6);
    const c = deriveTileVariantSeed(42, 4, 5);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('varies with the floor seed for a fixed coordinate', () => {
    expect(deriveTileVariantSeed(1, 0, 0)).not.toBe(deriveTileVariantSeed(2, 0, 0));
  });

  it('never returns a value outside the signed 32-bit range', () => {
    for (let i = 0; i < 200; i++) {
      const value = deriveTileVariantSeed(i * 7919, i, i * 3);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(value).toBeLessThan(2 ** 31);
    }
  });
});

describe('pickPoolVariant', () => {
  it('returns null for an empty pool (caller falls back to legacy rendering)', () => {
    expect(pickPoolVariant([], 42, 0, 0)).toBeNull();
  });

  it('returns the sole variant for a single-entry pool regardless of coordinates', () => {
    const single = pool(1);
    expect(pickPoolVariant(single, 42, 0, 0)).toBe(single[0]);
    expect(pickPoolVariant(single, 999, 17, 4)).toBe(single[0]);
  });

  it('is deterministic: the same (pool, seed, x, y) always yields the same variant', () => {
    const p = pool(5);
    const first = pickPoolVariant(p, 42, 10, 20);
    const second = pickPoolVariant(p, 42, 10, 20);
    expect(first).toBe(second);
  });

  it('produces different variants across a spread of coordinates (not constant)', () => {
    const p = pool(5);
    const results = new Set<string>();
    for (let x = 0; x < 20; x++) {
      for (let y = 0; y < 20; y++) {
        const v = pickPoolVariant(p, 42, x, y);
        if (v) results.add(v.id);
      }
    }
    // With 400 samples across 5 variants we expect meaningfully more than 1
    // distinct id to appear — proves it isn't degenerately constant.
    expect(results.size).toBeGreaterThan(1);
  });

  it('always returns a member of the supplied pool', () => {
    const p = pool(4);
    const ids = new Set(p.map((v) => v.id));
    for (let x = 0; x < 10; x++) {
      const variant = pickPoolVariant(p, 7, x, x * 2);
      expect(variant).not.toBeNull();
      expect(ids.has(variant!.id)).toBe(true);
    }
  });
});

describe('buildWeightedCombos — weighted expansion (2026-07-26 shared-base redesign)', () => {
  it('expands every (variant, allowed transform) pair exactly once', () => {
    const p = eightSourcePool();
    const combos = buildWeightedCombos(p);
    const keys = combos.map((c) => `${c.combo.variant.id}:${c.combo.transform}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(p.reduce((n, v) => n + (v.allowedTransforms?.length ?? 1), 0));
  });

  it('divides a declared weight evenly across a variant\u2019s transforms, so weight is total probability', () => {
    const combos = buildWeightedCombos(weightedPool());
    const totalFor = (id: string) =>
      combos.filter((c) => c.combo.variant.id === id).reduce((n, c) => n + c.weight, 0);
    // source-0 has 4 transforms, source-5 has 2 — declared weight still lands whole.
    expect(totalFor('source-0')).toBeCloseTo(10, 10);
    expect(totalFor('source-5')).toBeCloseTo(1, 10);
    expect(combos.reduce((n, c) => n + c.weight, 0)).toBeCloseTo(24, 10);
  });

  it('treats an omitted weight as 1, reproducing the legacy uniform-per-variant draw', () => {
    const combos = buildWeightedCombos(eightSourcePool());
    const totals = new Set(
      combos
        .map((c) => c.combo.variant.id)
        .filter((id, i, a) => a.indexOf(id) === i)
        .map((id) =>
          combos.filter((c) => c.combo.variant.id === id).reduce((n, c) => n + c.weight, 0),
        ),
    );
    expect([...totals]).toEqual([1]);
  });
});

describe('pickPoolCombo — weighted deterministic draw (2026-07-26 shared-base redesign)', () => {
  it('returns null for an empty pool', () => {
    expect(pickPoolCombo([], 42, 0, 0)).toBeNull();
  });

  it('is deterministic: the same (pool, seed, x, y) always yields the same combo', () => {
    const p = weightedPool();
    const first = pickPoolCombo(p, 42, 10, 20);
    const second = pickPoolCombo(p, 42, 10, 20);
    expect(first).toEqual(second);
  });

  it('only ever returns a source + transform declared by the pool', () => {
    const p = weightedPool();
    const byId = new Map(p.map((v) => [v.id, v]));
    for (let x = 0; x < 25; x++) {
      for (let y = 0; y < 25; y++) {
        const combo = pickPoolCombo(p, 7, x, y)!;
        expect(combo).not.toBeNull();
        expect(byId.get(combo.variant.id)?.allowedTransforms).toContain(combo.transform);
      }
    }
  });

  it('honours declared weights: the plain base and quiet variant dominate the field', () => {
    const p = weightedPool();
    const counts = new Map<string, number>();
    let total = 0;
    for (const seed of [1, 42, 999, 123456]) {
      for (let x = 0; x < 40; x++) {
        for (let y = 0; y < 40; y++) {
          const combo = pickPoolCombo(p, seed, x, y)!;
          counts.set(combo.variant.id, (counts.get(combo.variant.id) ?? 0) + 1);
          total++;
        }
      }
    }
    const share = (id: string) => (counts.get(id) ?? 0) / total;
    // Declared 10 : 8 : 1x6 of 24 => 41.7% / 33.3% / 4.2% each.
    expect(share('source-0')).toBeGreaterThan(0.37);
    expect(share('source-0')).toBeLessThan(0.46);
    expect(share('source-1')).toBeGreaterThan(0.29);
    expect(share('source-1')).toBeLessThan(0.38);
    expect(share('source-0') + share('source-1')).toBeGreaterThan(0.65);
    // Every sparse detail variant still appears — dominance must not starve them.
    for (let i = 2; i < 8; i++) {
      expect(counts.get(`source-${i}`) ?? 0).toBeGreaterThan(0);
    }
  });

  it('draws all 8 sources roughly evenly when no weights are declared', () => {
    const p = eightSourcePool();
    const counts = new Map<string, number>();
    let total = 0;
    for (const seed of [1, 42, 999, 123456]) {
      for (let x = 0; x < 40; x++) {
        for (let y = 0; y < 40; y++) {
          const combo = pickPoolCombo(p, seed, x, y)!;
          counts.set(combo.variant.id, (counts.get(combo.variant.id) ?? 0) + 1);
          total++;
        }
      }
    }
    expect(counts.size).toBe(8);
    for (const n of counts.values()) {
      expect(n / total).toBeGreaterThan(0.09);
      expect(n / total).toBeLessThan(0.16);
    }
  });

  it('permits matching orthogonal neighbours — anti-adjacency was removed deliberately', () => {
    // The 2026-07-25 parity-bucket design forced neighbours to differ, which
    // maximised the very seams that made the field read as a quilt. Cohesion is
    // now guaranteed structurally (shared byte-identical tile borders), so a
    // repeated neighbour is correct output, not a defect.
    const p = weightedPool();
    let matchingNeighbours = 0;
    for (let x = 0; x < 40; x++) {
      for (let y = 0; y < 40; y++) {
        const here = pickPoolCombo(p, 42, x, y)!;
        const right = pickPoolCombo(p, 42, x + 1, y)!;
        if (`${here.variant.id}:${here.transform}` === `${right.variant.id}:${right.transform}`) {
          matchingNeighbours++;
        }
      }
    }
    expect(matchingNeighbours).toBeGreaterThan(0);
  });
});

describe('buildPoolStampConfig — center-origin runtime transform (2026-07-25 resolution #2)', () => {
  it('none is the identity: positive scale on both axes, center origin', () => {
    expect(buildPoolStampConfig('none', 2)).toEqual({
      originX: 0.5,
      originY: 0.5,
      scaleX: 2,
      scaleY: 2,
    });
  });

  it('flipH negates only scaleX', () => {
    expect(buildPoolStampConfig('flipH', 2)).toEqual({
      originX: 0.5,
      originY: 0.5,
      scaleX: -2,
      scaleY: 2,
    });
  });

  it('flipV negates only scaleY', () => {
    expect(buildPoolStampConfig('flipV', 2)).toEqual({
      originX: 0.5,
      originY: 0.5,
      scaleX: 2,
      scaleY: -2,
    });
  });

  it('flipHV negates both axes', () => {
    expect(buildPoolStampConfig('flipHV', 2)).toEqual({
      originX: 0.5,
      originY: 0.5,
      scaleX: -2,
      scaleY: -2,
    });
  });
});

describe('pickWallAccentSelection — wall-accent density + representation (2026-07-25 resolution #4)', () => {
  it('returns null for an empty accent list', () => {
    expect(pickWallAccentSelection([], 42, 0, 0)).toBeNull();
  });

  it('is deterministic for the same (accents, seed, x, y)', () => {
    const first = pickWallAccentSelection(accents, 42, 5, 5);
    const second = pickWallAccentSelection(accents, 42, 5, 5);
    expect(first).toEqual(second);
  });

  it('a large multi-seed sample lands total accented density in the required 15-25% band', () => {
    let total = 0;
    let accented = 0;
    for (const seed of [1, 42, 999, 123456, 55]) {
      for (let x = 0; x < 100; x++) {
        for (let y = 0; y < 100; y++) {
          total++;
          if (pickWallAccentSelection(accents, seed, x, y)) accented++;
        }
      }
    }
    const density = accented / total;
    expect(density).toBeGreaterThanOrEqual(0.15);
    expect(density).toBeLessThanOrEqual(0.25);
  });

  it('all 4 accent variants are represented among accented tiles with reasonable balance', () => {
    const counts: Record<string, number> = Object.fromEntries(accents.map((a) => [a.id, 0]));
    for (const seed of [1, 42, 999, 123456, 55]) {
      for (let x = 0; x < 100; x++) {
        for (let y = 0; y < 100; y++) {
          const accent = pickWallAccentSelection(accents, seed, x, y);
          if (accent) counts[accent.id] = (counts[accent.id] ?? 0) + 1;
        }
      }
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    for (const accent of accents) {
      const share = (counts[accent.id] ?? 0) / total;
      // Perfectly uniform would be 25% each; require every accent to hold a
      // "reasonable" (not negligible, not dominant) share.
      expect(share).toBeGreaterThan(0.1);
      expect(share).toBeLessThan(0.4);
    }
  });

  it('respects the exported WALL_ACCENT_DENSITY as its default density parameter', () => {
    expect(WALL_ACCENT_DENSITY).toBeGreaterThanOrEqual(0.15);
    expect(WALL_ACCENT_DENSITY).toBeLessThanOrEqual(0.25);
  });

  describe('pickGroundDecal', () => {
    const FRAMES = 6;

    it('is a pure function of seed and anchor coordinates', () => {
      for (let ay = 0; ay < 8; ay += 1) {
        for (let ax = 0; ax < 8; ax += 1) {
          expect(pickGroundDecal(FRAMES, 1234, ax, ay)).toEqual(
            pickGroundDecal(FRAMES, 1234, ax, ay),
          );
        }
      }
    });

    it('produces different layouts for different floor seeds', () => {
      const layoutFor = (seed: number): string =>
        Array.from({ length: 12 }, (_, ay) =>
          Array.from({ length: 12 }, (_, ax) => {
            const pick = pickGroundDecal(FRAMES, seed, ax, ay);
            return pick ? String(pick.frame) : '.';
          }).join(''),
        ).join('|');
      expect(layoutFor(1)).not.toEqual(layoutFor(2));
    });

    it('keeps frame indices in range and offsets inside the unit cell', () => {
      for (let ay = 0; ay < 24; ay += 1) {
        for (let ax = 0; ax < 24; ax += 1) {
          const pick = pickGroundDecal(FRAMES, 99, ax, ay);
          if (!pick) continue;
          expect(pick.frame).toBeGreaterThanOrEqual(0);
          expect(pick.frame).toBeLessThan(FRAMES);
          expect(pick.offsetX).toBeGreaterThanOrEqual(0);
          expect(pick.offsetX).toBeLessThan(1);
          expect(pick.offsetY).toBeGreaterThanOrEqual(0);
          expect(pick.offsetY).toBeLessThan(1);
          expect(pick.subTileX).toBeGreaterThanOrEqual(0);
          expect(pick.subTileX).toBeLessThan(1);
          expect(pick.subTileY).toBeGreaterThanOrEqual(0);
          expect(pick.subTileY).toBeLessThan(1);
          expect(pick.rotationDeg).toBeGreaterThanOrEqual(0);
          expect(pick.rotationDeg).toBeLessThan(360);
        }
      }
    });

    it('rotates off-axis, not in quarter turns, so an axis-aligned crack cannot stay grid-locked', () => {
      // A quarter turn maps horizontal to vertical, so it preserves the
      // alignment of a crack that already runs along an axis. Measured over the
      // shipped atlases several frames sit within 13 degrees of an axis, so
      // quarter turns alone leave them reading as a grid.
      const octants = new Array(8).fill(0);
      let offAxis = 0;
      let total = 0;
      for (let ay = 0; ay < 60; ay += 1) {
        for (let ax = 0; ax < 60; ax += 1) {
          const pick = pickGroundDecal(FRAMES, 31337, ax, ay);
          if (!pick) continue;
          octants[Math.floor(pick.rotationDeg / 45)] += 1;
          // Distance to the nearest multiple of 90 degrees.
          const toAxis = Math.min(pick.rotationDeg % 90, 90 - (pick.rotationDeg % 90));
          if (toAxis > 15) offAxis += 1;
          total += 1;
        }
      }
      // Angles must be spread, not snapped: every octant represented.
      expect(octants.every((c) => c / total > 0.08 && c / total < 0.18)).toBe(true);
      // Quarter-turn-only rotation would put 100% of decals ON an axis.
      expect(offAxis / total).toBeGreaterThan(0.6);
    });

    it('mirrors about half of decals, covering the reflection rotation alone cannot reach', () => {
      let mirrored = 0;
      let total = 0;
      for (let ay = 0; ay < 60; ay += 1) {
        for (let ax = 0; ax < 60; ax += 1) {
          const pick = pickGroundDecal(FRAMES, 31337, ax, ay);
          if (!pick) continue;
          if (pick.flipX) mirrored += 1;
          total += 1;
        }
      }
      expect(mirrored / total).toBeGreaterThan(0.4);
      expect(mirrored / total).toBeLessThan(0.6);
    });

    it('shifts decals off the tile grid so a decal edge rarely lands on a tile edge', () => {
      // Snapping to the tile grid aligns every decal boundary with a tile
      // boundary, which is itself a tiling cue independent of the artwork.
      let offGrid = 0;
      let total = 0;
      for (let ay = 0; ay < 60; ay += 1) {
        for (let ax = 0; ax < 60; ax += 1) {
          const pick = pickGroundDecal(FRAMES, 5150, ax, ay);
          if (!pick) continue;
          if (pick.subTileX > 0.1 && pick.subTileY > 0.1) offGrid += 1;
          total += 1;
        }
      }
      expect(offGrid / total).toBeGreaterThan(0.6);
    });

    it('stamps close to the configured density over a large anchor sample', () => {
      let stamped = 0;
      let total = 0;
      for (let ay = 0; ay < 60; ay += 1) {
        for (let ax = 0; ax < 60; ax += 1) {
          if (pickGroundDecal(FRAMES, 4242, ax, ay)) stamped += 1;
          total += 1;
        }
      }
      expect(stamped / total).toBeGreaterThan(GROUND_DECAL_DENSITY - 0.06);
      expect(stamped / total).toBeLessThan(GROUND_DECAL_DENSITY + 0.06);
    });

    it('decorrelates sets so a second lattice fills the first lattice gaps', () => {
      // Without a per-set salt, two sets draw the same value at the same (ax, ay)
      // and therefore skip the SAME anchors wherever their lattices coincide —
      // re-creating the bands of untouched ground the second set exists to fill.
      let agree = 0;
      let total = 0;
      for (let ay = 0; ay < 60; ay += 1) {
        for (let ax = 0; ax < 60; ax += 1) {
          const a = pickGroundDecal(FRAMES, 4242, ax, ay, 0.5, 0);
          const b = pickGroundDecal(FRAMES, 4242, ax, ay, 0.5, 1);
          if (Boolean(a) === Boolean(b)) agree += 1;
          total += 1;
        }
      }
      // Independent 50/50 draws agree ~50% of the time; a shared hash agrees 100%.
      expect(agree / total).toBeGreaterThan(0.4);
      expect(agree / total).toBeLessThan(0.6);
    });

    it('returns null when the atlas has no frames', () => {
      expect(pickGroundDecal(0, 7, 1, 1)).toBeNull();
    });
  });

  describe('buildGroundDecalStampConfig', () => {
    it('is center-origin so rotation and mirroring act about the frame middle', () => {
      const config = buildGroundDecalStampConfig(2, 0, false);
      expect(config.originX).toBe(0.5);
      expect(config.originY).toBe(0.5);
      expect(config.scaleX).toBe(2);
      expect(config.scaleY).toBe(2);
      expect(config.angle).toBe(0);
    });

    it('mirrors by negating only scaleX, matching buildPoolStampConfig', () => {
      const config = buildGroundDecalStampConfig(2, 0, true);
      expect(config.scaleX).toBe(-2);
      expect(config.scaleY).toBe(2);
    });

    it('passes the continuous angle through rather than snapping it to a quarter turn', () => {
      expect(buildGroundDecalStampConfig(1, 37.5, false).angle).toBe(37.5);
      expect(buildGroundDecalStampConfig(1, 212.25, true).angle).toBe(212.25);
    });
  });

  describe('groundDecalHalfExtentPx', () => {
    it('equals half the size when axis-aligned (the square covers exactly its own span)', () => {
      expect(groundDecalHalfExtentPx(192, 0)).toBeCloseTo(96);
      expect(groundDecalHalfExtentPx(192, 90)).toBeCloseTo(96);
      expect(groundDecalHalfExtentPx(192, 180)).toBeCloseTo(96);
    });

    it('peaks at sqrt(2)/2 * size at 45 degrees, where the corners sweep furthest out', () => {
      expect(groundDecalHalfExtentPx(192, 45)).toBeCloseTo(96 * Math.SQRT2);
      expect(groundDecalHalfExtentPx(192, 135)).toBeCloseTo(96 * Math.SQRT2);
    });

    it('never reports less than half the size, so the check can never under-cover the stamp', () => {
      for (let deg = 0; deg < 360; deg += 3) {
        const extent = groundDecalHalfExtentPx(192, deg);
        expect(extent).toBeGreaterThanOrEqual(96 - 1e-9);
        expect(extent).toBeLessThanOrEqual(96 * Math.SQRT2 + 1e-9);
      }
    });
  });
});

describe('resolveDoorOrientationFromFlanks — door axis semantics (Fix 2)', () => {
  it('horizontalDoorway=true (walls left+right) → vertical art (passage runs top-to-bottom)', () => {
    expect(resolveDoorOrientationFromFlanks(true)).toBe('vertical');
  });

  it('horizontalDoorway=false (walls top+bottom) → horizontal art (passage runs left-to-right)', () => {
    expect(resolveDoorOrientationFromFlanks(false)).toBe('horizontal');
  });

  it('is a pure function: same input always returns the same string', () => {
    expect(resolveDoorOrientationFromFlanks(true)).toBe(resolveDoorOrientationFromFlanks(true));
    expect(resolveDoorOrientationFromFlanks(false)).toBe(resolveDoorOrientationFromFlanks(false));
  });
});
