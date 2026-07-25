import assert from 'node:assert/strict';
import test from 'node:test';

import guard from '../guards/authoring-main-sync.mjs';

test('authoring sync guard observes active tools but leaves PR publication to preflight', () => {
  assert.equal(guard.matches('edit'), true);
  assert.equal(guard.matches('powershell'), true);
  assert.equal(guard.matches('create_pull_request'), false);
  assert.equal(guard.failClosed, false);
});
