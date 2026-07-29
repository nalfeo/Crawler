/**
 * Deterministic-build + validation tests for the terrain-pack tooling under
 * `scripts/sprites/terrain-packs/` (build-industrial-cave.ts,
 * build-caeles-fixture.ts, validate.ts, atlas-grid.ts).
 *
 * Covers the TESTS section of the terrain-pack spec's "Tooling" bullet:
 *   - fixture and authored pack build to 512x384 (8x6 x 64) output
 *   - exactly 47 mask mappings
 *   - missing/duplicate masks fail validation
 *   - seam (compatible-boundary) checks
 *   - deterministic output bytes/hash across rebuild
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildIndustrialCavePack,
  writeIndustrialCavePack,
} from '../../../scripts/sprites/terrain-packs/build-industrial-cave.js';
import {
  buildCaelesFixturePack,
  verifySha256,
} from '../../../scripts/sprites/terrain-packs/build-caeles-fixture.js';
import {
  validateAtlasDimensions,
  validateCompatibleBoundaries,
  validateMaskCoverage,
  validateManifestSchema,
  validateTerrainPack,
  validatePoolAndDoorImages,
  validateWallAutotileImagePath,
} from '../../../scripts/sprites/terrain-packs/validate.js';
import {
  ATLAS_HEIGHT_PX,
  ATLAS_WIDTH_PX,
} from '../../../scripts/sprites/terrain-packs/atlas-grid.js';
import { decodePng, cropImage } from '../../../scripts/sprites/terrain-packs/png-buffer.js';
import {
  buildEdgeReferences,
  classifyCellEdges,
  CELL_EDGES,
  VENDORED_EDGE_SAMPLING,
} from '../../../scripts/sprites/terrain-packs/edge-signature.js';
import { edgeConnectionsFromMask } from '../../../src/shared/terrain-pack-mask.js';
import type { TerrainPackDef } from '../../../src/shared/terrain-pack-types.js';
import { readFileSync } from 'node:fs';

function repoRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..');
}

function readVendoredTemplate(): Buffer {
  return readFileSync(
    path.join(
      repoRoot(),
      'public',
      'assets',
      'vendor',
      'terrain-packs',
      'caeles-seamless-template-ii',
      'template8x6.png',
    ),
  );
}

function atlasBufferOf(result: {
  files: readonly { relativePath: string; buffer: Buffer }[];
}): Buffer {
  const atlas = result.files.find((f) => f.relativePath.endsWith('wall-atlas.png'));
  if (!atlas) throw new Error('expected a wall-atlas.png output file');
  return atlas.buffer;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

describe('buildIndustrialCavePack (authored)', () => {
  const result = buildIndustrialCavePack();

  it('produces a 512x384 (8x6 x 64px) wall atlas', () => {
    const atlas = decodePng(atlasBufferOf(result));
    expect(atlas.width).toBe(ATLAS_WIDTH_PX);
    expect(atlas.height).toBe(ATLAS_HEIGHT_PX);
    expect(atlas.width).toBe(512);
    expect(atlas.height).toBe(384);
  });

  it('manifest lists exactly 47 mask entries, one per canonical mask', () => {
    expect(result.manifest.wallAutotile.masks).toHaveLength(47);
    expect(new Set(result.manifest.wallAutotile.masks.map((m) => m.maskId)).size).toBe(47);
  });

  it('renders a non-transparent atlas cell for canonical mask 0 (isolated wall tile)', () => {
    const atlas = decodePng(atlasBufferOf(result));
    const mask0 = result.manifest.wallAutotile.masks.find((m) => m.maskId === 0);
    expect(mask0).toBeDefined();
    const cellPx = result.manifest.wallAutotile.cellPx;
    const framesPerRow = Math.floor(atlas.width / cellPx);
    const frameIndex = mask0!.frameIndex;
    const x0 = (frameIndex % framesPerRow) * cellPx;
    const y0 = Math.floor(frameIndex / framesPerRow) * cellPx;

    let hasOpaquePixel = false;
    for (let y = y0; y < y0 + cellPx && !hasOpaquePixel; y++) {
      for (let x = x0; x < x0 + cellPx; x++) {
        const alpha = atlas.data[(y * atlas.width + x) * 4 + 3]!;
        if (alpha !== 0) {
          hasOpaquePixel = true;
          break;
        }
      }
    }
    expect(hasOpaquePixel).toBe(true);
  });
  it('produces exactly 8 floor variants, 8 corridor variants, 4 wall accents, and exactly 4 door PNGs (grown from 4/4/0 2026-07-25)', () => {
    expect(result.manifest.floorPool.length).toBe(8);
    expect(result.manifest.corridorPool.length).toBe(8);
    expect(result.manifest.wallAccents).toHaveLength(4);
    expect(Object.keys(result.manifest.doorSet)).toHaveLength(4);
  });

  it('every floor/corridor variant declares allowedTransforms including "none", with >=24 combos per pool', () => {
    for (const pool of [result.manifest.floorPool, result.manifest.corridorPool]) {
      let totalCombos = 0;
      for (const variant of pool) {
        expect(variant.allowedTransforms).toContain('none');
        totalCombos += variant.allowedTransforms?.length ?? 1;
      }
      expect(totalCombos).toBeGreaterThanOrEqual(24);
    }
  });

  it('passes full validateTerrainPack (schema + dimensions + mask coverage + seam check)', () => {
    const validation = validateTerrainPack(result.manifest, atlasBufferOf(result));
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it('rebuilds byte-identical output (deterministic — no Math.random, no timestamps)', () => {
    const again = buildIndustrialCavePack();
    expect(sha256(atlasBufferOf(again))).toBe(sha256(atlasBufferOf(result)));
    expect(JSON.stringify(again.manifest)).toBe(JSON.stringify(result.manifest));
    // Every output file (atlas + pools + doors), not just the atlas.
    expect(again.files).toHaveLength(result.files.length);
    for (let i = 0; i < result.files.length; i++) {
      expect(again.files[i]!.relativePath).toBe(result.files[i]!.relativePath);
      expect(sha256(again.files[i]!.buffer)).toBe(sha256(result.files[i]!.buffer));
    }
  });
});

describe('buildCaelesFixturePack (vendored CC0 fixture)', () => {
  const templatePng = readVendoredTemplate();

  it('verifies the vendored source template SHA-256 before assembling (provenance pin)', () => {
    expect(sha256(templatePng)).toBe(
      '34f07db7bb4872406f35507c515e2fca78bbabbf5a112a20c995bcf554992d76',
    );
  });

  const result = buildCaelesFixturePack(templatePng);

  it('produces a 512x384 (8x6 x 64px) wall atlas from the 256x192 (8x6 x 32px) source', () => {
    const atlas = decodePng(atlasBufferOf(result));
    expect(atlas.width).toBe(512);
    expect(atlas.height).toBe(384);
  });

  it('manifest lists exactly 47 mask entries, one per canonical mask', () => {
    expect(result.manifest.wallAutotile.masks).toHaveLength(47);
    expect(new Set(result.manifest.wallAutotile.masks.map((m) => m.maskId)).size).toBe(47);
  });

  it('carries full immutable provenance for the vendored asset', () => {
    const provenance = result.manifest.provenance;
    expect(provenance.kind).toBe('vendored');
    if (provenance.kind === 'vendored') {
      expect(provenance.originalFilename).toBe('template8x6.png');
      expect(provenance.sourceUrl).toBe(
        'https://opengameart.org/content/seamless-tileset-template-ii',
      );
      expect(provenance.fileUrl).toBe(
        'https://opengameart.org/sites/default/files/template8x6.png',
      );
      expect(provenance.title).toBe('Seamless Tileset Template II');
      expect(provenance.author).toBe('caeles');
      expect(provenance.license).toBe('CC0');
      expect(provenance.licenseUrl).toMatch(/creativecommons\.org/);
      expect(provenance.sha256).toBe(
        '34f07db7bb4872406f35507c515e2fca78bbabbf5a112a20c995bcf554992d76',
      );
      expect(provenance.derivationNote.length).toBeGreaterThan(20);
    }
  });

  it('passes full validateTerrainPack at the documented vendored seam-pass-rate floor', () => {
    const validation = validateTerrainPack(result.manifest, atlasBufferOf(result));
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it('rebuilds byte-identical output from the same source bytes (deterministic assignment)', () => {
    const again = buildCaelesFixturePack(templatePng);
    expect(sha256(atlasBufferOf(again))).toBe(sha256(atlasBufferOf(result)));
    expect(JSON.stringify(again.manifest)).toBe(JSON.stringify(result.manifest));
  });
});

describe('validateMaskCoverage — missing/duplicate mask failures', () => {
  const base = buildIndustrialCavePack().manifest;

  it('fails when a canonical mask is missing from the table', () => {
    const mutated: TerrainPackDef = {
      ...base,
      wallAutotile: { ...base.wallAutotile, masks: base.wallAutotile.masks.slice(1) },
    };
    const result = validateMaskCoverage(mutated);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'mask-missing')).toBe(true);
  });

  it('fails when a maskId is duplicated', () => {
    const masks = [...base.wallAutotile.masks];
    masks[1] = { ...masks[0]! }; // duplicate maskId 0's entry over index 1
    const mutated: TerrainPackDef = { ...base, wallAutotile: { ...base.wallAutotile, masks } };
    const result = validateMaskCoverage(mutated);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'mask-duplicate')).toBe(true);
  });

  it('fails when a frameIndex is duplicated', () => {
    const masks = base.wallAutotile.masks.map((m, i) =>
      i === 1 ? { ...m, frameIndex: base.wallAutotile.masks[0]!.frameIndex } : m,
    );
    const mutated: TerrainPackDef = { ...base, wallAutotile: { ...base.wallAutotile, masks } };
    const result = validateMaskCoverage(mutated);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'frame-duplicate')).toBe(true);
  });

  it('passes for the real, unmodified industrial-cave manifest', () => {
    expect(validateMaskCoverage(base).ok).toBe(true);
  });
});

describe('validateAtlasDimensions — dimension pinning', () => {
  const result = buildIndustrialCavePack();

  it('fails when the atlas PNG is not the exact expected width/height', () => {
    const atlas = decodePng(atlasBufferOf(result));
    const wrongSized = { ...atlas, width: 256, height: 256 };
    const validation = validateAtlasDimensions(result.manifest, wrongSized);
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.code === 'atlas-dimensions')).toBe(true);
  });

  it('fails when cellPx does not equal the pinned 64px terrain-pack cell size', () => {
    const atlas = decodePng(atlasBufferOf(result));
    const mutated: TerrainPackDef = {
      ...result.manifest,
      wallAutotile: { ...result.manifest.wallAutotile, cellPx: 32 as unknown as 64 },
    };
    const validation = validateAtlasDimensions(mutated, atlas);
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.code === 'cell-size')).toBe(true);
  });

  it('passes for the real, unmodified atlas + manifest pairing', () => {
    const atlas = decodePng(atlasBufferOf(result));
    expect(validateAtlasDimensions(result.manifest, atlas).ok).toBe(true);
  });
});

describe('validateCompatibleBoundaries — documented seam/edge-consistency check', () => {
  const result = buildIndustrialCavePack();
  const atlas = decodePng(atlasBufferOf(result));

  it('the authored pack meets the 100% edge-pass-rate floor (provable by construction)', () => {
    const validation = validateCompatibleBoundaries(result.manifest, atlas, {
      minEdgePassRate: 1.0,
    });
    expect(validation.ok).toBe(true);
  });

  it('fails loudly when an unreachable pass-rate threshold is required (proves the comparison itself works)', () => {
    const validation = validateCompatibleBoundaries(result.manifest, atlas, {
      minEdgePassRate: 1.0001,
    });
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.code === 'boundary-mismatch')).toBe(true);
  });

  it('the vendored fixture meets its documented 0.90 floor', () => {
    const vendored = buildCaelesFixturePack(readVendoredTemplate());
    const vendoredAtlas = decodePng(atlasBufferOf(vendored));
    const validation = validateCompatibleBoundaries(vendored.manifest, vendoredAtlas, {
      minEdgePassRate: 0.9,
    });
    expect(validation.ok).toBe(true);
  });

  /**
   * Pins WHY the vendored floor is below 1.0, so the next person to touch it
   * does not have to re-derive it (and notices immediately if the residue
   * changes shape rather than just changing size).
   *
   * The 8 misses are a single class: every one is a `wall -> floor` misread,
   * exactly two per compass direction, confined to the four single-arm stubs
   * (1/2/4/8) and the two straight corridors (5/10). Hand-drawn line art draws
   * a wall reached by one narrow arm thin, so that edge band is mostly floor.
   */
  it('the vendored fixture misses ONLY on the thin-arm masks, and only wall->floor', () => {
    const vendored = buildCaelesFixturePack(readVendoredTemplate());
    const atlas = decodePng(atlasBufferOf(vendored));
    const { cellPx, gridCols } = vendored.manifest.wallAutotile;
    const cellFor = (frameIndex: number) =>
      cropImage(
        atlas,
        (frameIndex % gridCols) * cellPx,
        Math.floor(frameIndex / gridCols) * cellPx,
        cellPx,
        cellPx,
      );
    const maskToFrame = new Map(
      vendored.manifest.wallAutotile.masks.map((m) => [m.maskId, m.frameIndex]),
    );
    const refs = buildEdgeReferences(
      cellFor(maskToFrame.get(0)!),
      cellFor(maskToFrame.get(255)!),
      VENDORED_EDGE_SAMPLING,
    );

    const misses: { maskId: number; edge: string; expected: boolean }[] = [];
    for (const { maskId, frameIndex } of vendored.manifest.wallAutotile.masks) {
      const expected = edgeConnectionsFromMask(maskId);
      const classified = classifyCellEdges(cellFor(frameIndex), refs, VENDORED_EDGE_SAMPLING);
      for (const edge of CELL_EDGES) {
        if (classified[edge] !== expected[edge]) {
          misses.push({ maskId, edge, expected: expected[edge] });
        }
      }
    }

    // Every miss is a thin wall arm read as floor — never the reverse.
    expect(misses.every((m) => m.expected === true)).toBe(true);
    // Confined to the single-arm stubs and straight corridors.
    expect([...new Set(misses.map((m) => m.maskId))].sort((a, b) => a - b)).toEqual([
      1, 2, 4, 5, 8, 10,
    ]);
    // Symmetric across compass directions (the art has no directional bias).
    const perEdge = CELL_EDGES.map((e) => misses.filter((m) => m.edge === e).length);
    expect(new Set(perEdge).size).toBe(1);
    // And the total stays clear of the 0.90 floor (0.90 * 188 => at most 18).
    expect(misses.length).toBe(8);
  });
});

