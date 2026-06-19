/**
 * Sprite post-processor.
 *
 * Pure, deterministic transformation from a raw generated PNG to the
 * game-ready PNG that gets handed to sensors and (eventually) the engine.
 *
 * Steps, in this exact order:
 *   1. Background removal: 4-corner flood fill -> alpha 0 on reachable pixels.
 *   2. Resample: nearest-neighbor fit to brief.size (preserve aspect ratio).
 *   3. Palette quantize: snap each opaque pixel to its nearest palette entry
 *      by Euclidean RGB distance.
 *   4. Alpha hard-threshold: alpha > 128 -> 255, else -> 0.
 *
 * Purity contract:
 *   - No clocks (no Date.now, no performance.now).
 *   - No randomness (no Math.random; if you need ties broken, break them
 *     deterministically on index).
 *   - No environment reads (no process.env).
 *   - No filesystem access. The function takes the raw PNG bytes and returns
 *     the encoded result.
 *
 * Note on signature: the spec writes `(rawPng, brief) => Buffer`, but the brief
 * carries a palette *id*, not the resolved color list. To keep this function
 * pure (no disk reads to resolve the id), we accept the resolved palette as a
 * third argument. Callers (a Phase-2 driver) load the palette JSON once and
 * pass the colors in.
 */

import { PNG } from 'pngjs';
import type { Brief, PaletteColors, RgbTriple } from './brief-schema.js';

interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export type SpeckleMode = 'edge-drop' | 'preserve-orphans' | 'disabled';
export type EnclosedBackgroundMode = 'enabled' | 'disabled';

export interface PostprocessOptions {
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
}

export interface PostprocessTrace {
  readonly finalPng: Buffer;
  readonly steps: ReadonlyArray<PostprocessStepTrace>;
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
  const pushStep = (id: string, label: string, image: RgbaImage): void => {
    steps.push({ id, label, png: encodePng(image) });
  };

  let image = decodePng(rawPng);
  const backgroundSource = image;
  const defaultBackgroundColorToleranceSq = BACKGROUND_B_COLOR_TOLERANCE_SQ;
  const backgroundColorToleranceSq = normalizeTolerance(
    options.background?.colorToleranceSq,
    defaultBackgroundColorToleranceSq,
  );
  const backgroundFringeToleranceSq = normalizeTolerance(
    options.background?.fringeToleranceSq,
    BACKGROUND_B_FRINGE_TOLERANCE_SQ,
  );
  image = removeBackgroundB(image, {
    colorToleranceSq: backgroundColorToleranceSq,
    fringeToleranceSq: backgroundFringeToleranceSq,
    clearEnclosedIslands: false,
  });
  pushStep('background-removal', 'Background removal', image);
  const enclosedRegionMode: EnclosedBackgroundMode =
    options.modules?.enclosedBackgroundMode ?? 'enabled';
  const shouldRunEnclosedBackgroundCleanup =
    enclosedRegionMode !== 'disabled' && (brief.type === 'enemy' || brief.type === 'character');
  if (shouldRunEnclosedBackgroundCleanup) {
    image = removeEnclosedBackgroundRegions(image, backgroundSource, backgroundFringeToleranceSq);
    pushStep('background-enclosed-regions', 'Background enclosed-region cleanup', image);
  } else {
    pushStep(
      'background-enclosed-regions-disabled',
      'Background enclosed-region cleanup (disabled)',
      image,
    );
  }

  const fitMode = brief.type === 'enemy' || brief.type === 'character';
  const fitResize = fitWithinNearest(image, brief.size.width, brief.size.height, fitMode);
  image = fitResize.image;
  pushStep(
    'resize-nearest',
    fitMode
      ? `Resize (nearest-fit, ${fitResize.fittedWidth}x${fitResize.fittedHeight} in ${image.width}x${image.height})`
      : `Resize (nearest, ${image.width}x${image.height})`,
    image,
  );

