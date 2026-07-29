/**
 * Sprite post-processor.
 *
 * Pure, deterministic transformation from a raw generated PNG to the
 * game-ready PNG that gets handed to sensors and (eventually) the engine.
 *
 * Steps, in this exact order:
 *   1. Background removal: 4-corner flood fill -> alpha 0 on reachable pixels,
 *      plus near-background fringe and enclosed-region cleanup.
 *   2. Transparent trim: crop to the opaque bounding box, then re-pad with a
 *      small proportional transparent margin (~6% of the larger subject
 *      dimension, min 1px) on each edge so the subject stays off the frame edge.
 *   3. Resample: nearest-neighbor fit to brief.size (tiles stretch exactly).
 *   4. Background re-removal: re-key against the original background colours to
 *      clear pink fringe that nearest-neighbor stretching re-exposes.
 *   5. Speckle cleanup, palette quantize (strict only), alpha hard-threshold,
 *      and optional trim-and-fit.
 *
 * Purity contract:
 *   - No clocks (no Date.now, no performance.now).
 *   - No randomness (no Math.random; if you need ties broken, break them
 *     deterministically on index).
 *   - No environment reads (no process.env).
 *   - No network access or environment-driven behavior.
 *   - Pipeline templates are loaded from disk via a cached resolver; image
 *     processing itself remains pure for a given raw PNG + brief + palette.
 *
 * Note on signature: the spec writes `(rawPng, brief) => Buffer`, but the brief
 * carries a palette *id*, not the resolved color list. To keep this function
 * pure (no disk reads to resolve the id), we accept the resolved palette as a
 * third argument. Callers (a Phase-2 driver) load the palette JSON once and
 * pass the colors in.
 */

import { PNG } from 'pngjs';
import type { Brief, PaletteColors, RgbTriple } from './brief-schema.js';
import { getPipelineForType, getActiveModules } from './template-pipeline.js';
import { postprocessModules } from './postprocess-modules.js';
import {
  BACKGROUND_B_COLOR_TOLERANCE_SQ,
  BACKGROUND_B_FRINGE_TOLERANCE_SQ,
} from './postprocess-constants.js';

interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export type SpeckleMode = 'edge-drop' | 'preserve-orphans' | 'disabled';
export type EnclosedBackgroundMode = 'enabled' | 'disabled';

/**
 * Tight opaque bounding box of a sprite frame, in pixel coordinates relative
 * to the top-left corner of the full cell (before any cropping or resizing).
 * All four edges are inclusive. Exported for frame-sequence union-crop logic.
 */
export interface OpaqueRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface PostprocessOptions {
  /** Canonical template module names to pass through without executing. */
  readonly disabledModules?: ReadonlyArray<string>;
  readonly background?: {
    readonly colorToleranceSq?: number;
    readonly fringeToleranceSq?: number;
  };
  readonly speckle?: {
    readonly minChannel?: number;
    readonly maxOpaqueNeighbors?: number;
    readonly dropEdgeOrphans?: boolean;
  };
  readonly modules?: {
    readonly speckleMode?: SpeckleMode;
    readonly enclosedBackgroundMode?: EnclosedBackgroundMode;
  };
  /**
   * When set (for frame-sequence briefs), the `transparent-trim` module crops
   * every frame to this pre-computed union bounding box + proportional margin
   * instead of computing a per-frame tight bbox. This ensures every frame in
   * the ordered walk cycle uses the SAME crop-to-canvas mapping (identical
   * scale factor and floor-line placement) rather than a per-frame independent
   * bbox that varies with silhouette width from pose to pose.
   *
   * Computed at runtime by {@link computeFrameSequenceUnionCropRect}; do NOT
   * persist this field to disk — it must be re-derived from the current raw
   * frames on every run/rerun so it stays current if frames are regenerated.
   */
  readonly sharedCropRect?: OpaqueRect;
}

export function postprocess(
  rawPng: Buffer,
  brief: Brief,
  palette: PaletteColors,
  options: PostprocessOptions = {},
): Buffer {
  return postprocessWithTrace(rawPng, brief, palette, options).finalPng;
}

export interface PostprocessStepTrace {
  readonly id: string;
  readonly label: string;
  readonly png: Buffer;
  readonly moduleId: string;
  readonly skipped: boolean;
}

export interface PostprocessTrace {
  readonly finalPng: Buffer;
  readonly steps: ReadonlyArray<PostprocessStepTrace>;
}

/**
 * Validate and canonicalize disabled module names against the effective pipeline
 * for this brief. The pipeline order is authoritative, so persisted profiles are
 * deterministic even when the client sends duplicate or reordered names.
 */
export function normalizeDisabledModules(value: unknown, brief: Brief): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('postprocess: disabledModules must be an array of module names');
  }
  const activeNames = getActiveModules(getPipelineForType(brief.type), brief.type).map(
    ({ name }) => name,
  );
  const activeSet = new Set(activeNames);
  const requested = new Set(value as string[]);
  const invalid = [...requested].find((name) => !activeSet.has(name));
  if (invalid !== undefined) {
    throw new Error(
      `postprocess: disabledModules contains unknown or inactive module "${invalid}"`,
    );
  }
  return activeNames.filter((name) => requested.has(name));
}

