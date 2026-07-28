/**
 * Pure image operations for composing generated MATERIAL art onto the tracked
 * blob47 wall silhouettes.
 *
 * Everything here is deterministic and dependency-free (beyond the shared
 * `png-buffer` helpers), so a fixed material cache always recomposes to the same
 * bytes. Nothing in this module talks to the network.
 *
 * The two operations that matter for correctness:
 *
 *  - {@link makeSeamless} guarantees the 64px material tiles edge-to-edge with
 *    itself. Because every wall cell samples the material at `(x % 64, y % 64)`
 *    in CELL-LOCAL space, and cells are exactly 64px, adjacent wall cells in the
 *    map are automatically texture-continuous.
 *  - {@link applyMaterial} takes the silhouette's ALPHA UNCHANGED. That is what
 *    preserves the authored pack's provable 100% edge-compatibility: the
 *    validator classifies an edge by mean luminance, and fully-transparent
 *    pixels are scored as "open" (255). Re-texturing only ever changes RGB
 *    inside the silhouette.
 */
import { createImage, nearestNeighborResize, setPixel, type RgbaImage } from '../png-buffer.js';
import { SeededRandom } from '../../../../src/shared/random.js';
import { WALL_OPACITY_THRESHOLD, isWallAlpha } from '../wall-opacity.js';

function pixelAt(img: RgbaImage, x: number, y: number): [number, number, number, number] {
  const idx = (y * img.width + x) * 4;
  return [img.data[idx]!, img.data[idx + 1]!, img.data[idx + 2]!, img.data[idx + 3]!];
}

/**
 * Area-average ("box") downsample. Required because materials arrive at
 * 1024×1024 and land at 64×64 — a 16× reduction where nearest-neighbor would
 * alias into noise instead of reading as rock.
 */
export function boxDownsample(src: RgbaImage, destWidth: number, destHeight: number): RgbaImage {
  const out = createImage(destWidth, destHeight);
  for (let dy = 0; dy < destHeight; dy++) {
    const y0 = Math.floor((dy * src.height) / destHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((dy + 1) * src.height) / destHeight));
    for (let dx = 0; dx < destWidth; dx++) {
      const x0 = Math.floor((dx * src.width) / destWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((dx + 1) * src.width) / destWidth));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const [pr, pg, pb, pa] = pixelAt(src, x, y);
          r += pr;
          g += pg;
          b += pb;
          a += pa;
          n += 1;
        }
      }
      setPixel(
        out,
        dx,
        dy,
        Math.round(r / n),
        Math.round(g / n),
        Math.round(b / n),
        Math.round(a / n),
      );
    }
  }
  return out;
}

/**
 * Make an image seamlessly tileable via offset cross-fade.
 *
 * Blends the four half-period-shifted copies of the source with triangular
 * weights that fall to zero at the tile borders. At x=0 the result samples the
 * source's INTERIOR (x=W/2), and at x=W-1 it samples x=W/2-1 — adjacent source
 * pixels — so wrapping is continuous by construction, for any input.
 */
export function makeSeamless(src: RgbaImage): RgbaImage {
  const { width: w, height: h } = src;
  const halfW = Math.floor(w / 2);
  const halfH = Math.floor(h / 2);
  const out = createImage(w, h);
  for (let y = 0; y < h; y++) {
    // Triangular weight: 0 at the border, 1 at the half-period.
    const wy = 1 - Math.abs((2 * y) / h - 1);
    for (let x = 0; x < w; x++) {
      const wx = 1 - Math.abs((2 * x) / w - 1);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [sx, gx] of [
        [0, wx],
        [halfW, 1 - wx],
      ] as const) {
        for (const [sy, gy] of [
          [0, wy],
          [halfH, 1 - wy],
        ] as const) {
          const weight = gx * gy;
          if (weight === 0) continue;
          const [pr, pg, pb, pa] = pixelAt(src, (x + sx) % w, (y + sy) % h);
          r += pr * weight;
          g += pg * weight;
          b += pb * weight;
          a += pa * weight;
        }
      }
      setPixel(out, x, y, Math.round(r), Math.round(g), Math.round(b), Math.round(a));
    }
  }
  return out;
}

/** Clamp a channel into 0..255. */
function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * Posterize each RGB channel to `levels` steps. Pulls generated photo-ish
 * gradients toward the flat, banded look of the rest of the game's tile art.
 */
export function posterize(src: RgbaImage, levels: number): RgbaImage {
  if (levels < 2) throw new Error(`posterize levels must be >= 2, got ${levels}`);
  const out = createImage(src.width, src.height);
  const step = 255 / (levels - 1);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const [r, g, b, a] = pixelAt(src, x, y);
      setPixel(
        out,
        x,
        y,
        clamp8(Math.round(r / step) * step),
        clamp8(Math.round(g / step) * step),
        clamp8(Math.round(b / step) * step),
        a,
      );
    }
  }
  return out;
}

/**
 * Scale luminance toward a target mean and cap the maximum.
 *
 * The authored-pack edge validator scores transparent pixels as luminance 255
 * ("open"), so wall material must stay clearly dark or an edge band can
 * misclassify. This makes that requirement explicit and enforceable instead of
 * hoping the generator returned something dark.
 */
