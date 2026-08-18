import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateTextRasterRuns,
  isFuzzinessFinding,
  measureCropCrispness,
  suppressUnsupportedFuzziness,
} from './text-raster-lib.mjs';

function pixels(rows) {
  return Uint8Array.from(rows.flatMap((row) => row.flatMap((value) => [value, value, value, 255])));
}

test('distinguishes crisp transitions from softened transitions', () => {
  const crisp = measureCropCrispness({
    pixels: pixels([
      [0, 0, 255, 255],
      [0, 0, 255, 255],
    ]),
    width: 4,
    height: 2,
  });
  const soft = measureCropCrispness({
    pixels: pixels([
      [0, 24, 48, 72],
      [0, 24, 48, 72],
    ]),
    width: 4,
    height: 2,
  });
  assert.ok(crisp.score > soft.score);
  assert.equal(crisp.score, 1);
});

test('fails text runs with an unloaded font, fractional raster, or soft crop', () => {
  const report = evaluateTextRasterRuns([
    {
      id: 'good',
      text: 'Stats',
      fontFamily: 'UI Sans',
      fontLoaded: true,
      rasterX: 10,
      rasterY: 20,
      rasterScaleX: 1,
      rasterScaleY: 1,
      resolution: 2,
      crispness: 0.9,
      sampledEdges: 8,
    },
    {
      id: 'bad',
      fontLoaded: false,
      rasterX: 10.5,
      rasterY: 20,
      rasterScaleX: 1,
      rasterScaleY: 1,
      resolution: 2,
      crispness: 0.05,
      sampledEdges: 8,
    },
  ]);
  assert.equal(report.passed, false);
  assert.equal(report.entries[0].pass, true);
  assert.deepEqual(report.entries[1].failures, [
    'intended font is not loaded',
    'text raster geometry is not integer-aligned',
    'crop crispness 0.050 is below 0.1',
  ]);
});

test('removes Azure-only fuzziness claims when deterministic evidence passes', () => {
  const result = {
    blocking_findings: ['Text is blurry in the bag column', 'Footer has copious wasted space'],
    recommended_fixes: ['Use a sharper font', 'Move the footer up'],
    axes: { readability: { issues: ['Soft text reduces readability'] } },
  };
  const suppressed = suppressUnsupportedFuzziness(result, { passed: true });
  assert.equal(suppressed, 3);
  assert.deepEqual(result.blocking_findings, ['Footer has copious wasted space']);
  assert.deepEqual(result.recommended_fixes, ['Move the footer up']);
  assert.deepEqual(result.axes.readability.issues, []);
});

test('does not suppress non-text blur findings', () => {
  assert.equal(isFuzzinessFinding('Weapon icon is blurry'), false);
  assert.equal(isFuzzinessFinding('Text is blurry'), true);
});

test('preserves non-fuzziness clauses from mixed findings', () => {
  const result = {
    blocking_findings: ['Text is blurry and contrast is insufficient'],
    recommended_fixes: [],
  };
  assert.equal(suppressUnsupportedFuzziness(result, { passed: true }), 1);
  assert.deepEqual(result.blocking_findings, ['contrast is insufficient']);
});
