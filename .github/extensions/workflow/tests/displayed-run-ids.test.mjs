import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readDisplayedRunIds } from '../lib/displayed-run-ids.mjs';

test('displayed-run route validation rejects missing and blank identifiers', () => {
  for (const body of [
    {},
    { briefId: 'brief', runId: '' },
    { briefId: ' ', runId: 'run' },
    { briefId: 'brief', runId: ' \t' },
    { briefId: 1, runId: 'run' },
  ]) {
    assert.equal(readDisplayedRunIds(body), null);
  }
});

test('displayed-run route validation normalizes identifiers before sidecar and cache use', () => {
  assert.deepEqual(readDisplayedRunIds({ briefId: ' brief ', runId: '\trun\n' }), {
    briefId: 'brief',
    runId: 'run',
  });
});
