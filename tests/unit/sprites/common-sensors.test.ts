/**
 * Unit tests for sensors/common.ts — focused on the `dimensionsExact`
 * EFFECTIVE GEOMETRY contract:
 *
 *   wide  (width strategy): exact W required; height MUST NOT exceed target H
 *   tall  (height strategy): exact H required; width MUST NOT exceed target W
 *   large (cover strategy): exact W×H required (no secondary-axis growth)
 *   fit   (normal sprites): exact W×H required
 *   tile  (stretch): trimAndFit path skips the sensor entirely
 *
 * These tests pin the new overflow-rejection behavior so a future
 * rollback of the EFFECTIVE GEOMETRY fix is immediately visible.
 */

import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { briefSchema, type Brief } from '../../../scripts/sprites/brief-schema.js';
import { dimensionsExact } from '../../../scripts/sprites/sensors/common.js';

function makeImage(w: number, h: number): { width: number; height: number; data: Uint8Array } {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 120;
    png.data[i + 1] = 120;
    png.data[i + 2] = 120;
    png.data[i + 3] = 255;
  }
  const buf = PNG.sync.write(png);
  const decoded = PNG.sync.read(buf);
  return {
    width: decoded.width,
    height: decoded.height,
    data: new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
  };
}

function makeWideBrief(w = 128, h = 64): Brief {
  return briefSchema.parse({
    type: 'enemy',
    name: 'wide-enemy',
    size: { width: w, height: h },
    palette: { id: 'kenney-roguelike' },
    anchor: { x: w / 2, y: h / 2 },
    tags: [],
    prompt: 'A wide enemy.',
    references: [{ path: 'docs/refs/r.png' }],
    generation: { sheet: { rows: 3, cols: 2, emptyCells: [], nativeCanvas: 1024 } },
  });
}

function makeTallBrief(w = 64, h = 128): Brief {
  return briefSchema.parse({
    type: 'enemy',
    name: 'tall-enemy',
    size: { width: w, height: h },
    palette: { id: 'kenney-roguelike' },
    anchor: { x: w / 2, y: h / 2 },
    tags: [],
    prompt: 'A tall enemy.',
    references: [{ path: 'docs/refs/r.png' }],
    generation: { sheet: { rows: 2, cols: 3, emptyCells: [], nativeCanvas: 1024 } },
  });
}

function makeLargeBrief(w = 128, h = 128): Brief {
  return briefSchema.parse({
    type: 'enemy',
    name: 'large-enemy',
    size: { width: w, height: h },
    palette: { id: 'kenney-roguelike' },
    anchor: { x: w / 2, y: h / 2 },
    tags: [],
    prompt: 'A large enemy.',
    references: [{ path: 'docs/refs/r.png' }],
    generation: { sheet: { rows: 2, cols: 2, emptyCells: [], nativeCanvas: 1024 } },
  });
}

function makeSquareBrief(size = 64): Brief {
  return briefSchema.parse({
    type: 'weapon',
    name: 'sword',
    size: { width: size, height: size },
    palette: { id: 'kenney-roguelike' },
    anchor: { x: size / 2, y: size - 2 },
    tags: [],
    prompt: 'A sword.',
    references: [{ path: 'docs/refs/r.png' }],
  });
}

// ---------------------------------------------------------------------------
// Wide (width strategy) — exact W, height must not exceed H
// ---------------------------------------------------------------------------
describe('dimensionsExact — wide (width strategy)', () => {
  it('passes when image is exactly the target dimensions', () => {
    const r = dimensionsExact(makeImage(128, 64), makeWideBrief());
    expect(r.ok).toBe(true);
  });

  it('passes when height is less than target (undersized secondary axis is fine)', () => {
    const r = dimensionsExact(makeImage(128, 50), makeWideBrief());
    expect(r.ok).toBe(true);
  });

  it('fails when width does not match target', () => {
    const r = dimensionsExact(makeImage(100, 64), makeWideBrief());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/expected width 128/);
  });

  it('fails when height EXCEEDS target — EFFECTIVE GEOMETRY overflow violation', () => {
    const r = dimensionsExact(makeImage(128, 96), makeWideBrief());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/EFFECTIVE GEOMETRY/);
    expect(r.ok === false && r.reason).toMatch(/exceeds target 64/);
  });

  it('uses the sensor name dimensions-exact on failure', () => {
    const r = dimensionsExact(makeImage(128, 114), makeWideBrief());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.sensor).toBe('dimensions-exact');
  });
});

// ---------------------------------------------------------------------------
// Tall (height strategy) — exact H, width must not exceed W
// ---------------------------------------------------------------------------
describe('dimensionsExact — tall (height strategy)', () => {
  it('passes when image is exactly the target dimensions', () => {
    const r = dimensionsExact(makeImage(64, 128), makeTallBrief());
    expect(r.ok).toBe(true);
  });

  it('passes when width is less than target (undersized secondary axis is fine)', () => {
    const r = dimensionsExact(makeImage(50, 128), makeTallBrief());
    expect(r.ok).toBe(true);
  });

  it('fails when height does not match target', () => {
    const r = dimensionsExact(makeImage(64, 100), makeTallBrief());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/expected height 128/);
  });

  it('fails when width EXCEEDS target — EFFECTIVE GEOMETRY overflow violation', () => {
    const r = dimensionsExact(makeImage(90, 128), makeTallBrief());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/EFFECTIVE GEOMETRY/);
    expect(r.ok === false && r.reason).toMatch(/exceeds target 64/);
  });
});

// ---------------------------------------------------------------------------
// Large (cover strategy) — exact W×H required
// ---------------------------------------------------------------------------
describe('dimensionsExact — large (cover strategy)', () => {
  it('passes when image is exactly the target dimensions', () => {
    const r = dimensionsExact(makeImage(128, 128), makeLargeBrief());
    expect(r.ok).toBe(true);
  });

  it('fails when image is smaller than target', () => {
    const r = dimensionsExact(makeImage(100, 100), makeLargeBrief());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/expected exactly 128x128/);
  });

  it('fails when image EXCEEDS target — no secondary-axis growth allowed', () => {
    const r = dimensionsExact(makeImage(150, 128), makeLargeBrief());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/expected exactly 128x128/);
  });

  it('fails when only one axis is wrong', () => {
    const r = dimensionsExact(makeImage(128, 150), makeLargeBrief());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/expected exactly 128x128/);
  });
});

// ---------------------------------------------------------------------------
// Normal (fit strategy) — exact W×H
// ---------------------------------------------------------------------------
describe('dimensionsExact — normal square (fit strategy)', () => {
  it('passes when image matches exactly', () => {
    const r = dimensionsExact(makeImage(64, 64), makeSquareBrief());
    expect(r.ok).toBe(true);
  });

  it('fails when width differs', () => {
    const r = dimensionsExact(makeImage(63, 64), makeSquareBrief());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/64x64/);
  });

  it('fails when height differs', () => {
    const r = dimensionsExact(makeImage(64, 65), makeSquareBrief());
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// trimAndFit skips the sensor
// ---------------------------------------------------------------------------
describe('dimensionsExact — trimAndFit bypass', () => {
  it('always returns ok when trimAndFit is enabled regardless of dimensions', () => {
    const brief: Brief = {
      ...makeSquareBrief(),
      postprocessing: { trimAndFit: true },
    } as Brief;
    // Wildly wrong dimensions — should still pass because trimAndFit skips the check.
    const r = dimensionsExact(makeImage(999, 1), brief);
    expect(r.ok).toBe(true);
  });
});