/**
 * Modules that MUST be disabled for `frameSequence`-enabled briefs so every
 * frame keeps uniform scale and centering across the ordered walk cycle.
 *
 * `transparent-trim` is no longer disabled here: it now uses a pre-computed
 * union bounding box (passed as {@link PostprocessOptions.sharedCropRect}) so
 * every frame is cropped to the SAME bbox + margin before resizing. Callers
 * must supply `sharedCropRect` via {@link computeFrameSequenceUnionCropRect}.
 *
 * `trim-and-fit` is still disabled because it re-trims AFTER resize using an
 * independent per-frame bbox, which would reintroduce different centering
 * offsets per pose even after the initial crop is uniform.
 *
 * Returns `[]` for non-frame-sequence briefs (no behavior change) and filters
 * to only modules actually active for this brief's type.
 */
export function frameSequenceDisabledModules(brief: Brief): string[] {
  if (!brief.frameSequence.enabled) return [];
  const activeNames = new Set(
    getActiveModules(getPipelineForType(brief.type), brief.type).map(({ name }) => name),
  );
  return ['trim-and-fit'].filter((name) => activeNames.has(name));
}

export function postprocessWithTrace(
  rawPng: Buffer,
  brief: Brief,
  palette: PaletteColors,
  options: PostprocessOptions = {},
): PostprocessTrace {
  if (palette.length === 0) {
    throw new Error('postprocess: palette must contain at least one color');
  }

  const steps: PostprocessStepTrace[] = [];

  let image = decodePng(rawPng);
  const backgroundSource = image;

  // Load the pipeline template for this sprite type
  const pipeline = getPipelineForType(brief.type);
  const activeModules = getActiveModules(pipeline, brief.type);
  const disabledModules = new Set(normalizeDisabledModules(options.disabledModules, brief));

  // Determine if enclosed-region cleanup should run. It runs for every sprite
  // type whose pipeline keeps the `enclosed-regions` module active — i.e. all
  // types except those that explicitly disable it (tiles, vfx) or that pass it
  // in `disabledModules` at runtime, and unless the global escape hatch
  // `enclosedBackgroundMode: 'disabled'` is set. Deriving the flag from the
  // effective pipeline (rather than a hard-coded type list) also keeps
  // `background-rekey`'s post-resize enclosed-island clearing tied to the SAME
  // opt-out, so disabling `enclosed-regions` truly disables all enclosed
  // cleanup instead of leaving the rekey pass punching holes.
  const enclosedRegionMode: EnclosedBackgroundMode =
    options.modules?.enclosedBackgroundMode ?? 'enabled';
  const enclosedRegionsActive =
    activeModules.some(({ name }) => name === 'enclosed-regions') &&
    !disabledModules.has('enclosed-regions');
  const shouldRunEnclosedBackgroundCleanup =
    enclosedRegionMode !== 'disabled' && enclosedRegionsActive;

  // Execute each module in the pipeline
  for (const { name, config } of activeModules) {
    if (disabledModules.has(name)) {
      steps.push({
        id: name,
        label: config.description ?? name,
        png: encodePng(image),
        moduleId: name,
        skipped: true,
      });
      continue;
    }
    const handler = postprocessModules[config.type];
    if (!handler) {
      throw new Error(`Unknown module type: ${config.type} (from module: ${name})`);
    }

    // Apply options overrides to module params
    const moduleParams: Record<string, unknown> = { ...config.params };
    if (config.type === 'background-removal' && options.background) {
      if (options.background.colorToleranceSq !== undefined) {
        moduleParams.colorToleranceSq = options.background.colorToleranceSq;
      }
      if (options.background.fringeToleranceSq !== undefined) {
        moduleParams.fringeToleranceSq = options.background.fringeToleranceSq;
      }
    }
    if (
      (config.type === 'enclosed-region-cleanup' || config.type === 'background-rekey') &&
      options.background?.fringeToleranceSq !== undefined
    ) {
      moduleParams.fringeToleranceSq = options.background.fringeToleranceSq;
    }
    if (config.type === 'speckle-cleanup' && options.speckle) {
      if (options.speckle.minChannel !== undefined) {
        moduleParams.minChannel = options.speckle.minChannel;
      }
      if (options.speckle.maxOpaqueNeighbors !== undefined) {
        moduleParams.maxOpaqueNeighbors = options.speckle.maxOpaqueNeighbors;
      }
      if (options.speckle.dropEdgeOrphans !== undefined) {
        moduleParams.dropEdgeOrphans = options.speckle.dropEdgeOrphans;
      }
    }
    if (config.type === 'speckle-cleanup' && options.modules?.speckleMode !== undefined) {
      moduleParams.mode = options.modules.speckleMode;
    }

    image = handler(image, moduleParams, {
      brief,
      palette,
      pushStep: (id: string, label: string, stepImage: RgbaImage): void => {
        steps.push({
          id,
          label,
          png: encodePng(stepImage),
          moduleId: name,
          skipped: false,
        });
      },
      backgroundSource,
      shouldRunEnclosedBackgroundCleanup,
      sharedCropRect: options.sharedCropRect,
    });
  }

  return { finalPng: encodePng(image), steps };
}