export function normalizeLuminance(
  src: RgbaImage,
  targetMean: number,
  maxLuminance: number,
): RgbaImage {
  const current = meanOpaqueLuminance(src);
  const scale = current <= 0 ? 1 : targetMean / current;
  const out = createImage(src.width, src.height);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const [r, g, b, a] = pixelAt(src, x, y);
      let nr = r * scale;
      let ng = g * scale;
      let nb = b * scale;
      const lum = 0.299 * nr + 0.587 * ng + 0.114 * nb;
      if (lum > maxLuminance) {
        const capScale = maxLuminance / lum;
        nr *= capScale;
        ng *= capScale;
        nb *= capScale;
      }
      setPixel(out, x, y, clamp8(nr), clamp8(ng), clamp8(nb), a);
    }
  }
  return out;
}

/** Population standard deviation of luminance over OPAQUE pixels only. */
export function stdDevOpaqueLuminance(img: RgbaImage): number {
  const mean = meanOpaqueLuminance(img);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3]! === 0) continue;
    const lum = 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
    sum += (lum - mean) ** 2;
    count += 1;
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

/**
 * Rescale luminance spread about the mean until it hits `targetStdDev`.
 *
 * `makeSeamless` averages four offset copies, which roughly halves contrast, and
 * the wall luminance cap compresses what is left. Without this restoration step
 * a posterize pass snaps the whole tile into one or two bands and the material
 * renders as flat colour. Channels are scaled by a single per-pixel factor so
 * hue is preserved.
 */
export function normalizeContrast(
  src: RgbaImage,
  targetStdDev: number,
  maxLuminance: number,
): RgbaImage {
  const mean = meanOpaqueLuminance(src);
  const sd = stdDevOpaqueLuminance(src);
  const scale = sd <= 0.5 ? 1 : targetStdDev / sd;
  const out = createImage(src.width, src.height);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const [r, g, b, a] = pixelAt(src, x, y);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (a === 0 || lum <= 0) {
        setPixel(out, x, y, r, g, b, a);
        continue;
      }
      const target = Math.min(maxLuminance, Math.max(1, mean + (lum - mean) * scale));
      const factor = target / lum;
      setPixel(out, x, y, clamp8(r * factor), clamp8(g * factor), clamp8(b * factor), a);
    }
  }
  return out;
}

/** Mean luminance over OPAQUE pixels only (transparent pixels are not material). */
export function meanOpaqueLuminance(img: RgbaImage): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3]! === 0) continue;
    sum += 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

/** Max luminance over OPAQUE pixels only. */
export function maxOpaqueLuminance(img: RgbaImage): number {
  let max = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3]! === 0) continue;
    const lum = 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
    if (lum > max) max = lum;
  }
  return max;
}

/**
 * Re-texture a silhouette with a tiling material.
 *
 * The material is sampled in CELL-LOCAL coordinates modulo the material size, so
 * every cell of the atlas paints the same 64px texture and neighbouring wall
 * cells in the map stay continuous. Alpha is copied from the silhouette
 * verbatim — see the module doc for why that is load-bearing.
 */
export function applyMaterial(silhouette: RgbaImage, material: RgbaImage): RgbaImage {
  const out = createImage(silhouette.width, silhouette.height);
  for (let y = 0; y < silhouette.height; y++) {
    for (let x = 0; x < silhouette.width; x++) {
      const alpha = silhouette.data[(y * silhouette.width + x) * 4 + 3]!;
      if (alpha === 0) continue; // leave fully transparent — preserves edge classification
      const [r, g, b] = pixelAt(material, x % material.width, y % material.height);
      setPixel(out, x, y, r, g, b, alpha);
    }
  }
  return out;
}

/**
 * Darken the material a fixed distance inward from any silhouette boundary and
 * add a lighter lip along the top boundary, so re-textured walls read as solid
 * volumes rather than flat stamps.
 *
 * Only pixels that are already opaque are touched, so the alpha silhouette — and
 * therefore edge compatibility — is untouched.
 */
export function applyRimShading(
  img: RgbaImage,
  options: { readonly rimPx: number; readonly rimDarken: number; readonly topLift: number },
): RgbaImage {
  const { width: w, height: h } = img;
  const out = createImage(w, h);
  out.data.set(img.data);
  const isOpaque = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && img.data[(y * w + x) * 4 + 3]! !== 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isOpaque(x, y)) continue;
      // Chebyshev distance to the nearest non-opaque pixel (or outside the cell).
      let dist = options.rimPx + 1;
      for (let d = 1; d <= options.rimPx; d++) {
        let boundary = false;
        for (let oy = -d; oy <= d && !boundary; oy++) {
          for (let ox = -d; ox <= d && !boundary; ox++) {
            if (Math.max(Math.abs(ox), Math.abs(oy)) !== d) continue;
            if (!isOpaque(x + ox, y + oy)) boundary = true;
          }
        }
        if (boundary) {
          dist = d;
          break;
        }
      }
      if (dist > options.rimPx) continue;
      const t = 1 - (dist - 1) / options.rimPx;
      const [r, g, b, a] = pixelAt(img, x, y);
      // A boundary directly above means this is a top lip — lift it instead.
      const lift = !isOpaque(x, y - 1) ? options.topLift : 0;
      const factor = 1 - options.rimDarken * t + lift * t;
      setPixel(out, x, y, clamp8(r * factor), clamp8(g * factor), clamp8(b * factor), a);
    }
  }
  return out;
}

/**
 * Full material pipeline: raw generated PNG → seamless, posterized, luminance-
 * normalized 64×64 tile.
 */
