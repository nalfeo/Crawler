import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeGeometryBlockers,
  normalizeOverallScore,
  findingKey,
  findingKeys,
  dedupeFindings,
  diffFindings,
  lacksPixelGroundedGeometry,
} from './visual-review-lib.mjs';

/** @typedef {import('./visual-review-lib.d.mts').VisualReviewRegion} Region */

function region(id, box, extra = {}) {
  return { id, box, ...extra };
}
function box(x, y, width, height) {
  return { x, y, width, height };
}

// ---------------------------------------------------------------------------
// computeGeometryBlockers
// ---------------------------------------------------------------------------

test('computeGeometryBlockers: empty / invalid input returns []', () => {
  assert.deepEqual(computeGeometryBlockers([]), []);
  assert.deepEqual(computeGeometryBlockers(undefined), []);
  // width 0 and non-finite boxes are skipped.
  assert.deepEqual(
    computeGeometryBlockers([
      region('a', box(0, 0, 0, 64), { kind: 'slot' }),
      region('b', box(0, 0, Number.NaN, 64), { kind: 'slot' }),
    ]),
    [],
  );
});

test('computeGeometryBlockers: overlapping sibling slots flag an overlap with ids', () => {
  const out = computeGeometryBlockers([
    region('cell:0', box(0, 0, 64, 64), { kind: 'slot', parentId: 'panel' }),
    region('cell:1', box(32, 0, 64, 64), { kind: 'slot', parentId: 'panel' }),
  ]);
  assert.deepEqual(out, ['Slot boxes overlap: cell:0 intersects cell:1.']);
});

test('computeGeometryBlockers: touching siblings (gap 0, shared extent >= 8) flag touch, not overlap', () => {
  const out = computeGeometryBlockers([
    region('cell:0', box(0, 0, 64, 64), { kind: 'slot', parentId: 'panel' }),
    region('cell:1', box(0, 64, 64, 64), { kind: 'slot', parentId: 'panel' }),
  ]);
  assert.deepEqual(out, ['Slot boxes touch with no breathing room: cell:0 adjacent to cell:1.']);
});

test('computeGeometryBlockers: comfortable gap (5px) produces no blocker', () => {
  const out = computeGeometryBlockers([
    region('cell:0', box(0, 0, 64, 64), { kind: 'slot', parentId: 'panel' }),
    region('cell:1', box(0, 69, 64, 64), { kind: 'slot', parentId: 'panel' }),
  ]);
  assert.deepEqual(out, []);
});

test('computeGeometryBlockers: regions in DIFFERENT parent groups are not compared', () => {
  const out = computeGeometryBlockers([
    region('a', box(0, 0, 64, 64), { kind: 'slot', parentId: 'g1' }),
    region('b', box(32, 0, 64, 64), { kind: 'slot', parentId: 'g2' }),
  ]);
  assert.deepEqual(out, []);
});

test('computeGeometryBlockers: non-slot siblings use the generic "Regions" noun', () => {
  const out = computeGeometryBlockers([
    region('label:title', box(0, 0, 64, 20), { kind: 'text', parentId: 'panel' }),
    region('label:sub', box(32, 0, 64, 20), { kind: 'text', parentId: 'panel' }),
  ]);
  assert.deepEqual(out, ['Regions overlap: label:title intersects label:sub.']);
});

test('computeGeometryBlockers: panel/tooltip container kinds are excluded from overlap', () => {
  const out = computeGeometryBlockers([
    region('panel', box(0, 0, 100, 100), { kind: 'panel' }),
    region('tooltip', box(50, 50, 100, 100), { kind: 'tooltip' }),
  ]);
  assert.deepEqual(out, []);
});

test('computeGeometryBlockers: icon escaping its parent box is flagged; contained icon is not', () => {
  const escaping = computeGeometryBlockers([
    region('slot:head', box(100, 100, 64, 64), { kind: 'slot' }),
    region('slot:head.icon', box(95, 100, 64, 64), { kind: 'icon', parentId: 'slot:head' }),
  ]);
  assert.deepEqual(escaping, ['Icon escapes its box: slot:head.icon (outside slot:head).']);

  const contained = computeGeometryBlockers([
    region('slot:head', box(100, 100, 64, 64), { kind: 'slot' }),
    region('slot:head.icon', box(102, 102, 60, 60), { kind: 'icon', parentId: 'slot:head' }),
  ]);
  assert.deepEqual(contained, []);
});

test('computeGeometryBlockers: overlap pairs come before icon escapes (stable order)', () => {
  const out = computeGeometryBlockers([
    region('a', box(0, 0, 64, 64), { kind: 'slot', parentId: 'panel' }),
    region('b', box(32, 0, 64, 64), { kind: 'slot', parentId: 'panel' }),
    region('a.icon', box(-5, 0, 64, 64), { kind: 'icon', parentId: 'a' }),
  ]);
  assert.deepEqual(out, [
    'Slot boxes overlap: a intersects b.',
    'Icon escapes its box: a.icon (outside a).',
  ]);
});

// ---------------------------------------------------------------------------
// normalizeOverallScore
// ---------------------------------------------------------------------------

test('normalizeOverallScore: in-range 0-100 score is kept (not normalized)', () => {
  const r = normalizeOverallScore({ overall: { score: 72 }, axes: { a: { score: 70 } } });
  assert.deepEqual(r, { score: 72, raw: 72, normalized: false });
});

test('normalizeOverallScore: in-range decimal is preserved to 1 dp', () => {
  const r = normalizeOverallScore({ overall: { score: 63.5 }, axes: { a: { score: 60 } } });
  assert.equal(r.score, 63.5);
  assert.equal(r.normalized, false);
});

