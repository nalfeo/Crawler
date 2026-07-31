/**
 * Deterministic build script for the authored "industrial-cave" terrain pack.
 *
 * Produces the deterministic PROCEDURAL PLACEHOLDER art (all original — no
 * external assets):
 *   - A 512x384 (8x6 grid, 64px cells) wall autotile atlas covering all 47
 *     canonical blob47 masks, composed from a 20-quadrant kit.
 *   - 8 floor-pool variants + 8 corridor-pool variants (64x64 each), each
 *     with derived `allowedTransforms` metadata (2026-07-25 terrain-variance
 *     design — grown from the original 4+4).
 *   - 4 mask-aware wall-accent overlay atlases (crack / mineral-vein /
 *     rust-brace / damp-stain placeholders).
 *   - 4 door images: open/closed x horizontal/vertical (64x64 each).
 *   - The pack manifest JSON consumed by `src/shared/terrain-pack-registry.ts`.
 *
 * IMPORTANT: the industrial-cave art that actually SHIPS is Azure gpt-image-1
 * generated + composed over these procedural silhouettes (see the committed
 * manifest provenance + session handoff), NOT the placeholder this script
 * writes. `writeIndustrialCavePack` is therefore GUARDED so `terrain-packs:build`
 * will not silently overwrite the shipped art. The pure `buildIndustrialCavePack`
 * builder below is unchanged and still exercised by the deterministic-build tests.
 *
 * Usage:
 *   npx tsx scripts/sprites/terrain-packs/build-industrial-cave.ts
 *   npm run terrain-packs:build          (builds both packs)
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashStringToSeed, SeededRandom } from '../../../src/shared/random.js';
import type { TerrainPackDef, TransformId } from '../../../src/shared/terrain-pack-types.js';
import {
  TERRAIN_PACK_CELL_PX,
  TERRAIN_PACK_POOL_TARGET_SIZE,
  WALL_ACCENT_COUNT,
} from '../../../src/shared/terrain-pack-types.js';
import {
  ATLAS_GRID_COLS,
  ATLAS_GRID_ROWS,
  ATLAS_HEIGHT_PX,
  ATLAS_WIDTH_PX,
  buildMaskFrameAssignments,
} from './atlas-grid.js';
import { composeWallCellOutput } from './compose-wall-cell.js';
import { encodePng, compositeInto, createImage, setPixel, type RgbaImage } from './png-buffer.js';
import { generateQuadrantKit } from './quadrant-kit.js';
import { renderSpeckledSurface, type SurfacePalette } from './procedural-surfaces.js';
import { deriveAllowedTransforms } from './transform-eligibility.js';
import { buildWallAccentAtlas } from './wall-accent-tools.js';

const INDUSTRIAL_CAVE_PACK_ID = 'industrial-cave' as const;

/**
 * 8 floor-pool source palettes (grown from 4, 2026-07-25 terrain-variance
 * design). Variant index 6 carries a deliberate top-to-bottom gradient (a
 * "grime pooling downward" motif) so the transform-eligibility deriver
 * legitimately restricts its `allowedTransforms` — proving the asymmetric
 * per-source allowance rule holds even in the pure procedural placeholder,
 * not only in the Azure-generated shipped art.
 */
const FLOOR_PALETTES: readonly {
  readonly palette: SurfacePalette;
  readonly gradient?: { readonly axis: 'vertical' | 'horizontal'; readonly strength: number };
}[] = [
  { palette: { base: [46, 42, 40, 255], speckle: [58, 53, 50, 255], speckleDensity: 0.08 } },
  { palette: { base: [48, 44, 41, 255], speckle: [36, 33, 31, 255], speckleDensity: 0.06 } },
  { palette: { base: [44, 41, 44, 255], speckle: [55, 50, 55, 255], speckleDensity: 0.1 } },
  { palette: { base: [50, 45, 40, 255], speckle: [40, 36, 33, 255], speckleDensity: 0.07 } },
  { palette: { base: [43, 40, 38, 255], speckle: [60, 55, 48, 255], speckleDensity: 0.09 } },
  { palette: { base: [47, 43, 46, 255], speckle: [33, 30, 33, 255], speckleDensity: 0.05 } },
  {
    palette: { base: [40, 37, 33, 255], speckle: [52, 48, 40, 255], speckleDensity: 0.08 },
    gradient: { axis: 'vertical', strength: 34 },
  },
  { palette: { base: [49, 46, 42, 255], speckle: [38, 35, 30, 255], speckleDensity: 0.11 } },
];

