/**
 * Shared wall/floor sample signature used by both `edge-signature.ts` and
 * `corner-signature.ts`.
 *
 * Why two channels
 * ----------------
 * Neither channel alone separates wall from floor across every pack kind:
 *
 * - `opacity` (mean alpha) separates alpha-clean packs, where floor is simply
 *   not drawn. The vendored caeles template paints its walls pure WHITE on a
 *   transparent ground, so a luminance-only classifier reads wall ~242 and
 *   transparent-as-background 255 and cannot tell them apart at all.
 * - `luminance` (mean luminance, with transparent counted as background-white)
 *   separates fully-opaque packs, where alpha carries no information.
 *
 * Classification is nearest-reference by Euclidean distance over both channels,
 * each in 0-255 units. That is degenerate for neither pack kind.
 *
 * This module exists because using luminance alone silently mis-scored the
 * caeles fixture: the earlier greedy cell→mask search was tuned against a
 * degenerate luminance-only edge check, so a wrong mapping scored ~0.94 while
 * the correct, art-derived mapping scored ~0.38.
 */
import type { RgbaImage } from './png-buffer.js';

export interface SampleSignature {
  /** Mean alpha over the sample, 0-255. */
  readonly opacity: number;
  /** Mean luminance over the sample, 0-255; fully-transparent pixels count as 255. */
  readonly luminance: number;
}

export function sampleSignature(img: RgbaImage): SampleSignature {
  let alphaSum = 0;
  let lumSum = 0;
  let count = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3]!;
    alphaSum += a;
    lumSum +=
      a === 0 ? 255 : 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
    count += 1;
  }
  if (count === 0) return { opacity: 0, luminance: 0 };
  return { opacity: alphaSum / count, luminance: lumSum / count };
}

/** Euclidean distance between two signatures, in 0-255 units. */
export function signatureDistance(a: SampleSignature, b: SampleSignature): number {
  const dOpacity = a.opacity - b.opacity;
  const dLuminance = a.luminance - b.luminance;
  return Math.sqrt(dOpacity * dOpacity + dLuminance * dLuminance);
}

/** Zero signature; only used to initialise reference records before they are filled. */
export const ZERO_SIGNATURE: SampleSignature = { opacity: 0, luminance: 0 };
