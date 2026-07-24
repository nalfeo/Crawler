/**
 * Deterministic build script for the authored "industrial-cave" terrain pack.
 *
 * Produces the deterministic PROCEDURAL PLACEHOLDER art (all original — no
 * external assets):
 *   - A 512x384 (8x6 grid, 64px cells) wall autotile atlas covering all 47
 *     canonical blob47 masks, composed from a 20-quadrant kit.
 *   - 4 floor-pool variants + 4 corridor-pool variants (64x64 each).
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
import { hashStringToSeed } from '../../../src/shared/random.js';
import type { TerrainPackDef } from '../../../src/shared/terrain-pack-types.js';
import { TERRAIN_PACK_CELL_PX } from '../../../src/shared/terrain-pack-types.js';
import {
  ATLAS_GRID_COLS,
  ATLAS_GRID_ROWS,
  ATLAS_HEIGHT_PX,
  ATLAS_WIDTH_PX,
  buildMaskFrameAssignments,
} from './atlas-grid.js';
import { composeWallCellOutput } from './compose-wall-cell.js';
import { encodePng, compositeInto, createImage, type RgbaImage } from './png-buffer.js';
import { generateQuadrantKit } from './quadrant-kit.js';
import {
  renderDoorTile,
  renderSpeckledSurface,
  type SurfacePalette,
} from './procedural-surfaces.js';

const INDUSTRIAL_CAVE_PACK_ID = 'industrial-cave' as const;

const FLOOR_PALETTES: readonly SurfacePalette[] = [
  { base: [46, 42, 40, 255], speckle: [58, 53, 50, 255], speckleDensity: 0.08 },
  { base: [48, 44, 41, 255], speckle: [36, 33, 31, 255], speckleDensity: 0.06 },
  { base: [44, 41, 44, 255], speckle: [55, 50, 55, 255], speckleDensity: 0.1 },
  { base: [50, 45, 40, 255], speckle: [40, 36, 33, 255], speckleDensity: 0.07 },
];

const CORRIDOR_PALETTES: readonly SurfacePalette[] = [
  { base: [40, 38, 44, 255], speckle: [52, 49, 56, 255], speckleDensity: 0.09 },
  { base: [42, 40, 46, 255], speckle: [30, 29, 34, 255], speckleDensity: 0.05 },
  { base: [38, 37, 42, 255], speckle: [48, 46, 52, 255], speckleDensity: 0.11 },
  { base: [44, 42, 48, 255], speckle: [34, 32, 38, 255], speckleDensity: 0.06 },
];

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
    palettes: readonly SurfacePalette[],
  ): { id: string; imagePath: string; textureKey: string }[] {
    return palettes.map((palette, i) => {
      const id = `${kind}-${i}`;
      const seed = hashStringToSeed(`industrial-cave-${kind}-${i}`);
      const img = renderSpeckledSurface(seed, palette);
      const relPath = `${packDir}/${kind}-${i}.png`;
      files.push({ relativePath: relPath, buffer: encodePng(img) });
      return { id, imagePath: relPath, textureKey: `terrain-pack-industrial-cave-${kind}-${i}` };
    });
  }
  const floorPool = buildPool('floor', FLOOR_PALETTES);
  const corridorPool = buildPool('corridor', CORRIDOR_PALETTES);

  // --- Doors -----------------------------------------------------------------
  const doorSpecs = [
    { key: 'openHorizontal', isOpen: true, orientation: 'horizontal' as const },
    { key: 'openVertical', isOpen: true, orientation: 'vertical' as const },
    { key: 'closedHorizontal', isOpen: false, orientation: 'horizontal' as const },
    { key: 'closedVertical', isOpen: false, orientation: 'vertical' as const },
  ];
  const doorEntries: Record<string, { imagePath: string; textureKey: string }> = {};
  for (const spec of doorSpecs) {
    const img: RgbaImage = renderDoorTile(spec.isOpen, spec.orientation);
    const fileName = `door-${spec.isOpen ? 'open' : 'closed'}-${spec.orientation}.png`;
    const relPath = `${packDir}/${fileName}`;
    files.push({ relativePath: relPath, buffer: encodePng(img) });
    doorEntries[spec.key] = {
      imagePath: relPath,
      textureKey: `terrain-pack-industrial-cave-door-${spec.isOpen ? 'open' : 'closed'}-${spec.orientation}`,
    };
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
    doorSet: doorEntries as TerrainPackDef['doorSet'],
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
  if (!process.env.TERRAIN_PACKS_ALLOW_PROCEDURAL_OVERWRITE) {
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
