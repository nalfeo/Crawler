import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildPostprocessParentPatch,
  parentSelectionMatches,
} from '../lib/postprocess-parent-sync.mjs';

const candidates = [{ index: 0 }, { index: 1 }, { index: 2 }];

test('variant scope carries all candidates (reprocess clears every sibling judge map)', () => {
  assert.deepEqual(
    buildPostprocessParentPatch({
      briefId: 'brief',
      runId: 'run',
      mode: 'replace',
      applyToAll: false,
      variantIndex: 1,
      candidates,
    }),
    {
      briefId: 'brief',
      runId: 'run',
      scope: 'variant',
      variantIndex: 1,
      candidates,
    },
  );
});

test('apply-to-all and reset carry every candidate', () => {
  for (const input of [
    { mode: 'replace', applyToAll: true },
    { mode: 'reset', applyToAll: false },
  ]) {
    const patch = buildPostprocessParentPatch({
      briefId: 'brief',
      runId: 'run',
      variantIndex: 1,
      candidates,
      ...input,
    });
    assert.equal(patch.scope, 'all');
    assert.equal(patch.variantIndex, null);
    assert.deepEqual(patch.candidates, candidates);
  }
});

test('parent selection must still own the persisted run', () => {
  assert.equal(parentSelectionMatches({ briefId: 'brief', runId: 'run' }, 'brief', 'run'), true);
  assert.equal(parentSelectionMatches({ briefId: 'brief', runId: 'other' }, 'brief', 'run'), false);
});