export interface MaterialTileOptions {
  readonly sizePx: number;
  readonly posterizeLevels: number;
  readonly targetMeanLuminance: number;
  readonly maxLuminance: number;
  /** Luminance spread to restore after seamless blending flattens the tile. */
  readonly targetStdDev: number;
  /**
   * Skip the seamless mirror-blend.
   *
   * WHY THIS EXISTS. `makeSeamless` mirror-blends a tile against itself so its
   * own edges match. That is required for a tile that ships as a standalone
   * repeating surface, but it is actively destructive on a window cut from a
   * larger material: a sub-window is not a period of the texture, so the blend
   * folds real structure back on itself and the result reads as a kaleidoscope —
   * visibly symmetric cracks. Callers that discard the window's edges anyway
   * (pool variants, whose borders are restored from the shared base) get the
   * generated structure intact by setting this.
   */
  readonly skipSeamless?: boolean;
}

export interface PixelArtMaterialStyle {
  readonly targetMeanLuminance: number;
  readonly maxLuminance: number;
  readonly targetStdDev: number;
  /** Fixed luminance increment used to eliminate photo-like micro-gradients. */
  readonly valueStep: number;
  /** Maximum RGB channel spread after chroma compression. */
  readonly maxChroma: number;
}

/**
 * Constrain a material to a subdued, stepped pixel-art value range while
 * preserving its large-scale motif and alpha. This is intentionally applied
 * after seamless composition: it removes realistic micro-gradients and
 * saturated tile-wide color without blurring or changing geometry.
 */
export function restylePixelArtMaterial(src: RgbaImage, style: PixelArtMaterialStyle): RgbaImage {
  for (const key of [
    'targetMeanLuminance',
    'maxLuminance',
    'targetStdDev',
    'valueStep',
    'maxChroma',
  ] as const) {
    if (!Number.isFinite(style[key]) || style[key] <= 0) {
      throw new Error(
        `restylePixelArtMaterial: option "${key}" must be a positive finite number, got ${style[key]}`,
      );
    }
  }

  const ranged = normalizeLuminance(src, style.targetMeanLuminance, style.maxLuminance);
  const contrasted = normalizeContrast(ranged, style.targetStdDev, style.maxLuminance);
  const out = createImage(src.width, src.height);
  for (let y = 0; y < contrasted.height; y++) {
    for (let x = 0; x < contrasted.width; x++) {
      const [r, g, b, a] = pixelAt(contrasted, x, y);
      if (a === 0) continue;
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      const quantizedLuminance = Math.min(
        style.maxLuminance,
        Math.max(style.valueStep, Math.round(luminance / style.valueStep) * style.valueStep),
      );
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const chromaScale = chroma > style.maxChroma ? style.maxChroma / chroma : 1;
      const quantizeChannel = (channel: number): number => {
        const offset = Math.round(((channel - luminance) * chromaScale) / 4) * 4;
        return clamp8(quantizedLuminance + offset);
      };
      setPixel(out, x, y, quantizeChannel(r), quantizeChannel(g), quantizeChannel(b), a);
    }
  }
  return out;
}

export interface PixelArtGroundStyle {
  /**
   * Radius of a WRAPPED high-pass, in px. The tile's own low-frequency content
   * (large blobs, the corridor's rivet grid) is subtracted, leaving fine grain
   * around a flat mean.
   *
   * This exists because stepping up contrast to reach a pixel-art look also
   * amplifies the base's LARGE shapes, and large recognizable shapes are what
   * make a 64px tile read as a repeating grid — fine grain does not. High-passing
   * first lets the value-snap bite on texture without turning the motif into
   * visible wallpaper.
   *
   * Omit or set 0 to skip.
   */
  readonly flattenRadius?: number;
  /**
   * Radius of a WRAPPED box blur applied after the high-pass, in px.
   *
   * Quantizing raw per-pixel noise just produces stepped noise — the grain gets
   * chunkier but stays undifferentiated speckle. Low-passing first collapses the
   * photographic micro-detail into broad shapes, so the value-snap then yields
   * large flat regions with hard boundaries (cel-shaded stone) instead. Sampling
   * wraps modulo the tile so seamlessness survives.
   *
   * Omit or set 0 to skip.
   */
  readonly smoothRadius?: number;
  /**
   * Grain block size in px. Every aligned `blockPx x blockPx` block is flattened
   * to its own average, so the smallest feature the texture can express is
   * `blockPx` wide. This is the single most important knob: 1px continuous noise
   * reads as a downsampled photograph, whereas a 2px minimum feature size reads
   * as deliberately placed pixel clusters.
   */
  readonly blockPx: number;
  /**
   * Luminance increment the result is snapped to. Collapses the tile onto a
   * small, explicit value ramp instead of a continuous gradient.
   */
  readonly valueStep: number;
  /**
   * Absolute luminance stddev to hit BEFORE snapping. Block-averaging removes
   * variance, so without this the stepped result would flatten toward a single
   * level and lose the texture entirely.
   *
   * Omit it when restyling art whose contrast is already deliberate (a composed
   * detail variant), where renormalizing would fight the injected amplitude.
   */
  readonly targetStdDev?: number;
  /** Maximum RGB channel spread; keeps ground from out-saturating props. */
  readonly maxChroma: number;
}

