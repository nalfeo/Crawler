/**
 * Minimal, pure RGBA image-buffer helpers shared by the terrain-pack
 * assembler/validator scripts. Deliberately tiny and dependency-free (beyond
 * `pngjs` for encode/decode) so every transform is easy to reason about and
 * test without touching disk.
 *
 * Reviewed-design refinement #4: all scaling here is EXPLICIT deterministic
 * nearest-neighbor — never implicit browser/canvas resizing.
 */
import { PNG } from 'pngjs';

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA8 pixel data, length === width*height*4. */
  readonly data: Buffer;
}

/** Allocate a new fully-transparent RGBA image buffer. */
export function createImage(width: number, height: number): RgbaImage {
  return { width, height, data: Buffer.alloc(width * height * 4, 0) };
}

function assertInBounds(img: RgbaImage, x: number, y: number): void {
  if (x < 0 || x >= img.width || y < 0 || y >= img.height) {
    throw new RangeError(`Pixel (${x},${y}) out of bounds for ${img.width}x${img.height} image`);
  }
}

export function setPixel(
  img: RgbaImage,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  assertInBounds(img, x, y);
  const idx = (y * img.width + x) * 4;
  img.data[idx] = r;
  img.data[idx + 1] = g;
  img.data[idx + 2] = b;
  img.data[idx + 3] = a;
}

function getPixel(img: RgbaImage, x: number, y: number): [number, number, number, number] {
  assertInBounds(img, x, y);
  const idx = (y * img.width + x) * 4;
  return [img.data[idx]!, img.data[idx + 1]!, img.data[idx + 2]!, img.data[idx + 3]!];
}

/** Fill an axis-aligned rectangle (clamped to image bounds) with one RGBA color. */
export function fillRect(
  img: RgbaImage,
  x0: number,
  y0: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const xEnd = Math.min(img.width, x0 + w);
  const yEnd = Math.min(img.height, y0 + h);
  for (let y = Math.max(0, y0); y < yEnd; y++) {
    for (let x = Math.max(0, x0); x < xEnd; x++) {
      setPixel(img, x, y, r, g, b, a);
    }
  }
}

/**
 * Coverage of one pixel by a disc, estimated by uniform supersampling.
 *
 * Returns the fraction (0..1) of the pixel's area that lies INSIDE the disc.
 * Sampling is a fixed `SUBSAMPLES x SUBSAMPLES` grid of sample points at pixel
 * sub-centres, so the result is fully deterministic (no randomness, no
 * platform-dependent float libm calls beyond a squared-distance compare).
 *
 * This is the only anti-aliasing primitive the terrain-pack tooling needs: all
 * rounded wall geometry is expressed as adding or subtracting quarter-discs.
 */
const SUBSAMPLES = 4;

function discCoverage(
  px: number,
  py: number,
  centerX: number,
  centerY: number,
  radius: number,
): number {
  const r2 = radius * radius;
  let inside = 0;
  for (let sy = 0; sy < SUBSAMPLES; sy++) {
    const y = py + (sy + 0.5) / SUBSAMPLES - centerY;
    for (let sx = 0; sx < SUBSAMPLES; sx++) {
      const x = px + (sx + 0.5) / SUBSAMPLES - centerX;
      if (x * x + y * y <= r2) inside++;
    }
  }
  return inside / (SUBSAMPLES * SUBSAMPLES);
}

/**
 * Erase an anti-aliased quarter-disc from `img`, keeping only the quadrant of
 * the disc that lies in the direction (`dirX`, `dirY`) from its centre.
 *
 * Used to take a ROUNDED BITE out of a corner: place the centre at the corner
 * and point the quadrant at the material to remove. Pixels fully inside the
 * quarter-disc become transparent; pixels straddling the arc keep a partial
 * alpha, which is what makes the curve read smoothly once the 256px cell is
 * scaled down to its final tile size.
 *
 * Only alpha is modified — RGB is left intact so a later re-texture pass can
 * still read the original colour under a partially erased pixel.
 */
export function eraseQuarterDisc(
  img: RgbaImage,
  centerX: number,
  centerY: number,
  radius: number,
  dirX: -1 | 1,
  dirY: -1 | 1,
): void {
  forEachQuadrantPixel(img, centerX, centerY, radius, dirX, dirY, (idx, coverage) => {
    const erased = Math.round(img.data[idx + 3]! * (1 - coverage));
    if (erased < img.data[idx + 3]!) img.data[idx + 3] = erased;
  });
}

