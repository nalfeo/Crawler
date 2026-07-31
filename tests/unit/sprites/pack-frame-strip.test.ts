import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { FrameStripError, packFrameStrip } from '../../../scripts/sprites/pack-frame-strip.js';

function makeFrame(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe('packFrameStrip', () => {
  it('packs N uniform frames into one width*N x height strip with no gaps', () => {
    const frames = [
      makeFrame(4, 6, [255, 0, 0]),
      makeFrame(4, 6, [0, 255, 0]),
      makeFrame(4, 6, [0, 0, 255]),
    ];
    const result = packFrameStrip(frames);
    expect(result.frameWidth).toBe(4);
    expect(result.frameHeight).toBe(6);
    expect(result.frameCount).toBe(3);

    const strip = PNG.sync.read(result.buffer);
    expect(strip.width).toBe(12);
    expect(strip.height).toBe(6);

    // Sample a pixel from the middle of each frame's cell region and confirm
    // it carries that frame's color, with no cross-frame bleed.
    const sample = (x: number, y: number): [number, number, number] => {
      const idx = (y * strip.width + x) * 4;
      return [strip.data[idx]!, strip.data[idx + 1]!, strip.data[idx + 2]!];
    };
    expect(sample(2, 3)).toEqual([255, 0, 0]); // frame 0
    expect(sample(6, 3)).toEqual([0, 255, 0]); // frame 1
    expect(sample(10, 3)).toEqual([0, 0, 255]); // frame 2
  });

  it('preserves alpha (transparent background stays transparent)', () => {
    const png = new PNG({ width: 2, height: 2 });
    // Leave fully transparent (all zeros).
    const transparentFrame = PNG.sync.write(png);
    const result = packFrameStrip([transparentFrame, transparentFrame]);
    const strip = PNG.sync.read(result.buffer);
    expect(strip.data[3]).toBe(0); // alpha channel of first pixel
  });

  it('throws FrameStripError("no-frames") for an empty array', () => {
    expect(() => packFrameStrip([])).toThrow(FrameStripError);
    try {
      packFrameStrip([]);
    } catch (err) {
      expect(err).toBeInstanceOf(FrameStripError);
      expect((err as FrameStripError).kind).toBe('no-frames');
    }
  });

  it('throws FrameStripError("size-mismatch") when a frame differs in size from frame 0', () => {
    const frames = [makeFrame(4, 4, [1, 2, 3]), makeFrame(5, 4, [1, 2, 3])];
    expect(() => packFrameStrip(frames)).toThrow(FrameStripError);
    try {
      packFrameStrip(frames);
    } catch (err) {
      expect(err).toBeInstanceOf(FrameStripError);
      expect((err as FrameStripError).kind).toBe('size-mismatch');
    }
  });

  it('single-frame input packs to a strip identical to the source frame', () => {
    const frame = makeFrame(3, 3, [9, 9, 9]);
    const result = packFrameStrip([frame]);
    expect(result.frameCount).toBe(1);
    const strip = PNG.sync.read(result.buffer);
    expect(strip.width).toBe(3);
    expect(strip.height).toBe(3);
  });
});