/**
 * Box blur that samples with WRAP-AROUND addressing.
 *
 * Wrapping is not cosmetic: these tiles must stay seamless, and a clamped or
 * zero-padded blur biases the outer rows/columns toward their own side, which
 * silently breaks the edge continuity the whole pack depends on.
 */
function wrappedBoxBlur(src: RgbaImage, radius: number): RgbaImage {
  const out = createImage(src.width, src.height);
  const span = radius * 2 + 1;
  const denom = span * span;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = (((y + dy) % src.height) + src.height) % src.height;
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = (((x + dx) % src.width) + src.width) % src.width;
          const px = pixelAt(src, sx, sy);
          r += px[0];
          g += px[1];
          b += px[2];
        }
      }
      const a = pixelAt(src, x, y)[3];
      setPixel(out, x, y, Math.round(r / denom), Math.round(g / denom), Math.round(b / denom), a);
    }
  }
  return out;
}

/**
 * Subtract a wrapped low-pass from the image, re-centred on the tile's own mean
 * per channel. Keeps fine texture, discards large-scale shape.
 */
function wrappedHighPass(src: RgbaImage, radius: number): RgbaImage {
  const low = wrappedBoxBlur(src, radius);
  const mean = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < src.data.length; i += 4) {
    if (src.data[i + 3]! === 0) continue;
    mean[0]! += src.data[i]!;
    mean[1]! += src.data[i + 1]!;
    mean[2]! += src.data[i + 2]!;
    n++;
  }
  if (n === 0) return src;
  const out = createImage(src.width, src.height);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const [r, g, b, a] = pixelAt(src, x, y);
      if (a === 0) continue;
      const [lr, lg, lb] = pixelAt(low, x, y);
      setPixel(
        out,
        x,
        y,
        clamp8(r - lr + mean[0]! / n),
        clamp8(g - lg + mean[1]! / n),
        clamp8(b - lb + mean[2]! / n),
        a,
      );
    }
  }
  return out;
}

/**
 * True when every aligned `blockPx` block is already flat.
 *
 * This is {@link toPixelArtGround}'s canonical form and therefore its
 * idempotency test. The transform is applied to the pack's canonical base tiles
 * IN PLACE, so it must be a genuine fixed point — otherwise re-running the
 * rebuild script would compound contrast normalization and slowly destroy the
 * art (which has already happened once on this pack, see the header of
 * `rebuild-shared-base-pools.ts`). Block-flatness is destroyed by every step of
 * the transform and restored by exactly one, so it is a sound witness.
 */
export function isPixelArtGround(src: RgbaImage, blockPx: number): boolean {
  if (!Number.isInteger(blockPx) || blockPx < 1) {
    throw new Error(`isPixelArtGround: blockPx must be a positive integer, got ${blockPx}`);
  }
  if (blockPx === 1) return true;
  for (let by = 0; by < src.height; by += blockPx) {
    for (let bx = 0; bx < src.width; bx += blockPx) {
      const [r0, g0, b0] = pixelAt(src, bx, by);
      for (let y = by; y < Math.min(by + blockPx, src.height); y++) {
        for (let x = bx; x < Math.min(bx + blockPx, src.width); x++) {
          const [r, g, b] = pixelAt(src, x, y);
          if (r !== r0 || g !== g0 || b !== b0) return false;
        }
      }
    }
  }
  return true;
}

/**
 * Restyle a continuous-tone ground tile into stepped, chunky pixel art.
 *
 * Motivation: the shipped Floor 2 base tiles were smooth per-pixel noise —
 * measured 232-640 unique colors over 4096px across 28-78 luminance levels,
 * with a mean adjacent-pixel luminance delta of ~2. That is the numeric
 * signature of a downsampled photograph, and next to Crawler's characters and
 * props (chunky hard-stepped clusters) the ground read as a different medium.
 *
 * Order matters and is not arbitrary:
 *   1. block-average  — establishes the minimum feature size
 *   2. normalizeContrast — restores the variance step 1 removed, to an
 *      ABSOLUTE target so the operation cannot compound across runs
 *   3. value-snap     — collapses onto the explicit ramp
 *
 * Steps 2 and 3 are pointwise, so a seamless input stays seamless, and step 1's
 * blocks are aligned to the tile origin and never straddle the tile boundary.
 *
 * Alpha is copied verbatim, so this is safe on silhouetted art.
 */
