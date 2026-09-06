/**
 * Deterministic build script for the shipped "companion-overworld" terrain pack
 * (Floor 3 — Companion League Overworld, issue #4294).
 *
 * Unlike `industrial-cave` / `floor1-dungeon`, this pack has NO generated-image
 * step: every pixel is original procedural art produced here from `SeededRandom`
 * (never `Math.random()`), so `npm run terrain-packs:build` reproduces the
 * committed bytes exactly. That is what makes the pack repairable after a
 * canonical blob47 silhouette change — the wall atlas is composed through
 * `composeWallAtlas`, which re-textures `composeWallCellOutput(maskId)`
 * silhouettes rather than baking a hand-authored atlas.
 *
 * Art brief: a bright, sunlit outdoor arena — grass ground with sparse dirt /
 * clover / pebble punctuation, and mossy sun-lit rock walls. Deliberately much
 * lighter than the underground packs (the Floor 3 manifest also raises ambient
 * light to 0.45).
 *
 * Pool weighting follows the shared-base contract in
 * `src/shared/terrain-pack-variants.ts`: ONE dominant base (weight 10), one
 * quiet near-plain companion (weight 8) and six sparse detail variants
 * (weight 1) so ground reads as continuous grassland instead of a uniform
 * 8-way patchwork.
 *
 * Usage:
 *   npx tsx scripts/sprites/terrain-packs/build-companion-overworld.ts
 *   npm run terrain-packs:build          (builds every pack)
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashStringToSeed, SeededRandom } from '../../../src/shared/random.js';
import type { TerrainPackDef, TransformId } from '../../../src/shared/terrain-pack-types.js';
import {
  TERRAIN_PACK_CELL_PX,
  TERRAIN_PACK_POOL_TARGET_SIZE,
} from '../../../src/shared/terrain-pack-types.js';
import { ATLAS_GRID_COLS, ATLAS_GRID_ROWS } from './atlas-grid.js';
import { composeWallAtlas } from './gen/compose-pack.js';
import { createImage, encodePng, type RgbaImage } from './png-buffer.js';
import { renderSpeckledSurface, type SurfacePalette } from './procedural-surfaces.js';
import { deriveAllowedTransforms } from './transform-eligibility.js';

export const COMPANION_OVERWORLD_PACK_ID = 'companion-overworld' as const;

const PACK_DIR = `assets/terrain-packs/${COMPANION_OVERWORLD_PACK_ID}`;

/**
 * Selection weights, by pool index: base 10, quiet 8, detail 1 x6 — the
 * established distribution `industrial-cave` ships (see
 * `buildWeightedCombos`). Index 0 and 1 are deliberately the two calmest,
 * closest-toned variants so the dominant 75% of ground alternates between two
 * near-identical grasses.
 */
const POOL_WEIGHTS: readonly number[] = [10, 8, 1, 1, 1, 1, 1, 1];

interface SurfaceSpec {
  readonly palette: SurfacePalette;
  readonly gradient?: { readonly axis: 'vertical' | 'horizontal'; readonly strength: number };
}

/**
 * 8 floor-pool palettes. 0 = sunlit grass BASE, 1 = quiet grass (same hue,
 * fewer blades), 2-7 = sparse punctuation (clover, dry grass, dirt scuff,
 * pebbled turf, deep-green shade, bare earth).
 */
const FLOOR_PALETTES: readonly SurfaceSpec[] = [
  { palette: { base: [116, 160, 78, 255], speckle: [136, 180, 92, 255], speckleDensity: 0.14 } },
  { palette: { base: [114, 157, 76, 255], speckle: [128, 170, 86, 255], speckleDensity: 0.07 } },
  { palette: { base: [104, 154, 74, 255], speckle: [150, 190, 104, 255], speckleDensity: 0.18 } },
  { palette: { base: [140, 166, 92, 255], speckle: [166, 186, 112, 255], speckleDensity: 0.16 } },
  { palette: { base: [150, 128, 92, 255], speckle: [172, 150, 112, 255], speckleDensity: 0.15 } },
  { palette: { base: [120, 158, 84, 255], speckle: [168, 168, 160, 255], speckleDensity: 0.09 } },
  { palette: { base: [94, 138, 70, 255], speckle: [112, 156, 82, 255], speckleDensity: 0.12 } },
  { palette: { base: [158, 134, 96, 255], speckle: [134, 112, 80, 255], speckleDensity: 0.2 } },
];