describe('validateTerrainPack — VENDORED_MIN_EDGE_PASS_RATE default constant is exercised end-to-end', () => {
  /**
   * The existing caeles fixture test calls validateTerrainPack with the pristine
   * atlas (rate 0.957), which passes at any constant ≤ 0.957 — including the
   * old 0.85 floor — and therefore does NOT test that VENDORED_MIN_EDGE_PASS_RATE
   * is actually 0.90.
   *
   * This suite constructs a deterministic "degraded" atlas by swapping the
   * frameIndex assignments for two pairs of opposite-corner masks in the
   * manifest (masks 3↔12 and 7↔14; pixel data is unchanged). The swap drops
   * the edge-pass rate from 0.957 to 0.8936 (168/188 edges pass), placing it
   * in the 0.85–0.90 window: above the old 0.85 floor but below the new 0.90
   * floor.
   *
   * Reverting VENDORED_MIN_EDGE_PASS_RATE to 0.85 would cause the second test
   * to fail because boundary-mismatch would no longer appear in the issues.
   */
  const caeles = buildCaelesFixturePack(readVendoredTemplate());
  const atlasBuf = atlasBufferOf(caeles);

  function swappedManifest(): TerrainPackDef {
    const masks = caeles.manifest.wallAutotile.masks.map((m) => ({ ...m }));
    for (const [a, b] of [
      [3, 12],
      [7, 14],
    ] as [number, number][]) {
      const ia = masks.findIndex((m) => m.maskId === a);
      const ib = masks.findIndex((m) => m.maskId === b);
      const tmp = masks[ia]!.frameIndex;
      masks[ia] = { ...masks[ia]!, frameIndex: masks[ib]!.frameIndex };
      masks[ib] = { ...masks[ib]!, frameIndex: tmp };
    }
    return { ...caeles.manifest, wallAutotile: { ...caeles.manifest.wallAutotile, masks } };
  }

  it('rate-0.8936 atlas passes validateCompatibleBoundaries at explicit 0.85 (proves rate > old floor)', () => {
    const atlas = decodePng(atlasBuf);
    const result = validateCompatibleBoundaries(swappedManifest(), atlas, {
      minEdgePassRate: 0.85,
    });
    expect(result.ok).toBe(true);
  });

  it('rate-0.8936 atlas: validateTerrainPack without options reports boundary-mismatch (VENDORED_MIN_EDGE_PASS_RATE enforced at 0.90)', () => {
    const result = validateTerrainPack(swappedManifest(), atlasBuf);
    // boundary-mismatch appears because the production default (0.90) rejects rate 0.8936.
    // If VENDORED_MIN_EDGE_PASS_RATE were reverted to 0.85, this assertion would fail.
    expect(result.issues.some((i) => i.code === 'boundary-mismatch')).toBe(true);
  });
});

