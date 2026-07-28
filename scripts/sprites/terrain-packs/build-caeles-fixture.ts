/**
 * Deterministic import/assembly script for the vendored CC0 "caeles" fixture
 * terrain pack.
 *
 * Source: `public/assets/vendor/terrain-packs/caeles-seamless-template-ii/template8x6.png`
 * (256x192, 8 cols x 6 rows of 32px cells) — see `provenance` below for full
 * attribution. The source is a CC0 seamless-tileset *template* (line-art
 * guide cells for hand-painting a blob47 set), not finished colored wall art;
 * this script assembles it into the same explicit 47-mask atlas contract
 * every terrain pack uses, and documents that transformation via
 * `provenance.derivationNote`.
 *
 * Cell → mask assignment: the last (48th) template cell is reserved as a
 * spare (used to derive floor/corridor/door pool art, since the template has
 * no dedicated art for those surfaces). The first 47 cells are assigned to
 * the 47 canonical blob47 masks via a deterministic two-phase GREEDY
 * content-aware match (see `assignPoolCellsToMasks`): phase 1 bootstraps
 * open/solid edge references from pool cell 0 and the spare cell to lock in
 * masks 0 (all-open) and 255 (all-solid) first; phase 2 rebuilds the
 * references from the cells actually assigned to those two masks (so the
 * classifier is self-consistent with what the post-hoc compatible-boundary
 * validator will later sample straight from the atlas) and greedily assigns
 * every remaining mask in fixed ascending mask-value order, breaking ties by
 * lowest cell index. This is still fully deterministic build-time
 * computation — the result is written down as a literal, explicit
 * `{maskId, frameIndex}` table in the manifest (never inferred from atlas
 * position at runtime) — and it measurably beats a blind positional
 * assignment on the compatible-boundary check (~0.94 vs ~0.55-0.65
 * edge-match rate on this fixture; see `validate.ts`).
 *
 * Usage:
 *   npx tsx scripts/sprites/terrain-packs/build-caeles-fixture.ts
 *   npm run terrain-packs:build          (builds both packs)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  BLOB47_CANONICAL_MASKS,
  edgeConnectionsFromMask,
} from '../../../src/shared/terrain-pack-mask.js';
import type { TerrainPackDef } from '../../../src/shared/terrain-pack-types.js';
import { TERRAIN_PACK_CELL_PX } from '../../../src/shared/terrain-pack-types.js';
import {
  ATLAS_GRID_COLS,
  ATLAS_GRID_ROWS,
  ATLAS_HEIGHT_PX,
  ATLAS_WIDTH_PX,
  buildMaskFrameAssignments,
} from './atlas-grid.js';
import {
  buildEdgeReferences,
  classifyCellEdges,
  CELL_EDGES,
  VENDORED_EDGE_SAMPLING,
  type CellEdge,
} from './edge-signature.js';
import {
  compositeInto,
  createImage,
  cropImage,
  decodePng,
  encodePng,
  nearestNeighborResize,
  type RgbaImage,
} from './png-buffer.js';
import type { BuildOutputFile } from './build-industrial-cave.js';
import { renderDoorTile } from './procedural-surfaces.js';

const CAELES_FIXTURE_PACK_ID = 'caeles-fixture' as const;

/** Explicit source dimensions of the vendored template — pinned, not inferred (refinement #4). */
const SOURCE_CELL_PX = 32;
const SOURCE_GRID_COLS = 8;
const SOURCE_GRID_ROWS = 6;
const SOURCE_WIDTH_PX = SOURCE_GRID_COLS * SOURCE_CELL_PX; // 256
const SOURCE_HEIGHT_PX = SOURCE_GRID_ROWS * SOURCE_CELL_PX; // 192

