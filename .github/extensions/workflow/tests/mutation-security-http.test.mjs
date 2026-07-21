/**
 * Real HTTP-server test for readJsonBody's 413 handling (mutation-security.mjs).
 *
 * The EventEmitter-level unit test (mutation-security.test.mjs) proves
 * `readJsonBody` doesn't call `req.destroy()`, but that alone doesn't prove a
 * client actually receives a clean 413 — `req`/`res` share the same
 * underlying socket, so destroying one half silently breaks the other even
 * though `readJsonBody`'s own promise looks fine in isolation. This test
 * exercises a REAL `node:http` server + a REAL client connection (loopback
 * TCP, no mocks) reproducing exactly how `extension.mjs`'s `/api/accept`
 * route uses `readJsonBody`, so a regression that resets the socket would
 * show up as a client-side network error instead of a clean 413 response.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { readJsonBody } from '../lib/mutation-security.mjs';

const BODY_LIMIT = 16;

/** Start a loopback server whose one route mirrors extension.mjs's /api/accept 413 mapping. */
function startServer() {
  const server = createServer((req, res) => {
    readJsonBody(req, BODY_LIMIT).then(
      (body) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, body }));
      },
      (error) => {
        const tooLarge = error?.statusCode === 413 || error?.code === 'body-too-large';
        res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: tooLarge ? 'body-too-large' : 'bad-request',
            message: error?.message ?? String(error),
          }),
        );
      },
    );
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** POST `body` to the server over a real loopback connection and resolve with {status, json}. */
function post(server, body) {
  const { port } = server.address();
  return fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }).then(async (response) => ({
    status: response.status,
    json: await response.json(),
  }));
}

test('an oversized body over a real socket gets a clean 413 JSON response, not a connection reset', async () => {
  const server = await startServer();
  try {
    const oversized = JSON.stringify({ filler: 'x'.repeat(BODY_LIMIT * 4) });
    assert.ok(oversized.length > BODY_LIMIT, 'fixture body must exceed the limit');

    // If readJsonBody destroyed the socket on overflow, this fetch would
    // reject with a network error (e.g. "fetch failed" / ECONNRESET) instead
    // of resolving with a real HTTP response.
    const result = await post(server, oversized);

    assert.equal(result.status, 413);
    assert.equal(result.json.error, 'body-too-large');
    assert.match(result.json.message, /too large/);
  } finally {
    await stopServer(server);
  }
});

test('a within-limit body over the same real socket still parses normally', async () => {
  const server = await startServer();
  try {
    const result = await post(server, JSON.stringify({ ok: 1 }));
    assert.equal(result.status, 200);
    assert.deepEqual(result.json.body, { ok: 1 });
  } finally {
    await stopServer(server);
  }
});

test('the same server handles an oversized request followed by a normal one (socket/server stay healthy)', async () => {
  const server = await startServer();
  try {
    const big = await post(server, JSON.stringify({ filler: 'x'.repeat(BODY_LIMIT * 4) }));
    assert.equal(big.status, 413);

    const normal = await post(server, JSON.stringify({ ok: 1 }));
    assert.equal(normal.status, 200);
    assert.deepEqual(normal.json.body, { ok: 1 });
  } finally {
    await stopServer(server);
  }
});
