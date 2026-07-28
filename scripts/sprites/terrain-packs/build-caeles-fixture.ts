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
 * Cell → mask assignment: DERIVED from the art, not guessed. The template is
 * alpha-clean (opaque = wall, transparent = floor), so each 32px cell's own
 * blob47 signature is read straight off its pixels — the midpoint of each edge
 * for the 4 cardinal bits, the extreme corner pixel for each of the 4 diagonal
 * bits — and normalized through the shared `normalizeBlob47Mask`. See
 * `deriveTemplateCellMasks`. That recovers the template's real layout exactly:
 * 47 distinct canonical masks over the 48 cells, every raw signature already
 * canonical, and mask 255 appearing twice (the template ships two fully-solid
 * cells; the second is the spare used to derive floor/corridor/door art). The
 * derivation asserts all of that and throws if the vendored source ever stops
 * matching. The result is still written down as a literal, explicit
 * `{maskId, frameIndex}` table in the manifest — never inferred from atlas
 * position at runtime.
 *
 * This replaced an earlier two-phase GREEDY best-match search that scored cells
 * only against expected CARDINAL connectivity. Being blind to diagonals, it
 * mapped a half-floor cell onto mask 255, emitted duplicate silhouettes, and
 * reserved cell 47 as the "spare" when cell 47 is really mask 9 — while still
 * scoring ~0.94 on the cardinal-only edge check. The corner-coverage check in
 * `validate.ts` now catches that class of error.
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
  MASK_BIT,
  normalizeBlob47Mask,
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
import { isWallAlpha } from './wall-opacity.js';

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
    'Sliced into 48 32px cells (8x6 grid, row-major). Cell -> mask assignment is DERIVED from ' +
    'the artwork rather than guessed: the template is alpha-clean (opaque = wall, transparent = ' +
    "floor), so each cell's own blob47 signature is read directly off its pixels - the midpoint " +
    'of each edge for the 4 cardinal bits, the extreme corner pixel for each of the 4 diagonal ' +
    'bits - and normalized through the shared normalizeBlob47Mask (see deriveTemplateCellMasks ' +
    'in build-caeles-fixture.ts). Every raw signature is already canonical, the 48 cells yield ' +
    'exactly the 47 canonical masks, and mask 255 appears twice; the second fully-solid cell is ' +
    'the spare. The derivation asserts all of that and throws if the vendored source ever stops ' +
    'matching. Each assigned cell is nearest-neighbor upscaled 32x32 -> 64x64 (factor 2, explicit ' +
    'source/destination size, no implicit resizing). Floor/corridor/door pool images are derived ' +
    'by deterministically cropping/recoloring the spare cell (documented here, not literal ' +
    'additional vendored artwork) because the source template has no dedicated ' +
    'floor/corridor/door art.',
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
 * Recover the template's TRUE cell→mask layout by reading each cell's own
 * 8-neighbour signature directly out of the art.
 *
 * The vendored template is alpha-clean: wall pixels are opaque, floor pixels
 * fully transparent. So for each 32px cell we can read the blob47 signature
 * off the art exactly the way the runtime reads it off the tilemap — sample the
 * midpoint of each of the 4 edges for the cardinal bits, and the extreme corner
 * pixel for each of the 4 diagonal bits — then normalize through the shared
 * `normalizeBlob47Mask`.
 *
 * This is a derivation, not a heuristic. It is self-verifying: the 48 cells
 * yield exactly the 47 canonical masks with mask 255 appearing twice (the
 * template ships two fully-solid cells), every raw signature is already
 * canonical (no diagonal needed gating), and the function throws if any of that
 * stops holding — which is precisely what a swapped or corrupted vendored
 * source would do.
 *
 * It replaces an earlier two-phase GREEDY best-match search that scored cells
 * against expected cardinal connectivity. That search could only ever see the 4
 * cardinal bits, so it was blind to the diagonals that distinguish 31 of the 47
 * masks; it mapped a half-floor cell onto mask 255, produced duplicate
 * silhouettes, and reserved cell 47 as the "spare" when cell 47 is really
 * mask 9.
 *
 * Returns { maskToCell, spareCellIndex }, where `spareCellIndex` is the second
 * (higher-index) fully-solid cell — the one not needed for mask 255, reused to
 * derive floor/corridor/door art.
 */