/**
 * Round off a sharp convex corner of a filled region, in place.
 *
 * `(cornerX, cornerY)` is the sharp corner itself and (`dirX`, `dirY`) points
 * INTO the material. The arc centre is placed one radius inward along both axes,
 * so the resulting quarter-round is tangent to both edges that met at the corner
 * — the wall eases into the floor instead of stepping.
 *
 * This is the inverse of `eraseQuarterDisc`: it erases the sliver of material
 * OUTSIDE the arc but inside the corner's radius-by-radius box, rather than the
 * disc itself.
 */
export function roundConvexCorner(
  img: RgbaImage,
  cornerX: number,
  cornerY: number,
  radius: number,
  dirX: -1 | 1,
  dirY: -1 | 1,
): void {
  const centerX = cornerX + dirX * radius;
  const centerY = cornerY + dirY * radius;
  // Walk the corner box explicitly: pixels with NO disc coverage must be fully
  // erased, so we cannot early-out on `coverage === 0` the way the disc helper does.
  const x0 = Math.max(0, Math.floor(dirX > 0 ? cornerX : cornerX - radius));
  const x1 = Math.min(img.width, Math.ceil(dirX > 0 ? cornerX + radius : cornerX));
  const y0 = Math.max(0, Math.floor(dirY > 0 ? cornerY : cornerY - radius));
  const y1 = Math.min(img.height, Math.ceil(dirY > 0 ? cornerY + radius : cornerY));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const coverage = discCoverage(x, y, centerX, centerY, radius);
      const idx = (y * img.width + x) * 4;
      const kept = Math.round(img.data[idx + 3]! * coverage);
      if (kept < img.data[idx + 3]!) img.data[idx + 3] = kept;
    }
  }
}

function forEachQuadrantPixel(
  img: RgbaImage,
  centerX: number,
  centerY: number,
  radius: number,
  dirX: -1 | 1,
  dirY: -1 | 1,
  visit: (idx: number, coverage: number) => void,
): void {
  const x0 = Math.max(0, Math.floor(dirX > 0 ? centerX : centerX - radius));
  const x1 = Math.min(img.width, Math.ceil(dirX > 0 ? centerX + radius : centerX));
  const y0 = Math.max(0, Math.floor(dirY > 0 ? centerY : centerY - radius));
  const y1 = Math.min(img.height, Math.ceil(dirY > 0 ? centerY + radius : centerY));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const coverage = discCoverage(x, y, centerX, centerY, radius);
      if (coverage <= 0) continue;
      visit((y * img.width + x) * 4, coverage);
    }
  }
}

/** Paste `src` into `dst` with its top-left corner at (destX, destY). No blending — overwrite. */
export function compositeInto(dst: RgbaImage, src: RgbaImage, destX: number, destY: number): void {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const [r, g, b, a] = getPixel(src, x, y);
      setPixel(dst, destX + x, destY + y, r, g, b, a);
    }
  }
}

/** Extract a sub-rectangle as a new standalone image (no bounds growth). */
export function cropImage(src: RgbaImage, x0: number, y0: number, w: number, h: number): RgbaImage {
  const out = createImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = getPixel(src, x0 + x, y0 + y);
      setPixel(out, x, y, r, g, b, a);
    }
  }
  return out;
}

/**
 * Deterministic nearest-neighbor resize. Explicit source/destination
 * dimensions are required by the caller (refinement #4) — this function
 * never infers a scale factor from anything but the two sizes given.
 */
export function nearestNeighborResize(
  src: RgbaImage,
  destWidth: number,
  destHeight: number,
): RgbaImage {
  const out = createImage(destWidth, destHeight);
  for (let y = 0; y < destHeight; y++) {
    // Map dest pixel center back to source space, then floor to nearest source pixel.
    const srcY = Math.min(src.height - 1, Math.floor(((y + 0.5) * src.height) / destHeight));
    for (let x = 0; x < destWidth; x++) {
      const srcX = Math.min(src.width - 1, Math.floor(((x + 0.5) * src.width) / destWidth));
      const [r, g, b, a] = getPixel(src, srcX, srcY);
      setPixel(out, x, y, r, g, b, a);
    }
  }
  return out;
}

export function encodePng(img: RgbaImage): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  return PNG.sync.write(png);
}

export function decodePng(buffer: Buffer): RgbaImage {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: Buffer.from(png.data) };
}
