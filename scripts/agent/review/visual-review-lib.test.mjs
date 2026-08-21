import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeGeometryBlockers,
  computeAlignmentBlockers,
  suppressUnsupportedAlignment,
  normalizeOverallScore,
  deriveAnchoredScore,
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
// containment (container overrun)
// ---------------------------------------------------------------------------

test('containment: a slot crossing its panel top edge is reported with pixels', () => {
  const blockers = computeGeometryBlockers([
    region('panel', box(0, 100, 400, 300), { kind: 'panel' }),
    region('slot:head', box(20, 90, 40, 40), { kind: 'slot', parentId: 'panel' }),
  ]);
  assert.equal(blockers.length, 1);
  assert.match(
    blockers[0],
    /^Region overruns its container: slot:head crosses panel top by 9px\.$/,
  );
});

test('containment: a fully-inside child is not reported', () => {
  assert.deepEqual(
    computeGeometryBlockers([
      region('panel', box(0, 100, 400, 300), { kind: 'panel' }),
      region('slot:head', box(20, 120, 40, 40), { kind: 'slot', parentId: 'panel' }),
    ]),
    [],
  );
});

test('containment: 1px is tolerated (matches the icon-escape threshold)', () => {
  assert.deepEqual(
    computeGeometryBlockers([
      region('panel', box(0, 100, 400, 300), { kind: 'panel' }),
      region('slot:head', box(20, 99, 40, 40), { kind: 'slot', parentId: 'panel' }),
    ]),
    [],
  );
});

test('containment: multiple crossed edges are listed together', () => {
  const blockers = computeGeometryBlockers([
    region('panel', box(100, 100, 200, 200), { kind: 'panel' }),
    region('text:title', box(90, 90, 300, 300), { kind: 'text', parentId: 'panel' }),
  ]);
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /left by 9px, top by 9px, right by 89px, bottom by 89px/);
});

test('containment: an icon still reports with the legacy wording', () => {
  const blockers = computeGeometryBlockers([
    region('slot:head', box(20, 120, 40, 40), { kind: 'slot' }),
    region('slot:head.icon', box(10, 120, 40, 40), { kind: 'icon', parentId: 'slot:head' }),
  ]);
  assert.deepEqual(blockers, ['Icon escapes its box: slot:head.icon (outside slot:head).']);
});

test('containment: a region with no declared parent is never reported', () => {
  assert.deepEqual(
    computeGeometryBlockers([region('slot:head', box(-50, -50, 40, 40), { kind: 'slot' })]),
    [],
  );
});

// ---------------------------------------------------------------------------
// grid alignment
// ---------------------------------------------------------------------------

test('alignment: a slot 2px off its row is reported', () => {
  const blockers = computeAlignmentBlockers([
    region('slot:gloves', box(20, 200, 40, 40), { kind: 'slot', parentId: 'panel' }),
    region('slot:legs', box(120, 200, 40, 40), { kind: 'slot', parentId: 'panel' }),
    region('slot:ring2', box(220, 202, 40, 40), { kind: 'slot', parentId: 'panel' }),
  ]);
  assert.equal(blockers.length, 1);
  assert.match(
    blockers[0],
    /^Slot is off its row: slot:ring2 top edge is 2px off the row shared by slot:gloves, slot:legs\.$/,
  );
});

test('alignment: deliberate separate rows are NOT reported (the ring1/ring2 false positive)', () => {
  // Crawler's paper doll puts Ring 1 in the top row and Ring 2 two rows below.
  assert.deepEqual(
    computeAlignmentBlockers([
      region('slot:neck', box(20, 0, 40, 40), { kind: 'slot', parentId: 'panel' }),
      region('slot:head', box(120, 0, 40, 40), { kind: 'slot', parentId: 'panel' }),
      region('slot:ring1', box(220, 0, 40, 40), { kind: 'slot', parentId: 'panel' }),
      region('slot:gloves', box(20, 198, 40, 40), { kind: 'slot', parentId: 'panel' }),
      region('slot:legs', box(120, 198, 40, 40), { kind: 'slot', parentId: 'panel' }),
      region('slot:ring2', box(220, 198, 40, 40), { kind: 'slot', parentId: 'panel' }),
    ]),
    [],
  );
});

