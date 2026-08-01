import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  briefSchema,
  type Brief,
  type PaletteColors,
} from '../../../scripts/sprites/brief-schema.js';
import { postprocess } from '../../../scripts/sprites/postprocess.js';
import { decodeSprite, dimensionsExact } from '../../../scripts/sprites/sensors/common.js';
import { scoreCandidate } from '../../../scripts/sprites/score-candidate.js';

const PALETTE: PaletteColors = [
  [0, 0, 0],
  [255, 255, 255],
];

function makeBrief(
  size: { width: number; height: number } = { width: 6, height: 6 },
  anchor: { x: number; y: number } = { x: 3, y: 5 },
): Brief {
  return briefSchema.parse({
    type: 'enemy',
    name: 'resize-fit-test',
    size,
    palette: { id: 'kenney-roguelike' },
    anchor,
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

function makeTallFixture(): Buffer {
  const png = new PNG({ width: 4, height: 8 });
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 4; x++) {
      const idx = (y * 4 + x) * 4;
      png.data[idx] = 80;
      png.data[idx + 1] = 140;
      png.data[idx + 2] = 220;
      png.data[idx + 3] = 255;
    }
  }
  const corners: ReadonlyArray<[number, number]> = [
    [0, 0],
    [3, 0],
    [0, 7],
    [3, 7],
  ];
  for (const [x, y] of corners) {
    const idx = (y * 4 + x) * 4;
    png.data[idx] = 255;
    png.data[idx + 1] = 0;
    png.data[idx + 2] = 255;
    png.data[idx + 3] = 0;
  }
  return PNG.sync.write(png);
}

function alphaAt(png: PNG, x: number, y: number): number {
  return png.data[(y * png.width + x) * 4 + 3] ?? 0;
}

function expectSensorOk(processed: Buffer, brief: Brief, sensor: string): void {
  const card = scoreCandidate(processed, brief, PALETTE);
  const result = card.breakdown.find((entry) => entry.sensor === sensor);
  expect(result).toBeDefined();
  expect(result).toMatchObject({ ok: true, sensor });
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

  it('scales double-wide briefs width-first even when output becomes taller', () => {
    const brief = makeBrief({ width: 12, height: 6 }, { x: 6, y: 3 });
    const processed = postprocess(makeTallFixture(), brief, PALETTE);
    const out = PNG.sync.read(processed);

    expect(out.width).toBe(12);
    expect(out.height).toBeGreaterThan(6);
    expect(dimensionsExact(decodeSprite(processed), brief)).toEqual({
      ok: true,
      sensor: 'dimensions-exact',
    });
    expectSensorOk(processed, brief, 'anchor-opaque');
  });

  it('scales tall briefs height-first even when output becomes wider', () => {
    const brief = makeBrief({ width: 6, height: 12 }, { x: 3, y: 6 });
    const processed = postprocess(makeWideFixture(), brief, PALETTE);
    const out = PNG.sync.read(processed);

    expect(out.height).toBe(12);
    expect(out.width).toBeGreaterThan(6);
    expect(dimensionsExact(decodeSprite(processed), brief)).toEqual({
      ok: true,
      sensor: 'dimensions-exact',
    });
    expectSensorOk(processed, brief, 'anchor-opaque');
  });

  it('scales large square briefs to keep strong 128x128 occupancy', () => {
    const brief = makeBrief({ width: 128, height: 128 }, { x: 64, y: 64 });
    const processed = postprocess(makeWideFixture(), brief, PALETTE);
    const out = PNG.sync.read(processed);

    expect(out.width).toBeGreaterThanOrEqual(128);
    expect(out.height).toBeGreaterThanOrEqual(128);
    expect(dimensionsExact(decodeSprite(processed), brief)).toEqual({
      ok: true,
      sensor: 'dimensions-exact',
    });
    expectSensorOk(processed, brief, 'anchor-opaque');
  });

  it('cover-expands canvas height for a tall silhouette in a 256x256 default-size frame', () => {
    // 256×256 is the default output size for character/enemy/prop/equipment after
    // the 256-defaults change. Square ≥128 briefs use the 'cover' resize strategy,
    // which expands the secondary axis so the subject fills the dominant axis
    // without letterboxing. A 4×8 source with 1px transparent-trim margin becomes
    // ~6×10 before resize; cover scales to width-first (scale≈42.67), giving
    // fittedHeight≈427 which expands the canvas beyond the 256 box.
    // dimensionsExact accepts any size ≥ brief.size for cover strategy.
    const brief = makeBrief({ width: 256, height: 256 }, { x: 128, y: 128 });
    const processed = postprocess(makeTallFixture(), brief, PALETTE);
    const out = PNG.sync.read(processed);

    // Width is locked to the requested 256 (dominant axis).
    expect(out.width).toBe(256);
    // Height expands past 256 — the canvas is NOT letterboxed at 256×256.
    expect(out.height).toBeGreaterThan(256);
    // Concrete regression: transparent-trim pads 4×8 → ~6×10, cover scale≈42.67
    // yields fittedHeight=round(10×42.67)=427.
    expect(out.height).toBe(427);
    expect(dimensionsExact(decodeSprite(processed), brief)).toEqual({
      ok: true,
      sensor: 'dimensions-exact',
    });
  });
});
