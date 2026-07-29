/**
 * frame-coherence.ts — deterministic cross-frame coherence gate for
 * multi-frame animation sheets (walk cycles etc.), Slice B.
 *
 * A frame-sequence brief asks the model to draw the SAME character across
 * several ordered poses. Nothing stops the model from drifting — a
 * different outfit color, a different silhouette, or an unrelated subject
 * in a later frame. This module is the deterministic gate that catches
 * that drift BEFORE a sequence can be approved/checked in.
 *
 * It compares every consecutive pair of frames on two purely deterministic,
 * cheap-to-compute signals:
 *
 *   1. Palette distance — a coarse RGB-quantized color histogram (opaque
 *      pixels only) compared via normalized L1 (histogram-intersection)
 *      distance in [0, 1]. A different character/outfit palette shows up
 *      as a large distance even though poses differ frame to frame.
 *   2. Silhouette mass delta ratio — the opaque-pixel COUNT of each frame,
 *      compared as `1 - min(a, b) / max(a, b)`, in [0, 1). A frame with a
 *      wildly different opaque-pixel count (a missing limb, an added prop,
 *      a totally different subject scale) signals drift even when the
 *      palette happens to match.
 *
 *   3. Baseline (floor-line) stability — the row of the lowest opaque pixel
 *      in each frame (the character's feet), compared frame-to-frame as an
 *      absolute pixel delta. `build-prompt.ts` explicitly instructs the
 *      model to keep "the same floor line" across every frame; this signal
 *      deterministically enforces that instruction instead of trusting the
 *      prompt alone. A coherent walk cycle keeps the same standing height;
 *      vertical bobbing/drift (or a frame drawn at the wrong scale) shows up
 *      as a large delta even when palette and mass both happen to match.
 *
 * This is intentionally coarse and NOT a subjective similarity judge — no
 * LLM/VLM is involved, ever (see repo policy: deterministic gates only).
 * It is tuned to catch GROSS drift (different color scheme / wildly
 * different silhouette / vertical bobbing), not the subtle pose-to-pose
 * differences a real walk cycle is expected and required to have.
 */

import { decodeSprite, gatherOpaquePixels, type RgbaImage } from './common.js';

/**
 * Default max allowed normalized palette-histogram distance between two
 * consecutive frames, in [0, 1] (0 = identical opaque-pixel color
 * distribution, 1 = completely disjoint). Chosen empirically: a walk cycle
 * redrawing the same character/outfit in a new pose shifts distance by a
 * few hundredths to low tenths (shading/anti-aliasing/pose-driven
 * occlusion change); a genuinely different character or outfit palette
 * pushes this well past 0.5.
 */
export const DEFAULT_MAX_PALETTE_DISTANCE = 0.35;

/**
 * Default max allowed opaque-pixel "silhouette mass" delta ratio between
 * two consecutive frames, in [0, 1). A walking pose naturally changes the
 * opaque pixel count a little (limbs overlap/separate), but a coherent
 * cycle keeps the same subject at the same scale — a large swing signals a
 * different subject, a dropped limb, or a stray extra object.
 */
export const DEFAULT_MAX_MASS_DELTA_RATIO = 0.4;

/**
 * Default max allowed absolute-pixel delta in "lowest opaque row" (the
 * character's floor-contact height) between two consecutive frames. Chosen
 * empirically against 64px-tall frames: a couple of pixels of anti-aliasing
 * / stride variance is normal, but drift past this indicates the model
 * ignored the "same floor line" prompt instruction (vertical bobbing) or
 * drew a frame at a different scale entirely.
 */
export const DEFAULT_MAX_BASELINE_DELTA_PX = 6;

/** Quantize each 8-bit channel down to this many bits before histogramming. */
const PALETTE_BUCKET_BITS = 4;
const CHANNEL_SHIFT = 8 - PALETTE_BUCKET_BITS;

export interface FrameCoherenceOptions {
  readonly maxPaletteDistance?: number;
  readonly maxMassDeltaRatio?: number;
  readonly maxBaselineDeltaPx?: number;
  /**
   * When true, also check the final→first frame pair so the loop seam is
   * validated alongside interior pairs. A sequence can drift gradually enough
   * that every consecutive interior pair stays under the thresholds while the
   * wrap-around seam has a large palette, mass, or baseline jump — yet it will
   * still play that seam on every loop iteration.
   */
  readonly loop?: boolean;
}

export interface FrameCoherencePairResult {
  readonly frameA: number;
  readonly frameB: number;
  readonly paletteDistance: number;
  readonly massDeltaRatio: number;
  readonly baselineDeltaPx: number;
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

export interface FrameCoherenceResult {
  readonly ok: boolean;
  readonly pairs: readonly FrameCoherencePairResult[];
  /** Joined reasons from every failing pair, present only when `ok` is false. */
  readonly reason?: string;
}

function quantizedOpaqueHistogram(image: RgbaImage): { hist: Float64Array; opaqueCount: number } {
  const buckets = 1 << (PALETTE_BUCKET_BITS * 3);
  const hist = new Float64Array(buckets);
  let opaqueCount = 0;
  for (let i = 0; i + 3 < image.data.length; i += 4) {
    const a = image.data[i + 3] ?? 0;
    if (a === 0) continue;
    const r = (image.data[i] ?? 0) >> CHANNEL_SHIFT;
    const g = (image.data[i + 1] ?? 0) >> CHANNEL_SHIFT;
    const b = (image.data[i + 2] ?? 0) >> CHANNEL_SHIFT;
    const bucket = (r << (PALETTE_BUCKET_BITS * 2)) | (g << PALETTE_BUCKET_BITS) | b;
    hist[bucket] = (hist[bucket] ?? 0) + 1;
    opaqueCount += 1;
  }
  if (opaqueCount > 0) {
    for (let i = 0; i < hist.length; i++) {
      hist[i] = (hist[i] ?? 0) / opaqueCount;
    }
  }
  return { hist, opaqueCount };
}

/** Normalized L1 distance between two probability distributions, in [0, 1]. */
function histogramDistance(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  }
  // L1 distance between two L1-normalized non-negative vectors is in [0, 2];
  // halve it so the exported threshold is a clean [0, 1] "fraction disjoint".
  return sum / 2;
}

