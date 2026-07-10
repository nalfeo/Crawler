/**
 * Drift guard: the vendored `lib/canvas-harness.mjs` in every extension MUST be a
 * byte-for-byte copy of the single-source-of-truth `scripts/canvas-harness/`.
 * `checkHarness()` (EOL-normalized) is the same check the `sync.mjs --check` CLI
 * runs; asserting it here means CI fails loudly if a copy is hand-edited or the
 * canonical file changes without re-vendoring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkHarness } from '../../../../scripts/canvas-harness/sync.mjs';

test('vendored canvas-harness copies are in sync with the canonical source', () => {
  const result = checkHarness();
  assert.equal(
    result.ok,
    true,
    `vendored canvas-harness drifted from canonical: ${JSON.stringify(result.drifted)}. ` +
      `Run "node scripts/canvas-harness/sync.mjs" to re-vendor.`,
  );
  assert.ok(
    result.checked.includes('workflow'),
    `expected the workflow vendored copy to be checked; checked=${JSON.stringify(result.checked)}`,
  );
});