/**
 * 8 corridor-pool palettes: a trodden dirt path (base + quiet) with grass
 * encroachment, gravel and puddle-dry punctuation.
 */
const CORRIDOR_PALETTES: readonly SurfaceSpec[] = [
  { palette: { base: [158, 132, 94, 255], speckle: [176, 152, 114, 255], speckleDensity: 0.13 } },
  { palette: { base: [156, 130, 92, 255], speckle: [168, 144, 106, 255], speckleDensity: 0.06 } },
  { palette: { base: [148, 128, 92, 255], speckle: [120, 160, 82, 255], speckleDensity: 0.14 } },
  { palette: { base: [162, 140, 102, 255], speckle: [190, 172, 140, 255], speckleDensity: 0.17 } },
  { palette: { base: [144, 122, 88, 255], speckle: [170, 168, 158, 255], speckleDensity: 0.11 } },
  { palette: { base: [166, 142, 100, 255], speckle: [144, 120, 84, 255], speckleDensity: 0.19 } },
  { palette: { base: [152, 134, 98, 255], speckle: [178, 158, 118, 255], speckleDensity: 0.1 } },
  { palette: { base: [138, 118, 86, 255], speckle: [160, 140, 104, 255], speckleDensity: 0.15 } },
];

/**
 * Wall material: sun-lit mossy rock. `composeWallAtlas` applies its own rim
 * shading, so this stays a flat, bright material tile.
 */
const WALL_PALETTE: SurfacePalette = {
  base: [138, 142, 116, 255],
  speckle: [112, 132, 88, 255],
  speckleDensity: 0.22,
};

/**
 * Deterministic per-pixel tonal grain. `renderSpeckledSurface` emits exactly
 * two tones, which reads as flat, uniform noise at game scale; a small seeded
 * luminance jitter widens that to a believable natural-ground tone range
 * without introducing any structure (so the tile stays seamless and every
 * transform stays eligible). Pure function of `seed`, so a rebuild is
 * byte-identical.
 */
function applyTonalGrain(img: RgbaImage, seed: number, amplitude: number): RgbaImage {
  const rng = new SeededRandom(seed);
  const out = createImage(img.width, img.height);
  const clamp = (v: number): number => Math.max(0, Math.min(255, v));
  for (let i = 0; i < img.data.length; i += 4) {
    const shade = Math.round((rng.next() * 2 - 1) * amplitude);
    out.data[i] = clamp(img.data[i]! + shade);
    out.data[i + 1] = clamp(img.data[i + 1]! + shade);
    out.data[i + 2] = clamp(img.data[i + 2]! + shade);
    out.data[i + 3] = img.data[i + 3]!;
  }
  return out;
}

/** Render one pack surface: two-tone speckle plus deterministic tonal grain. */
function renderSurface(key: string, spec: SurfaceSpec, amplitude = 10): RgbaImage {
  const base = renderSpeckledSurface(hashStringToSeed(key), spec.palette, spec.gradient);
  return applyTonalGrain(base, hashStringToSeed(`${key}-grain`), amplitude);
}

export interface BuildOutputFile {
  readonly relativePath: string;
  readonly buffer: Buffer;
}

export interface CompanionOverworldBuildResult {
  readonly manifest: TerrainPackDef;
  readonly files: readonly BuildOutputFile[];
}