export function toPixelArtGround(src: RgbaImage, style: PixelArtGroundStyle): RgbaImage {
  for (const key of ['blockPx', 'valueStep', 'maxChroma'] as const) {
    if (!Number.isFinite(style[key]) || style[key] <= 0) {
      throw new Error(
        `toPixelArtGround: option "${key}" must be a positive finite number, got ${style[key]}`,
      );
    }
  }
  if (
    style.targetStdDev !== undefined &&
    (!Number.isFinite(style.targetStdDev) || style.targetStdDev <= 0)
  ) {
    throw new Error(
      `toPixelArtGround: option "targetStdDev" must be a positive finite number when provided, got ${style.targetStdDev}`,
    );
  }
  if (!Number.isInteger(style.blockPx)) {
    throw new Error(`toPixelArtGround: blockPx must be an integer, got ${style.blockPx}`);
  }
  if (src.width % style.blockPx !== 0 || src.height % style.blockPx !== 0) {
    throw new Error(
      `toPixelArtGround: blockPx ${style.blockPx} must divide the tile evenly ` +
        `(got ${src.width}x${src.height}); a block straddling the tile edge would break seamlessness`,
    );
  }
  // Already canonical — return the input untouched so repeated rebuilds are a
  // true fixed point rather than a compounding contrast stretch.
  if (isPixelArtGround(src, style.blockPx)) return src;

  const radius = style.smoothRadius ?? 0;
  if (!Number.isInteger(radius) || radius < 0) {
    throw new Error(
      `toPixelArtGround: smoothRadius must be a non-negative integer, got ${style.smoothRadius}`,
    );
  }
  const flatten = style.flattenRadius ?? 0;
  if (!Number.isInteger(flatten) || flatten < 0) {
    throw new Error(
      `toPixelArtGround: flattenRadius must be a non-negative integer, got ${style.flattenRadius}`,
    );
  }
  const flattened = flatten === 0 ? src : wrappedHighPass(src, flatten);
  const smoothed = radius === 0 ? flattened : wrappedBoxBlur(flattened, radius);

  const blocked = createImage(src.width, src.height);
  for (let by = 0; by < src.height; by += style.blockPx) {
    for (let bx = 0; bx < src.width; bx += style.blockPx) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      // RGB is averaged over OPAQUE pixels only, alpha over all of them. On a
      // fully-opaque ground tile these are the same set, so this is a no-op
      // there. On SILHOUETTED art (the wall atlas) a block straddling the
      // silhouette edge would otherwise average the transparent pixels' RGB —
      // usually (0,0,0) — into the result, dragging every edge block toward
      // black and shifting the luminance the pack's edge-compatibility
      // classifier reads.
      let or_ = 0;
      let og = 0;
      let ob = 0;
      let on = 0;
      for (let y = by; y < Math.min(by + style.blockPx, src.height); y++) {
        for (let x = bx; x < Math.min(bx + style.blockPx, src.width); x++) {
          const px = pixelAt(smoothed, x, y);
          r += px[0];
          g += px[1];
          b += px[2];
          a += px[3];
          n++;
          if (isWallAlpha(px[3])) {
            or_ += px[0];
            og += px[1];
            ob += px[2];
            on++;
          }
        }
      }
      const ar = on > 0 ? Math.round(or_ / on) : Math.round(r / n);
      const ag = on > 0 ? Math.round(og / on) : Math.round(g / n);
      const ab = on > 0 ? Math.round(ob / on) : Math.round(b / n);
      // Alpha is thresholded rather than averaged: ground tiles are opaque, and
      // a partially-transparent block on silhouetted art would soften an edge
      // the pack validator reads as authored geometry.
      const aa = a / n >= WALL_OPACITY_THRESHOLD ? 255 : 0;
      for (let y = by; y < Math.min(by + style.blockPx, src.height); y++) {
        for (let x = bx; x < Math.min(bx + style.blockPx, src.width); x++) {
          setPixel(blocked, x, y, ar, ag, ab, aa);
        }
      }
    }
  }

  const contrasted =
    style.targetStdDev === undefined
      ? blocked
      : normalizeContrast(blocked, style.targetStdDev, 255);

  const out = createImage(src.width, src.height);
  for (let y = 0; y < contrasted.height; y++) {
    for (let x = 0; x < contrasted.width; x++) {
      const [r, g, b, a] = pixelAt(contrasted, x, y);
      if (a === 0) continue;
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      const snapped = Math.max(
        style.valueStep,
        Math.round(luminance / style.valueStep) * style.valueStep,
      );
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const chromaScale = chroma > style.maxChroma ? style.maxChroma / chroma : 1;
      const channel = (c: number): number => clamp8(snapped + (c - luminance) * chromaScale);
      setPixel(out, x, y, channel(r), channel(g), channel(b), a);
    }
  }
  return out;
}

export interface DetailVariantOptions {
  /**
   * Untouched border width, in px, on all four sides. Detail is never written
   * inside this margin, so every variant built from the same base has
   * BYTE-IDENTICAL border pixels — which makes cross-variant seams exactly as
   * good as the base tiling against itself, by construction rather than by
   * measurement. This is the load-bearing property of the whole approach.
   */
  readonly borderMarginPx: number;
  /** Deterministic seed for the detail patch's shape and placement. */
  readonly seed: number;
  /** Target fraction of the FULL tile area the detail should cover (0..1). */
  readonly coverage: number;
  /**
   * How strongly the detail source's structure is injected over the base
   * (0..1). Only the detail's deviation from its own mean is applied, so the
   * base's mean luminance and palette survive untouched at any strength.
   */
  readonly strength: number;
  /** Mask quantization steps — keeps the blend edge stepped, not photographic. */
  readonly maskSteps: number;
}

/**
 * Smooth 0..1 ramp used to feather a blob's edge before quantization.
 *
 * Supports DESCENDING ranges (`edge1 < edge0`) — the sign of the divisor flips
 * naturally, so `smoothstep(hi, lo, x)` is a falling ramp. Only an exactly
 * degenerate range short-circuits; special-casing `edge1 <= edge0` instead
 * would silently return 0 across every descending ramp.
 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

interface Blob {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

/**
 * Build the per-pixel detail mask for `buildDetailVariant`.
 *
 * Blob centers/radii are drawn from `seed`; the radius scale is then fitted by
 * bisection so the realized coverage lands on `coverage`. Fitting (rather than
 * trusting the raw draw) is what lets a committed-art test assert a coverage
 * band without the generator being flaky across seeds.
 */
