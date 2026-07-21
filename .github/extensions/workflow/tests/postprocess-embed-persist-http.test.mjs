/**
 * Real-HTTP integration test for `/postprocess/api/persist-postprocess`'s full
 * guard chain (origin + token + content-type + body-size) plus the
 * never-trust-the-client normalize/rebuild step, exercised through a REAL
 * `node:http` server + REAL client connections — not just the source-text
 * regex assertions in `postprocess-embed-guards.test.mjs`.
 *
 * The route handler here is a byte-for-byte port of extension.mjs's
 * `/postprocess/api/persist-postprocess` handler (same shared modules, same
 * guard order, same status codes) so a regression in the real route would
 * show up here too; it can't import `extension.mjs` directly because that
 * file performs a top-level `joinSession()` SDK side effect on import (see
 * `extension-security-guards.test.mjs`'s header for the same rationale).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test, before, after } from 'node:test';

import {
  isJsonContentType,
  isTrustedMutationOrigin,
} from '../../shared/sprite-feedback-request.mjs';
import { readJsonBody, tokensMatch } from '../lib/mutation-security.mjs';
import {
  normalizePersistRequest,
  buildPersistPostprocessPayload,
} from '../../postprocess/lib/postprocess-client.mjs';

const MUTATION_TOKEN = 'wf-postprocess-token';

/** Fake postprocess-client.relayPersistPostprocess — no real sidecar. */
function fakeRelay(payloads) {
  return async ({ briefId, runId, payload }) => {
    payloads.push({ briefId, runId, payload });
    return { ok: true, summary: { briefId, runId, postprocessOverrides: { options: {} } } };
  };
}

function startServer(relayPersistPostprocess) {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/postprocess/api/persist-postprocess') {
      res.writeHead(404);
      res.end();
      return;
    }
    const entry = {
      url: `http://127.0.0.1:${server.address().port}/`,
      mutationToken: MUTATION_TOKEN,
    };
    (async () => {
      if (!isTrustedMutationOrigin(req, entry)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, reason: 'forbidden-origin', message: 'forbidden' }));
        return;
      }
      if (!tokensMatch(req.headers['x-workflow-mutation-token'], entry.mutationToken)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ ok: false, reason: 'forbidden', message: 'Invalid mutation token.' }),
        );
        return;
      }
      if (!isJsonContentType(req)) {
        res.writeHead(415, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            reason: 'unsupported-media-type',
            message: 'Content-Type must be application/json.',
          }),
        );
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const tooLarge = error?.statusCode === 413 || error?.code === 'body-too-large';
        res.writeHead(tooLarge ? 413 : 400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            reason: tooLarge ? 'body-too-large' : 'bad-request',
            message: error?.message ?? String(error),
          }),
        );
        return;
      }
      const normalized = normalizePersistRequest(body);
      if (!normalized.ok) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, reason: 'bad-request', message: normalized.error }));
        return;
      }
      const payload = buildPersistPostprocessPayload(normalized.args);
      const result = await relayPersistPostprocess({
        briefId: normalized.args.briefId,
        runId: normalized.args.runId,
        payload,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    })().catch((error) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'internal-error', message: String(error) }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function post(url, body, headers) {
  return fetch(url, { method: 'POST', headers, body }).then(async (response) => ({
    status: response.status,
    json: await response.json(),
  }));
}

let server;
let url;
let payloads;