describe('validateManifestSchema', () => {
  it('accepts the real built manifests', () => {
    expect(validateManifestSchema(buildIndustrialCavePack().manifest).ok).toBe(true);
    expect(validateManifestSchema(buildCaelesFixturePack(readVendoredTemplate()).manifest).ok).toBe(
      true,
    );
  });

  it('rejects a manifest missing a required top-level field', () => {
    const { id: _id, ...withoutId } = buildIndustrialCavePack().manifest;
    const result = validateManifestSchema(withoutId);
    expect(result.ok).toBe(false);
  });
});

describe('verifySha256 — provenance pin helper (Fix 4)', () => {
  const expected = '34f07db7bb4872406f35507c515e2fca78bbabbf5a112a20c995bcf554992d76';

  it('does not throw for the real vendored template', () => {
    const buf = readVendoredTemplate();
    expect(() => verifySha256(buf, expected)).not.toThrow();
  });

  it('throws with SHA-256 mismatch message when one byte is flipped', () => {
    const buf = readVendoredTemplate();
    const tampered = Buffer.from(buf);
    tampered[0] = tampered[0]! ^ 0xff; // flip all bits in the first byte
    expect(() => verifySha256(tampered, expected)).toThrow(/SHA-256 mismatch/);
  });

  it('throws when the expected hash itself is empty / malformed', () => {
    const buf = readVendoredTemplate();
    expect(() => verifySha256(buf, 'not-a-real-hash')).toThrow(/SHA-256 mismatch/);
  });
});

