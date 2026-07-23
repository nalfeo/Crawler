import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../extension.mjs', import.meta.url), 'utf8');

test('guards refresh action state after its asynchronous refresh completes', () => {
  const refreshAction = source.match(
    /name: 'refresh',[\s\S]*?handler: async \(ctx\) => \{([\s\S]*?)\n          \},/,
  );

  assert.ok(refreshAction);
  assert.match(
    refreshAction[1],
    /const payload = statePayload\(ctx\.instanceId\);\s+if \(!payload\?\.snapshot\)/,
  );
  assert.match(refreshAction[1], /return payload\.snapshot/);
});