before(async () => {
  payloads = [];
  server = await startServer(fakeRelay(payloads));
  url = `http://127.0.0.1:${server.address().port}/postprocess/api/persist-postprocess`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('no Origin header → 403 forbidden-origin', async () => {
  const result = await post(url, JSON.stringify({ briefId: 'b', runId: 'r', mode: 'reset' }), {
    'content-type': 'application/json',
    'x-workflow-mutation-token': MUTATION_TOKEN,
  });
  assert.equal(result.status, 403);
  assert.equal(result.json.reason, 'forbidden-origin');
});

test('a mismatched mutation token → 403 forbidden', async () => {
  const result = await post(url, JSON.stringify({ briefId: 'b', runId: 'r', mode: 'reset' }), {
    'content-type': 'application/json',
    origin: new URL(url).origin,
    'x-workflow-mutation-token': 'wrong',
  });
  assert.equal(result.status, 403);
  assert.equal(result.json.reason, 'forbidden');
});

test('a non-JSON content-type → 415 unsupported-media-type', async () => {
  const result = await post(url, 'plain text', {
    'content-type': 'text/plain',
    origin: new URL(url).origin,
    'x-workflow-mutation-token': MUTATION_TOKEN,
  });
  assert.equal(result.status, 415);
  assert.equal(result.json.reason, 'unsupported-media-type');
});

test('an oversized body → 413 body-too-large', async () => {
  const result = await post(
    url,
    JSON.stringify({ briefId: 'b', runId: 'r', mode: 'reset', filler: 'x'.repeat(20000) }),
    {
      'content-type': 'application/json',
      origin: new URL(url).origin,
      'x-workflow-mutation-token': MUTATION_TOKEN,
    },
  );
  assert.equal(result.status, 413);
  assert.equal(result.json.reason, 'body-too-large');
});

test('a bad mode → 400 bad-request (server rebuilds/validates, never trusts the client body)', async () => {
  const result = await post(url, JSON.stringify({ briefId: 'b', runId: 'r', mode: 'not-a-mode' }), {
    'content-type': 'application/json',
    origin: new URL(url).origin,
    'x-workflow-mutation-token': MUTATION_TOKEN,
  });
  assert.equal(result.status, 400);
  assert.equal(result.json.reason, 'bad-request');
});

test('a fully-authorized reset relays the SERVER-REBUILT payload ({mode:"reset"}), not the raw client body', async () => {
  const result = await post(
    url,
    JSON.stringify({ briefId: 'goblin', runId: 'run-1', mode: 'reset', evilExtraField: 'ignored' }),
    {
      'content-type': 'application/json',
      origin: new URL(url).origin,
      'x-workflow-mutation-token': MUTATION_TOKEN,
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.deepEqual(payloads.at(-1), {
    briefId: 'goblin',
    runId: 'run-1',
    payload: { mode: 'reset' },
  });
});

test('a fully-authorized replace relays a clamped, rebuilt payload with variantIndexes for a single variant', async () => {
  const result = await post(
    url,
    JSON.stringify({
      briefId: 'goblin',
      runId: 'run-2',
      mode: 'replace',
      variantIndex: 3,
      facingDirection: 'left',
      colorToleranceSq: -50,
      fringeToleranceSq: 999999999,
      disabledModules: ['resize', 'background-removal', 'resize'],
    }),
    {
      'content-type': 'application/json',
      origin: new URL(url).origin,
      'x-workflow-mutation-token': MUTATION_TOKEN,
    },
  );
  assert.equal(result.status, 200);
  const sent = payloads.at(-1);
  assert.equal(sent.briefId, 'goblin');
  assert.equal(sent.runId, 'run-2');
  assert.equal(sent.payload.mode, 'replace');
  assert.equal(sent.payload.facing.variantIndex, 3);
  assert.equal(sent.payload.facing.direction, 'left');
  assert.deepEqual(sent.payload.variantIndexes, [3]);
  // Clamped to [0, MAX] — never the raw out-of-range client values.
  assert.equal(sent.payload.options.background.colorToleranceSq, 0);
  assert.ok(sent.payload.options.background.fringeToleranceSq <= 255 * 255 * 3);
  assert.deepEqual(sent.payload.options.disabledModules, ['background-removal', 'resize']);
});

test('an unknown disabled module is rejected before the sidecar relay', async () => {
  const before = payloads.length;
  const result = await post(
    url,
    JSON.stringify({
      briefId: 'goblin',
      runId: 'run-3',
      mode: 'replace',
      variantIndex: 0,
      facingDirection: 'right',
      disabledModules: ['not-a-module'],
    }),
    {
      'content-type': 'application/json',
      origin: new URL(url).origin,
      'x-workflow-mutation-token': MUTATION_TOKEN,
    },
  );
  assert.equal(result.status, 400);
  assert.equal(result.json.reason, 'bad-request');
  assert.equal(payloads.length, before);
});