describe('buildCaelesFixturePack — SHA-256 gate (Fix 4)', () => {
  it('throws SHA-256 mismatch when called with a tampered byte buffer', () => {
    const buf = readVendoredTemplate();
    const tampered = Buffer.from(buf);
    tampered[100] = tampered[100]! ^ 0x01;
    expect(() => buildCaelesFixturePack(tampered)).toThrow(/SHA-256 mismatch/);
  });
});

describe('validatePoolAndDoorImages — pool/door image path validation (Fix 3)', () => {
  const repoRoot_ = repoRoot();
  const result = buildIndustrialCavePack();

  it('passes for the real industrial-cave manifest (all pool/door images exist at 64x64)', () => {
    const validation = validatePoolAndDoorImages(result.manifest, { repoRoot: repoRoot_ });
    expect(validation.ok).toBe(true);
    expect(validation.issues).toHaveLength(0);
  });

  it('reports path-traversal when imagePath contains ".."', () => {
    const manifest = {
      ...result.manifest,
      floorPool: [
        { ...result.manifest.floorPool[0]!, imagePath: 'assets/terrain-packs/../bad/floor.png' },
        ...result.manifest.floorPool.slice(1),
      ],
    };
    const validation = validatePoolAndDoorImages(manifest, { repoRoot: repoRoot_ });
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.code === 'path-traversal')).toBe(true);
  });

  it('reports path-not-in-allowed-root when imagePath is outside assets/terrain-packs/', () => {
    const manifest = {
      ...result.manifest,
      floorPool: [
        { ...result.manifest.floorPool[0]!, imagePath: 'assets/other/floor.png' },
        ...result.manifest.floorPool.slice(1),
      ],
    };
    const validation = validatePoolAndDoorImages(manifest, { repoRoot: repoRoot_ });
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.code === 'path-not-in-allowed-root')).toBe(true);
  });

  it('reports image-missing for a nonexistent imagePath', () => {
    const manifest = {
      ...result.manifest,
      floorPool: [
        {
          ...result.manifest.floorPool[0]!,
          imagePath: 'assets/terrain-packs/industrial-cave/nonexistent-999.png',
        },
        ...result.manifest.floorPool.slice(1),
      ],
    };
    const validation = validatePoolAndDoorImages(manifest, { repoRoot: repoRoot_ });
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.code === 'image-missing')).toBe(true);
  });
});

