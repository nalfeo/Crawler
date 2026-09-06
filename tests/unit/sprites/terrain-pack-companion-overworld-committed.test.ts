/**
 * Validation guard for the COMMITTED, SHIPPED `companion-overworld` terrain
 * pack — the Floor 3 runtime source of truth loaded by
 * `src/shared/terrain-pack-registry.ts`.
 *
 * Adding a pack to `RUNTIME_TERRAIN_PACK_IDS` enrolls it in the registry/schema
 * tests, but NOT in any committed-ART validation: the sibling suites for
 * `industrial-cave` and the Floor 1 packs hardcode their own pack IDs. Without
 * this file a wrong-dimension atlas, a stale (non-canonical) silhouette, a
 * degenerate flat tile, or a dark/unreadable palette would all ship green.
 *
 * The reproducibility test below is what makes this pack repairable: unlike the
 * generated-image packs, every companion-overworld pixel is deterministic
 * procedural output, so the committed bytes MUST equal a fresh build. That
 * turns `npm run terrain-packs:build` into a real recovery path after a
 * canonical blob47 geometry change rather than a claim in the provenance note.
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
import {
  buildCompanionOverworldPack,
  WOODLAND_FLOOR_VARIANT_IDS,
} from '../../../scripts/sprites/terrain-packs/build-companion-overworld.js';
import type { TerrainPackDef } from '../../../src/shared/terrain-pack-types.js';

const PACK_ID = 'companion-overworld';

function repoRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..');
}

function readCommittedManifest(): TerrainPackDef {
  return JSON.parse(
    readFileSync(
      path.join(repoRoot(), 'src', 'shared', 'data', 'terrain-packs', `${PACK_ID}.manifest.json`),
      'utf-8',
    ),
  ) as TerrainPackDef;
}

/** Mean + standard deviation of luminance over OPAQUE pixels only. */
function opaqueLuminance(pngPath: string): { mean: number; stdDev: number } {
  const img = decodePng(readFileSync(pngPath));
  const samples: number[] = [];
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3]! < 128) continue;
    samples.push(0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!);
  }
  if (samples.length === 0) return { mean: 0, stdDev: 0 };
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

/** Mean per-channel colour over OPAQUE pixels only. */
function opaqueMeanRgb(pngPath: string): { r: number; g: number; b: number } {
  const img = decodePng(readFileSync(pngPath));
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3]! < 128) continue;
    r += img.data[i]!;
    g += img.data[i + 1]!;
    b += img.data[i + 2]!;
    count++;
  }
  if (count === 0) return { r: 0, g: 0, b: 0 };
  return { r: r / count, g: g / count, b: b / count };
}

/** Every image path the manifest references, relative to `public/`. */
function poolImagePaths(manifest: TerrainPackDef): string[] {
  return [...manifest.floorPool, ...manifest.corridorPool].map((v) => v.imagePath);
}

