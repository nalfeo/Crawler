/**
 * Unit tests for the workflow mutation error → HTTP status mapping.
 *
 * Regression: every failure used to fall through to 502, so a caller mistake
 * (missing itemId, unknown item, wrong stage) was reported as an upstream
 * gateway failure even though no sidecar call had been made.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { workflowErrorStatus } from '../lib/workflow-errors.mjs';

test('local CanvasError codes map to caller-fault statuses, not 502', () => {
  assert.equal(workflowErrorStatus({ code: 'bad-request' }), 400);
  assert.equal(workflowErrorStatus({ code: 'item-not-found' }), 404);
  assert.equal(workflowErrorStatus({ code: 'item_not_found' }), 404);
  assert.equal(workflowErrorStatus({ code: 'not_found' }), 404);
  assert.equal(workflowErrorStatus({ code: 'not_open' }), 404);
  assert.equal(workflowErrorStatus({ code: 'missing-brief' }), 409);
  assert.equal(workflowErrorStatus({ code: 'missing-run' }), 409);
  assert.equal(workflowErrorStatus({ code: 'invalid-stage' }), 409);
});

test('a sidecar failure keeps its own status and unknown failures stay 502', () => {
  assert.equal(workflowErrorStatus({ code: 'etag-conflict', status: 409 }), 409);
  assert.equal(workflowErrorStatus({ code: 'http-503', status: 503 }), 503);
  assert.equal(workflowErrorStatus({ code: 'azure-unreachable' }), 502);
  assert.equal(workflowErrorStatus(new Error('boom')), 502);
  assert.equal(workflowErrorStatus(null), 502);
});

test('an inherited Object property can never be returned as a status', () => {
  assert.equal(workflowErrorStatus({ code: 'toString' }), 502);
  assert.equal(workflowErrorStatus({ code: 'constructor' }), 502);
});