function buildDetailMask(
  width: number,
  height: number,
  options: DetailVariantOptions,
): Float32Array {
  const { borderMarginPx, seed, coverage, maskSteps } = options;
  const rng = new SeededRandom(seed);
  const minX = borderMarginPx;
  const minY = borderMarginPx;
  const spanX = width - borderMarginPx * 2;
  const spanY = height - borderMarginPx * 2;
  const blobCount = rng.nextInt(2, 4);
  const baseRadius = Math.min(spanX, spanY) / 2;
  const blobs: Blob[] = [];
  for (let i = 0; i < blobCount; i++) {
    blobs.push({
      cx: minX + rng.next() * spanX,
      cy: minY + rng.next() * spanY,
      r: baseRadius * (0.35 + rng.next() * 0.45),
    });
  }

  const mask = new Float32Array(width * height);
  const paint = (scale: number): number => {
    mask.fill(0);
    let covered = 0;
    for (let y = minY; y < height - borderMarginPx; y++) {
      for (let x = minX; x < width - borderMarginPx; x++) {
        let m = 0;
        for (const blob of blobs) {
          const r = blob.r * scale;
          if (r <= 0) continue;
          const d = Math.hypot(x + 0.5 - blob.cx, y + 0.5 - blob.cy);
          // Feather the outer 35% of the radius, then step-quantize so the
          // falloff reads as pixel-art banding rather than a soft airbrush.
          const raw = 1 - smoothstep(r * 0.65, r, d);
          if (raw > m) m = raw;
        }
        // Fade the mask out as it approaches the margin so a blob clipped by
        // the interior rect doesn't leave a hard straight cut.
        const edgeFade = Math.min(
          smoothstep(minX - 1, minX + 3, x),
          smoothstep(minY - 1, minY + 3, y),
          smoothstep(width - borderMarginPx, width - borderMarginPx - 4, x),
          smoothstep(height - borderMarginPx, height - borderMarginPx - 4, y),
        );
        m *= edgeFade;
        const stepped = Math.round(m * maskSteps) / maskSteps;
        mask[y * width + x] = stepped;
        if (stepped > 0) covered++;
      }
    }
    return covered / (width * height);
  };

  let lo = 0;
  let hi = 2;
  let realized = paint(1);
  if (Math.abs(realized - coverage) > 0.01) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      realized = paint(mid);
      if (realized > coverage) hi = mid;
      else lo = mid;
      if (Math.abs(realized - coverage) <= 0.005) break;
    }
  }
  return mask;
}

/**
 * Fraction of `coverage` the fitted mask must actually realize.
 *
 * A mask that fits to ~0 makes `buildDetailVariant` emit a byte-identical copy
 * of the base: every structural validator, seam check and luminance guard still
 * passes green because a perfect copy of a valid tile is itself valid. That is
 * exactly how a reversed-ramp bug in `smoothstep` shipped 14 duplicate tiles.
 * Failing loudly here is the only cheap place to catch it.
 */
const MIN_REALIZED_COVERAGE_RATIO = 0.5;

/** Deterministic detail structures used as `buildDetailVariant` sources. */
export const DETAIL_STRUCTURE_KINDS = ['mottle', 'cracks', 'gravel', 'pitting', 'scoring'] as const;

export type DetailStructureKind = (typeof DETAIL_STRUCTURE_KINDS)[number];

/**
 * Draw a deterministic grayscale structure for `buildDetailVariant` to borrow.
 *
 * These replace the Azure-generated materials that previously seeded pool
 * details. Under the shared-base design only the source's *deviation from its
 * own mean luminance* is ever read — colour, palette and absolute brightness
 * are all discarded — so a photoreal material was doing almost no work that a
 * few hundred deterministic pixels cannot do better.
 *
 * Advantages that matter here:
 * - Reproducible from source forever. The Azure PNGs were untracked binaries
 *   with a gitignored cache; when they were lost they were simply gone.
 * - Hard-edged and integer-valued, so the structure reads as pixel art rather
 *   than as a downsampled photograph.
 *
 * The canvas is mid-gray (128) so the structure's mean lands near 128 and
 * deviation is roughly symmetric about zero — detail darkens and lightens the
 * base in equal measure instead of dragging its overall brightness.
 *
 * Tileability is deliberately NOT a requirement: `buildDetailVariant` confines
 * every detail inside `borderMarginPx`, so no structure pixel ever reaches a
 * tile edge.
 */