test('normalizeOverallScore: legacy 1-5 answer is rescaled to 0-100', () => {
  const axes = {
    layout_consistency: { score: 3 },
    spacing_balance: { score: 4 },
  };
  const r = normalizeOverallScore({ overall: { score: 3.5 }, axes });
  assert.equal(r.score, 70);
  assert.equal(r.raw, 3.5);
  assert.equal(r.normalized, true);
});

test('normalizeOverallScore: SUM-of-axes bug is repaired to the clamped mean', () => {
  const axes = {
    layout_consistency: { score: 60 },
    spacing_balance: { score: 60 },
    visual_hierarchy: { score: 60 },
    readability: { score: 60 },
    icon_usage: { score: 60 },
    typography_clarity: { score: 60 },
    thematic_fidelity: { score: 80 },
  };
  const r = normalizeOverallScore({ overall: { score: 440 }, axes });
  // mean = 440/7 = 62.857... -> 62.9
  assert.equal(r.score, 62.9);
  assert.equal(r.raw, 440);
  assert.equal(r.normalized, true);
});

test('normalizeOverallScore: out-of-range with non-finite axes falls back to clamped raw', () => {
  const r = normalizeOverallScore({ overall: { score: 440 }, axes: { a: { score: 'nope' } } });
  assert.equal(r.score, 100); // clamp(440) -> 100
  assert.equal(r.raw, 440);
  assert.equal(r.normalized, false);
});

test('normalizeOverallScore: missing score with no usable axes yields 0', () => {
  const r = normalizeOverallScore({ overall: {}, axes: {} });
  assert.equal(r.score, 0);
  assert.equal(r.normalized, false);
});

// ---------------------------------------------------------------------------
// findingKey
// ---------------------------------------------------------------------------

test('findingKey: pixel measurements are stripped so reworded deltas collapse', () => {
  assert.equal(
    findingKey('Shift tooltip left ~18px to sit flush beside it'),
    findingKey('Shift tooltip left ~24px to sit flush beside it'),
  );
});

test('findingKey: coordinate assignments are stripped', () => {
  assert.equal(
    findingKey('tooltip left edge (x=384) overhangs into the tile'),
    findingKey('tooltip left edge (x=390) overhangs into the tile'),
  );
});

test('findingKey: semantic indices are KEPT (cell 0 != cell 8)', () => {
  assert.notEqual(
    findingKey('cell 0 has no breathing room'),
    findingKey('cell 8 has no breathing room'),
  );
});

test('findingKey: case, whitespace and trailing punctuation are normalized', () => {
  assert.equal(findingKey('  Slot   Boxes Overlap.  '), 'slot boxes overlap');
  assert.equal(findingKey(42), '');
  assert.equal(findingKey(undefined), '');
});

// ---------------------------------------------------------------------------
// findingKeys / dedupeFindings / diffFindings
// ---------------------------------------------------------------------------

test('findingKeys: maps to keys and drops non-strings/empties', () => {
  assert.deepEqual(findingKeys(['Overlap here.', 42, '   ', 'Blur detected']), [
    'overlap here',
    'blur detected',
  ]);
});

test('dedupeFindings: collapses reworded duplicates, keeping first wording', () => {
  const out = dedupeFindings([
    'Shift tooltip left ~18px',
    'Shift tooltip left ~24px',
    'Text is blurry',
  ]);
  assert.deepEqual(out, ['Shift tooltip left ~18px', 'Text is blurry']);
});

test('diffFindings: splits NEW vs RECURRING against prior keys and dedupes current', () => {
  const prevKeys = findingKeys(['Text is blurry', 'Cramped rows']);
  const out = diffFindings(prevKeys, [
    'Text is blurry', // recurring
    'Slot boxes overlap: cell:0 intersects cell:1.', // new
    'Slot boxes overlap: cell:0 intersects cell:1.', // dup of the new one
  ]);
  assert.deepEqual(out, {
    new: ['Slot boxes overlap: cell:0 intersects cell:1.'],
    recurring: ['Text is blurry'],
  });
});

test('diffFindings: no prior keys means everything is NEW', () => {
  const out = diffFindings([], ['a finding', 'another finding']);
  assert.deepEqual(out, { new: ['a finding', 'another finding'], recurring: [] });
});

// ---------------------------------------------------------------------------
// lacksPixelGroundedGeometry
// ---------------------------------------------------------------------------

test('lacksPixelGroundedGeometry: none source always warns', () => {
  assert.equal(lacksPixelGroundedGeometry('none', 0), true);
  assert.equal(lacksPixelGroundedGeometry('none', 5), true);
});

test('lacksPixelGroundedGeometry: declared with 0 valid regions warns (misconfigured setup)', () => {
  // This is the exact hole reviewer PRRT_kwDOSvo2Ms6O2qUi flagged: a declared
  // contract that yields no valid regions must not pass silently.
  assert.equal(lacksPixelGroundedGeometry('declared', 0), true);
});

test('lacksPixelGroundedGeometry: declared with >=1 region does not warn', () => {
  assert.equal(lacksPixelGroundedGeometry('declared', 1), false);
  assert.equal(lacksPixelGroundedGeometry('declared', 17), false);
});

test('lacksPixelGroundedGeometry: equipment-legacy never warns (geometry comes from its probe, not regions)', () => {
  assert.equal(lacksPixelGroundedGeometry('equipment-legacy', 0), false);
});

test('lacksPixelGroundedGeometry: non-positive / non-finite region counts count as empty for declared', () => {
  assert.equal(lacksPixelGroundedGeometry('declared', -1), true);
  assert.equal(lacksPixelGroundedGeometry('declared', Number.NaN), true);
});
