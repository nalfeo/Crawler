/**
 * Validation guard for the COMMITTED Floor 1 terrain packs (`floor1-dungeon`,
 * `floor1-cave`) — the runtime source of truth loaded by
 * `src/shared/terrain-pack-registry.ts`.
 *
 * Beyond the standard structural validators, this suite adds a
 * NON-DEGENERATE-ART guard. Every structural validator passed green while two
 * real generation bugs shipped flat art during this pack's authoring:
 *
 *   1. posterize ran BEFORE luminance normalization, collapsing an already
 *      variance-halved seamless tile into one or two bands (~178-byte PNGs);
 *   2. a missing `targetStdDev` on the door-wood tile made the contrast scale
 *      NaN, so every channel clamped to 0 and the door slabs rendered solid
 *      black.
 *
 * Neither is a schema, dimension, or edge-classification failure, so nothing
 * caught them. Asserting that each committed tile actually carries luminance
 * variation is the deterministic check that closes that class.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  validateManifestSchema,
  validateMaskCoverage,
  validateAtlasDimensions,
  validateCompatibleBoundaries,
  validateAuthoredSilhouetteExact,
  validateWallAutotileImagePath,
  validatePoolAndDoorImages,
} from '../../../scripts/sprites/terrain-packs/validate.js';
import { decodePng } from '../../../scripts/sprites/terrain-packs/png-buffer.js';
import { composeWallAtlas } from '../../../scripts/sprites/terrain-packs/gen/compose-pack.js';
import { wallCornerStyleForPack } from '../../../scripts/sprites/terrain-packs/wall-corner-style.js';
import type { TerrainPackDef } from '../../../src/shared/terrain-pack-types.js';

function repoRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..');
}

const FLOOR1_PACK_IDS = ['floor1-dungeon', 'floor1-cave'] as const;

function readManifest(packId: string): TerrainPackDef {
  return JSON.parse(
    readFileSync(
      path.join(repoRoot(), 'src', 'shared', 'data', 'terrain-packs', `${packId}.manifest.json`),
      'utf-8',
    ),
  ) as TerrainPackDef;
}

/**
 * Standard deviation of luminance over OPAQUE pixels only. Transparent pixels
 * are excluded because a silhouette's cut-away area is uniformly (0,0,0,0) and
 * would otherwise dominate the statistic.
 */
function opaqueLuminanceStdDev(pngPath: string): number {
  const img = decodePng(readFileSync(pngPath));
  const samples: number[] = [];
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3]! < 128) continue;
    samples.push(0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!);
  }
  if (samples.length === 0) return 0;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
  return Math.sqrt(variance);
}

/** Mean luminance over OPAQUE pixels only. */
function opaqueMeanLuminance(pngPath: string): number {
  const img = decodePng(readFileSync(pngPath));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3]! < 128) continue;
    sum += 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
    count++;
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * Strongest axis-aligned LINE artifact in a tile, expressed as a structure
 * score (higher = more lattice-like).  Scored PER AXIS and combined with
 * `max`, never pooled: column deltas and row deltas are differently-centred,
 * so a pooled percentile is uninterpretable in either direction. (Established
 * empirically with the Floor 2 terrain session on six tiles, where pooling was
 * shown to be non-monotonic — it read both high and low against per-axis truth.)
 *
 * The score for each axis combines two terms:
 *
 *   1. Max POSITIVE z-score of the per-line mean-luminance profile (original
 *      behaviour): catches isolated bright lines.  Dark lines produce negative
 *      z-scores which the original `Math.max` discards — intentionally, because
 *      organic textures have single dark cracks/grooves whose |z| can reach 4+
 *      without any lattice being present.  Applying abs to this term would
 *      falsely flag every such tile.
 *
 *   2. Outlier-count term using ABSOLUTE z-scores: counts lines with |z|>2.5
 *      and scales by 0.6.  For k equal-brightness lines in an n-pixel profile,
 *      each line's z-score is √((n−k)/k).  For n=64 and threshold=3.4, the max
 *      alone fails when k≥6 (√(58/6)≈3.11<3.4).  The count term compensates:
 *      k=6 lines all have |z|=3.11>2.5, so count×0.6=3.6>3.4.  Using absolute
 *      z here catches dense DARK lattices too (grooves repeating across a tile)
 *      without triggering on a single organic dark feature (1×0.6=0.6).
 *
 * Exposed as `computeMaxLineZScore` so the negative-control tests below can
 * exercise it against synthetic pixel buffers without touching disk.
 *
 * NOTE: the wall-atlas is intentionally excluded from the anti-lattice test
 * that calls this function.  A composed atlas has inherent periodic structure
 * (cells arranged in a grid) that inflates the count term on its many columns.
 * The lattice defect is about individual FLOOR tiles that tile across a room —
 * the wall-atlas is not displayed as a tiled floor and cannot create that
 * artifact.
 */
