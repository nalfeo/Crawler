import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../extension.mjs', import.meta.url), 'utf8');

function orderPairs(result) {
  const start = SRC.indexOf('  // Emit newest-first, with a live-dev-to-latest overview');
  const end = SRC.indexOf('// ── live tool-use tracking');
  assert.ok(start > -1 && end > start, 'ordering block must be locatable');
  const body = SRC.slice(start, end).replace(/\}\s*$/, '');
  return new Function('result', `const LIVE_DEV_VERSION = 'live-dev';\n${body}`)(result);
}

const shot = (iso) => ({ path: 'p' + iso, takenAt: iso });
const pair = (key, before, after, bs, as) => ({
  key,
  before: shot(before),
  after: shot(after),
  states: { before: bs, after: as },
  reviews: { before: null, after: null },
});

test('backend emits lineage newest-first with a live-dev-to-latest overview first', () => {
  // Supplied oldest-first, the natural byKey order.
  const ordered = orderPairs([
    pair(
      'equipment · v0.1.0',
      '2026-08-19T00:09:45Z',
      '2026-08-19T00:07:06Z',
      'live-dev',
      'v0.1.0',
    ),
    pair('equipment · v0.2.0', '2026-08-19T00:07:06Z', '2026-08-19T16:24:28Z', 'v0.1.0', 'v0.2.0'),
    pair('equipment · v0.2.1', '2026-08-19T16:24:28Z', '2026-08-19T20:14:12Z', 'v0.2.0', 'v0.2.1'),
  ]);
  assert.deepEqual(
    ordered.map((p) => p.states.before + '|' + p.states.after),
    ['live-dev|v0.2.1', 'v0.2.0|v0.2.1', 'v0.1.0|v0.2.0', 'live-dev|v0.1.0'],
  );
});

test('backend ordering ignores incoming array order', () => {
  const ordered = orderPairs([
    pair('equipment · v0.2.1', '2026-08-19T16:24:28Z', '2026-08-19T20:14:12Z', 'v0.2.0', 'v0.2.1'),
    pair(
      'equipment · v0.1.0',
      '2026-08-19T00:09:45Z',
      '2026-08-19T00:07:06Z',
      'live-dev',
      'v0.1.0',
    ),
    pair('equipment · v0.2.0', '2026-08-19T00:07:06Z', '2026-08-19T16:24:28Z', 'v0.1.0', 'v0.2.0'),
  ]);
  assert.deepEqual(
    ordered.map((p) => p.states.before + '|' + p.states.after),
    ['live-dev|v0.2.1', 'v0.2.0|v0.2.1', 'v0.1.0|v0.2.0', 'live-dev|v0.1.0'],
  );
});

test('backend keeps incomplete comparisons after the full lineage', () => {
  const incomplete = {
    key: 'tooltip · v0.1.0',
    before: null,
    after: shot('2026-08-19T20:16:17Z'),
    states: { before: null, after: 'v0.1.0' },
    reviews: {},
  };
  const ordered = orderPairs([
    incomplete,
    pair(
      'equipment · v0.1.0',
      '2026-08-19T00:09:45Z',
      '2026-08-19T00:07:06Z',
      'live-dev',
      'v0.1.0',
    ),
    pair('equipment · v0.2.0', '2026-08-19T00:07:06Z', '2026-08-19T16:24:28Z', 'v0.1.0', 'v0.2.0'),
  ]);
  assert.equal(ordered.at(-1).key, 'tooltip · v0.1.0');
  assert.equal(ordered[0].states.after, 'v0.2.0');
});