export function buildDetailStructure(
  width: number,
  height: number,
  kind: DetailStructureKind,
  seed: number,
): RgbaImage {
  if (!Number.isFinite(seed)) {
    throw new Error(`buildDetailStructure: seed must be finite, got ${seed}`);
  }
  const img = createImage(width, height);
  const rng = new SeededRandom(seed);
  const MID = 128;
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = MID;
    img.data[i + 1] = MID;
    img.data[i + 2] = MID;
    img.data[i + 3] = 255;
  }

  const plot = (x: number, y: number, v: number): void => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    setPixel(img, px, py, v, v, v, 255);
  };
  const disc = (cx: number, cy: number, r: number, v: number): void => {
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        if (dx * dx + dy * dy <= r * r) plot(cx + dx, cy + dy, v);
      }
    }
  };

  switch (kind) {
    case 'mottle': {
      // Broad, low-amplitude tonal blotches for the QUIET pool slot.
      //
      // Every other structure here is sparse-and-loud: a handful of small,
      // high-contrast features. Scaled down for a quiet variant they don't get
      // subtler, they just get RARER — gravel at 0.6 strength changed ~30 of
      // 4096 pixels, i.e. the quiet variant was a byte-copy of the base in all
      // but name while carrying a third of the pool weight. Mottle inverts
      // that: it covers the whole cell at a small amplitude, so at low strength
      // it reads as gentle unevenness in the ground rather than as a feature,
      // and it actually differs from the base everywhere.
      const blobs = rng.nextInt(7, 11);
      const centers: { x: number; y: number; r: number; amp: number }[] = [];
      for (let i = 0; i < blobs; i++) {
        centers.push({
          x: rng.nextInt(0, width - 1),
          y: rng.nextInt(0, height - 1),
          r: rng.nextInt(9, 18),
          amp: (rng.next() < 0.5 ? -1 : 1) * rng.nextInt(14, 26),
        });
      }
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let sum = 0;
          for (const c of centers) {
            const dx = x - c.x;
            const dy = y - c.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d >= c.r) continue;
            // Cosine falloff: no hard blob rim, so the result reads as tone.
            sum += c.amp * 0.5 * (1 + Math.cos((d / c.r) * Math.PI));
          }
          // Quantize so the gradient steps like pixel art instead of airbrush.
          plot(x, y, MID + Math.round(sum / 6) * 6);
        }
      }
      break;
    }
    case 'cracks': {
      // Fissures radiating from ONE origin. Two independently-placed strands
      // routinely crossed into an X (reads as a scratch, not as fractured
      // ground) and could both miss the detail mask entirely, yielding a base
      // copy. A shared origin near the cell centre cannot self-cross and is
      // reliably inside whatever blob the mask fits.
      const walk = (x0: number, y0: number, angle0: number, len: number, depth: number): void => {
        let x = x0;
        let y = y0;
        let angle = angle0;
        for (let i = 0; i < len; i++) {
          // Low drift keeps fissures reading as fractures. Higher jitter makes
          // them curl into scratchy specks that read as dirt, not geology.
          angle += (rng.next() - 0.5) * 0.18;
          x += Math.cos(angle);
          y += Math.sin(angle);
          plot(x, y, 40);
          // A subtle 1px lighter lip on one side reads as depth at pixel scale.
          // Keep it dim: a bright lip turns the fissure into a scratch/hair.
          plot(x + Math.cos(angle + Math.PI / 2), y + Math.sin(angle + Math.PI / 2), 148);
          if (depth > 0 && rng.next() < 0.04) {
            walk(
              x,
              y,
              angle + (rng.next() < 0.5 ? 1 : -1) * 0.8,
              Math.floor(len * 0.45),
              depth - 1,
            );
          }
        }
      };
      const ox = width / 2 + (rng.next() - 0.5) * width * 0.25;
      const oy = height / 2 + (rng.next() - 0.5) * height * 0.25;
      const branches = rng.nextInt(3, 4);
      const spread = (Math.PI * 2) / branches;
      const base0 = rng.next() * Math.PI * 2;
      for (let b = 0; b < branches; b++) {
        walk(
          ox,
          oy,
          base0 + b * spread + (rng.next() - 0.5) * spread * 0.4,
          rng.nextInt(22, 34),
          2,
        );
      }
      break;
    }
    case 'gravel': {
      // Loose chips: small discs with a darker shadow pixel below-right.
      const count = rng.nextInt(26, 40);
      for (let i = 0; i < count; i++) {
        const cx = rng.nextInt(0, width - 1);
        const cy = rng.nextInt(0, height - 1);
        const r = rng.next() < 0.6 ? 1 : 2;
        disc(cx, cy, r, rng.next() < 0.5 ? 96 : 168);
        plot(cx + r, cy + r, 70);
      }
      break;
    }
    case 'pitting': {
      // Shallow bowls: dark core, bright rim on the light-facing side.
      const count = rng.nextInt(10, 16);
      for (let i = 0; i < count; i++) {
        const cx = rng.nextInt(0, width - 1);
        const cy = rng.nextInt(0, height - 1);
        const r = rng.nextInt(2, 4);
        disc(cx, cy, r, 82);
        for (let a = 0; a < 32; a++) {
          const t = (a / 32) * Math.PI * 2;
          // Upper-left arc only.
          if (Math.cos(t) > 0.2 || Math.sin(t) > 0.2) continue;
          plot(cx + Math.cos(t) * (r + 1), cy + Math.sin(t) * (r + 1), 178);
        }
      }
      break;
    }
    case 'scoring': {
      // Parallel machine gouges, jittered in length and spacing.
      const angle = rng.next() * Math.PI;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const lines = rng.nextInt(5, 8);
      for (let i = 0; i < lines; i++) {
        const cx = rng.nextInt(0, width - 1);
        const cy = rng.nextInt(0, height - 1);
        const len = rng.nextInt(10, 26);
        for (let t = -len / 2; t <= len / 2; t++) {
          plot(cx + dx * t, cy + dy * t, 84);
          plot(cx + dx * t - dy, cy + dy * t + dx, 170);
        }
      }
      break;
    }
  }

  return img;
}

