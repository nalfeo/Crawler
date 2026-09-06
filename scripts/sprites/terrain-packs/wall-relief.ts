/**
 * Build four mask-aware wall-face overlays from a pack's own wall material.
 *
 * The base blob47 atlas provides topology, but a texture clipped to that shape
 * can still read as a flat rug. These motifs add authored, directional
 * highlight/shadow pairs: raised courses, recessed seams, broken ledges and
 * inset faces. The geometry is deterministic; the colour and grain come from
 * the pack's real wall material.
 */
import { TERRAIN_PACK_CELL_PX } from '../../../src/shared/terrain-pack-types.js';
import { buildWallAccentAtlas } from './wall-accent-tools.js';
import { createImage, type RgbaImage } from './png-buffer.js';

export const WALL_RELIEF_IDS = [
  'raised-course',
  'recessed-seam',
  'broken-ledge',
  'inset-face',
] as const;

export interface WallReliefAtlas {
  readonly id: (typeof WALL_RELIEF_IDS)[number];
  readonly image: RgbaImage;
}

function clamp8(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function sample(material: RgbaImage, x: number, y: number): readonly [number, number, number] {
  const sx = ((x % material.width) + material.width) % material.width;
  const sy = ((y % material.height) + material.height) % material.height;
  const offset = (sy * material.width + sx) * 4;
  return [
    material.data[offset] ?? 0,
    material.data[offset + 1] ?? 0,
    material.data[offset + 2] ?? 0,
  ];
}

/**
 * A long segmented run keeps the relief natural while still reading as a
 * coherent wall course. Every variant shifts the joins so adjacent accented
 * tiles do not repeat the same silhouette.
 */
function inSegment(along: number, shift: number): boolean {
  const local = (along + shift + 64) % 28;
  return local < 17;
}

function reliefTone(
  variant: number,
  x: number,
  y: number,
): { readonly shade: number; readonly opaque: boolean } {
  const shift = variant * 5;

  const north = y >= 15 && y <= 19 && inSegment(x, shift);
  const south = y >= 44 && y <= 48 && inSegment(x, shift + 9);
  const west = x >= 15 && x <= 19 && inSegment(y, shift + 4);
  const east = x >= 44 && x <= 48 && inSegment(y, shift + 13);

  // Broad central faces are deliberately asymmetric and staggered. They make
  // most overlay pixels belong to wall interiors rather than merely tracing
  // the silhouette, which is what creates visible wall-to-floor layering.
  const upperFace =
    x >= 5 + variant &&
    x <= 29 + variant &&
    y >= 3 + (variant % 2) * 3 &&
    y <= 11 + (variant % 2) * 3;
  const middleFace = x >= 23 - variant && x <= 42 + variant && y >= 25 && y <= 39;
  const lowerFace =
    x >= 34 - variant &&
    x <= 59 - variant &&
    y >= 52 - (variant % 2) * 2 &&
    y <= 60 - (variant % 2) * 2;

  if (!(north || south || west || east || upperFace || middleFace || lowerFace)) {
    return { shade: 0, opaque: false };
  }

  let shade = -18;
  if (north) shade = y <= 16 ? 38 : -34;
  else if (south) shade = y <= 45 ? 28 : -42;
  else if (west) shade = x <= 16 ? 30 : -36;
  else if (east) shade = x <= 45 ? 22 : -44;
  else if (upperFace) shade = y <= 5 + (variant % 2) * 3 ? 34 : -20;
  else if (middleFace) shade = y <= 27 ? 28 : y >= 37 ? -38 : -8;
  else if (lowerFace) shade = y <= 54 - (variant % 2) * 2 ? 24 : -34;

  // Pixel-scale chipping prevents the broad faces from becoming sterile bars.
  shade += ((x * 7 + y * 11 + variant * 13) % 9) - 4;
  return { shade, opaque: true };
}

export function buildWallReliefAtlases(
  wallMaterial: RgbaImage,
  wallAtlas: RgbaImage,
): readonly WallReliefAtlas[] {
  return WALL_RELIEF_IDS.map((id, variant) => {
    const motif = createImage(TERRAIN_PACK_CELL_PX, TERRAIN_PACK_CELL_PX);
    for (let y = 0; y < TERRAIN_PACK_CELL_PX; y += 1) {
      for (let x = 0; x < TERRAIN_PACK_CELL_PX; x += 1) {
        const tone = reliefTone(variant, x, y);
        if (!tone.opaque) continue;
        const [r, g, b] = sample(wallMaterial, x + variant * 7, y + variant * 11);
        const offset = (y * TERRAIN_PACK_CELL_PX + x) * 4;
        motif.data[offset] = clamp8(r + tone.shade);
        motif.data[offset + 1] = clamp8(g + tone.shade);
        motif.data[offset + 2] = clamp8(b + tone.shade);
        motif.data[offset + 3] = 255;
      }
    }
    return { id, image: buildWallAccentAtlas(motif, wallAtlas) };
  });
}
