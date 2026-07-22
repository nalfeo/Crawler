import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildPersistPostprocessPayload,
  extractAppliedDisabledModules,
  normalizePersistRequest,
} from '../../postprocess/lib/postprocess-client.mjs';

function createFreshSelectedState(serializedSummary) {
  const summary = JSON.parse(serializedSummary);
  return {
    appliedDisabledModules: extractAppliedDisabledModules(summary),
  };
}

test('a skipped module survives persisted read-back into a fresh instance', () => {
  const request = normalizePersistRequest({
    briefId: 'goblin',
    runId: 'run-1',
    mode: 'replace',
    variantIndex: 0,
    facingDirection: 'right',
    disabledModules: ['resize'],
  });
  assert.equal(request.ok, true);
  const payload = buildPersistPostprocessPayload(request.args);
  const serializedSummary = JSON.stringify({
    postprocessOverrides: { options: payload.options },
  });

  const firstInstance = createFreshSelectedState(serializedSummary);
  firstInstance.appliedDisabledModules.length = 0;
  const reopenedInstance = createFreshSelectedState(serializedSummary);

  assert.deepEqual(reopenedInstance.appliedDisabledModules, ['resize']);
});

test('Workflow state construction hydrates skips from the fetched summary', async () => {
  const extensionPath = fileURLToPath(new URL('../extension.mjs', import.meta.url));
  const source = await readFile(extensionPath, 'utf8');
  assert.match(source, /appliedDisabledModules = extractAppliedDisabledModules\(summary\)/);
  assert.match(source, /appliedDisabledModules,/);
});
