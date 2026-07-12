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

export function getPixel(img: RgbaImage, x: number, y: number): [number, number, number, number] {
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