/**
 * 8 corridor-pool source palettes (grown from 4). Variant index 5 carries a
 * deliberate left-to-right gradient (a "runoff staining toward one wall"
 * motif) for the same transform-eligibility-restriction reason as floor
 * variant 6 above.
 */
const CORRIDOR_PALETTES: readonly {
  readonly palette: SurfacePalette;
  readonly gradient?: { readonly axis: 'vertical' | 'horizontal'; readonly strength: number };
}[] = [
  { palette: { base: [40, 38, 44, 255], speckle: [52, 49, 56, 255], speckleDensity: 0.09 } },
  { palette: { base: [42, 40, 46, 255], speckle: [30, 29, 34, 255], speckleDensity: 0.05 } },
  { palette: { base: [38, 37, 42, 255], speckle: [48, 46, 52, 255], speckleDensity: 0.11 } },
  { palette: { base: [44, 42, 48, 255], speckle: [34, 32, 38, 255], speckleDensity: 0.06 } },
  { palette: { base: [41, 39, 45, 255], speckle: [56, 52, 60, 255], speckleDensity: 0.08 } },
  {
    palette: { base: [39, 36, 41, 255], speckle: [50, 47, 54, 255], speckleDensity: 0.07 },
    gradient: { axis: 'horizontal', strength: 32 },
  },
  { palette: { base: [45, 43, 49, 255], speckle: [32, 31, 36, 255], speckleDensity: 0.1 } },
  { palette: { base: [37, 35, 40, 255], speckle: [49, 45, 53, 255], speckleDensity: 0.09 } },
];

/**
 * 4 procedural wall-accent motifs (crack / mineral-vein / rust-brace /
 * damp-stain), each a small deterministic blob rendered onto a transparent
 * 64x64 canvas — placeholder stand-ins for the Azure-generated motifs that
 * ship in the committed pack (see `generate-industrial-cave-motifs.ts`).
 * `buildWallAccentAtlas` then clips each motif to every mask's wall
 * silhouette to build the full 8x6 atlas (2026-07-25 refinement #3).
 */
const ACCENT_SPECS: readonly {
  readonly id: string;
  readonly color: readonly [number, number, number];
}[] = [
  { id: 'crack', color: [12, 10, 10] },
  { id: 'mineral-vein', color: [92, 168, 150] },
  { id: 'rust-brace', color: [140, 74, 34] },
  { id: 'damp-stain', color: [20, 28, 30] },
];

/** Render one deterministic transparent accent-motif blob (placeholder — no external art). */
function renderAccentMotif(seed: number, color: readonly [number, number, number]): RgbaImage {
  const size = TERRAIN_PACK_CELL_PX;
  const img = createImage(size, size);
  const rng = new SeededRandom(seed);
  const cx = size * (0.35 + rng.next() * 0.3);
  const cy = size * (0.35 + rng.next() * 0.3);
  const radius = size * (0.2 + rng.next() * 0.15);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // Soft-edged blob: opaque core fading to transparent — a believable
      // decal silhouette rather than a hard-edged square (avoids reading as
      // a generic overlay, refinement #3's "no generic overlays" spirit).
      const edge = radius * (0.7 + 0.3 * Math.sin(dx * 0.5) * Math.cos(dy * 0.5));
      if (dist < edge) {
        const falloff = 1 - dist / edge;
        const alpha = Math.round(160 + falloff * 95);
        setPixel(img, x, y, color[0], color[1], color[2], Math.min(255, alpha));
      }
    }
  }
  return img;
}