/**
 * Replace isolated near-white opaque pixels (often random model speckles) with
 * the dominant neighboring opaque color. If none are found, only drop the
 * pixel when it is on a transparency edge; otherwise preserve interior pixels.
 */
export function removeIsolatedNearWhiteSpeckles(
  image: RgbaImage,
  opts: { minChannel?: number; maxOpaqueNeighbors?: number; dropEdgeOrphans?: boolean } = {},
): RgbaImage {
  const minChannel = opts.minChannel ?? 245;
  const maxOpaqueNeighbors = opts.maxOpaqueNeighbors ?? 8;
  const dropEdgeOrphans = opts.dropEdgeOrphans ?? true;
  const { width, height, data: src } = image;
  const dst = new Uint8Array(src);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const a = src[idx + 3] ?? 0;
      if (a === 0) continue;
      const r = src[idx] ?? 0;
      const g = src[idx + 1] ?? 0;
      const b = src[idx + 2] ?? 0;
      if (r < minChannel || g < minChannel || b < minChannel) continue;
      let opaqueNeighbors = 0;
      let touchesTransparent = false;
      const neighborColors = new Map<string, number>();
      for (let ny = y - 1; ny <= y + 1; ny++) {
        for (let nx = x - 1; nx <= x + 1; nx++) {
          if (nx === x && ny === y) continue;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nIdx = (ny * width + nx) * 4;
          const na = src[nIdx + 3] ?? 0;
          if (na === 0) {
            touchesTransparent = true;
            continue;
          }
          opaqueNeighbors++;
          const nr = src[nIdx] ?? 0;
          const ng = src[nIdx + 1] ?? 0;
          const nb = src[nIdx + 2] ?? 0;
          if (nr >= minChannel && ng >= minChannel && nb >= minChannel) continue;
          const key = `${nr},${ng},${nb}`;
          neighborColors.set(key, (neighborColors.get(key) ?? 0) + 1);
        }
      }
      // Always clean near-white fringe pixels that touch transparency, even if
      // they are part of a larger white cluster (common after bg removal).
      if (opaqueNeighbors > maxOpaqueNeighbors && !touchesTransparent) continue;
      let chosen: string | null = null;
      let chosenCount = -1;
      for (const [key, count] of neighborColors.entries()) {
        if (count > chosenCount) {
          chosen = key;
          chosenCount = count;
        }
      }
      if (chosen) {
        const [nr, ng, nb] = chosen.split(',').map((v) => Number(v));
        dst[idx] = nr ?? 255;
        dst[idx + 1] = ng ?? 255;
        dst[idx + 2] = nb ?? 255;
      } else if (touchesTransparent && dropEdgeOrphans) {
        // Edge-adjacent near-white with no usable neighbors is usually a
        // background remnant; clear it so it can't become a solid artifact.
        dst[idx + 3] = 0;
      }
    }
  }
  return { width, height, data: dst };
}

function decodePng(buffer: Buffer): RgbaImage {
  const png = PNG.sync.read(buffer);
  // pngjs gives us a Buffer; treat it as a Uint8Array view so the rest of the
  // pipeline is buffer-agnostic.
  return {
    width: png.width,
    height: png.height,
    data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength),
  };
}

function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png);
}

/**
 * Mark every pixel reachable from any of the 4 corners (4-connected flood fill,
 * matching the corner pixel's RGB within `BACKGROUND_COLOR_TOLERANCE_SQ` in
 * squared Euclidean RGB distance) with alpha 0. Disconnected interior pixels
 * of the same color are preserved.
 *
 * The tolerance exists because model-generated PNGs rarely have a perfectly
 * uniform background — gpt-image-1 returns near-white with single-channel
 * deviations of 1-12 around the corners, which an exact-RGB flood fill misses
 * entirely (resulting in 100%-opaque sprites). 32 channels (≈ 12%) of squared
 * tolerance is conservative enough to leave saturated foreground intact
 * because foreground colors are typically ≥ ~80 channels away from white,
 * black, or magenta in any axis.
 *
 * Exported for direct unit testing.
 */
const BACKGROUND_COLOR_TOLERANCE_SQ = 32 * 32; // squared Euclidean RGB tolerance
export { BACKGROUND_B_COLOR_TOLERANCE_SQ, BACKGROUND_B_FRINGE_TOLERANCE_SQ };
/**
 * Minimum pixel area for an enclosed background-coloured region to be cleared.
 *
 * Enclosure (a region the edge flood cannot reach) is the primary gate; this
 * threshold only suppresses 1-3px interior specks that happen to match the
 * background colour. There is intentionally NO upper size cap — a large trapped
 * pocket (the gap between a character's legs) is exactly what we want to clear.
 */
const BACKGROUND_B_ENCLOSED_MIN_AREA = 4;

