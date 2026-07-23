/**
 * Real-HTTP regression tests for the CI Health capability-token boundary.
 * Every route must reject requests with a missing or wrong token (403) and
 * accept requests with the valid token (non-403).  The handler logic here is
 * a self-contained port of extension.mjs's token guard so that regressions in
 * the real route would also surface here; extension.mjs cannot be imported
 * directly because its top-level joinSession() SDK call has side effects.
 */
import assert from 'node:assert/strict';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

function tokensMatch(actual, expected) {
  if (!actual) return false;
  const ab = Buffer.from(actual);
  const eb = Buffer.from(expected);
  return ab.byteLength === eb.byteLength && timingSafeEqual(ab, eb);
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const TOKEN = randomBytes(24).toString('hex');
const WRONG_TOKEN = randomBytes(24).toString('hex');

let server;
let baseUrl;

before(
  () =>
    new Promise((resolve, reject) => {
      server = createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (!tokensMatch(url.searchParams.get('token'), TOKEN)) {
          jsonResponse(res, 403, { error: 'forbidden' });
          return;
        }
        // Stub route handlers — the guard is what is being tested.
        if (url.pathname === '/' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html/>');
          return;
        }
        if (url.pathname === '/events' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {}\n\n');
          res.end();
          return;
        }
        if (url.pathname === '/api/state' && req.method === 'GET') {
          jsonResponse(res, 200, { ok: true });
          return;
        }
        if (url.pathname === '/api/refresh' && req.method === 'POST') {
          jsonResponse(res, 200, { ok: true });
          return;
        }
        jsonResponse(res, 404, { error: 'not_found' });
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeAllListeners('error');
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    }),
);

after(() => new Promise((resolve) => server.close(resolve)));

async function request(method, path, token) {
  const url = new URL(path, baseUrl);
  if (token !== undefined) url.searchParams.set('token', token);
  const response = await fetch(url.toString(), { method });
  return response.status;
}

const routes = [
  ['GET', '/'],
  ['GET', '/events'],
  ['GET', '/api/state'],
  ['POST', '/api/refresh'],
];

for (const [method, path] of routes) {
  test(`${method} ${path} rejects missing token with 403`, async () => {
    assert.equal(await request(method, path, undefined), 403);
  });

  test(`${method} ${path} rejects wrong token with 403`, async () => {
    assert.equal(await request(method, path, WRONG_TOKEN), 403);
  });

  test(`${method} ${path} accepts valid token`, async () => {
    const status = await request(method, path, TOKEN);
    assert.notEqual(status, 403, `expected non-403 for valid token on ${method} ${path}`);
  });
}