export interface BuildOutputFile {
  readonly relativePath: string;
  readonly buffer: Buffer;
}

export interface IndustrialCaveBuildResult {
  readonly manifest: TerrainPackDef;
  readonly files: readonly BuildOutputFile[];
}

/**
 * Pure builder: computes the manifest + every output PNG buffer in memory,
 * with no filesystem access. `writeIndustrialCavePack` wraps this for the CLI.
 */
export function buildIndustrialCavePack(): IndustrialCaveBuildResult {
  const packDir = 'assets/terrain-packs/industrial-cave';
  const files: BuildOutputFile[] = [];

  // --- Wall autotile atlas -------------------------------------------------
  // NOTE: `generateQuadrantKit` emits SOLID-FILL silhouettes by design (see its
  // header) — this atlas carries correct blob47 geometry and alpha but no
  // material. `restyleWallAtlas` in rebuild-shared-base-pools.ts stamps the
  // floor material through it; that step is chained into `terrain-packs:build`.
  const quadrantKit = generateQuadrantKit();
  const assignments = buildMaskFrameAssignments();
  const atlas = createImage(ATLAS_WIDTH_PX, ATLAS_HEIGHT_PX);
  for (const { maskId, frameIndex } of assignments) {
    const cell = composeWallCellOutput(maskId, quadrantKit);
    const col = frameIndex % ATLAS_GRID_COLS;
    const row = Math.floor(frameIndex / ATLAS_GRID_COLS);
    compositeInto(atlas, cell, col * TERRAIN_PACK_CELL_PX, row * TERRAIN_PACK_CELL_PX);
  }
  const atlasRelPath = `${packDir}/wall-atlas.png`;
  files.push({ relativePath: atlasRelPath, buffer: encodePng(atlas) });

  // --- Floor / corridor pools -----------------------------------------------
  function buildPool(
    kind: 'floor' | 'corridor',
    specs: readonly {
      readonly palette: SurfacePalette;
      readonly gradient?: { readonly axis: 'vertical' | 'horizontal'; readonly strength: number };
    }[],
  ): TerrainPackDef['floorPool'] {
    return specs.map((spec, i) => {
      const id = `${kind}-${i}`;
      const seed = hashStringToSeed(`industrial-cave-${kind}-${i}`);
      const img = renderSpeckledSurface(seed, spec.palette, spec.gradient);
      const relPath = `${packDir}/${kind}-${i}.png`;
      files.push({ relativePath: relPath, buffer: encodePng(img) });
      const allowedTransforms: TransformId[] = deriveAllowedTransforms(img);
      return {
        id,
        imagePath: relPath,
        textureKey: `terrain-pack-industrial-cave-${kind}-${i}`,
        allowedTransforms,
      };
    });
  }
  const floorPool = buildPool('floor', FLOOR_PALETTES);
  const corridorPool = buildPool('corridor', CORRIDOR_PALETTES);
  if (floorPool.length !== TERRAIN_PACK_POOL_TARGET_SIZE) {
    throw new Error(
      `Expected ${TERRAIN_PACK_POOL_TARGET_SIZE} floor sources, built ${floorPool.length}`,
    );
  }
  if (corridorPool.length !== TERRAIN_PACK_POOL_TARGET_SIZE) {
    throw new Error(
      `Expected ${TERRAIN_PACK_POOL_TARGET_SIZE} corridor sources, built ${corridorPool.length}`,
    );
  }

  // --- Wall accents ----------------------------------------------------------
  const wallAccents: TerrainPackDef['wallAccents'] = ACCENT_SPECS.map((spec) => {
    const seed = hashStringToSeed(`industrial-cave-accent-${spec.id}`);
    const motif = renderAccentMotif(seed, spec.color);
    const accentAtlas = buildWallAccentAtlas(motif, atlas);
    const relPath = `${packDir}/accent-${spec.id}.png`;
    files.push({ relativePath: relPath, buffer: encodePng(accentAtlas) });
    return {
      id: spec.id,
      imagePath: relPath,
      textureKey: `terrain-pack-industrial-cave-accent-${spec.id}`,
    };
  });
  if (wallAccents.length !== WALL_ACCENT_COUNT) {
    throw new Error(`Expected ${WALL_ACCENT_COUNT} wall accents, built ${wallAccents.length}`);
  }

  const manifest: TerrainPackDef = {
    id: INDUSTRIAL_CAVE_PACK_ID,
    name: 'Industrial Cave',
    provenance: {
      kind: 'authored',
      author: 'Crawler agent (procedural placeholder build script)',
      derivationNote:
        'Procedural PLACEHOLDER geometry generated deterministically by ' +
        'scripts/sprites/terrain-packs/build-industrial-cave.ts from an original ' +
        '20-quadrant blob47 kit (no external art); rerunning reproduces byte-identical ' +
        'placeholder output. NOTE: the shipped industrial-cave art is Azure gpt-image-1 ' +
        'generated (see the committed manifest provenance); this writer is guarded so it ' +
        'will not overwrite that art.',
    },
    wallAutotile: {
      imagePath: atlasRelPath,
      textureKey: 'terrain-pack-industrial-cave-walls',
      cellPx: TERRAIN_PACK_CELL_PX,
      gridCols: ATLAS_GRID_COLS,
      gridRows: ATLAS_GRID_ROWS,
      masks: assignments.map(({ maskId, frameIndex }) => ({ maskId, frameIndex })),
    },
    floorPool,
    corridorPool,
    wallAccents,
  };

  return { manifest, files };
}