describe('validateWallAutotileImagePath — wall atlas image path validation', () => {
  const repoRoot_ = repoRoot();
  const result = buildIndustrialCavePack();

  it('passes for the real industrial-cave manifest (valid imagePath at exact 512×384)', () => {
    const validation = validateWallAutotileImagePath(result.manifest, { repoRoot: repoRoot_ });
    expect(validation.ok).toBe(true);
    expect(validation.issues).toHaveLength(0);
  });

  it('reports image-missing when wallAutotile.imagePath does not exist on disk', () => {
    const manifest: TerrainPackDef = {
      ...result.manifest,
      wallAutotile: {
        ...result.manifest.wallAutotile,
        imagePath: 'assets/terrain-packs/industrial-cave/nonexistent-wall-atlas-xyz.png',
      },
    };
    const validation = validateWallAutotileImagePath(manifest, { repoRoot: repoRoot_ });
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.code === 'image-missing')).toBe(true);
  });

  it('reports path-not-in-allowed-root when wallAutotile.imagePath is outside assets/terrain-packs/', () => {
    const manifest: TerrainPackDef = {
      ...result.manifest,
      wallAutotile: {
        ...result.manifest.wallAutotile,
        imagePath: 'assets/other/wall-atlas.png',
      },
    };
    const validation = validateWallAutotileImagePath(manifest, { repoRoot: repoRoot_ });
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.code === 'path-not-in-allowed-root')).toBe(true);
  });

  it('reports path-traversal for a schema-valid traversal imagePath — no throw, never reads the unsafe path', () => {
    // Regression: cli.ts previously read atlas bytes before validateWallAutotileImagePath,
    // so '../package.json' could be read+decoded (throwing) before the traversal check fired.
    const manifest: TerrainPackDef = {
      ...result.manifest,
      wallAutotile: { ...result.manifest.wallAutotile, imagePath: '../package.json' },
    };
    expect(() => validateWallAutotileImagePath(manifest, { repoRoot: repoRoot_ })).not.toThrow();
    const validation = validateWallAutotileImagePath(manifest, { repoRoot: repoRoot_ });
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.code === 'path-traversal')).toBe(true);
  });

  it('reports image-wrong-size when a real PNG at the path has wrong dimensions (64×64 floor image used as atlas)', () => {
    // Use an existing 64×64 pool image in place of the 512×384 wall atlas.
    const manifest: TerrainPackDef = {
      ...result.manifest,
      wallAutotile: {
        ...result.manifest.wallAutotile,
        imagePath: result.manifest.floorPool[0]!.imagePath,
      },
    };
    const validation = validateWallAutotileImagePath(manifest, { repoRoot: repoRoot_ });
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.code === 'image-wrong-size')).toBe(true);
  });
});

