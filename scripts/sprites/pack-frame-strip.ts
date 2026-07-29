/**
 * pack-frame-strip.ts — combine N already-uniform-sized frame PNGs (in cycle
 * order) into a single horizontal strip PNG with no margin/spacing between
 * cells, matching the shared `animation` manifest-descriptor contract:
 *
 *   frameWidth × frameHeight cells, `frameCount` of them, laid out
 *   left-to-right, so Phaser's `loader.spritesheet()` can slice the strip
 *   with `frameWidth`/`frameHeight` and zero margin/spacing.
 *
 * Frames are expected to already be uniform-sized — `postprocess.ts`
 * resamples every sliced cell to `brief.size`, so every frame from one
 * frame-sequence run shares dimensions already. This module still validates
 * that invariant explicitly and fails loudly rather than silently
 * stretching/cropping a mismatched frame, since a silent size mismatch would
 * desync the strip from the `animation.frameWidth`/`frameHeight` it reports.
 */

import { PNG } from 'pngjs';

export class FrameStripError extends Error {
  constructor(
    public readonly kind: 'no-frames' | 'size-mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'FrameStripError';
  }
}

export interface FrameStripResult {
  readonly buffer: Buffer;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly frameCount: number;
}

/**
 * Pack `frames` (already-decoded-size-uniform PNG buffers, in cycle order)
 * into one horizontal strip PNG. Throws `FrameStripError('no-frames')` for
 * an empty array, and `FrameStripError('size-mismatch')` if any frame's
 * dimensions differ from frame 0's.
 */
export function packFrameStrip(frames: ReadonlyArray<Buffer>): FrameStripResult {
  if (frames.length === 0) {
    throw new FrameStripError('no-frames', 'packFrameStrip requires at least one frame');
  }

  const decoded = frames.map((buf) => PNG.sync.read(buf));
  const frameWidth = decoded[0]!.width;
  const frameHeight = decoded[0]!.height;
  decoded.forEach((png, i) => {
    if (png.width !== frameWidth || png.height !== frameHeight) {
      throw new FrameStripError(
        'size-mismatch',
        `Frame ${i} is ${png.width}x${png.height}, expected ${frameWidth}x${frameHeight} ` +
          `(from frame 0) — all frames in a sequence must be uniform-sized.`,
      );
    }
  });

  const strip = new PNG({ width: frameWidth * decoded.length, height: frameHeight });
  // Manual row-by-row copy (not pngjs's bitblt) for the same reason
  // slice-sheet.ts's extractCell avoids it: bitblt's signature differs
  // subtly between pngjs versions, and a manual copy is trivially correct.
  decoded.forEach((src, index) => {
    const dstOriginX = index * frameWidth;
    for (let y = 0; y < frameHeight; y++) {
      const srcStart = y * frameWidth * 4;
      const srcEnd = srcStart + frameWidth * 4;
      const dstStart = (y * strip.width + dstOriginX) * 4;
      src.data.copy(strip.data, dstStart, srcStart, srcEnd);
    }
  });

  return {
    buffer: PNG.sync.write(strip),
    frameWidth,
    frameHeight,
    frameCount: decoded.length,
  };
}