const CAELES_PROVENANCE = {
  kind: 'vendored' as const,
  originalFilename: 'template8x6.png',
  sourceUrl: 'https://opengameart.org/content/seamless-tileset-template-ii',
  fileUrl: 'https://opengameart.org/sites/default/files/template8x6.png',
  title: 'Seamless Tileset Template II',
  author: 'caeles',
  license: 'CC0' as const,
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  sha256: '34f07db7bb4872406f35507c515e2fca78bbabbf5a112a20c995bcf554992d76',
  derivationNote:
    'Sliced into 48 32px cells (8x6 grid, row-major). The 48th (last) cell is reserved as a ' +
    'spare, used only to derive floor/corridor/door art and as a bootstrap "solid" reference ' +
    '(the source template has no dedicated art for those surfaces). The remaining 47 cells are ' +
    'assigned to the 47 canonical blob47 masks via a deterministic two-phase greedy ' +
    'content-aware match (see assignPoolCellsToMasks in build-caeles-fixture.ts): phase 1 ' +
    'classifies edges against the bootstrap open (cell 0) / solid (spare) references and locks ' +
    'in masks 0 and 255 first; phase 2 reclassifies the remaining cells against those two ' +
    "actually-assigned cells (self-consistent with what validate.ts's compatible-boundary " +
    'check will later sample from the atlas) and greedily assigns every other mask in ' +
    'ascending mask-value order, breaking ties by lowest cell index. Each assigned cell is ' +
    'nearest-neighbor upscaled 32x32 -> 64x64 (factor 2, explicit source/destination size, no ' +
    'implicit resizing). Floor/corridor/door pool images are derived by deterministically ' +
    'cropping/recoloring the spare cell (documented here, not literal additional vendored ' +
    'artwork) because the source template has no dedicated floor/corridor/door art.',
};

/** Read the 48 source cells (row-major) from the vendored template PNG bytes. */
function sliceSourceCells(templatePng: Buffer): readonly RgbaImage[] {
  const img = decodePng(templatePng);
  if (img.width !== SOURCE_WIDTH_PX || img.height !== SOURCE_HEIGHT_PX) {
    throw new Error(
      `Unexpected caeles template dimensions ${img.width}x${img.height}, expected ${SOURCE_WIDTH_PX}x${SOURCE_HEIGHT_PX}`,
    );
  }
  const cells: RgbaImage[] = [];
  for (let row = 0; row < SOURCE_GRID_ROWS; row++) {
    for (let col = 0; col < SOURCE_GRID_COLS; col++) {
      cells.push(
        cropImage(img, col * SOURCE_CELL_PX, row * SOURCE_CELL_PX, SOURCE_CELL_PX, SOURCE_CELL_PX),
      );
    }
  }
  return cells;
}

/**
 * Deterministically assign the 47 canonical blob47 masks to the 47 pool
 * cells (all source cells except the reserved spare), using a greedy
 * content-aware match on classified edge signatures.
 *
 * Algorithm (fully deterministic, no randomness), in two phases so the
 * reference cells used for classification are the SAME cells the
 * compatible-boundary validator will later see at frame 0 / frame 46 of the
 * assembled atlas (self-consistency — otherwise the build's own optimization
 * target and the post-hoc validation metric silently diverge):
 *  1. Bootstrap: classify all 47 pool cells against a provisional open
 *     reference (pool cell 0) and a provisional solid reference (the
 *     reserved spare cell, which itself is never placed in the atlas — it
 *     is only used here as an external "fully enclosed" exemplar). Use this
 *     bootstrap classification to pick the single best-matching pool cell
 *     for mask 0 (all-open) and, separately, for mask 255 (all-solid).
 *  2. Final: rebuild the open/solid references from the ACTUAL cells now
 *     assigned to mask 0 and mask 255 (i.e. the literal atlas frame-0/46
 *     content), reclassify the remaining pool cells against these final
 *     references, then process every other canonical mask in fixed
 *     ascending mask-value order — for each, score every still-unassigned
 *     cell by how many of its 4 classified edges match the mask's expected
 *     cardinal connectivity (0-4), pick the highest score, and break ties by
 *     the lowest remaining cell index.
 *
 * Returns a Map from maskId -> pool cell index (0-based, excludes the spare).
 */
