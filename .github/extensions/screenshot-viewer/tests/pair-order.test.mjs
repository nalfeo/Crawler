import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../extension.mjs', import.meta.url), 'utf8');

function orderPairs(result) {
  const start = SRC.indexOf('  // Emit newest-first, with a Main-to-latest overview');
  const end = SRC.indexOf('// ── live tool-use tracking');
  assert.ok(start > -1 && end > start, 'ordering block must be locatable');
  const body = SRC.slice(start, end).replace(/\}\s*$/, '');
  return new Function('result', body)(result);
}

const shot = (iso) => ({ path: 'p' + iso, takenAt: iso });
const pair = (key, before, after, bs, as) => ({
  key,
  before: shot(before),
  after: shot(after),
  states: { before: bs, after: as },
  reviews: { before: null, after: null },
});

test('backend emits lineage newest-first with a Main-to-latest overview first', () => {
  // Supplied oldest-first, the natural byKey order.
  const ordered = orderPairs([
    pair('equipment (v3)', '2026-08-19T00:09:45Z', '2026-08-19T00:07:06Z', 'main', 'v3'),
    pair('equipment (v4)', '2026-08-19T00:07:06Z', '2026-08-19T16:24:28Z', 'v3', 'v4'),
    pair('equipment (v5)', '2026-08-19T16:24:28Z', '2026-08-19T20:14:12Z', 'v4', 'v5'),
  ]);
  assert.deepEqual(
    ordered.map((p) => p.states.before + '|' + p.states.after),
    ['main|v5', 'v4|v5', 'v3|v4', 'main|v3'],
  );
});

test('backend ordering ignores incoming array order', () => {
  const ordered = orderPairs([
    pair('equipment (v5)', '2026-08-19T16:24:28Z', '2026-08-19T20:14:12Z', 'v4', 'v5'),
    pair('equipment (v3)', '2026-08-19T00:09:45Z', '2026-08-19T00:07:06Z', 'main', 'v3'),
    pair('equipment (v4)', '2026-08-19T00:07:06Z', '2026-08-19T16:24:28Z', 'v3', 'v4'),
  ]);
  assert.deepEqual(
    ordered.map((p) => p.states.before + '|' + p.states.after),
    ['main|v5', 'v4|v5', 'v3|v4', 'main|v3'],
  );
});

test('backend keeps incomplete comparisons after the full lineage', () => {
  const incomplete = {
    key: 'tooltip (current)',
    before: null,
    after: shot('2026-08-19T20:16:17Z'),
    states: { before: null, after: 'current' },
    reviews: {},
  };
  const ordered = orderPairs([
    incomplete,
    pair('equipment (v3)', '2026-08-19T00:09:45Z', '2026-08-19T00:07:06Z', 'main', 'v3'),
    pair('equipment (v4)', '2026-08-19T00:07:06Z', '2026-08-19T16:24:28Z', 'v3', 'v4'),
  ]);
  assert.equal(ordered.at(-1).key, 'tooltip (current)');
  assert.equal(ordered[0].states.after, 'v4');
});
