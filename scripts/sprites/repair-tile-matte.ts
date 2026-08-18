/**
 * Repair a tile PNG whose chroma-key matte was never keyed out.
 *
 * Some generated tiles shipped with a magenta chroma-key border baked into the
 * pixels (see `check-tile-seams.ts`). For an edge-to-edge TILING texture that
 * border is fatal: it tiles into a continuous magenta lattice across the whole
 * floor. `tile-stone-floor-var-2.png` shipped this way and is bound to
 * `TerrainType.STONE_FLOOR`, so every stone room in the game drew a pink grid.
 *
 * The matte replaced real pixels, so it cannot simply be made transparent (a
 * floor tile with a transparent border leaves gaps). Instead each matte pixel
 * is inpainted by MIRRORING the nearest interior pixel across the matte
 * boundary. For a high-frequency, non-directional stone texture this is
 * visually seamless and — critically — it is deterministic: no RNG, no model,
 * same input bytes always produce the same output bytes.
 *
 * Usage: tsx scripts/sprites/repair-tile-matte.ts <png> [...more]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

/** Same predicate `check-tile-seams.ts` uses, kept in sync deliberately. */
function isMatteMagenta(r: number, g: number, b: number, a: number): boolean {
  return a > 0 && r > 120 && g < 90 && b > g + 40;
}

interface RepairResult {
  readonly file: string;
  readonly repaired: number;
  readonly total: number;
}

/**
 * Inpaint every matte pixel from surrounding non-matte pixels.
 *
 * Iterative erosion: each pass replaces every matte pixel that has at least one
 * non-matte 8-neighbour with the average of those neighbours, then repeats. The
 * matte shrinks from its boundary inward until nothing is left, so it handles a
 * ring of uneven thickness (the corners are typically thicker than the edges)
 * without assuming any particular matte geometry.
 *
 * Deterministic: fixed scan order, integer averaging, no RNG.
 */
export function repairMatte(png: PNG, fringe = 2): number {
  const { width, height, data } = png;
  const at = (x: number, y: number): number => (y * width + x) * 4;

  const matte = new Uint8Array(width * height);
  let remaining = 0;
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    if (
      isMatteMagenta(
        data[i] as number,
        data[i + 1] as number,
        data[i + 2] as number,
        data[i + 3] as number,
      )
    ) {
      matte[p] = 1;
      remaining++;
    }
  }
  const repaired = remaining;
  if (remaining === 0) return 0;

  // Dilate the mask by `fringe` pixels. The matte's outer edge is anti-aliased
  // against the art, so pixels just inside it are BLENDS of magenta and stone —
  // below the strict predicate but still visibly purple, and they would tile
  // into a faint violet grid. Inpainting them too removes the fringe.
  for (let step = 0; step < fringe; step++) {
    const grow: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (matte[p] === 1) continue;
        let touches = false;
        for (let dy = -1; dy <= 1 && !touches; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            if (matte[ny * width + nx] === 1) {
              touches = true;
              break;
            }
          }
        }
        if (touches) grow.push(p);
      }
    }
    for (const p of grow) matte[p] = 1;
    remaining += grow.length;
  }

  // Bounded by the image diagonal: every pass removes at least the outermost
  // matte layer, so this always terminates.
  const maxPasses = width + height;
  for (let pass = 0; pass < maxPasses && remaining > 0; pass++) {
    const filled: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (matte[p] !== 1) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            if (matte[ny * width + nx] === 1) continue;
            const s = at(nx, ny);
            r += data[s] as number;
            g += data[s + 1] as number;
            b += data[s + 2] as number;
            n++;
          }
        }
        if (n === 0) continue;
        const d = at(x, y);
        data[d] = Math.round(r / n);
        data[d + 1] = Math.round(g / n);
        data[d + 2] = Math.round(b / n);
        data[d + 3] = 255;
        filled.push(p);
      }
    }
    if (filled.length === 0) break;
    for (const p of filled) matte[p] = 0;
    remaining -= filled.length;
  }
  return repaired;
}

function repairFile(file: string): RepairResult {
  const png = PNG.sync.read(readFileSync(file));
  const repaired = repairMatte(png);
  if (repaired > 0) writeFileSync(file, PNG.sync.write(png));
  return { file, repaired, total: png.width * png.height };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: tsx scripts/sprites/repair-tile-matte.ts <png> [...more]');
  process.exit(2);
}
for (const file of files) {
  const { repaired, total } = repairFile(file);
  const pct = ((repaired / total) * 100).toFixed(1);
  console.log(repaired > 0 ? `repaired ${file}: ${repaired}px (${pct}%)` : `clean     ${file}`);
}
