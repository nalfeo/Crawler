/**
 * Deterministic procedural generators for the industrial-cave pack's
 * floor-pool, corridor-pool, and door images. All original geometric art
 * (no external assets), driven entirely by `SeededRandom` — never
 * `Math.random()` — so a rebuild from the same inputs is byte-identical.
 */
import { SeededRandom } from '../../../src/shared/random.js';
import { TERRAIN_PACK_CELL_PX } from '../../../src/shared/terrain-pack-types.js';
import { createImage, fillRect, setPixel, type RgbaImage } from './png-buffer.js';

/** Base color + speckle color for one procedural surface variant. */
export interface SurfacePalette {
  readonly base: readonly [number, number, number, number];
  readonly speckle: readonly [number, number, number, number];
  readonly speckleDensity: number; // 0..1 probability per pixel
}

/**
 * Render one deterministic speckled-floor-style tile. `seed` should be a
 * stable per-variant integer (e.g. from `hashStringToSeed`) so the same
 * variant id always renders the same bytes.
 */
export function renderSpeckledSurface(seed: number, palette: SurfacePalette): RgbaImage {
  const size = TERRAIN_PACK_CELL_PX;
  const img = createImage(size, size);
  const [br, bg, bb, ba] = palette.base;
  fillRect(img, 0, 0, size, size, br, bg, bb, ba);
  const rng = new SeededRandom(seed);
  const [sr, sg, sb, sa] = palette.speckle;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (rng.next() < palette.speckleDensity) {
        setPixel(img, x, y, sr, sg, sb, sa);
      }
    }
  }
  return img;
}

export type DoorOrientation = 'horizontal' | 'vertical';

/**
 * Render one deterministic door tile: a jamb frame in the wall color, plus
 * (when closed) a solid slab spanning the orientation axis. `isOpen` doors
 * show only the frame with a clear passage through the middle.
 */
export function renderDoorTile(isOpen: boolean, orientation: DoorOrientation): RgbaImage {
  const size = TERRAIN_PACK_CELL_PX;
  const img = createImage(size, size);
  const jamb: [number, number, number, number] = [58, 56, 64, 255];
  const slab: [number, number, number, number] = [120, 84, 48, 255];
  const jambThickness = Math.round(size * 0.15);

  if (orientation === 'horizontal') {
    // Passage runs left-right; jambs are the top/bottom strips.
    fillRect(img, 0, 0, size, jambThickness, ...jamb);
    fillRect(img, 0, size - jambThickness, size, jambThickness, ...jamb);
    if (!isOpen) {
      fillRect(img, 0, jambThickness, size, size - 2 * jambThickness, ...slab);
    }
  } else {
    // Passage runs top-bottom; jambs are the left/right strips.
    fillRect(img, 0, 0, jambThickness, size, ...jamb);
    fillRect(img, size - jambThickness, 0, jambThickness, size, ...jamb);
    if (!isOpen) {
      fillRect(img, jambThickness, 0, size - 2 * jambThickness, size, ...slab);
    }
  }
  return img;
}
