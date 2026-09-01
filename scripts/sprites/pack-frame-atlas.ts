import { PNG } from 'pngjs';
import { FrameStripError, type FrameStripResult } from './pack-frame-strip.js';

export interface FrameAtlasResult extends FrameStripResult {
  readonly columns: number;
  readonly rows: number;
}

export function packFrameAtlas(frames: ReadonlyArray<Buffer>, columns: number): FrameAtlasResult {
  if (frames.length === 0) {
    throw new FrameStripError('no-frames', 'packFrameAtlas requires at least one frame');
  }
  if (!Number.isInteger(columns) || columns < 1 || frames.length % columns !== 0) {
    throw new FrameStripError(
      'size-mismatch',
      `Frame count ${frames.length} must divide evenly into ${columns} atlas columns.`,
    );
  }

  const decoded = frames.map((buffer) => PNG.sync.read(buffer));
  const frameWidth = decoded[0]!.width;
  const frameHeight = decoded[0]!.height;
  for (const [index, png] of decoded.entries()) {
    if (png.width !== frameWidth || png.height !== frameHeight) {
      throw new FrameStripError(
        'size-mismatch',
        `Frame ${index} is ${png.width}x${png.height}, expected ${frameWidth}x${frameHeight}.`,
      );
    }
  }

  const rows = frames.length / columns;
  const atlas = new PNG({ width: frameWidth * columns, height: frameHeight * rows });
  decoded.forEach((src, index) => {
    const originX = (index % columns) * frameWidth;
    const originY = Math.floor(index / columns) * frameHeight;
    for (let y = 0; y < frameHeight; y += 1) {
      const srcStart = y * frameWidth * 4;
      const srcEnd = srcStart + frameWidth * 4;
      const dstStart = ((originY + y) * atlas.width + originX) * 4;
      src.data.copy(atlas.data, dstStart, srcStart, srcEnd);
    }
  });

  return {
    buffer: PNG.sync.write(atlas),
    frameWidth,
    frameHeight,
    frameCount: frames.length,
    columns,
    rows,
  };
}