export function removeBackground(
  image: RgbaImage,
  toleranceSq: number = BACKGROUND_COLOR_TOLERANCE_SQ,
): RgbaImage {
  const { width, height } = image;
  const out = new Uint8Array(image.data);
  const total = width * height;
  if (total === 0) return { width, height, data: out };

  const visited = new Uint8Array(total);
  const corners: ReadonlyArray<[number, number]> = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];

  for (const [cx, cy] of corners) {
    const cIdx = (cy * width + cx) * 4;
    const cr = out[cIdx] ?? 0;
    const cg = out[cIdx + 1] ?? 0;
    const cb = out[cIdx + 2] ?? 0;
    const ca = out[cIdx + 3] ?? 0;
    // If the corner is already transparent, there's nothing meaningful to
    // flood — but we still mark it transparent so the result is idempotent.
    if (ca === 0) {
      out[cIdx + 3] = 0;
      visited[cy * width + cx] = 1;
      continue;
    }
    floodFill(out, visited, width, height, cx, cy, cr, cg, cb, toleranceSq);
  }

  return { width, height, data: out };
}

export function removeBackgroundB(
  image: RgbaImage,
  options: {
    readonly colorToleranceSq?: number;
    readonly fringeToleranceSq?: number;
    readonly clearEnclosedIslands?: boolean;
  } = {},
): RgbaImage {
  const colorToleranceSq = options.colorToleranceSq ?? BACKGROUND_B_COLOR_TOLERANCE_SQ;
  const fringeToleranceSq = options.fringeToleranceSq ?? BACKGROUND_B_FRINGE_TOLERANCE_SQ;
  const flooded = removeBackground(image, colorToleranceSq);
  const fringeCleaned = removeBackgroundFringe(flooded, image, fringeToleranceSq);
  if (!(options.clearEnclosedIslands ?? true)) return fringeCleaned;
  return removeEnclosedBackgroundRegions(fringeCleaned, image, fringeToleranceSq);
}

export function removeEnclosedBackgroundRegions(
  image: RgbaImage,
  source: RgbaImage,
  toleranceSq: number = BACKGROUND_B_FRINGE_TOLERANCE_SQ,
  seedToleranceSq: number = BACKGROUND_B_COLOR_TOLERANCE_SQ,
): RgbaImage {
  const { width, height } = image;
  if (width === 0 || height === 0) return image;
  const dst = new Uint8Array(image.data);
  const cornerColors = getCornerColors(source);
  if (cornerColors.length === 0) return { width, height, data: dst };
  clearEnclosedBackgroundRegions(dst, width, height, cornerColors, toleranceSq, seedToleranceSq);
  return { width, height, data: dst };
}

/**
 * Re-run background removal on an image that was already keyed once but has
 * since passed through a resampling (resize) step.
 *
 * Nearest-neighbor scaling can duplicate partially-keyed boundary samples and
 * re-expose background-coloured (e.g. magenta) fringe pixels — "stretching
 * brings the pink back". This re-keys against the ORIGINAL background colours,
 * read from `source`'s corners, rather than the resized image's own corners:
 * after a fit-resize the subject sits in a transparent-padded canvas, so the
 * post-resize corners are the padding colour (0,0,0), and keying on that would
 * eat dark foreground instead of the background. Keying on the original corner
 * colours clears reintroduced fringe while leaving foreground intact.
 *
 * Exported for direct unit testing.
 */
export function removeReintroducedBackground(
  image: RgbaImage,
  source: RgbaImage,
  options: { readonly fringeToleranceSq?: number; readonly clearEnclosedIslands?: boolean } = {},
): RgbaImage {
  const fringeToleranceSq = options.fringeToleranceSq ?? BACKGROUND_B_FRINGE_TOLERANCE_SQ;
  const fringeCleaned = removeBackgroundFringe(image, source, fringeToleranceSq);
  if (!(options.clearEnclosedIslands ?? true)) return fringeCleaned;
  return removeEnclosedBackgroundRegions(fringeCleaned, source, fringeToleranceSq);
}

function removeBackgroundFringe(
  flooded: RgbaImage,
  source: RgbaImage,
  toleranceSq: number,
): RgbaImage {
  const { width, height } = flooded;
  if (width === 0 || height === 0) return flooded;
  const dst = new Uint8Array(flooded.data);
  const cornerColors = getCornerColors(source);
  const queue: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if ((dst[idx + 3] ?? 0) === 0) queue.push(x, y);
    }
  }
  const offsets: ReadonlyArray<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  while (queue.length > 0) {
    const y = queue.pop() as number;
    const x = queue.pop() as number;
    for (const [dx, dy] of offsets) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const idx = (ny * width + nx) * 4;
      if ((dst[idx + 3] ?? 0) === 0) continue;
      if (!isNearCornerColor(dst, idx, cornerColors, toleranceSq)) continue;
      dst[idx + 3] = 0;
      queue.push(nx, ny);
    }
  }
  return { width, height, data: dst };
}