/**
 * Row index (0-based, top-down) of the lowest opaque pixel in the image —
 * i.e. where the character's feet meet the floor. Returns -1 for a fully
 * transparent image (trivially has no baseline to compare).
 */
function lowestOpaqueRow(image: RgbaImage): number {
  for (let y = image.height - 1; y >= 0; y--) {
    const rowStart = y * image.width * 4;
    for (let x = 0; x < image.width; x++) {
      const a = image.data[rowStart + x * 4 + 3] ?? 0;
      if (a !== 0) return y;
    }
  }
  return -1;
}

/**
 * Compare a sequence of already-decoded/post-processed frame PNG buffers
 * (in cycle order) for cross-frame coherence. Returns one pair result per
 * consecutive adjacent pair and, when `options.loop` is true, one additional
 * result for the final→first wrap-around seam; `ok` is true iff every pair
 * passes all thresholds.
 *
 * Fewer than 2 frames trivially passes (nothing to compare).
 */
export function checkFrameCoherence(
  frames: ReadonlyArray<Buffer>,
  options: FrameCoherenceOptions = {},
): FrameCoherenceResult {
  const maxPaletteDistance = options.maxPaletteDistance ?? DEFAULT_MAX_PALETTE_DISTANCE;
  const maxMassDeltaRatio = options.maxMassDeltaRatio ?? DEFAULT_MAX_MASS_DELTA_RATIO;
  const maxBaselineDeltaPx = options.maxBaselineDeltaPx ?? DEFAULT_MAX_BASELINE_DELTA_PX;

  if (frames.length < 2) {
    return { ok: true, pairs: [] };
  }

  const images = frames.map((buf) => decodeSprite(buf));
  const histograms = images.map((img) => quantizedOpaqueHistogram(img).hist);
  const masses = images.map((img) => gatherOpaquePixels(img).length);
  const baselines = images.map((img) => lowestOpaqueRow(img));

  // Build the list of frame-index pairs to compare. For a looping animation
  // the final frame plays directly into frame 0, so include that wrap-around
  // pair when `loop` is requested — a sequence can pass every interior pair
  // while the loop seam has a large palette, mass, or baseline jump.
  const pairIndices: Array<[number, number]> = [];
  for (let i = 0; i < images.length - 1; i++) {
    pairIndices.push([i, i + 1]);
  }
  if (options.loop === true && images.length >= 2) {
    pairIndices.push([images.length - 1, 0]);
  }

  const pairs: FrameCoherencePairResult[] = [];
  let allOk = true;
  for (const [i, j] of pairIndices) {
    const paletteDistance = histogramDistance(histograms[i]!, histograms[j]!);
    const massA = masses[i]!;
    const massB = masses[j]!;
    // Two fully-transparent frames are identical (0 vs 0), not maximally
    // different — without this short-circuit `Math.max(0, 0, 1)` forces
    // `maxMass=1` while `minMass=0`, producing a bogus 100% delta ratio for
    // a pair that is actually identical (multi-model review finding,
    // gemini-3.1-pro). The baseline check already independently fails a
    // fully-transparent frame (see below), so this only fixes the reported
    // math/reason, not the pass/fail outcome.
    const massDeltaRatio =
      massA === 0 && massB === 0 ? 0 : 1 - Math.min(massA, massB) / Math.max(massA, massB, 1);
    const baselineA = baselines[i]!;
    const baselineB = baselines[j]!;
    // A fully transparent frame has no baseline (-1); treat that as a
    // separate, more severe drift signal rather than a bogus pixel delta.
    const baselineDeltaPx =
      baselineA === -1 || baselineB === -1
        ? Number.POSITIVE_INFINITY
        : Math.abs(baselineA - baselineB);

    const reasons: string[] = [];
    if (paletteDistance > maxPaletteDistance) {
      reasons.push(
        `palette distance ${paletteDistance.toFixed(3)} between frame ${i} and frame ${j} exceeds max ${maxPaletteDistance}`,
      );
    }
    if (massDeltaRatio > maxMassDeltaRatio) {
      reasons.push(
        `silhouette mass delta ratio ${massDeltaRatio.toFixed(3)} between frame ${i} and frame ${j} exceeds max ${maxMassDeltaRatio} (${massA} vs ${massB} opaque px)`,
      );
    }
    if (baselineDeltaPx > maxBaselineDeltaPx) {
      reasons.push(
        `baseline (floor-line) delta ${
          Number.isFinite(baselineDeltaPx) ? baselineDeltaPx : 'n/a (empty frame)'
        }px between frame ${i} and frame ${j} exceeds max ${maxBaselineDeltaPx}px (row ${baselineA} vs ${baselineB})`,
      );
    }
    const ok = reasons.length === 0;
    if (!ok) allOk = false;
    pairs.push({
      frameA: i,
      frameB: j,
      paletteDistance,
      massDeltaRatio,
      baselineDeltaPx,
      ok,
      reasons,
    });
  }

  if (allOk) {
    return { ok: true, pairs };
  }
  const reason = pairs
    .filter((p) => !p.ok)
    .flatMap((p) => p.reasons)
    .join('; ');
  return { ok: false, pairs, reason };
}
