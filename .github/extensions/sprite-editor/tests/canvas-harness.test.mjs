import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';

import { startCanvasServer } from '../lib/canvas-harness.mjs';

// Raw node:http (not fetch): undici's fetch strips the forbidden `Origin`
// header, so we cannot forge a cross-origin request with it. node:http lets us
// set any header, which is exactly what a hostile page's browser would send.
function httpRequest(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn) {
  const server = await startCanvasServer({
    instanceId: 'harness-test',
    renderHtml: () => '<!doctype html><title>t</title>',
    buildState: () => ({ ok: true }),
    jsonRoutes: [{ method: 'POST', path: '/api/save', handler: () => ({ json: { ok: true } }) }],
  });
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

test('mutating POST with no Origin is allowed (server-side caller)', async () => {
  await withServer(async ({ port }) => {
    const res = await httpRequest(port, { method: 'POST', path: '/api/save' });
    assert.equal(res.status, 200);
    assert.match(res.body, /"ok":true/);
  });
});

test("mutating POST with the server's own loopback origin is allowed", async () => {
  await withServer(async ({ port }) => {
    const res = await httpRequest(port, {
      method: 'POST',
      path: '/api/save',
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(res.status, 200);
  });
});

test('mutating POST with a localhost same-port origin is allowed', async () => {
  await withServer(async ({ port }) => {
    const res = await httpRequest(port, {
      method: 'POST',
      path: '/api/save',
      headers: { Origin: `http://localhost:${port}` },
    });
    assert.equal(res.status, 200);
  });
});

test('mutating POST from a hostile cross-origin is rejected with 403', async () => {
  await withServer(async ({ port }) => {
    const res = await httpRequest(port, {
      method: 'POST',
      path: '/api/save',
      headers: { Origin: 'http://evil.example.com' },
    });
    assert.equal(res.status, 403);
    assert.match(res.body, /forbidden-origin/);
  });
});

test('mutating POST from a loopback host on a DIFFERENT port is rejected', async () => {
  await withServer(async ({ port }) => {
    const otherPort = port === 65535 ? port - 1 : port + 1;
    const res = await httpRequest(port, {
      method: 'POST',
      path: '/api/save',
      headers: { Origin: `http://127.0.0.1:${otherPort}` },
    });
    assert.equal(res.status, 403);
  });
});

test('GET routes are NOT subject to the origin guard', async () => {
  await withServer(async ({ port }) => {
    const res = await httpRequest(port, {
      method: 'GET',
      path: '/api/state',
      headers: { Origin: 'http://evil.example.com' },
    });
    assert.equal(res.status, 200);
  });
});