/**
 * Clear enclosed background-coloured regions in place.
 *
 * Algorithm (topology-gated, no shape/size/colour-family heuristics):
 *   1. A pixel is a "background candidate" if it is opaque AND its colour is
 *      within `toleranceSq` of any corner (background) colour.
 *   2. Flood-fill (4-connected) candidate pixels into connected components.
 *   3. A component is "enclosed" iff none of its pixels touch the image border.
 *   4. A component is "seeded" iff at least one of its pixels is within the
 *      much tighter `seedToleranceSq` of a corner colour.
 *   5. Clear (make transparent) every enclosed, seeded component whose area is
 *      at least `BACKGROUND_B_ENCLOSED_MIN_AREA`.
 *
 * WHY THE TWO THRESHOLDS (do not collapse them back into one):
 *
 * `toleranceSq` here is the *fringe* tolerance (~12000, a radius of ~110 in RGB
 * space). That radius is correct for clearing the anti-aliased magenta halo that
 * blends into the subject, but it is far too loose to *decide* that a pixel is
 * background on its own: warm mid-tones sit inside it. Measured against the real
 * magenta key rgb(182,51,135), a tan/leather rgb(207,127,69) is only 10757 away —
 * comfortably inside 12000. So a single loose threshold punched holes straight
 * through skin, leather and cloth.
 *
 * The docstring used to claim "shadows and shaded body pixels sit far from the
 * pure background colour, so they are never candidates". That is false for warm
 * mid-tones against a magenta key, and it was silently eating foreground: across
 * a 1617-sample sweep of generated runs, ~50% of all pixels this function cleared
 * (532825 -> 268135) were false positives, and 415 samples had NOTHING genuine to
 * clear yet still lost pixels.
 *
 * Edge keying gets away with the loose radius because its flood is anchored to
 * already-transparent exterior pixels — contiguity with known background is the
 * evidence. An enclosed region has no such anchor, so it must supply its own:
 * at least one pixel that matches the background under the strict tolerance.
 * Growth then proceeds at the loose tolerance, so a genuine trapped pocket still
 * gets its halo cleaned; a speckle cluster of skin tone never seeds and survives.
 */
function clearEnclosedBackgroundRegions(
  data: Uint8Array,
  width: number,
  height: number,
  cornerColors: ReadonlyArray<[number, number, number]>,
  toleranceSq: number,
  seedToleranceSq: number,
): void {
  const total = width * height;
  if (total === 0) return;

  const distanceSq = (idx: number): number => {
    const offset = idx * 4;
    const r = data[offset] ?? 0;
    const g = data[offset + 1] ?? 0;
    const b = data[offset + 2] ?? 0;
    let min = Number.POSITIVE_INFINITY;
    for (const [cr, cg, cb] of cornerColors) {
      const dr = r - cr;
      const dg = g - cg;
      const db = b - cb;
      const d = dr * dr + dg * dg + db * db;
      if (d < min) min = d;
    }
    return min;
  };

  const isCandidate = (idx: number): boolean => {
    const alpha = data[idx * 4 + 3] ?? 0;
    if (alpha === 0) return false;
    return distanceSq(idx) <= toleranceSq;
  };

  const isSeed = (idx: number): boolean => {
    const alpha = data[idx * 4 + 3] ?? 0;
    if (alpha === 0) return false;
    return distanceSq(idx) <= seedToleranceSq;
  };

  const visited = new Uint8Array(total);
  const stack: number[] = [];

  for (let start = 0; start < total; start += 1) {
    if (visited[start]) continue;
    visited[start] = 1;
    if (!isCandidate(start)) continue;

    // BFS/DFS over this connected component of background-coloured pixels.
    const component: number[] = [];
    let touchesEdge = false;
    let hasSeed = false;
    stack.length = 0;
    stack.push(start);

    while (stack.length > 0) {
      const idx = stack.pop() as number;
      component.push(idx);
      if (!hasSeed && isSeed(idx)) hasSeed = true;

      const x = idx % width;
      const y = (idx - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        touchesEdge = true;
      }

      // 4-connected neighbours.
      if (x > 0) {
        const n = idx - 1;
        if (!visited[n]) {
          visited[n] = 1;
          if (isCandidate(n)) stack.push(n);
        }
      }
      if (x < width - 1) {
        const n = idx + 1;
        if (!visited[n]) {
          visited[n] = 1;
          if (isCandidate(n)) stack.push(n);
        }
      }
      if (y > 0) {
        const n = idx - width;
        if (!visited[n]) {
          visited[n] = 1;
          if (isCandidate(n)) stack.push(n);
        }
      }
      if (y < height - 1) {
        const n = idx + width;
        if (!visited[n]) {
          visited[n] = 1;
          if (isCandidate(n)) stack.push(n);
        }
      }
    }

    if (touchesEdge) continue;
    if (!hasSeed) continue;
    if (component.length < BACKGROUND_B_ENCLOSED_MIN_AREA) continue;

    for (const idx of component) {
      data[idx * 4 + 3] = 0;
    }
  }
}

function isNearCornerColor(
  data: Uint8Array,
  idx: number,
  cornerColors: ReadonlyArray<[number, number, number]>,
  toleranceSq: number,
): boolean {
  return minCornerColorDistanceSq(data, idx, cornerColors) <= toleranceSq;
}

function minCornerColorDistanceSq(
  data: Uint8Array,
  idx: number,
  cornerColors: ReadonlyArray<[number, number, number]>,
): number {
  const r = data[idx] ?? 0;
  const g = data[idx + 1] ?? 0;
  const b = data[idx + 2] ?? 0;
  let minDistanceSq = Number.POSITIVE_INFINITY;
  for (const [cr, cg, cb] of cornerColors) {
    const dr = r - cr;
    const dg = g - cg;
    const db = b - cb;
    const distanceSq = dr * dr + dg * dg + db * db;
    if (distanceSq < minDistanceSq) minDistanceSq = distanceSq;
  }
  return minDistanceSq;
}

