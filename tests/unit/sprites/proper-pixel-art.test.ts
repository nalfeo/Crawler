import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { recoverPixelArtMesh, type RgbaImage } from '../../../scripts/sprites/proper-pixel-art.js';

function makeGridFixture(): RgbaImage {
  const width = 16;
  const height = 16;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      data[index] = Math.floor(x / 4) * 60;
      data[index + 1] = Math.floor(y / 4) * 60;
      data[index + 2] = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 0 : 255;
      data[index + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('recoverPixelArtMesh', () => {
  it('returns the deterministic native mesh without non-uniform source-canvas expansion', () => {
    const recovered = recoverPixelArtMesh(makeGridFixture(), 4);
    const repeated = recoverPixelArtMesh(makeGridFixture(), 4);

    expect(recovered).toEqual(repeated);
    expect({ width: recovered.width, height: recovered.height }).toEqual({
      width: 7,
      height: 7,
    });
    expect(createHash('sha256').update(recovered.data).digest('hex')).toBe(
      '3c699713d02e965cbb7b34da76ee9b987868e39c880934042a61dd034cc72fa7',
    );
  });

  it('rejects invalid explicit pixel widths before spawning Python', () => {
    expect(() => recoverPixelArtMesh(makeGridFixture(), 0)).toThrow(/positive integer/u);
    expect(() => recoverPixelArtMesh(makeGridFixture(), 1.5)).toThrow(/positive integer/u);
  });
});
