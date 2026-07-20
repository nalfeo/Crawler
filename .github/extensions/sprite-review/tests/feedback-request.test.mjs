import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { readJsonBody } from '../lib/feedback-request.mjs';

test('readJsonBody classifies malformed JSON', async () => {
  await assert.rejects(
    () => readJsonBody(Readable.from(['{not-json'])),
    (error) => error.code === 'invalid-json',
  );
});

test('readJsonBody classifies oversized feedback', async () => {
  await assert.rejects(
    () => readJsonBody(Readable.from([Buffer.alloc(16 * 1024 + 1)])),
    (error) => error.code === 'body-too-large',
  );
});