function getCornerColors(image: RgbaImage): ReadonlyArray<[number, number, number]> {
  const { width, height, data } = image;
  if (width === 0 || height === 0) return [];
  const corners: ReadonlyArray<[number, number]> = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];
  return corners.map(([x, y]) => {
    const idx = (y * width + x) * 4;
    return [
      (data[idx] ?? 0) as number,
      (data[idx + 1] ?? 0) as number,
      (data[idx + 2] ?? 0) as number,
    ];
  });
}

function floodFill(
  data: Uint8Array,
  visited: Uint8Array,
  width: number,
  height: number,
  startX: number,
  startY: number,
  r: number,
  g: number,
  b: number,
  toleranceSq: number,
): void {
  // Iterative stack-based 4-connected flood fill. We avoid recursion so this
  // works on large images without blowing the call stack.
  const stack: number[] = [startX, startY];
  while (stack.length > 0) {
    const y = stack.pop() as number;
    const x = stack.pop() as number;
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    const linear = y * width + x;
    if (visited[linear]) continue;
    const idx = linear * 4;
    const dr = (data[idx] ?? 0) - r;
    const dg = (data[idx + 1] ?? 0) - g;
    const db = (data[idx + 2] ?? 0) - b;
    if (dr * dr + dg * dg + db * db > toleranceSq) continue;
    visited[linear] = 1;
    data[idx + 3] = 0;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
}

/**
 * Fraction of the trimmed subject's larger dimension kept as a transparent
 * margin on every edge by the trim phase. ~6% leaves the subject occupying
 * roughly 88-90% of its dominant axis after the fit-resize, which keeps the
 * main silhouette off the frame edge (so `opaque-bbox-fits` still passes) while
 * maximising pixel utilisation.
 *
 * Exported for direct unit testing.
 */
export const SUBJECT_TRIM_MARGIN_FRACTION = 0.06;

/**
 * Per-edge transparent margin (in pixels) for a trimmed subject of the given
 * dimensions. At least 1px so there is always a transparent border for the
 * post-resize background re-removal to flood from.
 *
 * Exported for direct unit testing.
 */
export function subjectTrimMarginPx(width: number, height: number): number {
  const maxDim = Math.max(width, height);
  return Math.max(1, Math.round(maxDim * SUBJECT_TRIM_MARGIN_FRACTION));
}

export function fitWithinNearest(
  image: RgbaImage,
  boxW: number,
  boxH: number,
  strategy: 'fit' | 'width' | 'height' | 'cover' | 'stretch' = 'fit',
): { image: RgbaImage; fittedWidth: number; fittedHeight: number } {
  const { width: srcW, height: srcH } = image;
  if (srcW <= 0 || srcH <= 0) {
    return {
      image: { width: boxW, height: boxH, data: new Uint8Array(boxW * boxH * 4) },
      fittedWidth: 0,
      fittedHeight: 0,
    };
  }
  if (strategy === 'stretch') {
    return {
      image: upscaleNearest(image, boxW, boxH),
      fittedWidth: boxW,
      fittedHeight: boxH,
    };
  }
  const scale =
    strategy === 'width'
      ? boxW / srcW
      : strategy === 'height'
        ? boxH / srcH
        : strategy === 'cover'
          ? Math.max(boxW / srcW, boxH / srcH)
          : Math.min(boxW / srcW, boxH / srcH);
  const fittedWidth =
    strategy === 'width'
      ? boxW
      : Math.max(
          1,
          strategy === 'fit' ? Math.min(boxW, Math.round(srcW * scale)) : Math.round(srcW * scale),
        );
  const fittedHeight =
    strategy === 'height'
      ? boxH
      : Math.max(
          1,
          strategy === 'fit' ? Math.min(boxH, Math.round(srcH * scale)) : Math.round(srcH * scale),
        );
  const scaled = upscaleNearest(image, fittedWidth, fittedHeight);
  const outW = strategy === 'height' || strategy === 'cover' ? Math.max(boxW, fittedWidth) : boxW;
  const outH = strategy === 'width' || strategy === 'cover' ? Math.max(boxH, fittedHeight) : boxH;
  const out = new Uint8Array(outW * outH * 4);
  const offsetX = Math.floor((outW - fittedWidth) / 2);
  const offsetY = Math.floor((outH - fittedHeight) / 2);
  for (let y = 0; y < fittedHeight; y++) {
    for (let x = 0; x < fittedWidth; x++) {
      const srcIdx = (y * fittedWidth + x) * 4;
      const dstIdx = ((offsetY + y) * outW + (offsetX + x)) * 4;
      out[dstIdx] = scaled.data[srcIdx] ?? 0;
      out[dstIdx + 1] = scaled.data[srcIdx + 1] ?? 0;
      out[dstIdx + 2] = scaled.data[srcIdx + 2] ?? 0;
      out[dstIdx + 3] = scaled.data[srcIdx + 3] ?? 0;
    }
  }
  return {
    image: { width: outW, height: outH, data: out },
    fittedWidth,
    fittedHeight,
  };
}

/**
 * Snap every opaque pixel's RGB to the nearest palette entry by Euclidean
 * distance. Transparent pixels (alpha === 0) are left untouched in RGB and
 * keep alpha 0.
 *
 * Tie-breaking: the *first* palette entry at minimum distance wins. This
 * makes quantization deterministic regardless of palette order beyond ties.
 *
 * Exported for direct unit testing.
 */
export function quantizeToPalette(image: RgbaImage, palette: PaletteColors): RgbaImage {
  if (palette.length === 0) {
    throw new Error('quantizeToPalette: palette must be non-empty');
  }
  const { width, height, data: src } = image;
  const dst = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3] ?? 0;
    if (a === 0) {
      // preserve transparent pixels, including their RGB (avoids leaking
      // bg color into anything that later inspects raw RGB)
      dst[i] = src[i] ?? 0;
      dst[i + 1] = src[i + 1] ?? 0;
      dst[i + 2] = src[i + 2] ?? 0;
      dst[i + 3] = 0;
      continue;
    }
    const r = src[i] ?? 0;
    const g = src[i + 1] ?? 0;
    const b = src[i + 2] ?? 0;
    const nearest = nearestPaletteEntry(r, g, b, palette);
    dst[i] = nearest[0];
    dst[i + 1] = nearest[1];
    dst[i + 2] = nearest[2];
    dst[i + 3] = a;
  }
  return { width, height, data: dst };
}

