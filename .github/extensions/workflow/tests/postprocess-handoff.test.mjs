import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildPostprocessDeepLink } from '../lib/postprocess-handoff.mjs';

test('builds a deep link carrying briefId, runId, sheet, and variantIndex', () => {
  const link = buildPostprocessDeepLink({
    briefId: 'goblin-warrior',
    runId: 'run-2026-01-01T00-00-00',
    sheet: 'sheet-01.png',
    variantIndex: 3,
  });
  assert.equal(
    link,
    'project:postprocess briefId=goblin-warrior runId=run-2026-01-01T00-00-00 sheet=sheet-01.png variantIndex=3',
  );
});

test('omits optional fields (sheet, variantIndex) when absent', () => {
  const link = buildPostprocessDeepLink({ briefId: 'b', runId: 'r' });
  assert.equal(link, 'project:postprocess briefId=b runId=r');
});

test('variantIndex 0 is included (falsy but valid)', () => {
  const link = buildPostprocessDeepLink({ briefId: 'b', runId: 'r', variantIndex: 0 });
  assert.match(link, /variantIndex=0/);
});

test('URL-encodes special characters in briefId/runId/sheet', () => {
  const link = buildPostprocessDeepLink({
    briefId: 'a b',
    runId: 'r/1',
    sheet: 'sheet name.png',
  });
  assert.match(link, /briefId=a%20b/);
  assert.match(link, /runId=r%2F1/);
  assert.match(link, /sheet=sheet%20name\.png/);
});

test('tolerates a missing/undefined context', () => {
  assert.equal(buildPostprocessDeepLink(undefined), 'project:postprocess');
  assert.equal(buildPostprocessDeepLink({}), 'project:postprocess');
});