/** Pure builder: every output PNG + the manifest, computed in memory. */
export function buildCompanionOverworldPack(): CompanionOverworldBuildResult {
  const files: BuildOutputFile[] = [];

  // --- Wall autotile atlas --------------------------------------------------
  // `composeWallAtlas` re-textures the canonical `composeWallCellOutput(maskId)`
  // silhouettes, so the atlas is edge-compatible and silhouette-exact BY
  // CONSTRUCTION — a canonical-geometry change is repaired by re-running this
  // script, never by hand-editing wall-atlas.png.
  const wallTile = renderSurface(`${COMPANION_OVERWORLD_PACK_ID}-wall-material`, {
    palette: WALL_PALETTE,
  });
  const { atlas, masks } = composeWallAtlas(wallTile);
  const atlasRelPath = `${PACK_DIR}/wall-atlas.png`;
  files.push({ relativePath: atlasRelPath, buffer: encodePng(atlas) });
  // Durable rebuild input (same convention as industrial-cave/floor1). Not
  // referenced by the manifest — it is a build input, not a runtime asset.
  files.push({ relativePath: `${PACK_DIR}/wall-material.png`, buffer: encodePng(wallTile) });

  // --- Floor / corridor pools ----------------------------------------------
  function buildPool(kind: 'floor' | 'corridor', specs: readonly SurfaceSpec[]) {
    return specs.map((spec, i) => {
      const id = `${kind}-${i}`;
      const img = renderSurface(`${COMPANION_OVERWORLD_PACK_ID}-${kind}-${i}`, spec);
      const relPath = `${PACK_DIR}/${id}.png`;
      files.push({ relativePath: relPath, buffer: encodePng(img) });
      const allowedTransforms: TransformId[] = deriveAllowedTransforms(img);
      const weight = POOL_WEIGHTS[i];
      if (weight === undefined) throw new Error(`No pool weight declared for index ${i}`);
      return {
        id,
        imagePath: relPath,
        textureKey: `terrain-pack-${COMPANION_OVERWORLD_PACK_ID}-${id}`,
        allowedTransforms,
        weight,
      };
    });
  }

  const floorPool = buildPool('floor', FLOOR_PALETTES);
  const corridorPool = buildPool('corridor', CORRIDOR_PALETTES);
  for (const [label, pool] of [
    ['floor', floorPool],
    ['corridor', corridorPool],
  ] as const) {
    if (pool.length !== TERRAIN_PACK_POOL_TARGET_SIZE) {
      throw new Error(
        `Expected ${TERRAIN_PACK_POOL_TARGET_SIZE} ${label} sources, built ${pool.length}`,
      );
    }
  }

  const manifest: TerrainPackDef = {
    id: COMPANION_OVERWORLD_PACK_ID,
    name: 'Companion League Overworld',
    provenance: {
      kind: 'authored',
      author: 'Crawler agent (deterministic procedural build script)',
      derivationNote:
        'Original procedural art with NO external or generated-image input: rendered ' +
        'deterministically by scripts/sprites/terrain-packs/build-companion-overworld.ts from ' +
        'SeededRandom, and composed onto the canonical 20-quadrant blob47 wall silhouettes via ' +
        'composeWallAtlas (scripts/sprites/terrain-packs/gen/compose-pack.ts). Fully ' +
        'reproducible and byte-identical: run `npm run terrain-packs:build`. Palette is a ' +
        'bright sunlit grass/dirt overworld for the Floor 3 Companion League brief. Pools are ' +
        'weighted 10:8:1x6 (grass base : quiet grass : sparse detail) so ground reads as ' +
        'continuous grassland with occasional punctuation rather than a uniform patchwork.',
    },
    wallAutotile: {
      imagePath: atlasRelPath,
      textureKey: `terrain-pack-${COMPANION_OVERWORLD_PACK_ID}-walls`,
      cellPx: TERRAIN_PACK_CELL_PX,
      gridCols: ATLAS_GRID_COLS,
      gridRows: ATLAS_GRID_ROWS,
      masks: masks.map(({ maskId, frameIndex }) => ({ maskId, frameIndex })),
    },
    floorPool,
    corridorPool,
  };

  return { manifest, files };
}

/** Write the pack's PNGs to `public/` and its manifest to `src/shared/data/terrain-packs/`. */
export function writeCompanionOverworldPack(repoRoot: string): void {
  const { manifest, files } = buildCompanionOverworldPack();
  for (const file of files) {
    const outPath = path.join(repoRoot, 'public', ...file.relativePath.split('/'));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, file.buffer);
  }
  const manifestDir = path.join(repoRoot, 'src', 'shared', 'data', 'terrain-packs');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, `${COMPANION_OVERWORLD_PACK_ID}.manifest.json`),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  console.log(`Wrote ${files.length} PNG(s) + manifest for ${COMPANION_OVERWORLD_PACK_ID} pack.`);
}

const cliEntry = process.argv[1];
if (cliEntry && import.meta.url === pathToFileURL(cliEntry).href) {
  writeCompanionOverworldPack(path.resolve(import.meta.dirname, '..', '..', '..'));
}