function nearestPaletteEntry(r: number, g: number, b: number, palette: PaletteColors): RgbTriple {
  let bestIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i] as RgbTriple;
    const dr = r - c[0];
    const dg = g - c[1];
    const db = b - c[2];
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
      if (dist === 0) break; // exact match; no need to continue
    }
  }
  return palette[bestIdx] as RgbTriple;
}

/**
 * Force every alpha channel to either 0 or 255 using a 128 threshold.
 * Eliminates anti-aliased fringes that the generator might produce; the
 * post-processor never ships partially-transparent pixels.
 *
 * Exported for direct unit testing.
 */
export function hardThresholdAlpha(image: RgbaImage): RgbaImage {
  const { width, height, data: src } = image;
  const dst = new Uint8Array(src);
  for (let i = 3; i < dst.length; i += 4) {
    dst[i] = (dst[i] ?? 0) > 128 ? 255 : 0;
  }
  return { width, height, data: dst };
}

/**
 * Trim fully-transparent rows and columns from all 4 edges.
 *
 * A row is "empty" if every pixel in it has alpha === 0.
 * A column is "empty" if every pixel in it has alpha === 0.
 *
 * When `border` is 0 (the default) the result is the tight opaque bounding box.
 * When `border` is > 0, that many fully-transparent rows/columns are added back
 * on every edge, so the result is the opaque bounding box surrounded by a
 * uniform transparent margin (e.g. `border = 1` keeps exactly one transparent
 * row/column on each edge).
 *
 * Returns the cropped sub-image. If the image is entirely transparent,
 * returns a 0×0 image (callers should guard against this).
 *
 * Exported for direct unit testing.
 */
export function trimTransparentEdges(image: RgbaImage, border = 0): RgbaImage {
  const { width, height, data } = image;
  if (width === 0 || height === 0) return { width: 0, height: 0, data: new Uint8Array(0) };

  // Find bounding box of non-transparent pixels.
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3] ?? 0;
      if (a > 0) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }

  // Entirely transparent — return empty.
  if (bottom === -1) return { width: 0, height: 0, data: new Uint8Array(0) };

  const pad = Math.max(0, Math.trunc(border));
  const contentW = right - left + 1;
  const contentH = bottom - top + 1;
  const newW = contentW + pad * 2;
  const newH = contentH + pad * 2;
  const dst = new Uint8Array(newW * newH * 4);
  for (let y = 0; y < contentH; y++) {
    const srcRow = (top + y) * width + left;
    const dstRow = (y + pad) * newW + pad;
    for (let x = 0; x < contentW; x++) {
      const si = (srcRow + x) * 4;
      const di = (dstRow + x) * 4;
      dst[di] = data[si] ?? 0;
      dst[di + 1] = data[si + 1] ?? 0;
      dst[di + 2] = data[si + 2] ?? 0;
      dst[di + 3] = data[si + 3] ?? 0;
    }
  }
  return { width: newW, height: newH, data: dst };
}

/**
 * Nearest-neighbor upscale so that the smallest dimension equals `minPx`.
 * If the image is already >= minPx on both axes, returns unchanged.
 * Maintains aspect ratio (both axes scale by the same integer or fractional factor).
 *
 * Exported for direct unit testing.
 */
export function scaleToMinDimension(image: RgbaImage, minPx: number): RgbaImage {
  const { width, height } = image;
  if (width === 0 || height === 0) return image;
  const minCurrent = Math.min(width, height);
  if (minCurrent >= minPx) return image;

  const scale = minPx / minCurrent;
  const dstW = Math.round(width * scale);
  const dstH = Math.round(height * scale);
  // Reuse the existing nearest-neighbor scaler (it handles up AND down).
  return upscaleNearest(image, dstW, dstH);
}

