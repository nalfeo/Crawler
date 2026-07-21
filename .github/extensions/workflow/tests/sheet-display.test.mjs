import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeSheetDisplaySize } from '../lib/sheet-display.mjs';

test('constrained mode scales a large sheet down to fit within 512x512', () => {
  const size = computeSheetDisplaySize(2048, 1024, 'constrained');
  assert.deepEqual(size, { width: 512, height: 256 });
});

test('constrained mode never upscales a sheet smaller than the cap', () => {
  const size = computeSheetDisplaySize(200, 100, 'constrained');
  assert.deepEqual(size, { width: 200, height: 100 });
});

test('constrained mode respects a custom maxSize', () => {
  const size = computeSheetDisplaySize(1000, 1000, 'constrained', 256);
  assert.deepEqual(size, { width: 256, height: 256 });
});

test('full mode always returns the natural size, regardless of cap', () => {
  const size = computeSheetDisplaySize(4096, 2048, 'full');
  assert.deepEqual(size, { width: 4096, height: 2048 });
});

test('a tall sheet is constrained by its height, not just its width', () => {
  const size = computeSheetDisplaySize(300, 3000, 'constrained');
  assert.deepEqual(size, { width: 51, height: 512 });
});

test('degrades to {0,0} for missing/zero natural dimensions', () => {
  assert.deepEqual(computeSheetDisplaySize(0, 0, 'constrained'), { width: 0, height: 0 });
  assert.deepEqual(computeSheetDisplaySize(NaN, 100, 'constrained'), { width: 0, height: 0 });
});

test('the underlying pixels are never touched — only display width/height are computed', () => {
  // This module has no notion of image bytes/src at all; it is pure sizing
  // math over natural dimensions, so it structurally cannot mutate pixels.
  const natural = { width: 800, height: 600 };
  const constrained = computeSheetDisplaySize(natural.width, natural.height, 'constrained');
  const full = computeSheetDisplaySize(natural.width, natural.height, 'full');
  assert.deepEqual(full, natural);
  assert.notDeepEqual(constrained, full);
});
