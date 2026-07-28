import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  briefSchema,
  type Brief,
  type PaletteColors,
  type SpriteType,
} from '../../../scripts/sprites/brief-schema.js';
import { postprocess, postprocessWithTrace } from '../../../scripts/sprites/postprocess.js';
import {
  getActiveModules,
  getPipelineForType,
} from '../../../scripts/sprites/template-pipeline.js';

const PALETTE: PaletteColors = [
  [0, 0, 0],
  [0, 180, 40],
  [255, 0, 255],
  [30, 60, 200],
  [255, 255, 255],
];

// Magenta is one of the per-item generation background candidates
// (build-prompt.ts BACKGROUND_CANDIDATES). A model routinely paints that
// background into enclosed holes (ring centre, bow inner curve). The enclosed
// pocket below reproduces that: sealed from the border by a green foreground
// ring, so 4-corner edge flood-fill can never reach it.
const MAGENTA: readonly [number, number, number] = [255, 0, 255];
const GREEN: readonly [number, number, number] = [0, 180, 40];
// Far from magenta in squared RGB (57250 » 12000 fringe) — a legitimate interior
// accent (e.g. a blue gem) that must survive enclosed-region cleanup.
const FAR: readonly [number, number, number] = [30, 60, 200];

function makeBrief(type: SpriteType, dimension: number): Brief {
  return briefSchema.parse({
    type,
    name: `${type}-enclosed-test`,
    size: { width: dimension, height: dimension },
    palette: { id: 'kenney-roguelike' },
    anchor: { x: dimension / 2, y: dimension - 1 },
    tags: [type, 'test'],
    prompt: `test ${type}`,
    references: [],
    // paletteMode 'none' keeps colours intact (no quantization) and resize is
    // nearest-neighbour, so an UNCLEARED magenta pocket stays exactly magenta in
    // the output while a CLEARED one is fully transparent — a deterministic check.
    postprocessing: { paletteMode: 'none', trimAndFit: false, minDimension: dimension },
    sensors: { edge: { allowMainTouch: true }, anchor: { derive: true } },
  });
}

function setPixel(
  png: PNG,
  x: number,
  y: number,
  [r, g, b]: readonly [number, number, number],
  alpha = 255,
): void {
  const idx = (y * png.width + x) * 4;
  png.data[idx] = r;
  png.data[idx + 1] = g;
  png.data[idx + 2] = b;
  png.data[idx + 3] = alpha;
}

/**
 * 64x64: solid magenta field, a 3px-thick green foreground ring at [16..47],
 * and a magenta interior pocket sealed inside it. If `pocketColor` is given it
 * paints the interior that colour instead (used for the far-colour case).
 */
function makeEnclosedPocketFixture(
  pocketColor: readonly [number, number, number] = MAGENTA,
): Buffer {
  const png = new PNG({ width: 64, height: 64 });
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      setPixel(png, x, y, MAGENTA);
    }
  }
  // 3px-thick green ring frame from (16,16) to (47,47).
  for (let y = 16; y <= 47; y++) {
    for (let x = 16; x <= 47; x++) {
      const onFrame = x <= 18 || x >= 45 || y <= 18 || y >= 45;
      if (onFrame) setPixel(png, x, y, GREEN);
    }
  }
  // Interior pocket (19..44) — magenta by default (already filled), or override.
  if (pocketColor !== MAGENTA) {
    for (let y = 19; y <= 44; y++) {
      for (let x = 19; x <= 44; x++) {
        setPixel(png, x, y, pocketColor);
      }
    }
  }
  return PNG.sync.write(png);
}

function alphaAt(png: PNG, x: number, y: number): number {
  return png.data[(y * png.width + x) * 4 + 3] ?? 0;
}

function hasOpaquePixelNear(png: PNG, color: readonly [number, number, number]): boolean {
  const [tr, tg, tb] = color;
  for (let i = 0; i < png.width * png.height; i++) {
    const o = i * 4;
    if ((png.data[o + 3] ?? 0) < 200) continue;
    const dr = (png.data[o] ?? 0) - tr;
    const dg = (png.data[o + 1] ?? 0) - tg;
    const db = (png.data[o + 2] ?? 0) - tb;
    if (dr * dr + dg * dg + db * db <= 1024) return true;
  }
  return false;
}

