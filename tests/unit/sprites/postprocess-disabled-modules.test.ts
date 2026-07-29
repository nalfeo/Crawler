import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  briefSchema,
  type Brief,
  type PaletteColors,
} from '../../../scripts/sprites/brief-schema.js';
import {
  frameSequenceDisabledModules,
  normalizeDisabledModules,
  postprocessWithTrace,
  computeOpaqueRect,
  cropRectWithMargin,
  computeFrameSequenceUnionCropRect,
  type OpaqueRect,
  type RgbaImage,
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

function makeCharacterFrameSequenceBrief(): Brief {
  return briefSchema.parse({
    type: 'character',
    name: 'frame-sequence-disabled-module-test',
    size: { width: 64, height: 64 },
    palette: { id: 'kenney-roguelike' },
    anchor: { x: 32, y: 63 },
    tags: ['character', 'test'],
    prompt: 'test walk cycle',
    references: [
      { path: 'public/assets/kenney/tiny-dungeon/spritesheet.png' },
      { path: 'public/assets/kenney/roguelike-rpg-pack/spritesheet.png' },
    ],
    postprocessing: { paletteMode: 'none', trimAndFit: false, minDimension: 64 },
    frameSequence: { enabled: true, frameCount: 4, frameRate: 8, loop: true },
    generation: { sheet: { rows: 1, cols: 4, emptyCells: [] } },
    sensors: { edge: { allowMainTouch: true }, anchor: { derive: true } },
  });
}

/** Build a raw PNG with a solid block of opaque pixels in a given region.
 *  Uses (32, 96, 144) — distance² from black = 30976, well above the
 *  BACKGROUND_B_FRINGE_TOLERANCE_SQ of 12000, so removeBackgroundFringe
 *  never clears these pixels.
 */
function makePngWithBlock(
  width: number,
  height: number,
  blockX: number,
  blockY: number,
  blockW: number,
  blockH: number,
): Buffer {
  const png = new PNG({ width, height });
  for (let y = blockY; y < blockY + blockH; y++) {
    for (let x = blockX; x < blockX + blockW; x++) {
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const idx = (y * png.width + x) * 4;
      png.data[idx] = 32;
      png.data[idx + 1] = 96;
      png.data[idx + 2] = 144;
      png.data[idx + 3] = 255;
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

  describe('frameSequenceDisabledModules', () => {
    it('returns only trim-and-fit for a frameSequence-enabled brief (transparent-trim now uses union crop instead)', () => {
      // transparent-trim is no longer disabled: it now uses the pre-computed
      // union bounding box (sharedCropRect) so all frames share the same
      // crop-to-canvas mapping. Only trim-and-fit (post-resize per-frame
      // re-trim) is still disabled, since that reintroduces independent
      // centering per frame even after the uniform initial crop.
      expect(frameSequenceDisabledModules(makeCharacterFrameSequenceBrief())).toEqual([
        'trim-and-fit',
      ]);
    });

    it('returns an empty array for a brief that does not opt into frameSequence', () => {
      expect(frameSequenceDisabledModules(makeTileBrief())).toEqual([]);
    });

    it('transparent-trim runs (not skipped) for frame-sequence briefs', () => {
      const brief = makeCharacterFrameSequenceBrief();
      const disabledModules = frameSequenceDisabledModules(brief);
      const traced = postprocessWithTrace(makeFixture(), brief, PALETTE, { disabledModules });
      const trimStep = traced.steps.find((step) => step.moduleId === 'transparent-trim');

      // transparent-trim must NOT be skipped — it runs using the per-frame
      // bbox (no sharedCropRect provided in this call) or the shared bbox
      // when provided via options.sharedCropRect.
      expect(trimStep).toMatchObject({ moduleId: 'transparent-trim', skipped: false });
    });

    it('transparent-trim uses the shared union bbox when sharedCropRect is provided', () => {
      const brief = makeCharacterFrameSequenceBrief();
      const sharedCropRect: OpaqueRect = { left: 10, top: 10, right: 30, bottom: 50 };
      const traced = postprocessWithTrace(makeFixture(), brief, PALETTE, { sharedCropRect });
      const trimStep = traced.steps.find((step) => step.moduleId === 'transparent-trim');

      expect(trimStep).toBeDefined();
      expect(trimStep!.skipped).toBe(false);
      // The step label must name the shared union bbox path.
      expect(trimStep!.label).toMatch(/shared union bbox/);
    });
  });

  describe('computeOpaqueRect', () => {
    it('returns the tight opaque bbox for a non-empty image', () => {
      const img: RgbaImage = {
        width: 10,
        height: 10,
        data: new Uint8Array(10 * 10 * 4),
      };
      // Set a single 2×2 opaque block at (3,4)...(4,5)
      const data = img.data as Uint8Array;
      for (let y = 4; y <= 5; y++) {
        for (let x = 3; x <= 4; x++) {
          data[(y * 10 + x) * 4 + 3] = 255;
        }
      }
      const rect = computeOpaqueRect(img);
      expect(rect).toEqual({ left: 3, top: 4, right: 4, bottom: 5 });
    });

    it('returns null for a fully transparent image', () => {
      const img: RgbaImage = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4) };
      expect(computeOpaqueRect(img)).toBeNull();
    });
  });

  describe('cropRectWithMargin', () => {
    it('crops a source image to the given rect plus margin', () => {
      // Build a 20×20 image with a 4×4 block at (5,5)..(8,8)
      const src: RgbaImage = {
        width: 20,
        height: 20,
        data: new Uint8Array(20 * 20 * 4),
      };
      const data = src.data as Uint8Array;
      for (let y = 5; y <= 8; y++) {
        for (let x = 5; x <= 8; x++) {
          const i = (y * 20 + x) * 4;
          data[i] = 200;
          data[i + 3] = 255;
        }
      }
      const result = cropRectWithMargin(src, { left: 5, top: 5, right: 8, bottom: 8 }, 2);
      // Content is 4×4, margin=2 → output is 8×8
      expect(result.width).toBe(8);
      expect(result.height).toBe(8);
      // Center pixel (at margin+0, margin+0 = 2,2 → offset (2*8+2)*4 = 72) should be 200
      expect(result.data[72]).toBe(200);
    });

    it('returns empty image for zero-area rect', () => {
      const src: RgbaImage = { width: 10, height: 10, data: new Uint8Array(10 * 10 * 4) };
      const result = cropRectWithMargin(src, { left: 5, top: 5, right: 4, bottom: 5 }, 0);
      expect(result.width).toBe(0);
      expect(result.height).toBe(0);
    });

    it('handles rect that extends beyond source bounds (fills out-of-bounds with transparency)', () => {
      const src: RgbaImage = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4) };
      // Set a pixel at (7,7)
      (src.data as Uint8Array)[(7 * 8 + 7) * 4 + 3] = 255;
      // Rect extends past the source edge
      const result = cropRectWithMargin(src, { left: 6, top: 6, right: 10, bottom: 10 }, 0);
      // Content bbox is 5×5 (6..10), but source only goes to 7 → out-of-bounds → transparent
      expect(result.width).toBe(5);
      expect(result.height).toBe(5);
      // Pixel at (1,1) in output = source (7,7) = opaque
      expect(result.data[(1 * 5 + 1) * 4 + 3]).toBe(255);
      // Pixel at (4,4) in output = source (10,10) = out of bounds = transparent
      expect(result.data[(4 * 5 + 4) * 4 + 3]).toBe(0);
    });
  });

  describe('computeFrameSequenceUnionCropRect', () => {
    it('returns null for an empty frame array', () => {
      expect(computeFrameSequenceUnionCropRect([])).toBeNull();
    });

    it('returns the union of two frames with non-overlapping content areas', () => {
      // Frame 0: opaque block in left half, frame 1: opaque block in right half.
      // Both frames have the same background corner pixels (white) for the
      // background-removal flood fill to clear; the union should span both.
      const frame0 = makePngWithBlock(64, 64, 5, 20, 10, 20);
      const frame1 = makePngWithBlock(64, 64, 40, 20, 10, 20);

      const rect = computeFrameSequenceUnionCropRect([frame0, frame1]);
      // Union must span left=5 to right=49, top=20 to bottom=39
      expect(rect).not.toBeNull();
      // The union left should be ≤ 5 and right should be ≥ 49
      expect(rect!.left).toBeLessThanOrEqual(5);
      expect(rect!.right).toBeGreaterThanOrEqual(49);
    });

    it('returns null when all frames are fully transparent', () => {
      const empty = new PNG({ width: 16, height: 16 });
      const buf = PNG.sync.write(empty);
      expect(computeFrameSequenceUnionCropRect([buf, buf])).toBeNull();
    });
  });
});