  const speckleMode = options.modules?.speckleMode ?? 'edge-drop';
  if (speckleMode !== 'disabled') {
    image = removeIsolatedNearWhiteSpeckles(image, {
      ...options.speckle,
      ...(speckleMode === 'preserve-orphans' ? { dropEdgeOrphans: false } : {}),
    });
    pushStep('speckle-cleanup', `Speckle cleanup (${speckleMode})`, image);
  } else {
    pushStep('speckle-cleanup-disabled', 'Speckle cleanup (disabled)', image);
  }

  if (brief.postprocessing?.paletteMode === 'strict') {
    image = quantizeToPalette(image, palette);
    pushStep('palette-quantize', 'Palette quantize (strict)', image);
  } else {
    pushStep('palette-quantize-skipped', 'Palette quantize (skipped)', image);
  }

  image = hardThresholdAlpha(image);
  pushStep('alpha-threshold', 'Alpha threshold', image);

  if (brief.postprocessing?.trimAndFit) {
    const trimmed = trimTransparentEdges(image);
    if (trimmed.width > 0 && trimmed.height > 0) {
      const minDim = brief.postprocessing.minDimension ?? 64;
      image = scaleToMinDimension(trimmed, minDim);
      pushStep('trim-fit', `Trim + fit (${minDim}px min)`, image);
    }
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
export const BACKGROUND_COLOR_TOLERANCE_SQ = 32 * 32; // squared Euclidean RGB tolerance
export const BACKGROUND_FRINGE_TOLERANCE_SQ = 56 * 56; // post-flood edge cleanup tolerance
export const BACKGROUND_B_COLOR_TOLERANCE_SQ = 4000; // fringe-clean default flood-fill tolerance
export const BACKGROUND_B_FRINGE_TOLERANCE_SQ = 12000; // fringe-clean default cleanup tolerance
export const BACKGROUND_B_MAX_ENCLOSED_ISLAND_PIXELS = 256;
export const BACKGROUND_B_ENCLOSED_MAX_COMPONENT_DISTANCE_SQ = 25000;
export const BACKGROUND_B_CENTER_SEED_TOLERANCE_SQ = 40000;
export const BACKGROUND_B_CENTER_FILL_MIN_AREA = 12;
export const BACKGROUND_B_CENTER_FILL_MAX_AREA = 384;
export const BACKGROUND_B_CENTER_FILL_MAX_WIDE_AREA = 12000;
export const BACKGROUND_B_CENTER_FILL_MIN_WIDE_ASPECT = 1.2;
export const BACKGROUND_B_CENTER_FILL_MIN_WIDE_CENTROID_Y_RATIO = 0.45;
export const BACKGROUND_B_CENTER_SEED_MIN_COSINE = 0.9;
export const BACKGROUND_B_MAGENTA_ARTIFACT_MIN_AREA = 12;
export const BACKGROUND_B_MAGENTA_ARTIFACT_MAX_AREA = 256;
export const BACKGROUND_B_MAGENTA_ARTIFACT_MIN_ASPECT = 1.6;
export const BACKGROUND_B_MAGENTA_ARTIFACT_MIN_CENTROID_Y_RATIO = 0.5;
export const BACKGROUND_B_MAGENTA_ARTIFACT_MAX_DISTANCE_SQ = 46000;
export const BACKGROUND_B_MAGENTA_ARTIFACT_MIN_COSINE = 0.85;
export const BACKGROUND_B_MAGENTA_ARTIFACT_MIN_BG_LIKE_RATIO = 0.85;
export const BACKGROUND_B_MAGENTA_ARTIFACT_MIN_TRANSPARENT_CONTACTS = 8;
export const BACKGROUND_B_MAGENTA_ARTIFACT_MIN_TRANSPARENT_CONTACT_RATIO = 0.2;

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
  const fringeCleaned = removeBackgroundFringe(flooded, image, fringeToleranceSq, false);
  if (!(options.clearEnclosedIslands ?? true)) return fringeCleaned;
  return removeEnclosedBackgroundRegions(fringeCleaned, image, fringeToleranceSq);
}

export function removeEnclosedBackgroundRegions(
  image: RgbaImage,
  source: RgbaImage,
  toleranceSq: number = BACKGROUND_B_FRINGE_TOLERANCE_SQ,
): RgbaImage {
  const { width, height } = image;
  if (width === 0 || height === 0) return image;
  const dst = new Uint8Array(image.data);
  const cornerColors = getCornerColors(source);
  clearEnclosedNearBackgroundIslands(dst, width, height, cornerColors, toleranceSq);
  return { width, height, data: dst };
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

function clearEnclosedNearBackgroundIslands(
  data: Uint8Array,
  width: number,
  height: number,
  cornerColors: ReadonlyArray<[number, number, number]>,
  toleranceSq: number,
): void {
  const total = width * height;
  const visitedNear = new Uint8Array(total);
  const offsets: ReadonlyArray<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  for (let linear = 0; linear < total; linear++) {
    if (visitedNear[linear]) continue;
    const idx = linear * 4;
    if ((data[idx + 3] ?? 0) === 0) continue;
    if (!isNearCornerColor(data, idx, cornerColors, toleranceSq)) continue;
    const component: number[] = [];
    const stack: number[] = [linear];
    visitedNear[linear] = 1;
    let touchesEdge = false;

    while (stack.length > 0) {
      const current = stack.pop() as number;
      component.push(current);
      const x = current % width;
      const y = Math.floor(current / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        touchesEdge = true;
      }

      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = ny * width + nx;
        const nIdx = neighbor * 4;
        if ((data[nIdx + 3] ?? 0) === 0) continue;
        if (visitedNear[neighbor]) continue;
        if (!isNearCornerColor(data, nIdx, cornerColors, toleranceSq)) continue;
        visitedNear[neighbor] = 1;
        stack.push(neighbor);
      }
    }

    // Guardrail: enclosed cleanup should only remove small trapped pockets.
    // Large interior regions that happen to be near corner colours are likely
    // legitimate foreground shading/hair/skin and should be preserved.
    if (touchesEdge || component.length > BACKGROUND_B_MAX_ENCLOSED_ISLAND_PIXELS) continue;
    for (const pixel of component) {
      data[pixel * 4 + 3] = 0;
    }
  }

  // Second pass: remove tiny enclosed residual islands that are entirely
  // background-like but include anti-aliased shades slightly beyond the fringe
  // threshold (e.g. pockets between legs/hair strands).
  const visitedResidual = new Uint8Array(total);
  for (let linear = 0; linear < total; linear++) {
    if (visitedResidual[linear]) continue;
    const idx = linear * 4;
    if ((data[idx + 3] ?? 0) === 0) continue;

    const component: number[] = [];
    const stack: number[] = [linear];
    visitedResidual[linear] = 1;
    let touchesEdge = false;
    let maxCornerDistanceSq = 0;

    while (stack.length > 0) {
      const current = stack.pop() as number;
      component.push(current);
      const x = current % width;
      const y = Math.floor(current / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        touchesEdge = true;
      }
      const currentDistanceSq = minCornerColorDistanceSq(data, current * 4, cornerColors);
      maxCornerDistanceSq = Math.max(maxCornerDistanceSq, currentDistanceSq);

      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = ny * width + nx;
        const nIdx = neighbor * 4;
        if ((data[nIdx + 3] ?? 0) === 0) continue;
        if (visitedResidual[neighbor]) continue;
        visitedResidual[neighbor] = 1;
        stack.push(neighbor);
      }
    }

    if (touchesEdge || component.length > BACKGROUND_B_MAX_ENCLOSED_ISLAND_PIXELS) continue;
    if (maxCornerDistanceSq > BACKGROUND_B_ENCLOSED_MAX_COMPONENT_DISTANCE_SQ) continue;
    for (const pixel of component) {
      data[pixel * 4 + 3] = 0;
    }
  }