test('alignment: a slot off its column is reported', () => {
  const blockers = computeAlignmentBlockers([
    region('slot:head', box(120, 0, 40, 40), { kind: 'slot', parentId: 'panel' }),
    region('slot:chest', box(120, 100, 40, 40), { kind: 'slot', parentId: 'panel' }),
    region('slot:feet', box(123, 200, 40, 40), { kind: 'slot', parentId: 'panel' }),
  ]);
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /off its column: slot:feet left edge is 3px/);
});

test('alignment: a 1px difference is tolerated', () => {
  assert.deepEqual(
    computeAlignmentBlockers([
      region('slot:gloves', box(20, 200, 40, 40), { kind: 'slot', parentId: 'panel' }),
      region('slot:legs', box(120, 201, 40, 40), { kind: 'slot', parentId: 'panel' }),
    ]),
    [],
  );
});

test('alignment: a lone slot never fires', () => {
  assert.deepEqual(
    computeAlignmentBlockers([
      region('slot:ring1', box(20, 200, 40, 40), { kind: 'slot', parentId: 'panel' }),
    ]),
    [],
  );
});

test('alignment: non-slot kinds do not participate', () => {
  assert.deepEqual(
    computeAlignmentBlockers([
      region('text:a', box(20, 200, 40, 40), { kind: 'text', parentId: 'panel' }),
      region('text:b', box(120, 206, 40, 40), { kind: 'text', parentId: 'panel' }),
    ]),
    [],
  );
});

