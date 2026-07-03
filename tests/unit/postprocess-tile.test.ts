import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { briefSchema, type Brief, type PaletteColors } from '../../scripts/sprites/brief-schema.js';
import { postprocess } from '../../scripts/sprites/postprocess.js';

const PALETTE: PaletteColors = [
  [0, 0, 0],
  [32, 96, 144],
  [255, 255, 255],
];

function makeTileBrief(): Brief {
  return briefSchema.parse({
    type: 'tile',
    name: 'tile-postprocess-test',
    size: { width: 256, height: 256 },
    palette: { id: 'kenney-roguelike' },
    anchor: { x: 128, y: 255 },
    tags: ['tile', 'test'],
    prompt: 'test tile',
    references: [
      { path: 'public/assets/kenney/tiny-dungeon/spritesheet.png' },
      { path: 'public/assets/kenney/roguelike-rpg-pack/spritesheet.png' },
    ],
    postprocessing: { paletteMode: 'none', trimAndFit: false, minDimension: 256 },
    sensors: { edge: { allowMainTouch: true }, anchor: { derive: true } },
  });
}

function makeBufferedTileFixture(): Buffer {
  const png = new PNG({ width: 64, height: 64 });
  for (let y = 14; y < 50; y++) {
    for (let x = 20; x < 44; x++) {
      setPixel(png, x, y, [32, 96, 144], 255);
    }
  }
  return PNG.sync.write(png);
}

function makeOpaqueCornerTileFixture(): Buffer {
  const png = new PNG({ width: 32, height: 32 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      setPixel(png, x, y, [255, 0, 255], 255);
    }
  }
  return PNG.sync.write(png);
}

function setPixel(
  png: PNG,
  x: number,
  y: number,
  [r, g, b]: readonly [number, number, number],
  alpha: number,
): void {
  const idx = (y * png.width + x) * 4;
  png.data[idx] = r;
  png.data[idx + 1] = g;
  png.data[idx + 2] = b;
  png.data[idx + 3] = alpha;
}

function alphaAt(png: PNG, x: number, y: number): number {
  return png.data[(y * png.width + x) * 4 + 3] ?? 0;
}

describe('tile postprocess', () => {
  it('slices transparent cell padding and resizes tiles exactly edge-to-edge', () => {
    const out = PNG.sync.read(postprocess(makeBufferedTileFixture(), makeTileBrief(), PALETTE));

    expect(out.width).toBe(256);
    expect(out.height).toBe(256);
    for (let x = 0; x < out.width; x++) {
      expect(alphaAt(out, x, 0)).toBe(255);
      expect(alphaAt(out, x, out.height - 1)).toBe(255);
    }
    for (let y = 0; y < out.height; y++) {
      expect(alphaAt(out, 0, y)).toBe(255);
      expect(alphaAt(out, out.width - 1, y)).toBe(255);
    }
  });

  it('keeps opaque tile corners instead of applying mob-style background removal', () => {
    const out = PNG.sync.read(postprocess(makeOpaqueCornerTileFixture(), makeTileBrief(), PALETTE));

    expect(out.width).toBe(256);
    expect(out.height).toBe(256);
    expect(alphaAt(out, 0, 0)).toBe(255);
    expect(alphaAt(out, 255, 0)).toBe(255);
    expect(alphaAt(out, 0, 255)).toBe(255);
    expect(alphaAt(out, 255, 255)).toBe(255);
  });
});