function assignPoolCellsToMasks(
  poolCells: readonly RgbaImage[],
  spareCell: RgbaImage,
): Map<number, number> {
  if (poolCells.length !== BLOB47_CANONICAL_MASKS.length) {
    throw new Error(
      `Expected ${BLOB47_CANONICAL_MASKS.length} pool cells, got ${poolCells.length}`,
    );
  }
  const OPEN_MASK_ID = 0;
  const SOLID_MASK_ID = 255;
  if (
    !BLOB47_CANONICAL_MASKS.includes(OPEN_MASK_ID) ||
    !BLOB47_CANONICAL_MASKS.includes(SOLID_MASK_ID)
  ) {
    throw new Error(
      'Greedy assignment requires canonical masks 0 and 255 to anchor the reference cells',
    );
  }

  const scoreAgainst = (
    classified: Readonly<Record<CellEdge, boolean>>,
    maskId: number,
  ): number => {
    const expected = edgeConnectionsFromMask(maskId);
    let score = 0;
    for (const edge of CELL_EDGES) {
      if (classified[edge] === expected[edge]) {
        score += 1;
      }
    }
    return score;
  };
  const pickBest = (
    candidateIndices: Iterable<number>,
    classifications: readonly Readonly<Record<CellEdge, boolean>>[],
    maskId: number,
  ): number => {
    let bestIndex = -1;
    let bestScore = -1;
    for (const index of candidateIndices) {
      const score = scoreAgainst(classifications[index]!, maskId);
      if (score > bestScore || (score === bestScore && (bestIndex === -1 || index < bestIndex))) {
        bestScore = score;
        bestIndex = index;
      }
    }
    return bestIndex;
  };

  const remaining = new Set<number>(poolCells.map((_, i) => i));
  const assignment = new Map<number, number>();

  // Phase 1: bootstrap classification vs external references, lock in masks 0 and 255 first.
  const bootstrapRefs = buildEdgeReferences(poolCells[0]!, spareCell, VENDORED_EDGE_SAMPLING);
  const bootstrapClassifications = poolCells.map((cell) =>
    classifyCellEdges(cell, bootstrapRefs, VENDORED_EDGE_SAMPLING),
  );

  const openIndex = pickBest(remaining, bootstrapClassifications, OPEN_MASK_ID);
  assignment.set(OPEN_MASK_ID, openIndex);
  remaining.delete(openIndex);
  const solidIndex = pickBest(remaining, bootstrapClassifications, SOLID_MASK_ID);
  assignment.set(SOLID_MASK_ID, solidIndex);
  remaining.delete(solidIndex);

  // Phase 2: reclassify against the FINAL self-consistent references (the actual assigned
  // mask-0/mask-255 cells) and greedily assign every remaining mask.
  const finalRefs = buildEdgeReferences(
    poolCells[openIndex]!,
    poolCells[solidIndex]!,
    VENDORED_EDGE_SAMPLING,
  );
  const finalClassifications = poolCells.map((cell) =>
    classifyCellEdges(cell, finalRefs, VENDORED_EDGE_SAMPLING),
  );

  for (const maskId of BLOB47_CANONICAL_MASKS) {
    if (maskId === OPEN_MASK_ID || maskId === SOLID_MASK_ID) {
      continue;
    }
    const bestIndex = pickBest(remaining, finalClassifications, maskId);
    if (bestIndex === -1) {
      throw new Error(`No remaining pool cell available for mask ${maskId}`);
    }
    assignment.set(maskId, bestIndex);
    remaining.delete(bestIndex);
  }
  return assignment;
}

export interface CaelesFixtureBuildResult {
  readonly manifest: TerrainPackDef;
  readonly files: readonly BuildOutputFile[];
}

/**
 * Verify that `bytes` matches `expectedHex` (SHA-256). Throws with a message
 * that includes both digests when there is a mismatch — callers must not
 * swallow the error.
 */
export function verifySha256(bytes: Buffer, expectedHex: string): void {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedHex) {
    throw new Error(
      `SHA-256 mismatch: expected ${expectedHex}, got ${actual}. ` +
        'The vendored source template has been modified or replaced; ' +
        'update CAELES_PROVENANCE.sha256 only after reviewing the new source.',
    );
  }
}

