/**
 * CLI: turn the cached Floor 2 Azure materials into the pack's COMMITTED source
 * PNGs.
 *
 * This is the boundary between "art generation" (non-reproducible, costs
 * credits, cached under the gitignored `.cache/terrain-gen/`) and "art
 * derivation" (fully deterministic, runs from committed bytes). Everything
 * downstream — `rebuild-shared-base-pools.ts`, the pixel-art re-grain, the wall
 * lighting pass — reads only the files this script writes, so a clean checkout
 * can rebuild the whole pack without an Azure key.
 *
 * Writes into the industrial-cave pack directory:
 *   floor-0.png      pool base for open ground
 *   corridor-0.png   pool base for corridors (a different window of the same
 *                    material, so the two surfaces stay in the same family)
 *   wall-material.png the atlas-sized rock texture the wall lighting pass
 *                    samples by absolute position
 *
 * Usage:
 *   npx tsx scripts/sprites/terrain-packs/gen/floor2-cli.ts        # fetch first
 *   npx tsx scripts/sprites/terrain-packs/import-floor2-materials.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng, type RgbaImage } from './png-buffer.js';
import { toMaterialTile, type MaterialTileOptions } from './gen/image-ops.js';
import { FLOOR2_INDUSTRIAL_CAVE_MATERIALS } from './gen/materials.js';
import { applySharedBasePoolRestyle } from './rebuild-shared-base-pools.js';
import { isWallAlpha } from './wall-opacity.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CACHE_DIR = path.join(REPO_ROOT, '.cache', 'terrain-gen');
const PACK_DIR = path.join(REPO_ROOT, 'public', 'assets', 'terrain-packs', 'industrial-cave');

/** Pool tiles are 64px; the wall atlas is 8x6 cells of 64px. */
const POOL_PX = 64;
const WALL_MATERIAL_W = 512;
const WALL_MATERIAL_H = 384;

/**
 * Side length of the material window that becomes ONE 64px ground tile.
 *
 * WHY THIS IS SMALL. Whatever window we crop is box-downsampled to POOL_PX, so
 * the window size IS the detail scale: a 512px window means an 8x reduction, which
 * turns a 32px crack the model drew into a 4px scratch and a 16px smudge into 2
 * indistinct pixels. That is the entire reason ground detail read as "way too
 * small/fine" — the generated art had prominent features and the import crushed
 * them. At 128 the reduction is 2x, so a crack keeps half its authored width and
 * still reads as a crack at play scale.
 *
 * Do not raise this to "get more variety into one tile". Variety comes from
 * cutting MORE windows (a 1024^2 material holds 64 disjoint 128px windows), not
 * from cramming a larger area into the same 64 pixels.
 */
const GROUND_WINDOW_PX = 128;