test('alignment blockers surface through computeGeometryBlockers', () => {
  const blockers = computeGeometryBlockers([
    region('slot:gloves', box(20, 200, 40, 40), { kind: 'slot', parentId: 'panel' }),
    region('slot:legs', box(120, 200, 40, 40), { kind: 'slot', parentId: 'panel' }),
    region('slot:ring2', box(220, 206, 40, 40), { kind: 'slot', parentId: 'panel' }),
  ]);
  assert.ok(blockers.some((b) => /off its row/.test(b)));
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
// deriveAnchoredScore
// ---------------------------------------------------------------------------

/** Three judge runs over BYTE-IDENTICAL captures actually returned this. */
const NOISE_AXES = {
  layout_consistency: { score: 78 },
  spacing_balance: { score: 68 },
  visual_hierarchy: { score: 75 },
  readability: { score: 65 },
  icon_usage: { score: 60 },
  typography_clarity: { score: 80 },
  thematic_fidelity: { score: 70 },
};

test('deriveAnchoredScore: clean surface scores the axis mean with no penalty', () => {
  const r = deriveAnchoredScore({
    overall: { score: 72 },
    axes: NOISE_AXES,
    blocking_findings: [],
    deterministic_blocking_findings: [],
  });
  assert.equal(r.penalty, 0);
  assert.equal(r.score, r.axisMean);
  assert.equal(r.anchored, true);
  assert.equal(r.modelScore, 72);
});

test('deriveAnchoredScore: the real 2/0/3-blocker noise triplet now separates', () => {
  const base = { overall: { score: 72 }, axes: NOISE_AXES, deterministic_blocking_findings: [] };
  const a = deriveAnchoredScore({ ...base, blocking_findings: ['x', 'y'] });
  const b = deriveAnchoredScore({ ...base, blocking_findings: [] });
  const c = deriveAnchoredScore({ ...base, blocking_findings: ['x', 'y', 'z'] });
  // The model gave all three the same 72; the anchored score must not.
  assert.ok(b.score > a.score, 'zero blockers must beat two');
  assert.ok(a.score > c.score, 'two blockers must beat three');
});

test('deriveAnchoredScore: a deterministic blocker costs more than an llm claim', () => {
  const det = deriveAnchoredScore({
    axes: NOISE_AXES,
    blocking_findings: ['Slot boxes overlap: a intersects b.'],
    deterministic_blocking_findings: ['Slot boxes overlap: a intersects b.'],
  });
  const llm = deriveAnchoredScore({
    axes: NOISE_AXES,
    blocking_findings: ['the header feels cramped'],
    deterministic_blocking_findings: [],
  });
  assert.equal(det.deterministicBlockers, 1);
  assert.equal(det.llmBlockers, 0);
  assert.equal(llm.llmBlockers, 1);
  assert.ok(det.score < llm.score);
});

test('deriveAnchoredScore: deterministic classification survives rewording (findingKey)', () => {
  const r = deriveAnchoredScore({
    axes: NOISE_AXES,
    blocking_findings: ['Shift tooltip left ~18px to sit flush beside it'],
    deterministic_blocking_findings: ['Shift tooltip left ~24px to sit flush beside it'],
  });
  assert.equal(r.deterministicBlockers, 1);
  assert.equal(r.llmBlockers, 0);
});

test('deriveAnchoredScore: score is clamped at 0 when penalties exceed the mean', () => {
  const r = deriveAnchoredScore({
    axes: { a: { score: 10 } },
    blocking_findings: Array.from({ length: 20 }, (_, i) => `d${i}`),
    deterministic_blocking_findings: Array.from({ length: 20 }, (_, i) => `d${i}`),
  });
  assert.equal(r.score, 0);
});

test('deriveAnchoredScore: falls back to the model score when no usable axes exist', () => {
  const r = deriveAnchoredScore({ overall: { score: 72 }, axes: {}, blocking_findings: ['x'] });
  assert.equal(r.anchored, false);
  assert.equal(r.score, 72);
  assert.equal(r.axisMean, null);
});

test('deriveAnchoredScore: identical input is deterministic across calls', () => {
  const input = {
    overall: { score: 72 },
    axes: NOISE_AXES,
    blocking_findings: ['x', 'y'],
    deterministic_blocking_findings: ['x'],
  };
  assert.deepEqual(deriveAnchoredScore(input), deriveAnchoredScore(input));
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

test('suppressUnsupportedAlignment: drops misalignment claims the grid check disproves', () => {
  const result = {
    blocking_findings: [
      'Paired slots Ring 1 and Ring 2 are misaligned vertically by 2px.',
      'Tooltip text is cramped.',
    ],
    recommended_fixes: ['Align Ring 1 and Ring 2 to the same vertical baseline.'],
    precise_fixes: [
      { kind: 'move', id: 'slot:ring1', reason: 'Ring 1 is misaligned with Ring 2.' },
      { kind: 'pad', id: 'tooltip', reason: 'Tooltip text is cramped.' },
    ],
  };
  const removed = suppressUnsupportedAlignment(result, []);
  assert.equal(removed, 3);
  assert.deepEqual(result.blocking_findings, ['Tooltip text is cramped.']);
  assert.deepEqual(result.recommended_fixes, []);
  assert.equal(result.precise_fixes.length, 1);
  assert.equal(result.precise_fixes[0].id, 'tooltip');
});

test('suppressUnsupportedAlignment: keeps claims when the grid check found a real defect', () => {
  const result = {
    blocking_findings: ['Head and Neck are misaligned.'],
  };
  const removed = suppressUnsupportedAlignment(result, [
    'Slot is off its row: neck top edge is 4px off the row shared by head.',
  ]);
  assert.equal(removed, 0);
  assert.equal(result.blocking_findings.length, 1);
});

test('suppressUnsupportedAlignment: drops overlap/touch claims the geometry disproves', () => {
  const result = {
    blocking_findings: [
      'Slot boxes touch each other horizontally with no breathing room.',
      'Tooltip overlaps the bottom edge of the panel by 40px.',
      'Empty-slot icons lack thematic depth.',
    ],
  };
  const removed = suppressUnsupportedAlignment(result, []);
  assert.equal(removed, 2);
  assert.deepEqual(result.blocking_findings, ['Empty-slot icons lack thematic depth.']);
});

test('suppressUnsupportedAlignment: keeps overlap claims when geometry found a real overlap', () => {
  const result = { blocking_findings: ['Slot boxes touch each other horizontally.'] };
  const removed = suppressUnsupportedAlignment(result, ['Slot boxes overlap: a intersects b.']);
  assert.equal(removed, 0);
});

test('suppressUnsupportedAlignment: drops header and bag-icon claims disproved by declared evidence', () => {
  const result = {
    blocking_findings: [
      'Headers are inconsistently aligned within their panels.',
      'Headers (Equipment, Stats, Bag) are not vertically aligned.',
      'Headers lack sufficient top padding, appearing too close to their panel edges.',
      'Some icons in the Bag section appear slightly off-center within their slots.',
    ],
  };
  const headers = [
    region('header:equipment', box(10, 10, 80, 20), { kind: 'header' }),
    region('header:stats', box(110, 10, 40, 20), { kind: 'header' }),
    region('header:bag', box(210, 10, 30, 20), { kind: 'header' }),
  ];
  const removed = suppressUnsupportedAlignment(result, [], headers);
  assert.equal(removed, 4);
  assert.deepEqual(result.blocking_findings, []);
});