/** Pure builder: computes the manifest + output PNG buffers in memory from the vendored source bytes. */
export function buildCaelesFixturePack(templatePng: Buffer): CaelesFixtureBuildResult {
  verifySha256(templatePng, CAELES_PROVENANCE.sha256);
  const packDir = 'assets/terrain-packs/caeles-fixture';
  const files: BuildOutputFile[] = [];

  const sourceCells = sliceSourceCells(templatePng);
  const spareCellRaw = sourceCells[sourceCells.length - 1]!;
  const poolCellsRaw = sourceCells.slice(0, sourceCells.length - 1);
  const poolCellsUpscaled = poolCellsRaw.map((cell) =>
    nearestNeighborResize(cell, TERRAIN_PACK_CELL_PX, TERRAIN_PACK_CELL_PX),
  );
  // Spare (48th) source cell is reused both as the "solid" reference for greedy mask assignment
  // (see `assignPoolCellsToMasks`) and, deterministically cropped/recolored, as the basis for
  // floor/corridor/door pool art — the template has no dedicated art for those surfaces.
  const spareUpscaled = nearestNeighborResize(
    spareCellRaw,
    TERRAIN_PACK_CELL_PX,
    TERRAIN_PACK_CELL_PX,
  );

  const maskToPoolIndex = assignPoolCellsToMasks(poolCellsUpscaled, spareUpscaled);
  const assignments = buildMaskFrameAssignments();

  const atlas = createImage(ATLAS_WIDTH_PX, ATLAS_HEIGHT_PX);
  for (const { maskId, frameIndex } of assignments) {
    const poolIndex = maskToPoolIndex.get(maskId);
    if (poolIndex === undefined) {
      throw new Error(`No pool cell assigned to mask ${maskId}`);
    }
    const upscaled = poolCellsUpscaled[poolIndex];
    if (!upscaled) {
      throw new Error(`Missing upscaled pool cell at index ${poolIndex}`);
    }
    const col = frameIndex % ATLAS_GRID_COLS;
    const row = Math.floor(frameIndex / ATLAS_GRID_COLS);
    compositeInto(atlas, upscaled, col * TERRAIN_PACK_CELL_PX, row * TERRAIN_PACK_CELL_PX);
  }
  const atlasRelPath = `${packDir}/wall-atlas.png`;
  files.push({ relativePath: atlasRelPath, buffer: encodePng(atlas) });

  function buildDerivedPool(
    kind: 'floor' | 'corridor',
    count: number,
  ): { id: string; imagePath: string; textureKey: string; allowedTransforms: ['none'] }[] {
    const out: {
      id: string;
      imagePath: string;
      textureKey: string;
      allowedTransforms: ['none'];
    }[] = [];
    for (let i = 0; i < count; i++) {
      const id = `${kind}-${i}`;
      const img = recolorDerivedTile(spareUpscaled, kind, i);
      const relPath = `${packDir}/${kind}-${i}.png`;
      files.push({ relativePath: relPath, buffer: encodePng(img) });
      // This build-only fixture pack has no diversity/transform requirement
      // (it never ships to a floor manifest, refinement scope is Floor 2's
      // industrial-cave only) — declare only the always-safe identity
      // transform rather than deriving eligibility for a fixture nobody
      // renders with variety.
      out.push({
        id,
        imagePath: relPath,
        textureKey: `terrain-pack-caeles-fixture-${kind}-${i}`,
        allowedTransforms: ['none'],
      });
    }
    return out;
  }
  const floorPool = buildDerivedPool('floor', 3);
  const corridorPool = buildDerivedPool('corridor', 3);

  const doorSpecs = [
    { key: 'openHorizontal' as const, isOpen: true, orientation: 'horizontal' as const },
    { key: 'openVertical' as const, isOpen: true, orientation: 'vertical' as const },
    { key: 'closedHorizontal' as const, isOpen: false, orientation: 'horizontal' as const },
    { key: 'closedVertical' as const, isOpen: false, orientation: 'vertical' as const },
  ];
  const doorEntries: Record<string, { imagePath: string; textureKey: string }> = {};
  for (const spec of doorSpecs) {
    const img = renderDoorTile(spec.isOpen, spec.orientation);
    const fileName = `door-${spec.isOpen ? 'open' : 'closed'}-${spec.orientation}.png`;
    const relPath = `${packDir}/${fileName}`;
    files.push({ relativePath: relPath, buffer: encodePng(img) });
    doorEntries[spec.key] = {
      imagePath: relPath,
      textureKey: `terrain-pack-caeles-fixture-door-${spec.isOpen ? 'open' : 'closed'}-${spec.orientation}`,
    };
  }

  // This build-only fixture pack never renders wall-accent variety (it never
  // ships to a floor manifest — scope is Floor 2's industrial-cave only), so
  // its 4 required accent atlases are fully-transparent no-ops: schema-valid,
  // trivially topology-safe (nothing is ever opaque, so nothing can ever
  // spill), and cheap to build.
  const wallAccentIds = ['crack', 'mineral-vein', 'rust-brace', 'damp-stain'] as const;
  const wallAccents: TerrainPackDef['wallAccents'] = wallAccentIds.map((id) => {
    const blank = createImage(ATLAS_WIDTH_PX, ATLAS_HEIGHT_PX);
    const relPath = `${packDir}/accent-${id}.png`;
    files.push({ relativePath: relPath, buffer: encodePng(blank) });
    return { id, imagePath: relPath, textureKey: `terrain-pack-caeles-fixture-accent-${id}` };
  });

  const manifest: TerrainPackDef = {
    id: CAELES_FIXTURE_PACK_ID,
    name: 'Caeles Seamless Template (CC0 fixture)',
    provenance: CAELES_PROVENANCE,
    wallAutotile: {
      imagePath: atlasRelPath,
      textureKey: 'terrain-pack-caeles-fixture-walls',
      cellPx: TERRAIN_PACK_CELL_PX,
      gridCols: ATLAS_GRID_COLS,
      gridRows: ATLAS_GRID_ROWS,
      masks: assignments.map(({ maskId, frameIndex }) => ({ maskId, frameIndex })),
    },
    floorPool,
    corridorPool,
    doorSet: doorEntries as TerrainPackDef['doorSet'],
    wallAccents,
  };

  return { manifest, files };
}