function computeMaxLineZScore(width: number, height: number, data: Buffer | Uint8Array): number {
  const axisPeak = (outer: number, inner: number, index: (a: number, b: number) => number) => {
    const means: number[] = [];
    for (let a = 0; a < outer; a++) {
      let sum = 0;
      let count = 0;
      for (let b = 0; b < inner; b++) {
        const i = index(a, b);
        if (data[i + 3]! < 128) continue;
        sum += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
        count++;
      }
      if (count > 0) means.push(sum / count);
    }
    if (means.length < 2) return 0;
    const mean = means.reduce((a, b) => a + b, 0) / means.length;
    const sd = Math.sqrt(means.reduce((a, b) => a + (b - mean) ** 2, 0) / means.length);
    if (sd === 0) return 0;
    // Term 1: max positive z-score — original bright-line detection.
    const maxPositiveZ = Math.max(...means.map((v) => (v - mean) / sd));
    // Term 2: outlier-count term — catches dense/periodic lattices (both signs).
    // k equal lines each score z=√((n−k)/k); for k≥6 this falls below 3.4.
    // Counting |z|>2.5 lines and scaling by 0.6 makes k=6 score 6×0.6=3.6.
    const nAbsOutliers = means.filter((v) => Math.abs((v - mean) / sd) > 2.5).length;
    // Term 3: dense periodicity term — catches k≥9 equal-spacing lattices.
    // For k=9 lines in a 64px profile, z=√(55/9)≈2.47, which is below the 2.5
    // threshold so Term 2 gives 0.  Counting |z|>2.0 lines and gating on ≥7
    // catches k≥9 without triggering on organic tiles (observed tiles have ≤6
    // lines with |z|>2.0 in the committed packs).  Scaling by 0.4 puts k=9
    // above the 3.4 gate (9×0.4=3.6).
    const nDenseOutliers = means.filter((v) => Math.abs((v - mean) / sd) > 2.0).length;
    return Math.max(
      maxPositiveZ,
      nAbsOutliers * 0.6,
      nDenseOutliers >= 7 ? nDenseOutliers * 0.4 : 0,
    );
  };
  return Math.max(
    axisPeak(width, height, (x, y) => (y * width + x) * 4),
    axisPeak(height, width, (y, x) => (y * width + x) * 4),
  );
}

function maxLineZScore(pngPath: string): number {
  const img = decodePng(readFileSync(pngPath));
  return computeMaxLineZScore(img.width, img.height, img.data);
}

/** Every image path the manifest references, relative to `public/`. */
function allImagePaths(manifest: TerrainPackDef): string[] {
  return [
    manifest.wallAutotile.imagePath,
    ...manifest.floorPool.map((v) => v.imagePath),
    ...manifest.corridorPool.map((v) => v.imagePath),
    ...Object.values(manifest.doorSet).map((v) => v.imagePath),
    ...Object.values(manifest.specialFloorPools ?? {}).flatMap((pool) =>
      pool.map((v) => v.imagePath),
    ),
  ];
}