describe('validateWallAutotileImagePath — existing directory path produces image-not-file (regression)', () => {
  const repoRoot_ = repoRoot();
  const result = buildIndustrialCavePack();

  it('reports image-not-file (not throw) when wallAutotile.imagePath resolves to a directory', () => {
    // 'assets/terrain-packs/industrial-cave' is a real directory under public/; the
    // old code would call existsSync (→ true) then readFileSync which threw EISDIR.
    const manifest: TerrainPackDef = {
      ...result.manifest,
      wallAutotile: {
        ...result.manifest.wallAutotile,
        imagePath: 'assets/terrain-packs/industrial-cave',
      },
    };
    expect(() => validateWallAutotileImagePath(manifest, { repoRoot: repoRoot_ })).not.toThrow();
    const validation = validateWallAutotileImagePath(manifest, { repoRoot: repoRoot_ });
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.code === 'image-not-file')).toBe(true);
  });
});

describe('validatePoolAndDoorImages — existing directory path produces image-not-file (regression)', () => {
  const repoRoot_ = repoRoot();
  const result = buildIndustrialCavePack();

  it('reports image-not-file (not throw) when a floorPool imagePath resolves to a directory', () => {
    // Same regression: existsSync would pass for a directory, then readFileSync would throw EISDIR.
    const manifest = {
      ...result.manifest,
      floorPool: [
        {
          ...result.manifest.floorPool[0]!,
          imagePath: 'assets/terrain-packs/industrial-cave',
        },
        ...result.manifest.floorPool.slice(1),
      ],
    };
    expect(() => validatePoolAndDoorImages(manifest, { repoRoot: repoRoot_ })).not.toThrow();
    const validation = validatePoolAndDoorImages(manifest, { repoRoot: repoRoot_ });
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.code === 'image-not-file')).toBe(true);
  });
});

