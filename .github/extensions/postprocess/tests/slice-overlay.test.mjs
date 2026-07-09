/**
 * Unit tests for the pure slice-overlay geometry/selection/status helpers. These
 * are the SAME functions serialized into the browser client, so testing them in
 * Node also guards the overlay math the iframe draws (monolith parity with
 * `drawSliceMapOnCanvas` / `buildSliceStatusText` in `src/devtools-main.ts`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeOverlayScale,
  computeDisplayDims,
  projectCell,
  indicesTrustworthy,
  resolveSelectedCell,
  classifyCell,
  buildSliceStatusText,
  hitTestCell,
  shouldApplyResponse,
} from '../lib/slice-overlay.mjs';

const MIDDOT = '\u00b7';
const DASH = '\u2014';
const TIMES = '\u00d7';
const WARN = '\u26a0';

test('computeOverlayScale caps at 640 (monolith maxW)', () => {
  assert.equal(computeOverlayScale(320), 1); // <= cap → 1:1
  assert.equal(computeOverlayScale(640), 1);
  assert.equal(computeOverlayScale(1280), 0.5); // 640/1280
  assert.equal(computeOverlayScale(0), 1); // guard: no natural width
  assert.equal(computeOverlayScale(1000, 500), 0.5); // custom cap
});

test('computeDisplayDims + projectCell round to integers', () => {
  assert.deepEqual(computeDisplayDims(1280, 640, 0.5), { dw: 640, dh: 320 });
  // 0.5 scale with an odd coordinate exercises Math.round
  assert.deepEqual(projectCell({ x0: 33, y0: 65, w: 31, h: 31 }, 0.5), {
    dx: 17, // round(16.5)
    dy: 33, // round(32.5)
    dw: 16, // round(15.5)
    dh: 16,
  });
});

test('indicesTrustworthy mirrors emptyCellsApplied !== false', () => {
  assert.equal(indicesTrustworthy({ emptyCellsApplied: true }), true);
  assert.equal(indicesTrustworthy({}), true); // undefined → trustworthy
  assert.equal(indicesTrustworthy({ emptyCellsApplied: false }), false);
  assert.equal(indicesTrustworthy(null), false);
});

test('resolveSelectedCell finds the cell only when indices are trustworthy', () => {
  const cells = [
    { index: 0, x0: 0, y0: 0, w: 16, h: 16, empty: false },
    { index: 1, x0: 16, y0: 0, w: 16, h: 16, empty: false },
  ];
  assert.equal(resolveSelectedCell({ cells, emptyCellsApplied: true }, 1), cells[1]);
  assert.equal(resolveSelectedCell({ cells, emptyCellsApplied: true }, 5), null); // no match
  assert.equal(resolveSelectedCell({ cells, emptyCellsApplied: false }, 1), null); // degraded
  assert.equal(resolveSelectedCell(null, 0), null);
});

test('classifyCell → empty | selected | other', () => {
  const sm = { emptyCellsApplied: true };
  assert.equal(classifyCell({ empty: true, index: 0 }, sm, 0), 'empty');
  assert.equal(classifyCell({ empty: false, index: 2 }, sm, 2), 'selected');
  assert.equal(classifyCell({ empty: false, index: 3 }, sm, 2), 'other');
  // degraded slice map can never select
  assert.equal(classifyCell({ empty: false, index: 2 }, { emptyCellsApplied: false }, 2), 'other');
});

test('buildSliceStatusText: grid + no-nudge + selected label', () => {
  const sm = {
    cols: 4,
    rows: 2,
    cellW: 32,
    cellH: 32,
    rowOffsets: [0, 0],
    colOffsets: [0, 0],
    emptyCellsApplied: true,
    cells: [{ index: 0, x0: 0, y0: 0, w: 32, h: 32, empty: false }],
  };
  const expected =
    '4' +
    TIMES +
    '2 grid ' +
    MIDDOT +
    ' 32' +
    TIMES +
    '32px cells' +
    ' ' +
    MIDDOT +
    ' no nudge' +
    ' ' +
    DASH +
    ' variant #0 at (0,0) 32' +
    TIMES +
    '32px';
  assert.equal(buildSliceStatusText(sm, 0), expected);
});

test('buildSliceStatusText: autoNudge note when offsets are non-zero', () => {
  const sm = {
    cols: 2,
    rows: 1,
    cellW: 16,
    cellH: 16,
    rowOffsets: [1],
    colOffsets: [0, -2],
    emptyCellsApplied: true,
    cells: [],
  };
  const text = buildSliceStatusText(sm, 0);
  assert.ok(text.includes(MIDDOT + ' autoNudge: rows[1] cols[0,-2]'), text);
  assert.ok(!text.includes('no nudge'), text);
});

test('buildSliceStatusText: degraded warning + no selected label', () => {
  const sm = {
    cols: 2,
    rows: 2,
    cellW: 16,
    cellH: 16,
    rowOffsets: [0, 0],
    colOffsets: [0, 0],
    emptyCellsApplied: false,
    cells: [{ index: 0, x0: 0, y0: 0, w: 16, h: 16, empty: false }],
  };
  const text = buildSliceStatusText(sm, 0);
  assert.ok(text.includes(WARN + ' approximate slicing (brief unavailable) ' + DASH), text);
  assert.ok(!text.includes('variant #0 at'), text); // degraded → no cell label
});

test('buildSliceStatusText returns empty string for a missing slice map', () => {
  assert.equal(buildSliceStatusText(null, 0), '');
});

test('hitTestCell hits non-empty cells within their display rect', () => {
  const hits = [
    { cell: { index: 0, empty: false }, x: 0, y: 0, w: 20, h: 20 },
    { cell: { index: 1, empty: true }, x: 20, y: 0, w: 20, h: 20 },
    { cell: { index: 2, empty: false }, x: 40, y: 0, w: 20, h: 20 },
  ];
  assert.equal(hitTestCell(hits, 10, 10).cell.index, 0);
  assert.equal(hitTestCell(hits, 50, 10).cell.index, 2);
  assert.equal(hitTestCell(hits, 25, 10), null); // over an empty cell → not selectable
  assert.equal(hitTestCell(hits, 200, 200), null); // outside all cells
  assert.equal(hitTestCell(null, 0, 0), null);
});

test('shouldApplyResponse only accepts the newest in-flight seq', () => {
  assert.equal(shouldApplyResponse(3, 3), true);
  assert.equal(shouldApplyResponse(2, 3), false); // stale
  assert.equal(shouldApplyResponse('3', 3), false); // non-number guard
});