describe.each(FLOOR1_PACK_IDS)('committed terrain pack — %s', (packId) => {
  const manifest = readManifest(packId);
  const atlas = decodePng(
    readFileSync(path.join(repoRoot(), 'public', manifest.wallAutotile.imagePath)),
  );

  it('parses against the shared terrain-pack schema', () => {
    expect(validateManifestSchema(manifest).ok).toBe(true);
  });

  it('covers all 47 canonical blob47 masks', () => {
    expect(validateMaskCoverage(manifest).ok).toBe(true);
  });

  it('has atlas dimensions matching its declared grid', () => {
    expect(validateAtlasDimensions(manifest, atlas).ok).toBe(true);
  });

  it('classifies 100% of cardinal edges (authored provenance floor)', () => {
    expect(validateCompatibleBoundaries(manifest, atlas, { minEdgePassRate: 1.0 }).ok).toBe(true);
  });

  /**
   * Edge classification only samples the four cardinal bands, so a defect
   * confined to a cell's interior scores a perfect 1.000 above. This asserts
   * every alpha pixel against `composeWallCellOutput`, the pure function the
   * silhouette is derived from.
   *
   * This is the guard that catches a STALE committed atlas: when #2189 changed
   * the canonical blob47 geometry (corner coverage + rounded cave corners), the
   * committed atlases here silently became wrong and every other check stayed
   * green. It surfaced only because someone ran the pack validator by hand.
   */
  it('matches the canonical silhouette exactly (catches a stale atlas)', () => {
    expect(validateAuthoredSilhouetteExact(manifest, atlas).ok).toBe(true);
  });

  it('resolves every referenced image path on disk', () => {
    expect(validateWallAutotileImagePath(manifest, { repoRoot: repoRoot() }).ok).toBe(true);
    expect(validatePoolAndDoorImages(manifest, { repoRoot: repoRoot() }).ok).toBe(true);
  });

  /**
   * REPRODUCIBILITY guard. Azure image generation is not byte-reproducible and
   * the raw material cache is gitignored, so without a tracked build input only
   * the original author's machine could recompose these atlases after a
   * canonical-geometry change like #2189 — the art would be detectably stale
   * but not repairably reproducible.
   *
   * `wall-material.png` is the committed 64x64 normalized wall tile the atlas is
   * textured from (matching the `industrial-cave` convention, which
   * `rebuild-shared-base-pools.ts` already reads from the tracked pack dir).
   * Recomposing from it must reproduce the committed atlas byte-for-byte, which
   * is what makes `gen/cli.ts --from-source` a real recovery path rather than a
   * claim. This also fails if someone edits the atlas without its source.
   */
  it('recomposes its committed atlas byte-for-byte from the tracked wall source', () => {
    const sourcePath = path.join(
      repoRoot(),
      'public',
      'assets',
      'terrain-packs',
      packId,
      'wall-material.png',
    );
    const wallTile = decodePng(readFileSync(sourcePath));
    expect({ width: wallTile.width, height: wallTile.height }).toEqual({ width: 64, height: 64 });

    const rebuilt = composeWallAtlas(wallTile, wallCornerStyleForPack(packId));
    expect({ width: rebuilt.atlas.width, height: rebuilt.atlas.height }).toEqual({
      width: atlas.width,
      height: atlas.height,
    });
    expect(Buffer.compare(Buffer.from(rebuilt.atlas.data), Buffer.from(atlas.data))).toBe(0);
  });

  it('ships NON-DEGENERATE art: every tile carries real luminance variation', () => {
    const flat: string[] = [];
    for (const imagePath of allImagePaths(manifest)) {
      const abs = path.join(repoRoot(), 'public', imagePath);
      // A posterized single-band tile lands near 0; healthy generated material
      // sits well above 4. This threshold catches collapse, not style.
      if (opaqueLuminanceStdDev(abs) < 4) flat.push(imagePath);
    }
    expect(flat).toEqual([]);
  });

  it('ships no all-black tile (guards the NaN-contrast door regression)', () => {
    const black: string[] = [];
    for (const imagePath of allImagePaths(manifest)) {
      const abs = path.join(repoRoot(), 'public', imagePath);
      if (opaqueMeanLuminance(abs) < 8) black.push(imagePath);
    }
    expect(black).toEqual([]);
  });

  /**
   * VALUE HIERARCHY: every walkable surface must read brighter than the wall it
   * sits against, or the walls stop reading as vertical and the room flattens.
   * (Floor 2 burned five procedural wall iterations adding TEXTURE before
   * finding the problem was tonal — see the Floor 2 terrain-variance ADR.)
   *
   * This is a real defect this guard caught: the boss-stair pool was authored
   * at mean luminance 58 against a 59.9 wall atlas, inverting the hierarchy in
   * the one room a player is guaranteed to walk into at the end of the floor.
   */
  it('keeps every ground surface brighter than the wall (value hierarchy)', () => {
    const wallMean = opaqueMeanLuminance(
      path.join(repoRoot(), 'public', manifest.wallAutotile.imagePath),
    );
    const groundPaths = [
      ...manifest.floorPool.map((v) => v.imagePath),
      ...manifest.corridorPool.map((v) => v.imagePath),
      ...Object.values(manifest.specialFloorPools ?? {}).flatMap((pool) =>
        pool.map((v) => v.imagePath),
      ),
    ];
    const tooDark = groundPaths.filter(
      (p) => opaqueMeanLuminance(path.join(repoRoot(), 'public', p)) <= wallMean,
    );
    expect(tooDark).toEqual([]);
  });

  /**
   * NO BAKED LATTICE: a seamless tile with a straight bright line in it chains
   * that line across every tile boundary, so a single 64px artifact becomes an
   * unbroken grid spanning a whole room.
   *
   * This is a real defect this guard caught, and the reason it is scored on
   * STRUCTURE rather than amplitude. The welcome-room floor was generated from a
   * prompt asking for "thin brass inlay lines ... repeating across the surface";
   * the model complied, and the spawn room — the first thing a player ever sees —
   * rendered as graph paper. Every existing guard passed it: its column standard
   * deviation was 11.58, LOWER than the ordinary floor's 12.49, because a perfect
   * lattice is a low-variance, high-regularity signal. Mean luminance, standard
   * deviation, silhouette geometry and seam byte-identity are all blind to it by
   * construction. Only asking whether the variance is STRUCTURED catches it.
   *
   * The wall-atlas is excluded from this check: it is a composed image whose
   * cells are arranged in a grid, giving it inherent periodic structure that
   * inflates the outlier-count term.  It is NOT displayed as a tiled floor tile
   * and therefore cannot create the room-scale lattice artifact.
   *
   * Threshold calibrated against individual tile images across three
   * independently generated packs (floor1-dungeon, floor1-cave, industrial-cave).
   * The score is max(maxPositiveZ, nAbsOutliers25 × 0.6, nDenseOutliers≥7 ? nDenseOutliers × 0.4 : 0);
   * for organic tiles the worst observed score is 2.80.  The original gridded
   * welcome tile scored 4.11 (columns) / 4.04 (rows), so 3.4 separates them
   * with margin on both sides.
   *
   * See the negative-control tests below for synthetic proofs that the guard
   * catches dense (k=6), dark-line, and k=9 lattice variants.
   */
  it('bakes no straight bright line into a tile (anti-lattice)', () => {
    const MAX_LINE_Z = 3.4;
    // Exclude the wall-atlas (composed atlas, not a floor tile) and all
    // doorSet images (doors have legitimate straight edges/highlights and are
    // never tiled as room-scale floors, so the lattice artifact cannot occur).
    const doorSetPaths = new Set(Object.values(manifest.doorSet).map((v) => v.imagePath));
    const tileImagePaths = allImagePaths(manifest).filter(
      (p) => p !== manifest.wallAutotile.imagePath && !doorSetPaths.has(p),
    );
    const offenders: string[] = [];
    for (const imagePath of tileImagePaths) {
      const z = maxLineZScore(path.join(repoRoot(), 'public', imagePath));
      if (z > MAX_LINE_Z) offenders.push(`${imagePath} (z=${z.toFixed(2)})`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('floor1-dungeon special-room floor pools', () => {
  const manifest = readManifest('floor1-dungeon');

  it('ships all three role-keyed pools', () => {
    expect(Object.keys(manifest.specialFloorPools ?? {}).sort()).toEqual([
      'bossStair',
      'safe',
      'welcome',
    ]);
  });

  it('gives each pool distinct variant textures so a room does not tile flat', () => {
    for (const [key, pool] of Object.entries(manifest.specialFloorPools ?? {})) {
      const keys = new Set(pool.map((v) => v.textureKey));
      expect(keys.size, `${key} pool has duplicate textureKeys`).toBe(pool.length);
      expect(pool.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('floor1-cave', () => {
  it('ships no special floor pools (they belong to the masonry pack)', () => {
    expect(readManifest('floor1-cave').specialFloorPools).toBeUndefined();
  });
});

/**
 * ANTI-LATTICE GUARD — negative controls (the guard MUST flag these).
 *
 * These synthetic pixel buffers prove that both fixes work:
 *   (a) absolute z-score catches dark lines (grooves/grout), not just bright ones.
 *   (b) outlier-count term catches dense/periodic lattices where each line's
 *       individual z-score is below the 3.4 threshold.
 *
 * The tests exercise `computeMaxLineZScore` directly with in-memory pixel data
 * so they run without reading any file and are immune to future art changes.
 */
describe('anti-lattice guard: synthetic negative controls (guard must reject)', () => {
  const W = 64;
  const H = 64;
  const THRESHOLD = 3.4;

  /** Build a fully-opaque greyscale 64×64 RGBA buffer from a per-pixel luminance fn. */
  function makeGrey(pixelFn: (x: number, y: number) => number): Buffer {
    const buf = Buffer.allocUnsafe(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const lum = Math.round(pixelFn(x, y));
        const i = (y * W + x) * 4;
        buf[i] = lum;
        buf[i + 1] = lum;
        buf[i + 2] = lum;
        buf[i + 3] = 255;
      }
    }
    return buf;
  }

  it('catches 6 equally bright column lines (dense lattice, z≈3.11 each — max alone misses)', () => {
    // k=6, n=64: z = sqrt(58/6) ≈ 3.11 < 3.4.  The outlier-count term scores
    // max(3.11, 6×0.6)=3.60, catching the dense lattice the peak alone misses.
    const brightCols = new Set([0, 10, 21, 32, 43, 53]);
    const data = makeGrey((x) => (brightCols.has(x) ? 200 : 50));
    expect(computeMaxLineZScore(W, H, data)).toBeGreaterThan(THRESHOLD);
  });

  it('catches 6 equally dark column lines (dark lattice — abs-z fix catches it)', () => {
    // Pre-fix: (v−mean)/sd for dark outliers is NEGATIVE; Math.max returned a
    // sub-threshold value.  Math.abs() makes the guard symmetric.
    const darkCols = new Set([0, 10, 21, 32, 43, 53]);
    const data = makeGrey((x) => (darkCols.has(x) ? 30 : 180));
    expect(computeMaxLineZScore(W, H, data)).toBeGreaterThan(THRESHOLD);
  });

  it('catches 6 equally dark row lines (dark lattice on the row axis)', () => {
    const darkRows = new Set([0, 10, 21, 32, 43, 53]);
    const data = makeGrey((_x, y) => (darkRows.has(y) ? 30 : 180));
    expect(computeMaxLineZScore(W, H, data)).toBeGreaterThan(THRESHOLD);
  });

  it('catches 9 equally bright column lines (denser lattice — Term 3 required)', () => {
    // k=9, n=64: z=√(55/9)≈2.47 < 2.5, so Term 2 (|z|>2.5 count) gives 0.
    // Without Term 3, the final score is only 2.47 — below the 3.4 gate.
    // Term 3 counts |z|>2.0 lines (=9) and gates on ≥7, scoring 9×0.4=3.6>3.4.
    const brightCols = new Set([0, 7, 14, 21, 28, 35, 42, 49, 56]);
    const data = makeGrey((x) => (brightCols.has(x) ? 200 : 50));
    expect(computeMaxLineZScore(W, H, data)).toBeGreaterThan(THRESHOLD);
  });
});
