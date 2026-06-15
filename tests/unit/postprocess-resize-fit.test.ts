import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { briefSchema, type Brief, type PaletteColors } from '../../scripts/sprites/brief-schema.js';
import { postprocess } from '../../scripts/sprites/postprocess.js';

const PALETTE: PaletteColors = [
  [0, 0, 0],
  [255, 255, 255],
];

function makeBrief(): Brief {
  return briefSchema.parse({
    type: 'enemy',
    name: 'resize-fit-test',
    size: { width: 6, height: 6 },
    palette: { id: 'kenney-roguelike' },
    anchor: { x: 3, y: 5 },
    tags: ['test'],
    prompt: 'test',
    references: [
      { path: 'public/assets/kenney/tiny-dungeon/spritesheet.png' },
      { path: 'public/assets/kenney/roguelike-rpg-pack/spritesheet.png' },
    ],
    postprocessing: { paletteMode: 'none', trimAndFit: false, minDimension: 64 },
  });
}

function makeWideFixture(): Buffer {
  const png = new PNG({ width: 8, height: 4 });
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 8; x++) {
      const idx = (y * 8 + x) * 4;
      png.data[idx] = 220;
      png.data[idx + 1] = 40;
      png.data[idx + 2] = 40;
      png.data[idx + 3] = 255;
    }
  }
  // Keep corners transparent so background flood fill does not erase the sprite.
  const corners: ReadonlyArray<[number, number]> = [
    [0, 0],
    [7, 0],
    [0, 3],
    [7, 3],
  ];
  for (const [x, y] of corners) {
    const idx = (y * 8 + x) * 4;
    png.data[idx] = 255;
    png.data[idx + 1] = 0;
    png.data[idx + 2] = 255;
    png.data[idx + 3] = 0;
  }
  return PNG.sync.write(png);
}

function makeOffCenterFixture(): Buffer {
  const png = new PNG({ width: 8, height: 8 });
  // Magenta background for deterministic corner flood fill.
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const idx = (y * 8 + x) * 4;
      png.data[idx] = 255;
      png.data[idx + 1] = 0;
      png.data[idx + 2] = 255;
      png.data[idx + 3] = 255;
    }
  }
  // Subject is intentionally left-biased.
  for (let y = 2; y <= 5; y++) {
    for (let x = 1; x <= 2; x++) {
      const idx = (y * 8 + x) * 4;
      png.data[idx] = 40;
      png.data[idx + 1] = 200;
      png.data[idx + 2] = 60;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function alphaAt(png: PNG, x: number, y: number): number {
  return png.data[(y * png.width + x) * 4 + 3] ?? 0;
}

describe('postprocess resize fit', () => {
  it('fits non-square sprites into target size without stretching', () => {
    const out = PNG.sync.read(postprocess(makeWideFixture(), makeBrief(), PALETTE));
    expect(out.width).toBe(6);
    expect(out.height).toBe(6);

    // Wide 8x4 source should fit as 6x3 centered vertically in a 6x6 frame.
    for (let x = 0; x < 6; x++) {
      expect(alphaAt(out, x, 0)).toBe(0);
      expect(alphaAt(out, x, 5)).toBe(0);
    }
    // Center band is opaque.
    expect(alphaAt(out, 2, 2)).toBe(255);
    expect(alphaAt(out, 3, 3)).toBe(255);
  });

  it('centers an off-center subject inside the output frame', () => {
    const out = PNG.sync.read(postprocess(makeOffCenterFixture(), makeBrief(), PALETTE));
    expect(out.width).toBe(6);
    expect(out.height).toBe(6);

    // Subject should be centered horizontally, so left and right transparent gutters match.
    for (let y = 0; y < 6; y++) {
      expect(alphaAt(out, 0, y)).toBe(0);
      expect(alphaAt(out, 5, y)).toBe(0);
    }
    // Center columns carry the subject.
    expect(alphaAt(out, 2, 2)).toBe(255);
    expect(alphaAt(out, 3, 3)).toBe(255);
  });
});