/**
 * Deterministically derive a floor/corridor/door tile from the spare source
 * cell via a fixed per-(kind,index[,orientation]) RGB tint — pure pixel math,
 * no randomness, so rebuilds are byte-identical.
 */
function recolorDerivedTile(
  base: RgbaImage,
  kind: 'floor' | 'corridor' | 'door',
  index: number,
  orientation?: 'horizontal' | 'vertical',
): RgbaImage {
  const tint = deriveTintFor(kind, index, orientation);
  const out = createImage(base.width, base.height);
  for (let i = 0; i < base.data.length; i += 4) {
    out.data[i] = clampByte(base.data[i]! + tint[0]);
    out.data[i + 1] = clampByte(base.data[i + 1]! + tint[1]);
    out.data[i + 2] = clampByte(base.data[i + 2]! + tint[2]);
    out.data[i + 3] = base.data[i + 3]!;
  }
  return out;
}

function deriveTintFor(
  kind: 'floor' | 'corridor' | 'door',
  index: number,
  orientation?: 'horizontal' | 'vertical',
): readonly [number, number, number] {
  const orientationOffset = orientation === 'vertical' ? 10 : 0;
  const kindOffset = kind === 'floor' ? 0 : kind === 'corridor' ? -20 : -40;
  const step = index * 8;
  return [kindOffset + step, kindOffset + step + orientationOffset, kindOffset + step] as const;
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** Write the pack's PNGs to `public/` and its manifest JSON to `src/shared/data/terrain-packs/`. */
export function writeCaelesFixturePack(repoRoot: string): void {
  const templatePath = path.join(
    repoRoot,
    'public',
    'assets',
    'vendor',
    'terrain-packs',
    'caeles-seamless-template-ii',
    'template8x6.png',
  );
  const templatePng = fs.readFileSync(templatePath);
  const { manifest, files } = buildCaelesFixturePack(templatePng);
  for (const file of files) {
    const outPath = path.join(repoRoot, 'public', ...file.relativePath.split('/'));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, file.buffer);
  }
  const manifestDir = path.join(repoRoot, 'src', 'shared', 'data', 'terrain-packs');
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, 'caeles-fixture.manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote ${files.length} PNG(s) + manifest for caeles-fixture pack.`);
}

const cliEntry = process.argv[1];
if (cliEntry && import.meta.url === pathToFileURL(cliEntry).href) {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  writeCaelesFixturePack(repoRoot);
}