export function deriveTemplateCellMasks(sourceCells: readonly RgbaImage[]): {
  maskToCell: Map<number, number>;
  spareCellIndex: number;
} {
  const expectedCells = SOURCE_GRID_COLS * SOURCE_GRID_ROWS;
  if (sourceCells.length !== expectedCells) {
    throw new Error(`Expected ${expectedCells} source cells, got ${sourceCells.length}`);
  }

  const isWall = (cell: RgbaImage, x: number, y: number): boolean =>
    isWallAlpha(cell.data[(y * cell.width + x) * 4 + 3]!);

  const signatures = sourceCells.map((cell) => {
    const size = cell.width;
    const mid = Math.floor(size / 2);
    const far = size - 1;
    let raw = 0;
    if (isWall(cell, mid, 0)) raw |= MASK_BIT.N;
    if (isWall(cell, far, mid)) raw |= MASK_BIT.E;
    if (isWall(cell, mid, far)) raw |= MASK_BIT.S;
    if (isWall(cell, 0, mid)) raw |= MASK_BIT.W;
    if (isWall(cell, far, 0)) raw |= MASK_BIT.NE;
    if (isWall(cell, far, far)) raw |= MASK_BIT.SE;
    if (isWall(cell, 0, far)) raw |= MASK_BIT.SW;
    if (isWall(cell, 0, 0)) raw |= MASK_BIT.NW;
    const canonical = normalizeBlob47Mask(raw);
    if (canonical !== raw) {
      throw new Error(
        `Template cell signature ${raw} is not blob47-canonical (normalizes to ${canonical}); ` +
          'the vendored source does not match the expected seamless-template layout',
      );
    }
    return raw;
  });

  const cellsByMask = new Map<number, number[]>();
  signatures.forEach((mask, index) => {
    cellsByMask.set(mask, [...(cellsByMask.get(mask) ?? []), index]);
  });

  const SOLID_MASK_ID = 255;
  const solidCells = cellsByMask.get(SOLID_MASK_ID) ?? [];
  if (solidCells.length !== 2) {
    throw new Error(
      `Expected exactly 2 fully-solid template cells (one for mask 255, one spare), got ${solidCells.length}`,
    );
  }
  const spareCellIndex = solidCells[1]!;

  const maskToCell = new Map<number, number>();
  for (const maskId of BLOB47_CANONICAL_MASKS) {
    const candidates = cellsByMask.get(maskId);
    if (!candidates || candidates.length === 0) {
      throw new Error(`Vendored template has no cell for canonical mask ${maskId}`);
    }
    if (candidates.length > 1 && maskId !== SOLID_MASK_ID) {
      throw new Error(
        `Vendored template has ${candidates.length} cells for mask ${maskId} (cells ${candidates.join(', ')}); ` +
          'the cell→mask mapping must be 1:1 apart from the duplicated solid cell',
      );
    }
    maskToCell.set(maskId, candidates[0]!);
  }
  if (maskToCell.size !== BLOB47_CANONICAL_MASKS.length) {
    throw new Error(
      `Derived ${maskToCell.size} mask assignments, expected ${BLOB47_CANONICAL_MASKS.length}`,
    );
  }
  return { maskToCell, spareCellIndex };
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
  const { maskToCell, spareCellIndex } = deriveTemplateCellMasks(sourceCells);
  const upscaledCells = sourceCells.map((cell) =>
    nearestNeighborResize(cell, TERRAIN_PACK_CELL_PX, TERRAIN_PACK_CELL_PX),
  );
  // The template ships TWO fully-solid cells; the second is surplus to mask 255 and is
  // deterministically cropped/recolored into floor/corridor/door art (the template has no
  // dedicated art for those surfaces).
  const spareUpscaled = upscaledCells[spareCellIndex]!;
  const assignments = buildMaskFrameAssignments();

  const atlas = createImage(ATLAS_WIDTH_PX, ATLAS_HEIGHT_PX);
  for (const { maskId, frameIndex } of assignments) {
    const cellIndex = maskToCell.get(maskId);
    if (cellIndex === undefined) {
      throw new Error(`No template cell derived for mask ${maskId}`);
    }
    const upscaled = upscaledCells[cellIndex];
    if (!upscaled) {
      throw new Error(`Missing upscaled template cell at index ${cellIndex}`);
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