describe('validateTerrainPack — malformed manifest produces structured issues, not TypeError', () => {
  it('returns schema issues (not throws) for a manifest missing floorPool and doorSet', () => {
    const malformed: unknown = {
      id: 'industrial-cave',
      name: 'Test',
      // floorPool, corridorPool, doorSet, wallAutotile, provenance all missing
    };
    const { manifest } = buildIndustrialCavePack();
    const atlasBytes = atlasBufferOf(buildIndustrialCavePack());
    const validation = validateTerrainPack(malformed, atlasBytes);
    expect(validation.ok).toBe(false);
    expect(validation.issues.length).toBeGreaterThan(0);
    expect(validation.issues.every((i) => i.code === 'schema')).toBe(true);
    // Ensure manifest itself is not harmed by this call
    expect(manifest.floorPool.length).toBeGreaterThan(0);
  });

  it('returns schema issues (not throws) for a manifest with floorPool missing', () => {
    const { wallAutotile, provenance, corridorPool, doorSet } = buildIndustrialCavePack().manifest;
    const malformed: unknown = {
      id: 'industrial-cave',
      name: 'Test',
      provenance,
      wallAutotile,
      corridorPool,
      doorSet,
      // floorPool deliberately absent
    };
    const atlasBytes = atlasBufferOf(buildIndustrialCavePack());
    const validation = validateTerrainPack(malformed, atlasBytes);
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.code === 'schema')).toBe(true);
  });

  it('returns structured atlas-decode-error (not throw) when atlas bytes are not valid PNG', () => {
    // Regression: validateTerrainPack previously called decodePng without a catch,
    // so malformed bytes would throw an unhandled error instead of returning structured issues.
    const { manifest } = buildIndustrialCavePack();
    const malformedBytes = Buffer.from('this is not a png file', 'utf8');
    expect(() => validateTerrainPack(manifest, malformedBytes)).not.toThrow();
    const validation = validateTerrainPack(manifest, malformedBytes);
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.code === 'atlas-decode-error')).toBe(true);
  });
});