  clearEnclosedBackgroundLikeRegionsFromCenter(data, width, height, cornerColors);
  if (isMagentaFamilyBackground(cornerColors)) {
    clearLowerHalfMagentaArtifacts(data, width, height, cornerColors);
  }
}

function clearEnclosedBackgroundLikeRegionsFromCenter(
  data: Uint8Array,
  width: number,
  height: number,
  cornerColors: ReadonlyArray<[number, number, number]>,
): void {
  const total = width * height;
  const visited = new Uint8Array(total);
  const offsets: ReadonlyArray<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const seedToleranceSq = BACKGROUND_B_CENTER_SEED_TOLERANCE_SQ;
  const seedMinCosine = BACKGROUND_B_CENTER_SEED_MIN_COSINE;
  for (let linear = 0; linear < total; linear++) {
    if (visited[linear]) continue;
    const idx = linear * 4;
    if ((data[idx + 3] ?? 0) === 0) continue;
    if (!isBackgroundLikeColor(data, idx, cornerColors, seedToleranceSq, seedMinCosine)) continue;

    const component: number[] = [];
    const stack: number[] = [linear];
    visited[linear] = 1;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    while (stack.length > 0) {
      const current = stack.pop() as number;
      component.push(current);
      const x = current % width;
      const y = Math.floor(current / width);
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (visited[neighbor]) continue;
        const nIdx = neighbor * 4;
        if ((data[nIdx + 3] ?? 0) === 0) continue;
        if (!isBackgroundLikeColor(data, nIdx, cornerColors, seedToleranceSq, seedMinCosine))
          continue;
        visited[neighbor] = 1;
        stack.push(neighbor);
      }
    }

    if (component.length < BACKGROUND_B_CENTER_FILL_MIN_AREA) continue;
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    const centroidY = sumY / component.length;
    const wideShadowLike =
      bboxW >= bboxH * BACKGROUND_B_CENTER_FILL_MIN_WIDE_ASPECT &&
      component.length <= BACKGROUND_B_CENTER_FILL_MAX_WIDE_AREA &&
      centroidY >= height * BACKGROUND_B_CENTER_FILL_MIN_WIDE_CENTROID_Y_RATIO;
    const clearByArea = component.length <= BACKGROUND_B_CENTER_FILL_MAX_AREA;
    if (!clearByArea && !wideShadowLike) continue;

    // Pick a seed nearest to the component center and clear from there.
    const centerX = sumX / component.length;
    const centerY = sumY / component.length;
    let seed = component[0] as number;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const pixel of component) {
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const dx = x - centerX;
      const dy = y - centerY;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        seed = pixel;
      }
    }
    floodClearNearBackgroundFromSeed(
      data,
      width,
      height,
      seed,
      cornerColors,
      seedToleranceSq,
      seedMinCosine,
    );
  }
}