/** Write the pack's PNGs to `public/` and its manifest JSON to `src/shared/data/terrain-packs/`. */
export function writeIndustrialCavePack(repoRoot: string): void {
  // The SHIPPED industrial-cave art is Azure gpt-image-1 generated + composed over
  // these procedural blob47 silhouettes (see the committed manifest provenance +
  // session handoff), NOT the procedural placeholder this script produces. Writing
  // the placeholder would silently overwrite the generated art and revert the
  // manifest provenance. Refuse unless explicitly forced (i.e. intentionally
  // regenerating the procedural placeholder).
  // Explicit opt-in only: a bare truthiness check would let a benign-looking
  // `TERRAIN_PACKS_ALLOW_PROCEDURAL_OVERWRITE=0` / `=false` (or any value left in a
  // shell profile / CI env) bypass the guard and clobber the shipped generated art.
  const overwriteFlag = process.env.TERRAIN_PACKS_ALLOW_PROCEDURAL_OVERWRITE?.trim().toLowerCase();
  const allowProceduralOverwrite = overwriteFlag === '1' || overwriteFlag === 'true';
  if (!allowProceduralOverwrite) {
    console.warn(
      '[industrial-cave] SKIPPED procedural write — shipped art is Azure gpt-image-1 generated. ' +
        'Set TERRAIN_PACKS_ALLOW_PROCEDURAL_OVERWRITE=1 to overwrite it with the procedural placeholder.',
    );
    return;
  }
  const { manifest, files } = buildIndustrialCavePack();
  for (const file of files) {
    const outPath = path.join(repoRoot, 'public', ...file.relativePath.split('/'));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, file.buffer);
  }
  const manifestDir = path.join(repoRoot, 'src', 'shared', 'data', 'terrain-packs');
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, 'industrial-cave.manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote ${files.length} PNG(s) + manifest for industrial-cave pack.`);
}

const cliEntry = process.argv[1];
if (cliEntry && import.meta.url === pathToFileURL(cliEntry).href) {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  writeIndustrialCavePack(repoRoot);
}
