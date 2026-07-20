import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { readJsonBody } from '../lib/feedback-request.mjs';

const BODY_LIMIT = 16 * 1024;

function startServer() {
  const server = http.createServer((req, res) => {
    readJsonBody(req, BODY_LIMIT).then(
      () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      },
      (error) => {
        const tooLarge = error?.statusCode === 413 || error?.code === 'body-too-large';
        res.writeHead(tooLarge ? 413 : 400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: tooLarge ? 'body-too-large' : 'bad-request',
            message: tooLarge ? error.message : 'Feedback payload must be valid JSON.',
          }),
        );
      },
    );
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind loopback server'));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

test('oversized feedback returns structured 413 instead of resetting the socket', async () => {
  const { server, url } = await startServer();
  try {
    const response = await fetch(`${url}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'x'.repeat(BODY_LIMIT + 1) }),
    });
    const json = await response.json();
    assert.equal(response.status, 413);
    assert.equal(json.error, 'body-too-large');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