/**
 * Compose one pool variant as `base` plus a sparse interior detail borrowed
 * from `detailSource`.
 *
 * Replaces the "8 independently generated seamless materials" approach that
 * shipped 2026-07-25 and read as a patchwork quilt: those tiles were seamless
 * against themselves but ~3x worse against each other (measured cross-seam
 * 17.3 vs 5.3 self-seam on floors), and stylistically foreign to the base
 * (23-61 colors at sd ~10 vs the base's 232 colors at sd 3.5).
 *
 * Here, cohesion is structural:
 * - Border pixels are never written, so all variants share the base's edges.
 * - Only the detail's DEVIATION FROM ITS OWN MEAN is applied, so the base's
 *   mean luminance, palette and chroma survive; the detail contributes
 *   structure only, never color or brightness.
 * - Alpha always comes from the base.
 */
export function buildDetailVariant(
  base: RgbaImage,
  detailSource: RgbaImage,
  options: DetailVariantOptions,
): RgbaImage {
  for (const key of ['borderMarginPx', 'seed', 'coverage', 'strength', 'maskSteps'] as const) {
    if (!Number.isFinite(options[key])) {
      throw new Error(
        `buildDetailVariant: option "${key}" must be a finite number, got ${options[key]}`,
      );
    }
  }
  if (options.coverage <= 0 || options.coverage >= 1) {
    throw new Error(`buildDetailVariant: coverage must be in (0,1), got ${options.coverage}`);
  }
  if (options.borderMarginPx * 2 >= Math.min(base.width, base.height)) {
    throw new Error(
      `buildDetailVariant: borderMarginPx ${options.borderMarginPx} leaves no interior on a ${base.width}x${base.height} tile`,
    );
  }
  if (options.maskSteps < 1) {
    throw new Error(`buildDetailVariant: maskSteps must be >= 1, got ${options.maskSteps}`);
  }

  const detailMean = meanOpaqueLuminance(detailSource);
  const mask = buildDetailMask(base.width, base.height, options);

  let maskSum = 0;
  for (const m of mask) maskSum += m;
  const realizedCoverage = maskSum / mask.length;
  if (realizedCoverage < options.coverage * MIN_REALIZED_COVERAGE_RATIO) {
    throw new Error(
      `buildDetailVariant: mask fitted to ${realizedCoverage.toFixed(4)} coverage, ` +
        `below ${(options.coverage * MIN_REALIZED_COVERAGE_RATIO).toFixed(4)} ` +
        `(target ${options.coverage}). The variant would be a copy of the base.`,
    );
  }

  const out = createImage(base.width, base.height);
  out.data.set(base.data);

  let changed = 0;
  for (let y = 0; y < base.height; y++) {
    for (let x = 0; x < base.width; x++) {
      const m = mask[y * base.width + x]!;
      if (m <= 0) continue;
      const [br, bg, bb, ba] = pixelAt(base, x, y);
      if (ba === 0) continue;
      // Sample the detail source with wraparound so a detail smaller than the
      // tile still supplies structure everywhere the mask reaches.
      const [dr, dg, db] = pixelAt(detailSource, x % detailSource.width, y % detailSource.height);
      const detailLum = 0.299 * dr + 0.587 * dg + 0.114 * db;
      const deviation = (detailLum - detailMean) * options.strength * m;
      if (Math.round(deviation) !== 0) changed++;
      setPixel(
        out,
        x,
        y,
        clamp8(br + deviation),
        clamp8(bg + deviation),
        clamp8(bb + deviation),
        ba,
      );
    }
  }
  if (changed === 0) {
    throw new Error(
      'buildDetailVariant: detail changed zero pixels; the variant is a copy of the base. ' +
        `Check strength (${options.strength}) and that the detail source is not flat.`,
    );
  }
  return out;
}

export function toMaterialTile(raw: RgbaImage, options: MaterialTileOptions): RgbaImage {
  // A missing or NaN parameter otherwise propagates through the luminance math
  // and clamps every pixel to 0, producing a silently black tile that still
  // passes pack validation. Fail loudly instead.
  for (const key of [
    'sizePx',
    'posterizeLevels',
    'targetMeanLuminance',
    'maxLuminance',
    'targetStdDev',
  ] as const) {
    if (!Number.isFinite(options[key])) {
      throw new Error(
        `toMaterialTile: option "${key}" must be a finite number, got ${options[key]}`,
      );
    }
  }
  // Downsample in two stages: a big box reduction, then a final exact-size pass.
  const intermediate =
    raw.width > options.sizePx * 4
      ? boxDownsample(raw, options.sizePx * 4, options.sizePx * 4)
      : raw;
  const small = boxDownsample(intermediate, options.sizePx, options.sizePx);
  const seamless = options.skipSeamless === true ? small : makeSeamless(small);
  // Order matters: land in the target luminance range, restore the contrast that
  // seamless blending removed, and only THEN posterize, so the bands are spaced
  // across the range the tile actually ships with. Posterizing first collapses a
  // narrow range into a single band and yields flat, textureless material.
  const ranged = normalizeLuminance(seamless, options.targetMeanLuminance, options.maxLuminance);
  const contrasted = normalizeContrast(ranged, options.targetStdDev, options.maxLuminance);
  const banded = posterize(contrasted, options.posterizeLevels);
  // Posterizing nudges the mean; re-lock it so the wall darkness guarantee holds.
  return normalizeLuminance(banded, options.targetMeanLuminance, options.maxLuminance);
}

/** Re-export so callers compose the whole pipeline from one module. */
export { nearestNeighborResize };
