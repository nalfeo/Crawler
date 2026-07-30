/**
 * Wall-accent atlas assembly (2026-07-25 terrain-variance adversarial-review
 * resolution #3): "Generic 64x64 wall overlays are forbidden. Use four
 * MASK-AWARE transparent 8x6 blob47 accent atlases ... that share the base
 * wall mask->frame mapping. At runtime stamp the matching accent frame over
 * the matching wall frame only."
 *
 * Given ONE 64x64 motif image (a crack / mineral-vein / rust-brace /
 * damp-stain decal, already transparent outside the motif shape — see
 * `scripts/sprites/postprocess.ts`'s `removeBackgroundB` chroma-key, used by
 * `generate-industrial-cave-motifs.ts` to key the Azure output out of its
 * flat magenta background) this module builds the FULL 8x6 grid atlas by
 * placing that motif at every canonical mask's frameIndex — the SAME
 * frameIndex the wall atlas uses for that mask (`buildMaskFrameAssignments`)
 * — and then ANDing its alpha against that same frame's WALL cell alpha:
 * wherever the wall cell is transparent (floor bleeding into a bevelled
 * corner for that mask), the accent cell is forced transparent too. This is
 * what makes "no accent may spill outside valid wall topology" provable by
 * construction rather than asserted by convention — `validateWallAccentTopology`
 * in `validate.ts` checks it holds pixel-for-pixel.
 */
import {
  ATLAS_GRID_COLS,
  ATLAS_HEIGHT_PX,
  ATLAS_WIDTH_PX,
  buildMaskFrameAssignments,
} from './atlas-grid.js';
import { compositeInto, createImage, cropImage, type RgbaImage } from './png-buffer.js';
import { TERRAIN_PACK_CELL_PX } from '../../../src/shared/terrain-pack-types.js';

/**
 * Composite `motif` (already alpha-keyed, e.g. via `removeBackgroundB`) into
 * one 64x64 wall-accent cell, clipped to `wallCell`'s own alpha silhouette.
 * Pure — allocates and returns a new image, never mutates its inputs.
 */
export function maskAccentCellToWallCell(motif: RgbaImage, wallCell: RgbaImage): RgbaImage {
  if (motif.width !== wallCell.width || motif.height !== wallCell.height) {
    throw new Error(
      `maskAccentCellToWallCell: size mismatch (motif ${motif.width}x${motif.height} vs wall cell ${wallCell.width}x${wallCell.height})`,
    );
  }
  const out = createImage(motif.width, motif.height);
  for (let i = 0; i < out.data.length; i += 4) {
    const wallAlpha = wallCell.data[i + 3] ?? 0;
    if (wallAlpha === 0) {
      // Wall cell is transparent here (floor bleeding into this corner for
      // this mask) — force the accent transparent too, regardless of the
      // motif's own alpha. This is the topology-safety invariant.
      continue; // out is already zero-initialized (fully transparent).
    }
    out.data[i] = motif.data[i] ?? 0;
    out.data[i + 1] = motif.data[i + 1] ?? 0;
    out.data[i + 2] = motif.data[i + 2] ?? 0;
    out.data[i + 3] = motif.data[i + 3] ?? 0;
  }
  return out;
}

/**
 * Build one full 8x6 (512x384) wall-accent atlas from a single 64x64 motif
 * image + the pack's already-assembled wall atlas. Frame `47` (the spare grid
 * cell, unused by any canonical mask) is left fully transparent, matching the
 * wall atlas's own spare-cell convention.
 */
export function buildWallAccentAtlas(motif: RgbaImage, wallAtlas: RgbaImage): RgbaImage {
  if (motif.width !== TERRAIN_PACK_CELL_PX || motif.height !== TERRAIN_PACK_CELL_PX) {
    throw new Error(
      `buildWallAccentAtlas: motif must be ${TERRAIN_PACK_CELL_PX}x${TERRAIN_PACK_CELL_PX}, got ${motif.width}x${motif.height}`,
    );
  }
  const atlas = createImage(ATLAS_WIDTH_PX, ATLAS_HEIGHT_PX);
  const assignments = buildMaskFrameAssignments();
  for (const { frameIndex } of assignments) {
    const col = frameIndex % ATLAS_GRID_COLS;
    const row = Math.floor(frameIndex / ATLAS_GRID_COLS);
    const wallCell = cropImage(
      wallAtlas,
      col * TERRAIN_PACK_CELL_PX,
      row * TERRAIN_PACK_CELL_PX,
      TERRAIN_PACK_CELL_PX,
      TERRAIN_PACK_CELL_PX,
    );
    const accentCell = maskAccentCellToWallCell(motif, wallCell);
    compositeInto(atlas, accentCell, col * TERRAIN_PACK_CELL_PX, row * TERRAIN_PACK_CELL_PX);
  }
  return atlas;
}
