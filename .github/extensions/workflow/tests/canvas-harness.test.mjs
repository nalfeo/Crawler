/**
 * Wiring tests for the GENERIC canvas harness (the vendored copy the extension
 * actually loads). Proves the domain-free server contract every canvas
 * extension relies on: `/`, `/api/state`, SSE `/events`, allowlisted JSON
 * routes, streamed binary relay (status + Content-Type preserved), and
 * controlled error codes.
 *
 * Moved from the now-removed standalone Sprite Review canvas — Workflow
 * vendors a byte-identical copy of `lib/canvas-harness.mjs` (see
 * `harness-drift.test.mjs`), so this coverage belongs here now.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { startCanvasServer, CANVAS_HARNESS_VERSION } from '../lib/canvas-harness.mjs';

async function withServer(opts, fn) {
  const server = await startCanvasServer({
    instanceId: 'test-1',
    renderHtml: (id) => `<!doctype html><title>${id}</title>`,
    buildState: () => ({ hello: 'world', instance: 'test-1' }),
    ...opts,
  });
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

test('exports a version string', () => {
  assert.match(CANVAS_HARNESS_VERSION, /^\d+\.\d+\.\d+$/);
});

test('GET / serves renderHtml as html and GET /api/state serves buildState', async () => {
  await withServer({}, async (server) => {
    const html = await fetch(server.url);
    assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await html.text(), /<title>test-1<\/title>/);

    const state = await fetch(`${server.url}api/state`);
    assert.deepEqual(await state.json(), { hello: 'world', instance: 'test-1' });
  });
});

test('SSE /events emits an initial state frame', async () => {
  await withServer({}, async (server) => {
    const controller = new AbortController();
    const res = await fetch(`${server.url}events`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 2000;
    while (!buf.includes('"type":"state"') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    controller.abort();
    assert.match(buf, /"type":"state"/);
    assert.match(buf, /"hello":"world"/);
  });
});

test('allowlisted JSON route returns {json,status}', async () => {
  await withServer(
    {
      jsonRoutes: [
        {
          method: 'GET',
          path: '/api/echo',
          handler: ({ url }) => ({ json: { q: url.searchParams.get('q') } }),
        },
        {
          method: 'GET',
          path: '/api/boom',
          handler: () => {
            throw new Error('kaboom');
          },
        },
      ],
    },
    async (server) => {
      const ok = await fetch(`${server.url}api/echo?q=hi`);
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { q: 'hi' });

      const boom = await fetch(`${server.url}api/boom`);
      assert.equal(boom.status, 502);
      assert.match((await boom.json()).error, /kaboom/);
    },
  );
});

test('binary route relays a web Response preserving status + Content-Type', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  await withServer(
    {
      binaryRoutes: [
        {
          method: 'GET',
          path: '/img/x',
          handler: () =>
            new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/png' } }),
        },
        { method: 'GET', path: '/img/missing', handler: () => null },
      ],
    },
    async (server) => {
      const img = await fetch(`${server.url}img/x`);
      assert.equal(img.status, 200);
      assert.equal(img.headers.get('content-type'), 'image/png');
      const body = Buffer.from(await img.arrayBuffer());
      assert.deepEqual([...body], [...bytes]);

      const missing = await fetch(`${server.url}img/missing`);
      assert.equal(missing.status, 404);
    },
  );
});

test('binary route relays a non-2xx web Response preserving status + Content-Type', async () => {
  // Regression: error responses used to be re-encoded as text/plain, dropping
  // the upstream Content-Type (breaks the "preserve status + Content-Type"
  // contract for structured error payloads from the sidecar image proxy).
  await withServer(
    {
      binaryRoutes: [
        {
          method: 'GET',
          path: '/img/err',
          handler: () =>
            new Response('{"error":"nope"}', {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            }),
        },
      ],
    },
    async (server) => {
      const res = await fetch(`${server.url}img/err`);
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type'), /application\/json/);
      assert.match(await res.text(), /nope/);
    },
  );
});

test('plain-binary route whose stream errors mid-relay tears down without crashing', async () => {
  // Regression: relayPlainBinary() piped a web ReadableStream with no 'error'
  // listener, so a stream that errors emitted an unhandled 'error' event and
  // killed the extension process (violates the harness "never crash" contract).
  // If the fix is absent, the unhandled 'error' crashes THIS test process.
  await withServer(
    {
      binaryRoutes: [
        {
          method: 'GET',
          path: '/img/broken',
          handler: () => ({
            status: 200,
            headers: { 'Content-Type': 'image/png' },
            body: new ReadableStream({
              start(controller) {
                controller.error(new Error('stream-broke'));
              },
            }),
          }),
        },
      ],
    },
    async (server) => {
      try {
        const res = await fetch(`${server.url}img/broken`);
        await res.arrayBuffer();
      } catch {
        // Reading a torn-down body may reject with a network error — expected.
      }
      // The server survived the stream error: a follow-up request still works.
      const state = await fetch(`${server.url}api/state`);
      assert.equal(state.status, 200);
    },
  );
});

test('unknown route returns 404', async () => {
  await withServer({}, async (server) => {
    const res = await fetch(`${server.url}nope`);
    assert.equal(res.status, 404);
  });
});

test('a throwing buildState degrades to an {error} state instead of crashing', async () => {
  await withServer(
    {
      buildState: () => {
        throw new Error('state-fail');
      },
    },
    async (server) => {
      const res = await fetch(`${server.url}api/state`);
      assert.equal(res.status, 200);
      assert.match((await res.json()).error, /state-fail/);
    },
  );
});
