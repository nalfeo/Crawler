import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterRuns } from '../lib/run-filter.mjs';

const RUNS = [
  { briefId: 'goblin-warrior', runId: 'run-2026-01-01T00-00-00', promoted: true },
  { briefId: 'goblin-archer', runId: 'run-2026-01-02T00-00-00', promoted: false },
  { briefId: 'rat-boss', runId: 'run-2026-01-03T00-00-00', promoted: false },
];

test('an empty query returns every run (subject to the promotion filter)', () => {
  assert.equal(filterRuns(RUNS, 'all', '').length, 3);
  assert.equal(filterRuns(RUNS, 'all', '   ').length, 3);
});

test('filters case-insensitively by a briefId substring', () => {
  const result = filterRuns(RUNS, 'all', 'GOBLIN');
  assert.deepEqual(
    result.map((r) => r.briefId),
    ['goblin-warrior', 'goblin-archer'],
  );
});

test('filters by a runId substring', () => {
  const result = filterRuns(RUNS, 'all', '01-03');
  assert.deepEqual(
    result.map((r) => r.runId),
    ['run-2026-01-03T00-00-00'],
  );
});

test('composes (ANDs) with the promotion filter rather than replacing it', () => {
  const result = filterRuns(RUNS, 'promoted', 'goblin');
  assert.deepEqual(
    result.map((r) => r.briefId),
    ['goblin-warrior'],
  );
});

test('a query with no matches returns an empty array', () => {
  assert.deepEqual(filterRuns(RUNS, 'all', 'no-such-run'), []);
});

test('tolerates a missing/undefined runs array', () => {
  assert.deepEqual(filterRuns(undefined, 'all', 'x'), []);
});