function readCached(cacheKey: string): RgbaImage {
  const file = path.join(CACHE_DIR, `${cacheKey}.png`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing cached material ${file}. Run scripts/sprites/terrain-packs/gen/floor2-cli.ts first.`,
    );
  }
  return decodePng(fs.readFileSync(file));
}

/**
 * Crop a window out of the raw 1024x1024 material.
 *
 * Different windows of ONE generated image is how two surfaces stay in the same
 * material family while still differing — the alternative, two independent
 * generations, is exactly what produced the "variations don't look cohesive"
 * result earlier in this work.
 */
function crop(src: RgbaImage, x0: number, y0: number, w: number, h: number): RgbaImage {
  const out: RgbaImage = { width: w, height: h, data: Buffer.alloc(w * h * 4) };
  for (let y = 0; y < h; y++) {
    const sy = (y0 + y) % src.height;
    for (let x = 0; x < w; x++) {
      const sx = (x0 + x) % src.width;
      src.data.copy(
        out.data,
        (y * w + x) * 4,
        (sy * src.width + sx) * 4,
        (sy * src.width + sx) * 4 + 4,
      );
    }
  }
  return out;
}

/** Tile `src` (already seamless) up to the requested size. */
function tileTo(src: RgbaImage, w: number, h: number): RgbaImage {
  const out: RgbaImage = { width: w, height: h, data: Buffer.alloc(w * h * 4) };
  for (let y = 0; y < h; y++) {
    const sy = y % src.height;
    for (let x = 0; x < w; x++) {
      const sx = x % src.width;
      src.data.copy(
        out.data,
        (y * w + x) * 4,
        (sy * src.width + sx) * 4,
        (sy * src.width + sx) * 4 + 4,
      );
    }
  }
  return out;
}

function write(relName: string, image: RgbaImage): void {
  const outPath = path.join(PACK_DIR, relName);
  fs.writeFileSync(outPath, encodePng(image));
  console.log(`  wrote ${relName} (${image.width}x${image.height})`);
}

/** Names of the four wall-accent overlay atlases, in manifest order. */
const ACCENT_NAMES = [
  'accent-crack.png',
  'accent-damp-stain.png',
  'accent-mineral-vein.png',
  'accent-rust-brace.png',
] as const;

/**
 * Nearest-neighbour downscale. Nearest, not averaged, on purpose: averaging is
 * what turns generated rock into the "downsampled photograph" look the judge
 * called out. Keeping hard pixel transitions is what makes it read as pixel art.
 */
function downscale(src: RgbaImage, w: number, h: number): RgbaImage {
  const out: RgbaImage = { width: w, height: h, data: Buffer.alloc(w * h * 4) };
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / w));
      src.data.copy(
        out.data,
        (y * w + x) * 4,
        (sy * src.width + sx) * 4,
        (sy * src.width + sx) * 4 + 4,
      );
    }
  }
  return out;
}

/**
 * Rebuild the four wall-accent atlases as FRACTURE overlays cut from the
 * generated facet material.
 *
 * WHY. Under blob47 the interior of a large wall mass is a single frame stamped
 * over and over, so the interior has no per-tile variety by construction — the
 * repeated finding behind the original "very repetitive" complaint. Wall accents
 * are the pack's already-wired mechanism for exactly this: a second, mask-aware
 * stamp on a deterministic subset of wall tiles. Four disjoint windows of ONE
 * generated material give four genuinely different interiors that still share a
 * palette and a facet scale, so the variety does not cost cohesion.
 *
 * Only the darker-than-mean part of the material is kept as the accent MASK. That
 * turns the material into fractures, recesses and chipped edges laid over the wall
 * rather than a second opaque texture competing with it.
 *
 * The accent's own colour is the generated material's colour at that pixel,
 * renormalized so the accent set sits at ACCENT_TARGET_MEAN. Accents are surface
 * FEATURES — mineral veins, rust braces, damp stains, fractured faces — so they
 * belong at or slightly above wall tone, not as near-black voids; a black void
 * reads as a hole punched through the mass. They stay far below floor luminance,
 * so an accent can still never pull a wall tile up toward reading as walkable.
 *
 * ALPHA IS BINARY (0 or 255), never graded. Partial alpha is banned pack-wide —
 * it is what makes art read as smooth/photographic rather than pixel art, and it
 * is asserted by the committed-pack test. All gradation lives in the RGB.
 */
function buildWallAccents(
  facetRaw: RgbaImage,
  specTile: (typeof FLOOR2_INDUSTRIAL_CAVE_MATERIALS)['wallFacet']['tile'],
): void {
  const atlasPath = path.join(PACK_DIR, 'wall-atlas.png');
  const atlas = decodePng(fs.readFileSync(atlasPath));

  // Downscale so one facet spans roughly half a 64px cell: big enough to read as
  // geology, small enough that a single cell shows more than one flat face.
  const seamless = toMaterialTile(facetRaw, { ...specTile, sizePx: 768 });
  const source = downscale(seamless, 768, 768);

  let mean = 0;
  for (let i = 0; i < source.data.length; i += 4) {
    mean += 0.299 * source.data[i]! + 0.587 * source.data[i + 1]! + 0.114 * source.data[i + 2]!;
  }
  mean /= source.data.length / 4;

  /** Luma deficit, below the material mean, that qualifies a pixel as accent. */
  const ACCENT_DEFICIT_PX = 1;
  /**
   * Mean luma the accent set is normalized to. Sits just above the wall atlas
   * (~35) and far below the floor (~74): visible as a feature, never walkable.
   */
  const ACCENT_TARGET_MEAN = 46;
  /** Channel quantization step — keeps the palette countable and pixel-arty. */
  const ACCENT_QUANT = 6;

  const offsets: readonly (readonly [number, number])[] = [
    [0, 0],
    [256, 0],
    [0, 384],
    [256, 384],
  ];

  ACCENT_NAMES.forEach((name, k) => {
    const [ox, oy] = offsets[k]!;
    const out: RgbaImage = {
      width: atlas.width,
      height: atlas.height,
      data: Buffer.alloc(atlas.width * atlas.height * 4),
    };
    // Pass 1: mask + collect the material colour, and measure the kept set.
    const kept: number[] = [];
    let keptLumaSum = 0;
    for (let y = 0; y < atlas.height; y++) {
      for (let x = 0; x < atlas.width; x++) {
        const i = (y * atlas.width + x) * 4;
        if (!isWallAlpha(atlas.data[i + 3]!)) continue;
        const sx = (x + ox) % source.width;
        const sy = (y + oy) % source.height;
        const si = (sy * source.width + sx) * 4;
        const luma =
          0.299 * source.data[si]! + 0.587 * source.data[si + 1]! + 0.114 * source.data[si + 2]!;
        if (mean - luma < ACCENT_DEFICIT_PX) continue;
        kept.push(i, si);
        keptLumaSum += luma;
      }
    }
    if (kept.length === 0) throw new Error(`accent ${name} produced an empty mask`);

    // Pass 2: renormalize the kept set to the accent target mean and quantize.
    const scale = ACCENT_TARGET_MEAN / (keptLumaSum / (kept.length / 2));
    for (let k = 0; k < kept.length; k += 2) {
      const i = kept[k]!;
      const si = kept[k + 1]!;
      for (let ch = 0; ch < 3; ch++) {
        const value = Math.min(255, Math.max(0, source.data[si + ch]! * scale));
        out.data[i + ch] = Math.min(255, Math.round(value / ACCENT_QUANT) * ACCENT_QUANT);
      }
      out.data[i + 3] = 255;
    }
    write(name, out);
  });
}

/**
 * Rank every disjoint window of the material by internal contrast, then hand back
 * a quiet base and the loudest N as variants.
 *
 * WHY RANKED, NOT HAND-PICKED. The pool is deliberately asymmetric: the base tile
 * covers ~70% of the ground, so it must be the CALM one, while the sparse variants
 * are what the eye actually catches — they carry the cracks and smudges. Picking
 * cell coordinates by hand gave no control over that, and produced variants that
 * were flatter than the base (detail variants that reduced detail). Scoring the
 * windows makes "variants are more textured than the base" true by construction
 * rather than by luck, which is exactly what the committed-pack test asserts.
 *
 * The base is taken from the calm end but not the calmest window, so the dominant
 * tile still has some structure instead of being a dead flat slab.
 */
function selectWindows(
  src: RgbaImage,
  tile: MaterialTileOptions,
  variantCount: number,
): { base: RgbaImage; variants: readonly RgbaImage[] } {
  const cellsPerAxis = Math.floor(src.width / GROUND_WINDOW_PX);
  const scored: { window: RgbaImage; stdDev: number }[] = [];
  for (let cy = 0; cy < cellsPerAxis; cy++) {
    for (let cx = 0; cx < cellsPerAxis; cx++) {
      const window = crop(
        src,
        cx * GROUND_WINDOW_PX,
        cy * GROUND_WINDOW_PX,
        GROUND_WINDOW_PX,
        GROUND_WINDOW_PX,
      );
      let sum = 0;
      let sumSq = 0;
      const n = window.data.length / 4;
      for (let i = 0; i < window.data.length; i += 4) {
        const luma =
          0.299 * window.data[i]! + 0.587 * window.data[i + 1]! + 0.114 * window.data[i + 2]!;
        sum += luma;
        sumSq += luma * luma;
      }
      const meanLuma = sum / n;
      scored.push({ window, stdDev: Math.sqrt(Math.max(0, sumSq / n - meanLuma * meanLuma)) });
    }
  }
  scored.sort((a, b) => a.stdDev - b.stdDev);
  if (scored.length < variantCount + 1) {
    throw new Error(`material yields only ${scored.length} windows; need ${variantCount + 1}`);
  }
  /** Percentile into the calm end of the distribution that the base is cut from. */
  const BASE_PERCENTILE = 0.15;
  const baseEntry = scored[Math.floor(scored.length * BASE_PERCENTILE)]!;
  const variantEntries = scored.slice(-variantCount);
  console.log(
    `  window sd: base ${baseEntry.stdDev.toFixed(1)}, variants ${variantEntries
      .map((entry) => entry.stdDev.toFixed(0))
      .join('/')}`,
  );
  return {
    // The base ships as a standalone repeating surface, so it MUST be seamless
    // with itself. Cutting it from the calm end of the distribution is what makes
    // that affordable: the mirror blend has almost no structure to fold back, so
    // it leaves no visible symmetry, and a near-featureless tile covering ~70% of
    // the ground is exactly what stops the surface reading as a stamped grid.
    base: toMaterialTile(baseEntry.window, tile),
    // Variants are cut from the loudest windows — the ones holding a branching
    // crack or a broad stain — and skip the mirror blend, because their borders
    // are overwritten by the base's during composition. That is what lets a
    // feature stay an asymmetric, readable crack instead of a kaleidoscope.
    variants: variantEntries.map((entry) =>
      toMaterialTile(entry.window, { ...tile, skipSeamless: true }),
    ),
  };
}

/**
 * Lay pre-materialized 64px tiles into one horizontal strip.
 *
 * WHY A STRIP OF REAL MATERIAL. The pool variants used to be `base + procedurally
 * synthesized detail patch`. Hand-written synthesis is exactly what kept reading
 * as fake; one generated material beat five procedural iterations. A 1024^2
 * material holds 64 disjoint 128px windows, so there is no reason to invent
 * detail — we can just cut more real rock.
 *
 * Each window went through `toMaterialTile` individually, which both makes it
 * seamless with itself AND normalizes it to the SAME target mean luminance as
 * every other window. That shared normalization is the cohesion guarantee: the
 * variants differ in structure but cannot drift apart in tone, which is what
 * made the earlier "8 independent materials" attempt look like a quilt.
 */
function buildVariantStrip(tiles: readonly RgbaImage[]): RgbaImage {
  const strip: RgbaImage = {
    width: POOL_PX * tiles.length,
    height: POOL_PX,
    data: Buffer.alloc(POOL_PX * tiles.length * POOL_PX * 4),
  };
  tiles.forEach((tiled, i) => {
    for (let y = 0; y < POOL_PX; y++) {
      for (let x = 0; x < POOL_PX; x++) {
        const si = (y * POOL_PX + x) * 4;
        const di = (y * strip.width + i * POOL_PX + x) * 4;
        tiled.data.copy(strip.data, di, si, si + 4);
      }
    }
  });
  return strip;
}

/** Pool variants per surface, excluding the base. */
const VARIANT_COUNT = 7;

/**
 * Decal sets emitted from the floor material, LARGEST FIRST so the rarest and
 * most valuable motif — a long crack — gets first pick of the material's crack
 * network, and the smaller sets are excluded from windows it already claimed.
 *
 * `windowScale` is the material-pixel size of one decal pixel. The 2- and
 * 3-tile sets use 2, matching the ground's own 2:1 downsample so their grain
 * matches the floor exactly. The 4- and 6-tile sets must use 1: at 2 they would
 * need 512px and 768px windows out of a 1024px material, which leaves only a
 * handful of positions that all overlap, so no set of well-separated frames
 * exists. Sampling 1:1 doubles the apparent stroke width relative to the
 * ground, which is the correct reading for a large crack anyway.
 */
const DECAL_SETS = [
  { spanTiles: 6, frames: 6, windowScale: 1, fileName: 'ground-decals-long.png' },
  { spanTiles: 4, frames: 8, windowScale: 1, fileName: 'ground-decals-large.png' },
  { spanTiles: 3, frames: 8, windowScale: 2, fileName: 'ground-decals.png' },
  { spanTiles: 2, frames: 10, windowScale: 2, fileName: 'ground-decals-small.png' },
] as const;
/** How far below the LOCAL background a pixel must sit to count as a crack. */
const DECAL_DARK_DELTA = 14;
/** Radius of the local-background estimate, in material pixels. */
const DECAL_BACKGROUND_RADIUS = 20;
/** Multiplier applied to a kept crack pixel's own colour. */
const DECAL_DARKEN = 0.62;
/**
 * Largest background blob, in decal pixels, that counts as an interior pinhole
 * rather than real ground showing between two separate cracks. Isolating the
 * crack network by luma leaves single-pixel gaps wherever one source pixel sat
 * just above the darkness threshold; at play scale those read as sparkle inside
 * the crack, not as ground.
 */
const DECAL_MAX_PINHOLE_PX = 4;
/**
 * Minimum centre separation between two accepted windows, as a fraction of the
 * window size. Densest-first alone picks near-duplicate overlapping windows —
 * the frames then all show the same crack, which is exactly the repetition the
 * decals exist to break.
 */
const DECAL_MIN_SEPARATION = 0.5;
/**
 * Cross-SET centre separation, as a fraction of the current set's window. Much
 * smaller than the within-set figure because the two constraints guard different
 * things: within a set, two frames drawn from overlapping windows really are the
 * same crack twice, but across sets the same source region yields a visibly
 * different decal — different scale, and at runtime an independent continuous
 * rotation and mirror. Reusing the within-set radius here lets the large sets
 * blanket the material and starve every set after them.
 */
const DECAL_CROSS_SET_SEPARATION = 0.25;

/** Box-blurred luma, used as a LOCAL background so a crack is measured against
 *  the ground right next to it rather than against the whole image's mean. */
function localLumaMean(src: RgbaImage, radius: number): Float32Array {
  const { width: w, height: h } = src;
  const luma = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    luma[i] =
      0.299 * src.data[i * 4]! + 0.587 * src.data[i * 4 + 1]! + 0.114 * src.data[i * 4 + 2]!;
  }
  const horiz = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let d = -radius; d <= radius; d++) {
        const sx = x + d;
        if (sx < 0 || sx >= w) continue;
        sum += luma[y * w + sx]!;
        n++;
      }
      horiz[y * w + x] = sum / n;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let d = -radius; d <= radius; d++) {
        const sy = y + d;
        if (sy < 0 || sy >= h) continue;
        sum += horiz[sy * w + x]!;
        n++;
      }
      out[y * w + x] = sum / n;
    }
  }
  return out;
}

/**
 * Remove isolated speckle, then thicken what survives.
 *
 * This is the step that makes a decal read as a CRACK rather than as grit. The
 * raw darker-than-background mask contains both, and they are separable by
 * connectivity, not by intensity: a crack pixel has crack neighbours, a grit
 * pixel does not. Erode drops anything without enough support, then two dilates
 * restore and widen the surviving lines so they stay legible after the 2×
 * downsample to decal resolution.
 */
function despeckle(mask: Uint8Array, w: number, h: number): Uint8Array {
  const at = (m: Uint8Array, x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : m[y * w + x]!;
  const eroded = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const support =
        at(mask, x - 1, y) + at(mask, x + 1, y) + at(mask, x, y - 1) + at(mask, x, y + 1);
      if (support >= 3) eroded[y * w + x] = 1;
    }
  }
  let current = eroded;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (
          current[y * w + x] ||
          at(current, x - 1, y) ||
          at(current, x + 1, y) ||
          at(current, x, y - 1) ||
          at(current, x, y + 1)
        ) {
          next[y * w + x] = 1;
        }
      }
    }
    current = next;
  }
  return current;
}

/**
 * Raise a decal mask to a minimum stroke width of 2 and close interior pinholes.
 *
 * Isolating cracks by luma produces two artefacts that only show at play scale.
 * Where the source crack faded, the mask narrows to a single pixel, which reads
 * as a stray scratch rather than as part of the crack. And wherever one interior
 * pixel sat just above the darkness threshold, the mask keeps a 1px hole that
 * shows ground through the middle of the crack, which sparkles.
 *
 * Thickening is directional (always down / right) on purpose: growing both ways
 * would take a 1px stroke to 3px and merge neighbouring cracks into a blob.
 * Reading support from the ORIGINAL mask keeps it a single pass rather than a
 * cascade that thickens what it just thickened.
 */
function boldenDecalMask(alpha: Uint8Array, size: number): Uint8Array {
  const at = (m: Uint8Array, x: number, y: number): number =>
    x < 0 || y < 0 || x >= size || y >= size ? 0 : m[y * size + x]!;
  const out = Uint8Array.from(alpha);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!alpha[y * size + x]) continue;
      // 1px tall here: grow downward. 1px wide here: grow rightward.
      if (!at(alpha, x, y - 1) && !at(alpha, x, y + 1) && y + 1 < size) out[(y + 1) * size + x] = 1;
      if (!at(alpha, x - 1, y) && !at(alpha, x + 1, y) && x + 1 < size) out[y * size + x + 1] = 1;
    }
  }

  // Close pinholes: flood the background, then fill any component that is both
  // small and fully enclosed. Testing enclosure by "does not touch the frame
  // border" is what stops this from filling the large open ground around the
  // crack, which a neighbour-count rule would eventually eat into.
  const seen = new Uint8Array(size * size);
  const stack: number[] = [];
  for (let start = 0; start < out.length; start++) {
    if (out[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    const blob: number[] = [];
    let touchesBorder = false;
    const push = (j: number): void => {
      if (out[j] || seen[j]) return;
      seen[j] = 1;
      stack.push(j);
    };
    while (stack.length > 0) {
      const i = stack.pop()!;
      blob.push(i);
      const x = i % size;
      const y = (i - x) / size;
      if (x === 0 || y === 0 || x === size - 1 || y === size - 1) touchesBorder = true;
      if (x > 0) push(i - 1);
      if (x < size - 1) push(i + 1);
      if (y > 0) push(i - size);
      if (y < size - 1) push(i + size);
    }
    if (!touchesBorder && blob.length <= DECAL_MAX_PINHOLE_PX) {
      for (const i of blob) out[i] = 1;
    }
  }
  return out;
}

/**
 * Build the cross-tile ground-decal atlas from the generated floor material.
 *
 * WHY THIS EXISTS. Every floor/corridor pool tile has its border byte-restored
 * from the shared base so neighbours tile seamlessly — which structurally means
 * no feature inside a pool tile can cross a tile edge. A long crack is exactly
 * such a feature, so it can never come from the pool no matter how the pool is
 * tuned. Decals are a separate overlay stamped across cells, which is the only
 * place a multi-tile motif can live without breaking seamlessness.
 *
 * The art is not synthesized: it is the crack network the generator already drew
 * in the floor material, isolated by keeping only pixels well below their LOCAL
 * background and then separating lines from grit by connectivity.
 */
function buildGroundDecals(floorRaw: RgbaImage): void {
  const background = localLumaMean(floorRaw, DECAL_BACKGROUND_RADIUS);
  const crackMask = new Uint8Array(floorRaw.width * floorRaw.height);
  for (let i = 0; i < crackMask.length; i++) {
    const luma =
      0.299 * floorRaw.data[i * 4]! +
      0.587 * floorRaw.data[i * 4 + 1]! +
      0.114 * floorRaw.data[i * 4 + 2]!;
    if (luma < background[i]! - DECAL_DARK_DELTA) crackMask[i] = 1;
  }
  const cleaned = despeckle(crackMask, floorRaw.width, floorRaw.height);

  // Windows already claimed by an earlier (larger) set, so a small decal is
  // never a sub-crop of a large one — that would read as the same crack twice.
  const claimed: { cx: number; cy: number; radius: number }[] = [];
  for (const set of DECAL_SETS) {
    buildGroundDecalSet(floorRaw, cleaned, set, claimed);
  }
}

function buildGroundDecalSet(
  floorRaw: RgbaImage,
  cleaned: Uint8Array,
  set: (typeof DECAL_SETS)[number],
  claimed: { cx: number; cy: number; radius: number }[],
): void {
  const cellPx = set.spanTiles * POOL_PX;
  const windowPx = cellPx * set.windowScale;
  const minSeparation = windowPx * DECAL_MIN_SEPARATION;
  const crossSetSeparation = windowPx * DECAL_CROSS_SET_SEPARATION;

  /**
   * Render one candidate window down to a decal frame and report both its
   * coverage and the span of its largest CONNECTED mark. Coverage alone is not a
   * sufficient selection signal: a window can be densely covered by many short
   * unconnected marks, which after downsampling reads as grit confined inside a
   * single tile — precisely what decals must not be.
   */
  const renderFrame = (
    winX: number,
    winY: number,
  ): { pixels: Buffer; coverage: number; span: number } => {
    const pixels = Buffer.alloc(cellPx * cellPx * 4);
    const alpha = new Uint8Array(cellPx * cellPx);
    const rgb = new Float32Array(cellPx * cellPx * 3);
    for (let y = 0; y < cellPx; y++) {
      for (let x = 0; x < cellPx; x++) {
        // Box-average the source block; a block counts as crack only if most of
        // it is crack, which keeps downsampled edges hard instead of dithered.
        // At windowScale 1 the block is one pixel and this reduces to the mask.
        let r = 0;
        let g = 0;
        let b = 0;
        let hits = 0;
        let n = 0;
        for (let sy = 0; sy < set.windowScale; sy++) {
          for (let sx = 0; sx < set.windowScale; sx++) {
            const si =
              (winY + y * set.windowScale + sy) * floorRaw.width +
              (winX + x * set.windowScale + sx);
            if (cleaned[si]) {
              r += floorRaw.data[si * 4]!;
              g += floorRaw.data[si * 4 + 1]!;
              b += floorRaw.data[si * 4 + 2]!;
              hits++;
            }
            n++;
          }
        }
        if (hits * 2 < n) continue;
        const mi = y * cellPx + x;
        rgb[mi * 3] = (r / hits) * DECAL_DARKEN;
        rgb[mi * 3 + 1] = (g / hits) * DECAL_DARKEN;
        rgb[mi * 3 + 2] = (b / hits) * DECAL_DARKEN;
        alpha[mi] = 1;
      }
    }

    // Thicken hairlines and close pinholes before emitting, so the committed art
    // carries the corrected shape and the runtime needs no per-frame work.
    const bold = boldenDecalMask(alpha, cellPx);
    let opaque = 0;
    for (let y = 0; y < cellPx; y++) {
      for (let x = 0; x < cellPx; x++) {
        const mi = y * cellPx + x;
        if (!bold[mi]) continue;
        opaque++;
        const di = mi * 4;
        // Binary alpha, per the pack-wide ban on partial alpha.
        pixels[di + 3] = 255;
        if (alpha[mi]) {
          pixels[di] = Math.round(rgb[mi * 3]!);
          pixels[di + 1] = Math.round(rgb[mi * 3 + 1]!);
          pixels[di + 2] = Math.round(rgb[mi * 3 + 2]!);
          continue;
        }
        // A pixel added by the morphology has no source colour of its own, so it
        // borrows the mean of the original crack pixels touching it. Widening
        // the search guarantees a hit for a pinhole enclosed at any distance.
        let r = 0;
        let g = 0;
        let b = 0;
        let found = 0;
        for (let radius = 1; radius <= 3 && found === 0; radius++) {
          for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= cellPx || ny >= cellPx) continue;
              const ni = ny * cellPx + nx;
              if (!alpha[ni]) continue;
              r += rgb[ni * 3]!;
              g += rgb[ni * 3 + 1]!;
              b += rgb[ni * 3 + 2]!;
              found++;
            }
          }
        }
        if (found === 0) continue;
        pixels[di] = Math.round(r / found);
        pixels[di + 1] = Math.round(g / found);
        pixels[di + 2] = Math.round(b / found);
      }
    }
    return {
      pixels,
      coverage: opaque / (cellPx * cellPx),
      span: largestConnectedSpan(bold, cellPx),
    };
  };

  const stride = Math.max(1, Math.floor(windowPx / 4));
  const candidates: { x: number; y: number; coverage: number }[] = [];
  for (let y = 0; y + windowPx <= floorRaw.height; y += stride) {
    for (let x = 0; x + windowPx <= floorRaw.width; x += stride) {
      let hits = 0;
      for (let wy = 0; wy < windowPx; wy++) {
        for (let wx = 0; wx < windowPx; wx++) {
          hits += cleaned[(y + wy) * floorRaw.width + (x + wx)]!;
        }
      }
      candidates.push({ x, y, coverage: hits / (windowPx * windowPx) });
    }
  }

  // Densest-first, but skip anything so covered it would read as a second opaque
  // ground layer instead of as cracks drawn on the ground, and suppress windows
  // that sit on top of an already-accepted one.
  const picked: { x: number; y: number; coverage: number; pixels: Buffer }[] = [];
  for (const cand of candidates
    .filter((c) => c.coverage <= 0.42 && c.coverage >= 0.02)
    .sort((a, b) => b.coverage - a.coverage)) {
    if (picked.length >= set.frames) break;
    const cx = cand.x + windowPx / 2;
    const cy = cand.y + windowPx / 2;
    const tooClose =
      picked.some(
        (p) =>
          Math.abs(p.x + windowPx / 2 - cx) < minSeparation &&
          Math.abs(p.y + windowPx / 2 - cy) < minSeparation,
      ) ||
      claimed.some(
        (c) =>
          Math.abs(c.cx - cx) < Math.min(c.radius, crossSetSeparation) &&
          Math.abs(c.cy - cy) < Math.min(c.radius, crossSetSeparation),
      );
    if (tooClose) continue;
    const rendered = renderFrame(cand.x, cand.y);
    // The decal's whole purpose is a mark that crosses a tile edge.
    if (rendered.span <= POOL_PX) continue;
    if (rendered.coverage < 0.01 || rendered.coverage >= 0.45) continue;
    picked.push({ ...cand, coverage: rendered.coverage, pixels: rendered.pixels });
  }
  if (picked.length < set.frames) {
    throw new Error(
      `ground decals (${set.spanTiles}x): only ${picked.length} well-separated cross-tile crack ` +
        `windows found (need ${set.frames}); the floor material may lack readable crack structure`,
    );
  }
  for (const p of picked) {
    claimed.push({
      cx: p.x + windowPx / 2,
      cy: p.y + windowPx / 2,
      radius: minSeparation,
    });
  }

  const atlas: RgbaImage = {
    width: cellPx * set.frames,
    height: cellPx,
    data: Buffer.alloc(cellPx * set.frames * cellPx * 4),
  };
  picked.forEach((win, frame) => {
    for (let y = 0; y < cellPx; y++) {
      win.pixels.copy(
        atlas.data,
        (y * atlas.width + frame * cellPx) * 4,
        y * cellPx * 4,
        (y + 1) * cellPx * 4,
      );
    }
  });
  write(set.fileName, atlas);
  console.log(
    `  ground decals ${set.spanTiles}x: ${set.frames} frames, coverage ${picked
      .map((p) => p.coverage.toFixed(3))
      .join('/')}`,
  );
}

/** Bounding-box span (in px) of the largest 4-connected component of `mask`. */
function largestConnectedSpan(mask: Uint8Array, size: number): number {
  const seen = new Uint8Array(size * size);
  let best = 0;
  for (let sy = 0; sy < size; sy++) {
    for (let sx = 0; sx < size; sx++) {
      if (seen[sy * size + sx] || !mask[sy * size + sx]) continue;
      let minX = sx;
      let maxX = sx;
      let minY = sy;
      let maxY = sy;
      const stack: number[] = [sy * size + sx];
      seen[sy * size + sx] = 1;
      while (stack.length > 0) {
        const idx = stack.pop()!;
        const cx = idx % size;
        const cy = (idx - cx) / size;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        if (cx > 0 && mask[idx - 1] && !seen[idx - 1]) {
          seen[idx - 1] = 1;
          stack.push(idx - 1);
        }
        if (cx + 1 < size && mask[idx + 1] && !seen[idx + 1]) {
          seen[idx + 1] = 1;
          stack.push(idx + 1);
        }
        if (cy > 0 && mask[idx - size] && !seen[idx - size]) {
          seen[idx - size] = 1;
          stack.push(idx - size);
        }
        if (cy + 1 < size && mask[idx + size] && !seen[idx + size]) {
          seen[idx + size] = 1;
          stack.push(idx + size);
        }
      }
      best = Math.max(best, maxX - minX + 1, maxY - minY + 1);
    }
  }
  return best;
}

function main(): void {
  const specs = FLOOR2_INDUSTRIAL_CAVE_MATERIALS;

  // Floor and corridor: two different windows of the same generated ground so
  // they read as the same cave, not as two separate art sets.
  const floorRaw = readCached(specs.floor.cacheKey);
  const floorTile: MaterialTileOptions = { ...specs.floor.tile, sizePx: POOL_PX };
  // Corridors read as more trodden: same material, slightly darker.
  const corridorTile: MaterialTileOptions = {
    ...floorTile,
    targetMeanLuminance: specs.floor.tile.targetMeanLuminance - 8,
  };

  const floorWindows = selectWindows(floorRaw, floorTile, VARIANT_COUNT);
  const corridorWindows = selectWindows(floorRaw, corridorTile, VARIANT_COUNT);

  write('floor-0.png', floorWindows.base);
  write('corridor-0.png', corridorWindows.base);

  // Real generated interiors for the pool variants, replacing procedural detail.
  write('floor-variant-src.png', buildVariantStrip(floorWindows.variants));
  write('corridor-variant-src.png', buildVariantStrip(corridorWindows.variants));

  // Wall: made seamless at a large size, then tiled to the atlas footprint. The
  // lighting pass samples this by ABSOLUTE atlas position, so a large material
  // means the generated rock's big facets span several cells instead of
  // reprinting inside every one.
  const wallRaw = readCached(specs.wall.cacheKey);
  const wallTile = toMaterialTile(wallRaw, { ...specs.wall.tile, sizePx: WALL_MATERIAL_W });
  write('wall-material.png', tileTo(wallTile, WALL_MATERIAL_W, WALL_MATERIAL_H));

  // Wall accents: the only per-tile variety a blob47 interior can have.
  buildWallAccents(readCached(specs.wallFacet.cacheKey), specs.wallFacet.tile);

  // Cross-tile crack decals — the only motif that can span tile edges.
  buildGroundDecals(floorRaw);

  // The import alone leaves the pack INVALID: `floor-0`, `corridor-0` and the
  // accents are written as raw pre-lighting material, and the pool variants
  // still derive from the previous base, so their byte-restored borders no
  // longer match. The rebuild is therefore chained here rather than documented
  // as a second command — a half-run pipeline ships art that looks like orange
  // speckle on a visible grid, and nothing but the running game catches it.
  const written = applySharedBasePoolRestyle();
  console.log(
    `\nFloor 2 source art imported; shared-base pools rebuilt (${written} PNG(s) + manifest).`,
  );
}

main();
