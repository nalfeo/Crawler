/**
 * Deterministic procedural generators for the industrial-cave pack's
 * floor-pool and corridor-pool images. All original geometric art
 * (no external assets), driven entirely by `SeededRandom` — never
 * `Math.random()` — so a rebuild from the same inputs is byte-identical.
 */
import { SeededRandom } from '../../../src/shared/random.js';
import { TERRAIN_PACK_CELL_PX } from '../../../src/shared/terrain-pack-types.js';
import { createImage, setPixel, type RgbaImage } from './png-buffer.js';

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
 *
 * `gradientAxis`/`gradientStrength` (optional) overlay a linear luminance
 * gradient along the given axis on top of the speckle — used to deliberately
 * author a DIRECTIONALLY-UNSAFE placeholder variant (e.g. gravity-fed
 * grime pooling toward one edge) so the transform-eligibility deriver
 * (`scripts/sprites/terrain-packs/transform-eligibility.ts`) has a real,
 * non-synthetic case to restrict in the procedural placeholder pack, not
 * just in unit-test fixtures. Omit for a uniform (non-directional, safe to
 * flip on any axis) surface — the default for most variants.
 */
export function renderSpeckledSurface(
  seed: number,
  palette: SurfacePalette,
  gradient?: { readonly axis: 'vertical' | 'horizontal'; readonly strength: number },
): RgbaImage {
  const size = TERRAIN_PACK_CELL_PX;
  const img = createImage(size, size);
  const [br, bg, bb, ba] = palette.base;
  const [sr, sg, sb, sa] = palette.speckle;
  const rng = new SeededRandom(seed);

  // Decide, per pixel, base-vs-speckle FIRST (into a plain boolean grid) so
  // the optional gradient shading below is a single, uniform pass over every
  // pixel exactly once — no "was this already painted?" pixel-color sniffing
  // (which is unreliable once both layers can carry the same shade).
  const isSpeckle = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (rng.next() < palette.speckleDensity) {
        isSpeckle[y * size + x] = 1;
      }
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const speckle = isSpeckle[y * size + x] === 1;
      const [baseR, baseG, baseB, baseA] = speckle ? [sr, sg, sb, sa] : [br, bg, bb, ba];
      if (gradient) {
        const t = gradient.axis === 'vertical' ? y / (size - 1) : x / (size - 1);
        const shade = Math.round(gradient.strength * (t - 0.5) * 2);
        setPixel(
          img,
          x,
          y,
          clampByte(baseR + shade),
          clampByte(baseG + shade),
          clampByte(baseB + shade),
          baseA,
        );
      } else {
        setPixel(img, x, y, baseR, baseG, baseB, baseA);
      }
    }
  }
  return img;
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, v));
}