function floodClearNearBackgroundFromSeed(
  data: Uint8Array,
  width: number,
  height: number,
  seed: number,
  cornerColors: ReadonlyArray<[number, number, number]>,
  toleranceSq: number,
  minCosine: number,
): void {
  const offsets: ReadonlyArray<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const visited = new Uint8Array(width * height);
  const stack: number[] = [seed];
  while (stack.length > 0) {
    const current = stack.pop() as number;
    if (visited[current]) continue;
    visited[current] = 1;
    const idx = current * 4;
    if ((data[idx + 3] ?? 0) === 0) continue;
    if (!isBackgroundLikeColor(data, idx, cornerColors, toleranceSq, minCosine)) continue;
    data[idx + 3] = 0;
    const x = current % width;
    const y = Math.floor(current / width);
    for (const [dx, dy] of offsets) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      stack.push(ny * width + nx);
    }
  }
}

function isBackgroundLikeColor(
  data: Uint8Array,
  idx: number,
  cornerColors: ReadonlyArray<[number, number, number]>,
  toleranceSq: number,
  minCosine: number,
): boolean {
  const nearest = nearestCornerColorMatch(data, idx, cornerColors);
  return nearest.distanceSq <= toleranceSq && nearest.cosine >= minCosine;
}

function nearestCornerColorMatch(
  data: Uint8Array,
  idx: number,
  cornerColors: ReadonlyArray<[number, number, number]>,
): { distanceSq: number; cosine: number } {
  const r = data[idx] ?? 0;
  const g = data[idx + 1] ?? 0;
  const b = data[idx + 2] ?? 0;
  let minDistanceSq = Number.POSITIVE_INFINITY;
  let bestCosine = -1;
  const pLen = Math.sqrt(r * r + g * g + b * b) || 1;
  for (const [cr, cg, cb] of cornerColors) {
    const dr = r - cr;
    const dg = g - cg;
    const db = b - cb;
    const distanceSq = dr * dr + dg * dg + db * db;
    if (distanceSq > minDistanceSq) continue;
    const cLen = Math.sqrt(cr * cr + cg * cg + cb * cb) || 1;
    const dot = r * cr + g * cg + b * cb;
    const cosine = dot / (pLen * cLen);
    if (distanceSq < minDistanceSq || cosine > bestCosine) {
      minDistanceSq = distanceSq;
      bestCosine = cosine;
    }
  }
  return { distanceSq: minDistanceSq, cosine: bestCosine };
}

