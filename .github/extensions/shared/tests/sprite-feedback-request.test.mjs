import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import {
  isJsonContentType,
  isTrustedMutationOrigin,
  readJsonBody,
  tokensMatch,
} from '../sprite-feedback-request.mjs';

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

test('readJsonBody rejects an empty payload', async () => {
  await assert.rejects(
    () => readJsonBody(Readable.from(['   '])),
    (error) => error.code === 'invalid-json',
  );
});

test('tokensMatch requires equal-length, matching strings', () => {
  assert.equal(tokensMatch('abc', 'abc'), true);
  assert.equal(tokensMatch('abc', 'abcd'), false);
  assert.equal(tokensMatch('abc', 'xyz'), false);
  assert.equal(tokensMatch(undefined, 'abc'), false);
  assert.equal(tokensMatch('abc', undefined), false);
});

test("isTrustedMutationOrigin accepts only the loopback server's own origin", () => {
  const entry = { url: 'http://127.0.0.1:54321/' };
  assert.equal(
    isTrustedMutationOrigin({ headers: { origin: 'http://127.0.0.1:54321' } }, entry),
    true,
  );
  assert.equal(
    isTrustedMutationOrigin({ headers: { origin: 'http://evil.example' } }, entry),
    false,
  );
  assert.equal(isTrustedMutationOrigin({ headers: {} }, entry), false);
  assert.equal(isTrustedMutationOrigin({ headers: { origin: '' } }, entry), false);
});

test('isJsonContentType only accepts application/json (with optional parameters)', () => {
  assert.equal(isJsonContentType({ headers: { 'content-type': 'application/json' } }), true);
  assert.equal(
    isJsonContentType({ headers: { 'content-type': 'application/json; charset=utf-8' } }),
    true,
  );
  assert.equal(isJsonContentType({ headers: { 'content-type': 'text/plain' } }), false);
  assert.equal(isJsonContentType({ headers: {} }), false);
});
