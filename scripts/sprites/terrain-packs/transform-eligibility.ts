/**
 * Transform-eligibility derivation + validation (2026-07-25 terrain-variance
 * adversarial-review resolution #2).
 *
 * "Explicit transform eligibility metadata per source variant. Build/
 * validation tooling must derive every allowed transformed view and verify
 * seam closure across allowed adjacencies; disallow transforms for
 * directionally unsafe art."
 *
 * Floor/corridor pool tiles are mottled/speckled material fills, not
 * continuous line art — unlike the wall blob47 atlas (which needs
 * pixel-exact edge-compatible silhouettes), there is no hard requirement
 * that a tile's edge pixels literally continue into its neighbour's edge
 * pixels. The seam-closure risk for THESE tiles is semantic/statistical:
 * a source with a strong directional feature baked in (a gravity-fed drip
 * stain, a light source in one corner, a grate whose bars run one way) will
 * look visibly wrong — or imply a false direction — once flipped, even
 * though nothing "breaks" pixel-for-pixel. `deriveAllowedTransforms` makes
 * that judgment call deterministic and checkable: it samples the mean
 * luminance of each of the tile's 4 edge bands and only allows a mirror axis
 * whose two edges are already close in tone (i.e. the art isn't obviously
 * anisotropic along that axis).
 */
import type { RgbaImage } from './png-buffer.js';
import { createImage } from './png-buffer.js';
import type { TransformId } from '../../../src/shared/terrain-pack-types.js';
import { TRANSFORM_IDS } from '../../../src/shared/terrain-pack-types.js';

export interface EdgeBandMeans {
  readonly N: number;
  readonly E: number;
  readonly S: number;
  readonly W: number;
}

/** Width (px) of the edge sampling band, in output (64px) cell space. */
const EDGE_BAND_PX = 8;

/**
 * Maximum allowed mean-luminance difference (0–255 scale) between a tile's
 * two edges on one mirror axis (N vs S for `flipV`; E vs W for `flipH`) for
 * that axis to be considered non-directional / safe to mirror. Documented,
 * not silently tuned per-source: a source that fails this on an axis gets a
 * SMALLER `allowedTransforms` set, not a lowered threshold.
 */
export const DIRECTIONAL_ASYMMETRY_THRESHOLD = 20;

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Mean luminance of each of the 4 `EDGE_BAND_PX`-wide edge bands of `image`. */
export function computeEdgeBandMeans(image: RgbaImage, bandPx = EDGE_BAND_PX): EdgeBandMeans {
  const { width, height, data } = image;
  const band = Math.max(1, Math.min(bandPx, Math.floor(Math.min(width, height) / 2)));

  const sumRegion = (x0: number, y0: number, w: number, h: number): number => {
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const idx = (y * width + x) * 4;
        sum += luminance(data[idx] ?? 0, data[idx + 1] ?? 0, data[idx + 2] ?? 0);
        count++;
      }
    }
    return count === 0 ? 0 : sum / count;
  };

  return {
    N: sumRegion(0, 0, width, band),
    S: sumRegion(0, height - band, width, band),
    W: sumRegion(0, 0, band, height),
    E: sumRegion(width - band, 0, band, height),
  };
}

/**
 * Deterministically derive the safe transform set for `image`: `'none'`
 * always, plus `'flipV'`/`'flipH'`/`'flipHV'` only when the corresponding
 * mirror axis (axes, for `flipHV`) is non-directional per
 * `DIRECTIONAL_ASYMMETRY_THRESHOLD`. Pure function of the image's pixels —
 * same input always yields the same allowed-transform list.
 */
export function deriveAllowedTransforms(image: RgbaImage): TransformId[] {
  const means = computeEdgeBandMeans(image);
  const verticalSafe = Math.abs(means.N - means.S) <= DIRECTIONAL_ASYMMETRY_THRESHOLD;
  const horizontalSafe = Math.abs(means.E - means.W) <= DIRECTIONAL_ASYMMETRY_THRESHOLD;
  const allowed: TransformId[] = ['none'];
  if (verticalSafe) allowed.push('flipV');
  if (horizontalSafe) allowed.push('flipH');
  if (verticalSafe && horizontalSafe) allowed.push('flipHV');
  return allowed;
}

/** Apply a deterministic geometric transform to a 64px (or any square) RgbaImage. Pure, no mutation of `image`. */
export function applyTransform(image: RgbaImage, transform: TransformId): RgbaImage {
  if (transform === 'none') {
    return { width: image.width, height: image.height, data: Buffer.from(image.data) };
  }
  const flipX = transform === 'flipH' || transform === 'flipHV';
  const flipY = transform === 'flipV' || transform === 'flipHV';
  const out = createImage(image.width, image.height);
  for (let y = 0; y < image.height; y++) {
    const srcY = flipY ? image.height - 1 - y : y;
    for (let x = 0; x < image.width; x++) {
      const srcX = flipX ? image.width - 1 - x : x;
      const srcIdx = (srcY * image.width + srcX) * 4;
      const dstIdx = (y * image.width + x) * 4;
      out.data[dstIdx] = image.data[srcIdx] ?? 0;
      out.data[dstIdx + 1] = image.data[srcIdx + 1] ?? 0;
      out.data[dstIdx + 2] = image.data[srcIdx + 2] ?? 0;
      out.data[dstIdx + 3] = image.data[srcIdx + 3] ?? 0;
    }
  }
  return out;
}

export interface TransformEligibilityIssue {
  readonly code: string;
  readonly message: string;
}

/**
 * Validation gate (2026-07-25 refinement #2): re-derive the safe transform
 * set from `image` and flag any `declared` transform that is NOT in that
 * derived set — a manifest cannot claim a transform is safe unless the
 * pixels back it up. Every declared transform must also be one of
 * `TRANSFORM_IDS` (structural safety net; the Zod enum already guarantees
 * this at the schema layer, this is a defense-in-depth belt-and-suspenders
 * check for callers that bypass the schema, e.g. direct build-tool use).
 */
export function validateDeclaredTransforms(
  image: RgbaImage,
  declared: readonly TransformId[],
  contextLabel: string,
): TransformEligibilityIssue[] {
  const issues: TransformEligibilityIssue[] = [];
  const safe = new Set(deriveAllowedTransforms(image));
  for (const t of declared) {
    if (!TRANSFORM_IDS.includes(t)) {
      issues.push({
        code: 'transform-unknown',
        message: `${contextLabel}: declared transform '${t}' is not a recognized TransformId`,
      });
      continue;
    }
    if (!safe.has(t)) {
      issues.push({
        code: 'transform-unsafe',
        message: `${contextLabel}: declared transform '${t}' fails the directional-asymmetry seam-closure check (edge means too different to mirror safely)`,
      });
    }
  }
  return issues;
}