function isMagentaFamilyBackground(cornerColors: ReadonlyArray<[number, number, number]>): boolean {
  if (cornerColors.length === 0) return false;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const [cr, cg, cb] of cornerColors) {
    r += cr;
    g += cg;
    b += cb;
  }
  const n = cornerColors.length;
  const ar = r / n;
  const ag = g / n;
  const ab = b / n;
  return ar >= 120 && ab >= 120 && ag <= 190 && Math.abs(ar - ab) <= 80;
}

function clearLowerHalfMagentaArtifacts(
  data: Uint8Array,
  width: number,
  height: number,
  cornerColors: ReadonlyArray<[number, number, number]>,
): void {
  const total = width * height;
  const visited = new Uint8Array(total);
  const offsets: ReadonlyArray<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (let linear = 0; linear < total; linear++) {
    if (visited[linear]) continue;
    const idx = linear * 4;
    if ((data[idx + 3] ?? 0) === 0) continue;
    if (!isMagentaLikePixel(data, idx)) continue;
    const stack: number[] = [linear];
    visited[linear] = 1;
    const component: number[] = [];
    let sumY = 0;
    let sumX = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let backgroundLikeCount = 0;
    while (stack.length > 0) {
      const current = stack.pop() as number;
      const ci = current * 4;
      if ((data[ci + 3] ?? 0) === 0) continue;
      if (!isMagentaLikePixel(data, ci)) continue;
      component.push(current);
      const x = current % width;
      const y = Math.floor(current / width);
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (
        isBackgroundLikeColor(
          data,
          ci,
          cornerColors,
          BACKGROUND_B_MAGENTA_ARTIFACT_MAX_DISTANCE_SQ,
          BACKGROUND_B_MAGENTA_ARTIFACT_MIN_COSINE,
        )
      ) {
        backgroundLikeCount += 1;
      }
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (visited[neighbor]) continue;
        visited[neighbor] = 1;
        stack.push(neighbor);
      }
    }
    if (
      component.length < BACKGROUND_B_MAGENTA_ARTIFACT_MIN_AREA ||
      component.length > BACKGROUND_B_MAGENTA_ARTIFACT_MAX_AREA
    ) {
      continue;
    }
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    if (bboxW < bboxH * BACKGROUND_B_MAGENTA_ARTIFACT_MIN_ASPECT) continue;
    const backgroundLikeRatio = backgroundLikeCount / component.length;
    if (backgroundLikeRatio < BACKGROUND_B_MAGENTA_ARTIFACT_MIN_BG_LIKE_RATIO) continue;
    const centroidX = sumX / component.length;
    const centroidY = sumY / component.length;
    if (centroidY < height * BACKGROUND_B_MAGENTA_ARTIFACT_MIN_CENTROID_Y_RATIO) continue;
    if (centroidX < 1 || centroidX >= width - 1) continue;
    const componentMask = new Uint8Array(total);
    for (const pixel of component) {
      componentMask[pixel] = 1;
    }
    let transparentContacts = 0;
    let boundarySamples = 0;
    for (const pixel of component) {
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (componentMask[neighbor]) continue;
        boundarySamples += 1;
        if ((data[neighbor * 4 + 3] ?? 0) === 0) {
          transparentContacts += 1;
        }
      }
    }
    const transparentContactRatio = boundarySamples > 0 ? transparentContacts / boundarySamples : 0;
    if (transparentContacts < BACKGROUND_B_MAGENTA_ARTIFACT_MIN_TRANSPARENT_CONTACTS) continue;
    if (transparentContactRatio < BACKGROUND_B_MAGENTA_ARTIFACT_MIN_TRANSPARENT_CONTACT_RATIO)
      continue;
    for (const pixel of component) {
      data[pixel * 4 + 3] = 0;
    }
  }
}

