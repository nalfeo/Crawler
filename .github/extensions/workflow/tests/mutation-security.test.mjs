import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { PayloadTooLargeError, readJsonBody, tokensMatch } from '../lib/mutation-security.mjs';

test('tokensMatch accepts only the exact per-instance token', () => {
  assert.equal(tokensMatch('abc123', 'abc123'), true);
  assert.equal(tokensMatch('abc124', 'abc123'), false);
  assert.equal(tokensMatch('short', 'much-longer'), false);
  assert.equal(tokensMatch(undefined, 'abc123'), false);
});

test('readJsonBody parses bounded object JSON', async () => {
  const request = new EventEmitter();
  const pending = readJsonBody(request, 100);
  request.emit('data', Buffer.from('{"variantIndex":2}'));
  request.emit('end');
  assert.deepEqual(await pending, { variantIndex: 2 });
});

test('readJsonBody rejects oversized payloads with a structured 413, without destroying the request', async () => {
  const request = new EventEmitter();
  // The request/socket must NEVER be destroyed by readJsonBody itself — the
  // caller needs a live connection to write its own 413 response. Fail the
  // test loudly if readJsonBody ever calls destroy().
  request.destroy = () => {
    throw new Error('readJsonBody must not destroy the request');
  };
  const pending = readJsonBody(request, 4);
  // Keep sending data after crossing the limit — a real client's remaining
  // bytes must be safely drained (not buffered) rather than causing a second
  // rejection or an unhandled error.
  request.emit('data', Buffer.from('{"tooLarge":'));
  request.emit('data', Buffer.from('true}'));
  request.emit('end');
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof PayloadTooLargeError);
    assert.equal(error.statusCode, 413);
    assert.equal(error.code, 'body-too-large');
    assert.match(error.message, /too large/);
    return true;
  });
});
