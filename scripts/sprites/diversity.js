/**
 * Diversity metric for a set of post-processed sprite variants.
 *
 * Motivation: sheet-mode generation gives us N candidates per provider call,
 * but if the model collapsed to "16 near-duplicates" we paid for variety we
 * didn't get. A per-sheet diversity number lets us A/B prompt or model
 * changes against data instead of intuition.
 *
 * Algorithm: a coarse perceptual hash per sprite, then average pairwise
 * Hamming distance across the set.
 *
 * Hash construction (deliberately simple — these are already post-processed PNGs):
 *   1. Decode the PNG to RGBA.
 *   2. For each pixel: if alpha == 0, treat as luminance 0 (background);
 *      else compute Rec. 601 luminance Y = 0.299R + 0.587G + 0.114B.
 *   3. Compute the mean luminance across all pixels.
 *   4. Emit one bit per pixel: 1 if Y >= mean, 0 otherwise.
 *
 * A sprite yields one hash bit per pixel (e.g. 16x16 -> 256 bits,
 * 64x64 -> 4096 bits). Hamming distance between two hashes
 * divided by bit length normalises to [0, 1] — 0 means "identical structure",
 * 1 means "perfectly inverted". Real near-duplicates score ~0.0-0.05;
 * meaningfully different variants score ~0.2-0.4; visually unrelated
 * images score 0.4+.
 *
 * The mean-threshold approach is intentionally weaker than a DCT-based pHash:
 * Kenney-style pixel art has very low frequency content and DCT would not
 * add information at this resolution. The mean-threshold hash also degrades
 * gracefully when the silhouette ratio shifts, which is exactly the kind of
 * variation we want to reward.
 *
 * The module is pure given its inputs (PNG buffers) — same buffers in, same
 * numbers out, no clock, no random. Network and FS are the caller's job.
 */
import { decodeSprite } from './sensors/common.js';
/**
 * Compute a perceptual hash from a sprite PNG.
 *
 * Returns a packed bit-vector together with the *true* bit length
 * (pixel count). Tracking the bit length separately is important because
 * pixel counts that aren't a multiple of 8 are zero-padded in the packed
 * Uint8Array — using `bits.length * 8` as the divisor would silently
 * normalise over the padding bits and skew the resulting Hamming distance.
 *
 * Each bit is `1` iff that pixel's luminance is `>=` the mean luminance
 * of the sprite. Bit order follows raster scan (`y * width + x`).
 */
export function perceptualHash(png) {
  const image = decodeSprite(png);
  const pixelCount = image.width * image.height;
  if (pixelCount === 0) return { bits: new Uint8Array(0), bitLength: 0 };
  const luminance = new Float64Array(pixelCount);
  let sum = 0;
  for (let i = 0; i < pixelCount; i++) {
    const r = image.data[i * 4] ?? 0;
    const g = image.data[i * 4 + 1] ?? 0;
    const b = image.data[i * 4 + 2] ?? 0;
    const a = image.data[i * 4 + 3] ?? 0;
    // Transparent pixels are background — count them as luminance 0 so
    // the mean correctly reflects "darker overall when the sprite covers
    // less of the frame" rather than skewing toward whatever colour the
    // background pre-clear happened to be.
    const y = a === 0 ? 0 : 0.299 * r + 0.587 * g + 0.114 * b;
    luminance[i] = y;
    sum += y;
  }
  const mean = sum / pixelCount;
  const byteLength = Math.ceil(pixelCount / 8);
  const bits = new Uint8Array(byteLength);
  for (let i = 0; i < pixelCount; i++) {
    if ((luminance[i] ?? 0) >= mean) {
      const byteIdx = i >>> 3;
      const bitIdx = i & 7;
      bits[byteIdx] |= 1 << bitIdx;
    }
  }
  return { bits, bitLength: pixelCount };
}
/**
 * Hamming distance between two equal-length bit vectors, normalised to
 * the bit length so the result lives in [0, 1].
 *
 * Important: `bitLength` is the *meaningful* bit length (the original
 * pixel count), not the underlying Uint8Array's byte capacity times 8.
 * Padding bits in the packed representation are always 0 and would
 * never differ, but normalising by byte-capacity would still skew the
 * ratio downward when `bitLength` isn't a multiple of 8.
 */
export function hammingDistance(a, b, bitLength) {
  if (a.length !== b.length) {
    throw new Error(`hammingDistance: byte length mismatch (${a.length} vs ${b.length})`);
  }
  if (bitLength <= 0) return 0;
  let diffBits = 0;
  for (let i = 0; i < a.length; i++) {
    let xor = (a[i] ?? 0) ^ (b[i] ?? 0);
    // Population count via Brian Kernighan's trick — clears the lowest set
    // bit each iteration; faster than per-bit shifting for sparse XOR
    // results and totally adequate for 32-byte hashes.
    while (xor !== 0) {
      xor &= xor - 1;
      diffBits++;
    }
  }
  return diffBits / bitLength;
}
/**
 * Compute a diversity summary across a set of post-processed sprite PNGs.
 *
 * Returns `null` when fewer than 2 sprites are supplied — diversity is
 * undefined for a singleton (no pairs) and we'd rather force callers to
 * handle the missing case explicitly than emit a sentinel `0` that looks
 * like "everything is identical".
 *
 * Hashes are computed once per sprite. The pair loop is `O(n^2)` but with
 * 16-32 sprites that's at most ~500 comparisons over 32-byte buffers, so
 * the whole thing runs in well under a millisecond. No need to short-circuit.
 */
export function computeDiversity(processedPngs) {
  if (processedPngs.length < 2) return null;
  const hashes = processedPngs.map((p) => perceptualHash(p));
  // Hashes must share the same meaningful bit length (the decoded
  // pixel count). Comparing by byte-length alone would let a 15x17 and a
  // hashes from different image dimensions slip through with the same packed size but different
  // pixel layouts; here we validate the underlying dimension instead.
  const bitLength = hashes[0].bitLength;
  if (bitLength === 0) return null;
  for (let i = 1; i < hashes.length; i++) {
    if (hashes[i].bitLength !== bitLength) {
      // When trimAndFit produces variable-sized outputs, diversity
      // comparison is meaningless — gracefully bail rather than crash.
      return null;
    }
  }
  let sum = 0;
  let pairCount = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + 1; j < hashes.length; j++) {
      const d = hammingDistance(hashes[i].bits, hashes[j].bits, bitLength);
      sum += d;
      if (d < min) min = d;
      if (d > max) max = d;
      pairCount++;
    }
  }
  return {
    variantCount: processedPngs.length,
    pairCount,
    meanHamming: sum / pairCount,
    minHamming: min,
    maxHamming: max,
    bitLength,
  };
}
//# sourceMappingURL=diversity.js.map