/**
 * Nearest-neighbor scale (works for both up and down). Same deterministic
 * logic as downscaleNearest but as a separate export for clarity.
 */
function upscaleNearest(image: RgbaImage, dstW: number, dstH: number): RgbaImage {
  const { width: srcW, height: srcH, data: src } = image;
  const dst = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor(((y + 0.5) * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor(((x + 0.5) * srcW) / dstW));
      const srcIdx = (sy * srcW + sx) * 4;
      const dstIdx = (y * dstW + x) * 4;
      dst[dstIdx] = src[srcIdx] ?? 0;
      dst[dstIdx + 1] = src[srcIdx + 1] ?? 0;
      dst[dstIdx + 2] = src[srcIdx + 2] ?? 0;
      dst[dstIdx + 3] = src[srcIdx + 3] ?? 0;
    }
  }
  return { width: dstW, height: dstH, data: dst };
}

// Re-export the internal image type so tests can build images without going
// through PNG encoding/decoding.
export type { RgbaImage };

/**
 * Compute the tight opaque bounding box of an image WITHOUT creating a new
 * cropped image. Returns null when the image is entirely transparent.
 *
 * Used by {@link computeFrameSequenceUnionCropRect} to derive a shared crop
 * rect across all frames of a walk-cycle brief.
 */
export function computeOpaqueRect(image: RgbaImage): OpaqueRect | null {
  const { width, height, data } = image;
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3] ?? 0;
      if (a > 0) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (bottom === -1) return null;
  return { left, top, right, bottom };
}

/**
 * Crop a source image to the given rect (inclusive on all sides) plus a
 * uniform `margin` padding on every edge. Source pixels outside the image
 * bounds default to fully transparent. Returns an image of dimensions
 * `(right - left + 1 + 2*margin) × (bottom - top + 1 + 2*margin)`.
 *
 * Used by the `transparent-trim` module when {@link PostprocessOptions.sharedCropRect}
 * is set, so all frames in a walk-cycle brief are cropped to the same bbox.
 */
export function cropRectWithMargin(image: RgbaImage, rect: OpaqueRect, margin: number): RgbaImage {
  const m = Math.max(0, Math.trunc(margin));
  const contentW = Math.max(0, rect.right - rect.left + 1);
  const contentH = Math.max(0, rect.bottom - rect.top + 1);
  const newW = contentW + m * 2;
  const newH = contentH + m * 2;
  if (newW === 0 || newH === 0) return { width: 0, height: 0, data: new Uint8Array(0) };
  const dst = new Uint8Array(newW * newH * 4); // initialized to 0 (transparent)
  for (let y = 0; y < contentH; y++) {
    const srcY = rect.top + y;
    if (srcY < 0 || srcY >= image.height) continue;
    const srcRowBase = srcY * image.width;
    const dstRowBase = (y + m) * newW;
    for (let x = 0; x < contentW; x++) {
      const srcX = rect.left + x;
      if (srcX < 0 || srcX >= image.width) continue;
      const si = (srcRowBase + srcX) * 4;
      const di = (dstRowBase + x + m) * 4;
      dst[di] = image.data[si] ?? 0;
      dst[di + 1] = image.data[si + 1] ?? 0;
      dst[di + 2] = image.data[si + 2] ?? 0;
      dst[di + 3] = image.data[si + 3] ?? 0;
    }
  }
  return { width: newW, height: newH, data: dst };
}

/**
 * Compute the UNION opaque bounding box across all raw frame PNGs in a
 * frame-sequence brief. Each frame is decoded and passed through a minimal
 * background-removal pass so background pixels do not inflate the bbox.
 *
 * Returns null when all frames are fully transparent (degenerate; the
 * `transparent-trim` module skips trimming when it receives null and leaves
 * the frame unchanged).
 *
 * This is the ONLY source of truth for the shared-crop rect that
 * `postprocessWithTrace` uses (via {@link PostprocessOptions.sharedCropRect})
 * to give every frame in a walk cycle the same scale factor and floor-line
 * placement. Callers MUST recompute this value from the current raw frames
 * on every run/rerun rather than persisting it to disk.
 */
export function computeFrameSequenceUnionCropRect(
  rawPngs: ReadonlyArray<Buffer>,
): OpaqueRect | null {
  if (rawPngs.length === 0) return null;
  let unionLeft = Infinity;
  let unionTop = Infinity;
  let unionRight = -Infinity;
  let unionBottom = -Infinity;
  let foundAny = false;
  for (const raw of rawPngs) {
    const image = decodePng(raw);
    // Run the same flood-fill background removal the pipeline uses so the bbox
    // only covers the character/subject, not the model-generated background.
    const bgRemoved = removeBackgroundB(image);
    const rect = computeOpaqueRect(bgRemoved);
    if (rect !== null) {
      foundAny = true;
      if (rect.left < unionLeft) unionLeft = rect.left;
      if (rect.top < unionTop) unionTop = rect.top;
      if (rect.right > unionRight) unionRight = rect.right;
      if (rect.bottom > unionBottom) unionBottom = rect.bottom;
    }
  }
  return foundAny
    ? { left: unionLeft, top: unionTop, right: unionRight, bottom: unionBottom }
    : null;
}
