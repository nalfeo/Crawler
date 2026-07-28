/**
 * Deterministic re-mask pass for the SHIPPED "industrial-cave" wall atlas.
 *
 * Why this exists
 * ---------------
 * The shipped industrial-cave atlas is Azure gpt-image-1 art that was supposed
 * to re-texture only the OPAQUE pixels of the procedural blob47 silhouettes
 * (see `build-industrial-cave.ts`). It did not: the generated pass filled every
 * cell edge-to-edge, destroying all diagonal information. The result was 16
 * fully-solid cells instead of 1, and only 16 distinct silhouettes across the
 * 47 mask slots — every group of masks sharing a cardinal N/E/S/W nibble
 * collapsed onto one image. The cardinal-only `validateCompatibleBoundaries`
 * check could not see any of that, so it shipped at a perfect 1.000.
 *
 * What this does
 * --------------
 * Restores the intended invariant WITHOUT re-generating any art and WITHOUT
 * needing Azure: for every mask frame it keeps the generated cell's RGB (the
 * rock texture — the actual value of the generated pass) and replaces its
 * alpha channel with the alpha of the corrected procedural silhouette for that
 * mask. Pixels the silhouette says are floor become fully transparent; pixels
 * it says are wall keep the generated rock.
 *
 * Where a generated cell has no rock to keep (it was transparent but the
 * silhouette says wall — should not happen, since the broken art is a strict
 * superset of every correct silhouette), the pixel is filled from the same cell's
 * mean opaque color so the output is never a hole. That fallback is asserted
 * against rather than relied on: the script reports any cell that needed it.
 *
 * This is fully deterministic and reproducible in-tree from two committed
 * inputs (the shipped atlas + the in-repo quadrant kit), so the pack stops
 * being "not byte-reproducible without the model".
 *
 * Usage:
 *   npx tsx scripts/sprites/terrain-packs/remask-industrial-cave.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TERRAIN_PACK_CELL_PX } from '../../../src/shared/terrain-pack-types.js';
import { ATLAS_GRID_COLS, buildMaskFrameAssignments } from './atlas-grid.js';
import { composeWallCellOutput } from './compose-wall-cell.js';
import { decodePng, encodePng, type RgbaImage } from './png-buffer.js';
import { generateQuadrantKit } from './quadrant-kit.js';

export interface RemaskReport {
  /** Frames that had wall pixels with no generated rock to keep (expected: empty). */
  readonly framesNeedingFill: readonly number[];
  /** Pixels cleared from wall to floor across the whole atlas. */
  readonly clearedPixels: number;
}

export interface RemaskResult {
  readonly atlas: Buffer;
  readonly report: RemaskReport;
}

/** Mean RGB of the opaque pixels of one cell; used only as a never-hit fallback fill. */
function meanOpaqueRgb(
  atlas: RgbaImage,
  originX: number,
  originY: number,
): readonly [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = 0; y < TERRAIN_PACK_CELL_PX; y += 1) {
    for (let x = 0; x < TERRAIN_PACK_CELL_PX; x += 1) {
      const i = ((originY + y) * atlas.width + (originX + x)) * 4;
      if (atlas.data[i + 3]! === 0) continue;
      r += atlas.data[i]!;
      g += atlas.data[i + 1]!;
      b += atlas.data[i + 2]!;
      n += 1;
    }
  }
  if (n === 0) return [0, 0, 0];
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/**
 * Pure transform: stencil the generated atlas with the corrected procedural
 * per-mask silhouettes. No filesystem access.
 */
export function remaskIndustrialCaveAtlas(sourceAtlasPng: Buffer): RemaskResult {
  const atlas = decodePng(sourceAtlasPng);
  const quadrantKit = generateQuadrantKit();
  const framesNeedingFill: number[] = [];
  let clearedPixels = 0;

  for (const { maskId, frameIndex } of buildMaskFrameAssignments()) {
    const silhouette = composeWallCellOutput(maskId, quadrantKit);
    const originX = (frameIndex % ATLAS_GRID_COLS) * TERRAIN_PACK_CELL_PX;
    const originY = Math.floor(frameIndex / ATLAS_GRID_COLS) * TERRAIN_PACK_CELL_PX;
    const fallback = meanOpaqueRgb(atlas, originX, originY);
    let neededFill = false;

    for (let y = 0; y < TERRAIN_PACK_CELL_PX; y += 1) {
      for (let x = 0; x < TERRAIN_PACK_CELL_PX; x += 1) {
        const dst = ((originY + y) * atlas.width + (originX + x)) * 4;
        const src = (y * silhouette.width + x) * 4;
        const wantAlpha = silhouette.data[src + 3]!;
        if (wantAlpha === 0) {
          if (atlas.data[dst + 3]! !== 0) clearedPixels += 1;
          atlas.data[dst] = 0;
          atlas.data[dst + 1] = 0;
          atlas.data[dst + 2] = 0;
          atlas.data[dst + 3] = 0;
          continue;
        }
        if (atlas.data[dst + 3]! === 0) {
          neededFill = true;
          atlas.data[dst] = fallback[0];
          atlas.data[dst + 1] = fallback[1];
          atlas.data[dst + 2] = fallback[2];
        }
        atlas.data[dst + 3] = wantAlpha;
      }
    }
    if (neededFill) framesNeedingFill.push(frameIndex);
  }

  return { atlas: encodePng(atlas), report: { framesNeedingFill, clearedPixels } };
}

/**
 * Build-time INPUT: the raw Azure-generated rock atlas, before any masking.
 *
 * Every cell of this image is textured edge to edge, so it is a strict superset
 * of any silhouette we could ever want to cut from it. Always re-masking from
 * here (rather than from the already-masked shipped atlas) makes the operation
 * idempotent and — critically — lets the silhouette geometry GROW as well as
 * shrink. Re-masking a masked atlas can only ever remove more rock, so a
 * geometry change that needs texture where the previous mask was transparent
 * would leave holes.
 *
 * It lives outside `public/` so this ~300KB build-time-only input is never
 * served to clients.
 */
const SOURCE_ATLAS_REL_PATH = path.join(
  'assets-src',
  'terrain-packs',
  'industrial-cave',
  'wall-atlas-generated.png',
);

/** Shipped OUTPUT: the masked atlas the runtime loads. */
const ATLAS_REL_PATH = path.join(
  'public',
  'assets',
  'terrain-packs',
  'industrial-cave',
  'wall-atlas.png',
);

export function writeRemaskedIndustrialCaveAtlas(repoRoot: string): RemaskReport {
  const sourcePath = path.join(repoRoot, SOURCE_ATLAS_REL_PATH);
  const { atlas, report } = remaskIndustrialCaveAtlas(fs.readFileSync(sourcePath));
  fs.writeFileSync(path.join(repoRoot, ATLAS_REL_PATH), atlas);
  return report;
}

const cliEntry = process.argv[1];
if (cliEntry && import.meta.url === pathToFileURL(cliEntry).href) {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  const report = writeRemaskedIndustrialCaveAtlas(repoRoot);
  console.log(
    `Re-masked industrial-cave wall atlas: cleared ${report.clearedPixels} wall pixel(s) to floor.`,
  );
  if (report.framesNeedingFill.length > 0) {
    console.warn(
      `WARNING: ${report.framesNeedingFill.length} frame(s) needed fallback fill: ` +
        report.framesNeedingFill.join(', '),
    );
  }
}
