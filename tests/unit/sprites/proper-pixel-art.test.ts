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

function makeAutoDetectFixture(): RgbaImage {
  const width = 128;
  const height = 128;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const logicalX = Math.floor(x / 16);
      const logicalY = Math.floor(y / 16);
      const index = (y * width + x) * 4;
      data[index] = (logicalX % 4) * 70;
      data[index + 1] = (logicalY % 4) * 70;
      data[index + 2] = (logicalX + logicalY) % 2 === 0 ? 0 : 180;
      data[index + 3] = logicalX < 2 && logicalY < 2 ? 0 : 255;
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

  it('auto-detects the production mesh path and preserves transparent cells', () => {
    const recovered = recoverPixelArtMesh(makeAutoDetectFixture());
    const alpha = Array.from(recovered.data).filter((_, index) => index % 4 === 3);

    expect({ width: recovered.width, height: recovered.height }).toEqual({
      width: 8,
      height: 8,
    });
    expect(alpha.filter((value) => value === 0)).toHaveLength(4);
    expect(createHash('sha256').update(recovered.data).digest('hex')).toBe(
      '93c5638e2f1d7f7cae18197f75d07c7c5577ca52cf3d83f79044ee313546504b',
    );
  });

  it('rejects invalid explicit pixel widths before spawning Python', () => {
    expect(() => recoverPixelArtMesh(makeGridFixture(), 0)).toThrow(/positive integer/u);
    expect(() => recoverPixelArtMesh(makeGridFixture(), 1.5)).toThrow(/positive integer/u);
  });

  it('fails closed when auto-detection returns only a trivial mesh', () => {
    const data = new Uint8Array(16 * 16 * 4);
    data.fill(255);

    expect(() => recoverPixelArtMesh({ width: 16, height: 16, data })).toThrow(
      /failed to detect a non-trivial mesh/u,
    );
  });
});