describe(`committed terrain pack — ${PACK_ID}`, () => {
  const manifest = readCommittedManifest();
  const atlasPath = path.join(repoRoot(), 'public', manifest.wallAutotile.imagePath);
  const atlas = decodePng(readFileSync(atlasPath));

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

  it('matches the canonical silhouette exactly (catches a stale atlas)', () => {
    expect(validateAuthoredSilhouetteExact(manifest, atlas).ok).toBe(true);
  });

  it('resolves every referenced image path on disk', () => {
    expect(validateWallAutotileImagePath(manifest, { repoRoot: repoRoot() }).ok).toBe(true);
    expect(validatePoolAndDoorImages(manifest, { repoRoot: repoRoot() }).ok).toBe(true);
  });

  /**
   * NON-DEGENERATE ART guard. Every structural validator above passes on a
   * flat, single-colour tile, which is exactly what a broken palette/normalize
   * step produces (see the Floor 1 committed suite for two shipped instances).
   */
  it('ships non-degenerate tiles (real luminance variation)', () => {
    for (const relPath of [manifest.wallAutotile.imagePath, ...poolImagePaths(manifest)]) {
      const { stdDev } = opaqueLuminance(path.join(repoRoot(), 'public', relPath));
      expect(stdDev, `${relPath} is flat (stdDev ${stdDev.toFixed(2)})`).toBeGreaterThan(2);
    }
  });

  /**
   * BRIGHT OUTDOOR guard (issue #4294). Floor 3's whole brief is a bright,
   * sunlit creature-league overworld; the underground packs it replaced sit
   * around luminance 40-60. A regression back to dark cave-toned art would
   * otherwise pass every check above.
   */
  it('ships a bright outdoor palette, not underground tones', () => {
    for (const relPath of [manifest.wallAutotile.imagePath, ...poolImagePaths(manifest)]) {
      const { mean } = opaqueLuminance(path.join(repoRoot(), 'public', relPath));
      expect(mean, `${relPath} mean luminance ${mean.toFixed(1)} is too dark`).toBeGreaterThan(100);
    }
  });

  /**
   * NATURAL-GROUND HUE guard. Brightness alone would accept a washed-out grey
   * or a purple "missing texture" fill. Grass and dirt are both warm and
   * green-of-blue; the cave/dungeon packs this replaced are grey-to-cool.
   */
  it('ships a green/earth ground palette, not grey or cool tones', () => {
    for (const relPath of poolImagePaths(manifest)) {
      const { r, g, b } = opaqueMeanRgb(path.join(repoRoot(), 'public', relPath));
      const detail = `${relPath} rgb=(${r.toFixed(0)}, ${g.toFixed(0)}, ${b.toFixed(0)})`;
      expect(g - b, `${detail} is not warm/green enough`).toBeGreaterThan(20);
      expect(r - b, `${detail} is not warm enough`).toBeGreaterThan(20);
    }
  });

  it('ships dedicated woodland floor surfaces for the outdoor circuit', () => {
    const floorById = new Map(manifest.floorPool.map((variant) => [variant.id, variant]));
    for (const id of WOODLAND_FLOOR_VARIANT_IDS) {
      const variant = floorById.get(id);
      expect(variant, `missing woodland floor variant ${id}`).toBeDefined();
      const rgb = opaqueMeanRgb(path.join(repoRoot(), 'public', variant!.imagePath));
      expect(
        rgb.g - rgb.b,
        `${id} rgb=(${rgb.r.toFixed(0)}, ${rgb.g.toFixed(0)}, ${rgb.b.toFixed(0)}) is not woodland-green`,
      ).toBeGreaterThan(35);
    }
  });

  /**
   * DOMINANT-BASE guard. `buildWeightedCombos` defaults a missing `weight` to
   * 1, so an unweighted 8-source pool draws uniformly — the uniform patchwork
   * the shared-base terrain contract explicitly replaced. Assert both pools
   * declare an explicit dominant base and keep detail sparse.
   */
  it('declares a dominant base and sparse detail in both pools', () => {
    for (const [label, pool] of [
      ['floorPool', manifest.floorPool],
      ['corridorPool', manifest.corridorPool],
    ] as const) {
      const declared = pool.map((v) => v.weight);
      expect(
        declared.every((w) => typeof w === 'number' && w > 0),
        `${label} has unweighted variants`,
      ).toBe(true);
      const weights = declared as number[];
      const total = weights.reduce((a, b) => a + b, 0);
      const sorted = [...weights].sort((a, b) => b - a);
      // The two calmest sources must own most of the ground.
      expect((sorted[0]! + sorted[1]!) / total, `${label} base share`).toBeGreaterThan(0.6);
      // No single detail variant may rival the base.
      expect(sorted[2]! / sorted[0]!, `${label} detail share`).toBeLessThan(0.5);
    }
  });

  /**
   * REPRODUCIBILITY guard. This pack has no generated-image step: the builder
   * is the source of truth, so the committed manifest + every committed PNG
   * must equal a fresh in-memory build. This fails if someone hand-edits an
   * asset (which cannot then survive a canonical-geometry rebuild) or edits
   * the builder without re-running `npm run terrain-packs:build`.
   */
  it('reproduces its committed bytes from `npm run terrain-packs:build`', () => {
    const built = buildCompanionOverworldPack();
    expect(built.manifest).toEqual(manifest);
    for (const file of built.files) {
      const committed = readFileSync(
        path.join(repoRoot(), 'public', ...file.relativePath.split('/')),
      );
      expect(
        committed.equals(file.buffer),
        `${file.relativePath} differs from a fresh deterministic build`,
      ).toBe(true);
    }
  });
});
