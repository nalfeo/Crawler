import { describe, expect, it } from 'vitest';
import { briefSchema, type PaletteColors } from '../../scripts/sprites/brief-schema.js';
import {
  postprocessModules,
  type ModuleContext,
} from '../../scripts/sprites/postprocess-modules.js';

interface TestImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

const PALETTE: PaletteColors = [
  [0, 0, 0],
  [255, 255, 255],
];

const BRIEF = briefSchema.parse({
  type: 'enemy',
  name: 'speckle-mode-regression',
  size: { width: 3, height: 3 },
  palette: { id: 'kenney-roguelike' },
  anchor: { x: 1, y: 2 },
  tags: ['test'],
  prompt: 'test',
  references: [
    { path: 'public/assets/kenney/tiny-dungeon/spritesheet.png' },
    { path: 'public/assets/kenney/roguelike-rpg-pack/spritesheet.png' },
  ],
  postprocessing: { paletteMode: 'none', trimAndFit: false, minDimension: 64 },
});

function makeSingleSpeckleImage(): TestImage {
  const data = new Uint8Array(3 * 3 * 4);
  const idx = (1 * 3 + 1) * 4;
  data[idx] = 255;
  data[idx + 1] = 255;
  data[idx + 2] = 255;
  data[idx + 3] = 255;
  return { width: 3, height: 3, data };
}

function alphaAt(image: TestImage, x: number, y: number): number {
  return image.data[(y * image.width + x) * 4 + 3] ?? 0;
}

function makeContext(steps: string[]): ModuleContext {
  return {
    brief: BRIEF,
    palette: PALETTE,
    pushStep: (id) => {
      steps.push(id);
    },
  };
}

describe('postprocessModules speckle-cleanup', () => {
  it('drops edge orphans in edge-drop mode', () => {
    const steps: string[] = [];
    const handler = postprocessModules['speckle-cleanup'];
    expect(handler).toBeDefined();

    const out = handler!(makeSingleSpeckleImage(), { mode: 'edge-drop' }, makeContext(steps));
    expect(alphaAt(out, 1, 1)).toBe(0);
    expect(steps).toContain('speckle-cleanup');
  });

  it('preserves edge orphans in preserve-orphans mode', () => {
    const steps: string[] = [];
    const handler = postprocessModules['speckle-cleanup'];
    expect(handler).toBeDefined();

    const out = handler!(
      makeSingleSpeckleImage(),
      { mode: 'preserve-orphans' },
      makeContext(steps),
    );
    expect(alphaAt(out, 1, 1)).toBe(255);
    expect(steps).toContain('speckle-cleanup');
  });

  it('skips cleanup when disabled', () => {
    const steps: string[] = [];
    const handler = postprocessModules['speckle-cleanup'];
    expect(handler).toBeDefined();

    const out = handler!(makeSingleSpeckleImage(), { mode: 'disabled' }, makeContext(steps));
    expect(alphaAt(out, 1, 1)).toBe(255);
    expect(steps).toContain('speckle-cleanup-disabled');
  });
});
