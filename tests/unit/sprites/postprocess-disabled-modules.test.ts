import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  briefSchema,
  type Brief,
  type PaletteColors,
} from '../../../scripts/sprites/brief-schema.js';
import {
  normalizeDisabledModules,
  postprocessWithTrace,
} from '../../../scripts/sprites/postprocess.js';

const PALETTE: PaletteColors = [
  [0, 0, 0],
  [32, 96, 144],
  [255, 255, 255],
];

function makeTileBrief(): Brief {
  return briefSchema.parse({
    type: 'tile',
    name: 'disabled-module-test',
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

function makeFixture(): Buffer {
  const png = new PNG({ width: 64, height: 64 });
  for (let y = 14; y < 50; y++) {
    for (let x = 20; x < 44; x++) {
      const index = (y * png.width + x) * 4;
      png.data[index] = 32;
      png.data[index + 1] = 96;
      png.data[index + 2] = 144;
      png.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe('postprocess disabled modules', () => {
  it('canonicalizes requested modules in effective pipeline order', () => {
    expect(
      normalizeDisabledModules(['resize', 'transparent-trim', 'resize'], makeTileBrief()),
    ).toEqual(['transparent-trim', 'resize']);
  });

  it('rejects unknown and inactive module IDs for the selected brief', () => {
    expect(() => normalizeDisabledModules(['not-a-module'], makeTileBrief())).toThrow(
      /unknown or inactive module/,
    );
    expect(() => normalizeDisabledModules(['background-removal'], makeTileBrief())).toThrow(
      /unknown or inactive module/,
    );
  });

  it('passes a disabled step through, keeps it visible, and changes the final output', () => {
    const traced = postprocessWithTrace(makeFixture(), makeTileBrief(), PALETTE, {
      disabledModules: ['resize'],
    });
    const skipped = traced.steps.find((step) => step.moduleId === 'resize');
    const final = PNG.sync.read(traced.finalPng);

    expect(skipped).toMatchObject({ moduleId: 'resize', skipped: true });
    expect(PNG.sync.read(skipped!.png)).toMatchObject({ width: 24, height: 36 });
    expect(final).toMatchObject({ width: 24, height: 36 });
  });
});
