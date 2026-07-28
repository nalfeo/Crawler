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

    const rebuilt = composeWallAtlas(wallTile);
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