describe('writeIndustrialCavePack — overwrite guard (TERRAIN_PACKS_ALLOW_PROCEDURAL_OVERWRITE)', () => {
  let tmpDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-cave-guard-test-'));
    savedEnv = process.env.TERRAIN_PACKS_ALLOW_PROCEDURAL_OVERWRITE;
    delete process.env.TERRAIN_PACKS_ALLOW_PROCEDURAL_OVERWRITE;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.TERRAIN_PACKS_ALLOW_PROCEDURAL_OVERWRITE;
    } else {
      process.env.TERRAIN_PACKS_ALLOW_PROCEDURAL_OVERWRITE = savedEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function anyFilesWritten(dir: string): boolean {
    // Recursively check whether any file was written under dir
    const check = (d: string): boolean => {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (check(path.join(d, entry.name))) return true;
        } else {
          return true;
        }
      }
      return false;
    };
    return check(dir);
  }

  it('does NOT write when the env var is unset', () => {
    // No env var set (deleted in beforeEach)
    writeIndustrialCavePack(tmpDir);
    expect(anyFilesWritten(tmpDir)).toBe(false);
  });

  it('does NOT write when the env var is "0"', () => {
    process.env.TERRAIN_PACKS_ALLOW_PROCEDURAL_OVERWRITE = '0';
    writeIndustrialCavePack(tmpDir);
    expect(anyFilesWritten(tmpDir)).toBe(false);
  });

  it('does NOT write when the env var is "false"', () => {
    process.env.TERRAIN_PACKS_ALLOW_PROCEDURAL_OVERWRITE = 'false';
    writeIndustrialCavePack(tmpDir);
    expect(anyFilesWritten(tmpDir)).toBe(false);
  });

  it('does NOT write when the env var is "FALSE" (case-insensitive)', () => {
    process.env.TERRAIN_PACKS_ALLOW_PROCEDURAL_OVERWRITE = 'FALSE';
    writeIndustrialCavePack(tmpDir);
    expect(anyFilesWritten(tmpDir)).toBe(false);
  });

  it('DOES write when the env var is "1"', () => {
    process.env.TERRAIN_PACKS_ALLOW_PROCEDURAL_OVERWRITE = '1';
    writeIndustrialCavePack(tmpDir);
    expect(anyFilesWritten(tmpDir)).toBe(true);
  });

  it('DOES write when the env var is "true"', () => {
    process.env.TERRAIN_PACKS_ALLOW_PROCEDURAL_OVERWRITE = 'true';
    writeIndustrialCavePack(tmpDir);
    expect(anyFilesWritten(tmpDir)).toBe(true);
  });

  it('DOES write when the env var is "TRUE" (case-insensitive)', () => {
    process.env.TERRAIN_PACKS_ALLOW_PROCEDURAL_OVERWRITE = 'TRUE';
    writeIndustrialCavePack(tmpDir);
    expect(anyFilesWritten(tmpDir)).toBe(true);
  });

  it('DOES write when the env var is " 1 " (with surrounding whitespace — trimmed)', () => {
    process.env.TERRAIN_PACKS_ALLOW_PROCEDURAL_OVERWRITE = ' 1 ';
    writeIndustrialCavePack(tmpDir);
    expect(anyFilesWritten(tmpDir)).toBe(true);
  });

  it('DOES write when the env var is " True " (mixed case + whitespace — trimmed + lowercased)', () => {
    process.env.TERRAIN_PACKS_ALLOW_PROCEDURAL_OVERWRITE = ' True ';
    writeIndustrialCavePack(tmpDir);
    expect(anyFilesWritten(tmpDir)).toBe(true);
  });
});