describe('postprocess enclosed-region cleanup for item-family sprite types', () => {
  it('activates the enclosed-regions module for every non-opted-out type', () => {
    const include: SpriteType[] = ['weapon', 'item', 'equipment', 'prop', 'enemy', 'character'];
    for (const type of include) {
      const names = getActiveModules(getPipelineForType(type), type).map(({ name }) => name);
      expect(names, `${type} should run enclosed-regions`).toContain('enclosed-regions');
    }
  });

  it('keeps the enclosed-regions module OFF for explicitly-disabled types (tile, vfx)', () => {
    for (const type of ['tile', 'vfx'] as SpriteType[]) {
      const names = getActiveModules(getPipelineForType(type), type).map(({ name }) => name);
      expect(names, `${type} must not run enclosed-regions`).not.toContain('enclosed-regions');
    }
  });

  it('clears an enclosed background pocket in a weapon sprite (runs the cleanup stage)', () => {
    const { finalPng, steps } = postprocessWithTrace(
      makeEnclosedPocketFixture(),
      makeBrief('weapon', 32),
      PALETTE,
    );

    // The dedicated cleanup stage actually ran (id is only pushed when enabled).
    const cleanup = steps.find((s) => s.id === 'background-enclosed-regions');
    expect(cleanup, 'enclosed-region cleanup stage should have run').toBeDefined();

    // Assert on the cleanup stage image directly (pre-resize, native coords) so
    // the proof cannot be attributed to a later stage such as background-rekey.
    const afterCleanup = PNG.sync.read(cleanup!.png);
    expect(alphaAt(afterCleanup, 31, 31)).toBe(0);

    // End-to-end: no opaque magenta survives anywhere in the final sprite.
    expect(hasOpaquePixelNear(PNG.sync.read(finalPng), MAGENTA)).toBe(false);
  });

  it('clears an enclosed background pocket in an equipment sprite', () => {
    const out = PNG.sync.read(
      postprocess(makeEnclosedPocketFixture(), makeBrief('equipment', 32), PALETTE),
    );
    expect(hasOpaquePixelNear(out, MAGENTA)).toBe(false);
  });

  it('preserves a legitimate enclosed interior accent far from the background colour', () => {
    const out = PNG.sync.read(
      postprocess(makeEnclosedPocketFixture(FAR), makeBrief('weapon', 32), PALETTE),
    );
    // The blue accent is nowhere near the magenta corner colour, so both the
    // pre-resize cleanup and the post-resize rekey pass must leave it intact.
    expect(hasOpaquePixelNear(out, FAR)).toBe(true);
    expect(hasOpaquePixelNear(out, MAGENTA)).toBe(false);
  });

  it('honours the disabledModules opt-out: rekey must not clear the pocket either', () => {
    const { finalPng, steps } = postprocessWithTrace(
      makeEnclosedPocketFixture(),
      makeBrief('weapon', 32),
      PALETTE,
      { disabledModules: ['enclosed-regions'] },
    );
    // Cleanup stage never ran...
    expect(steps.find((s) => s.id === 'background-enclosed-regions')).toBeUndefined();
    // ...and because the run flag is derived from the effective pipeline, the
    // background-rekey pass leaves the enclosed pocket alone too.
    expect(hasOpaquePixelNear(PNG.sync.read(finalPng), MAGENTA)).toBe(true);
  });

  it('honours the global enclosedBackgroundMode disabled escape hatch', () => {
    const out = PNG.sync.read(
      postprocess(makeEnclosedPocketFixture(), makeBrief('weapon', 32), PALETTE, {
        modules: { enclosedBackgroundMode: 'disabled' },
      }),
    );
    expect(hasOpaquePixelNear(out, MAGENTA)).toBe(true);
  });
});