function isMagentaLikePixel(data: Uint8Array, idx: number): boolean {
  const r = data[idx] ?? 0;
  const g = data[idx + 1] ?? 0;
  const b = data[idx + 2] ?? 0;
  return r >= 120 && b >= 120 && g <= 175 && Math.abs(r - b) <= 110;
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

function normalizeTolerance(raw: number | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!Number.isFinite(raw)) return fallback;
  const normalized = Math.round(raw);
  return normalized >= 0 ? normalized : fallback;
}

function fitWithinNearest(
  image: RgbaImage,
  boxW: number,
  boxH: number,
  centerSubject: boolean,
): { image: RgbaImage; fittedWidth: number; fittedHeight: number } {
  const subject = centerSubject ? trimTransparentEdges(image) : image;
  const { width: srcW, height: srcH } = subject;
  if (srcW <= 0 || srcH <= 0) {
    return {
      image: { width: boxW, height: boxH, data: new Uint8Array(boxW * boxH * 4) },
      fittedWidth: 0,
      fittedHeight: 0,
    };
  }
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const fittedWidth = Math.max(1, Math.min(boxW, Math.round(srcW * scale)));
  const fittedHeight = Math.max(1, Math.min(boxH, Math.round(srcH * scale)));
  const scaled = upscaleNearest(subject, fittedWidth, fittedHeight);
  const out = new Uint8Array(boxW * boxH * 4);
  const offsetX = Math.floor((boxW - fittedWidth) / 2);
  const offsetY = Math.floor((boxH - fittedHeight) / 2);
  for (let y = 0; y < fittedHeight; y++) {
    for (let x = 0; x < fittedWidth; x++) {
      const srcIdx = (y * fittedWidth + x) * 4;
      const dstIdx = ((offsetY + y) * boxW + (offsetX + x)) * 4;
      out[dstIdx] = scaled.data[srcIdx] ?? 0;
      out[dstIdx + 1] = scaled.data[srcIdx + 1] ?? 0;
      out[dstIdx + 2] = scaled.data[srcIdx + 2] ?? 0;
      out[dstIdx + 3] = scaled.data[srcIdx + 3] ?? 0;
    }
  }
  return {
    image: { width: boxW, height: boxH, data: out },
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
 * Returns the cropped sub-image. If the image is entirely transparent,
 * returns a 0×0 image (callers should guard against this).
 *
 * Exported for direct unit testing.
 */
export function trimTransparentEdges(image: RgbaImage): RgbaImage {
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

  const newW = right - left + 1;
  const newH = bottom - top + 1;
  const dst = new Uint8Array(newW * newH * 4);
  for (let y = 0; y < newH; y++) {
    const srcRow = (top + y) * width + left;
    const dstRow = y * newW;
    for (let x = 0; x < newW; x++) {
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
