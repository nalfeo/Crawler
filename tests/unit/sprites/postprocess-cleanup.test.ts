import { describe, it, expect } from 'vitest';
import {
  hardThresholdAlpha,
  removeIsolatedNearWhiteSpeckles,
  type RgbaImage,
} from '../../../scripts/sprites/postprocess.js';

function imageFromRgba(
  width: number,
  height: number,
  pixels: ReadonlyArray<readonly [number, number, number, number]>,
): RgbaImage {
  if (pixels.length !== width * height) {
    throw new Error(`pixel count ${pixels.length} != ${width}*${height}`);
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i] as readonly [number, number, number, number];
    data[i * 4] = p[0];
    data[i * 4 + 1] = p[1];
    data[i * 4 + 2] = p[2];
    data[i * 4 + 3] = p[3];
  }
  return { width, height, data };
}

describe('hardThresholdAlpha', () => {
  it('promotes alpha > 128 to 255 and demotes alpha <= 128 to 0', () => {
    const img = imageFromRgba(1, 5, [
      [0, 0, 0, 0],
      [0, 0, 0, 128],
      [0, 0, 0, 129],
      [0, 0, 0, 200],
      [0, 0, 0, 255],
    ]);
    const out = hardThresholdAlpha(img);
    const alphas = [out.data[3], out.data[7], out.data[11], out.data[15], out.data[19]];
    expect(alphas).toEqual([0, 0, 255, 255, 255]);
  });

  describe('removeIsolatedNearWhiteSpeckles', () => {
    it('recolors isolated near-white speckles to neighboring opaque color', () => {
      const img = imageFromRgba(3, 1, [
        [40, 50, 60, 255],
        [255, 255, 255, 255],
        [40, 50, 60, 255],
      ]);
      const out = removeIsolatedNearWhiteSpeckles(img);
      expect([out.data[4], out.data[5], out.data[6], out.data[7]]).toEqual([40, 50, 60, 255]);
    });

    it('drops edge-adjacent near-white pixel when no opaque neighbors exist', () => {
      const img = imageFromRgba(2, 1, [
        [255, 255, 255, 255],
        [0, 0, 0, 0],
      ]);
      const out = removeIsolatedNearWhiteSpeckles(img);
      expect(out.data[3]).toBe(0);
    });

    it('recolors near-white edge fringe pixels that touch transparency', () => {
      const img = imageFromRgba(3, 3, [
        [0, 0, 0, 0],
        [80, 60, 40, 255],
        [0, 0, 0, 0],
        [80, 60, 40, 255],
        [252, 252, 252, 255],
        [80, 60, 40, 255],
        [80, 60, 40, 255],
        [80, 60, 40, 255],
        [80, 60, 40, 255],
      ]);
      const out = removeIsolatedNearWhiteSpeckles(img);
      expect([out.data[16], out.data[17], out.data[18], out.data[19]]).toEqual([80, 60, 40, 255]);
    });
  });
});
