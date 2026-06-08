/**
 * Anchor overlay PNG builder.
 *
 * Produces a transparent PNG the same size as a processed sprite (typically
 * 16x16) with exactly one fully opaque red pixel (`rgba(255, 0, 0, 255)`) at
 * the derived anchor coordinate. Written next to every variant as
 * `processed/NN.anchor-overlay.png` so the gallery can composite it on top
 * of the sprite at the same scale without re-deriving the anchor or doing
 * any anti-aliased line drawing (which would break pixel-snapping).
 *
 * When derivation failed (anchor is null), the helper still returns a fully
 * transparent PNG of the same dimensions and the caller writes it anyway.
 * The gallery treats the missing red pixel as "no anchor for this variant",
 * which is the same visual signal as toggling the overlay off — no special
 * case for the consumer.
 *
 * Pure function: same inputs, same bytes out, no IO, no clock, no random.
 */

import { PNG } from 'pngjs';

export interface AnchorOverlayInput {
  readonly width: number;
  readonly height: number;
  /**
   * Anchor coordinate in pixel space (0-indexed, top-left origin). When
   * `null`, the helper returns a fully transparent PNG (no red pixel).
   */
  readonly anchor: { readonly x: number; readonly y: number } | null;
}

/**
 * Build a transparent overlay PNG with the anchor marked as a single red
 * pixel. Returns a deterministic PNG byte buffer.
 *
 * Throws when `width`/`height` are not positive integers, or when the
 * anchor falls outside the image. Callers should pass either a null anchor
 * or one that has already been validated against the image bounds.
 */
export function buildAnchorOverlay(input: AnchorOverlayInput): Buffer {
  const { width, height, anchor } = input;
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(`buildAnchorOverlay: width must be a positive integer, got ${width}`);
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new Error(`buildAnchorOverlay: height must be a positive integer, got ${height}`);
  }

  const png = new PNG({ width, height });
  // PNG constructor zeroes the data buffer, which is fully transparent
  // (rgba 0,0,0,0). We only need to set one pixel when an anchor is given.
  if (anchor !== null) {
    if (!Number.isInteger(anchor.x) || !Number.isInteger(anchor.y)) {
      throw new Error(
        `buildAnchorOverlay: anchor must be integer pixels, got (${anchor.x}, ${anchor.y})`,
      );
    }
    if (anchor.x < 0 || anchor.x >= width || anchor.y < 0 || anchor.y >= height) {
      throw new Error(
        `buildAnchorOverlay: anchor (${anchor.x}, ${anchor.y}) is out of ${width}x${height} bounds`,
      );
    }
    const idx = (anchor.y * width + anchor.x) * 4;
    png.data[idx] = 255;
    png.data[idx + 1] = 0;
    png.data[idx + 2] = 0;
    png.data[idx + 3] = 255;
  }

  return PNG.sync.write(png);
}
