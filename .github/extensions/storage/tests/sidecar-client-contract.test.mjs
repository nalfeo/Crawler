/**
 * Contract test (plan-review concern S8) for the vendored `sidecar-client.mjs`.
 * The storage extension depends on a NARROW slice of this shared module —
 * `resolveSidecarBaseUrl` precedence, the `sheet`/`processed` image-URL builders,
 * and `probeHealth` returning a `{ state }` object without throwing. Pin exactly
 * that surface so a future harness sync that changes the client is caught here
 * rather than at runtime against live Azure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSidecarBaseUrl, createSidecarClient } from '../lib/sidecar-client.mjs';

const BASE = 'http://127.0.0.1:17790';
const EXPECTED_VERSION = '0.3.0-managed';

test('resolveSidecarBaseUrl honors the explicit VITE override (highest precedence)', () => {
  const url = resolveSidecarBaseUrl({
    env: { VITE_SPRITES_SIDECAR_BASE_URL: 'http://example:1234/' },
  });
  assert.equal(url, 'http://example:1234'); // trailing slash trimmed
});

test('resolveSidecarBaseUrl returns a usable string when nothing is configured', () => {
  const url = resolveSidecarBaseUrl({ workspacePath: 'C:/nope', env: {} });
  assert.equal(typeof url, 'string');
  assert.match(url, /^https?:\/\//);
});

test('createSidecarClient exposes the image-URL builders the extension proxies', () => {
  const client = createSidecarClient({ baseUrl: BASE });
  assert.equal(typeof client.urls.sheet, 'function');
  assert.equal(typeof client.urls.processed, 'function');
  assert.equal(client.urls.sheet('b', 'r', 'a b.png'), `${BASE}/api/runs/b/r/sheet/a%20b.png`);
  assert.equal(client.urls.processed('b', 'r', '00.png'), `${BASE}/api/runs/b/r/processed/00.png`);
});

test('probeHealth never throws and reports state=down when the sidecar is unreachable', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    workspaceRoot: 'C:/repo',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const health = await client.probeHealth();
  assert.equal(typeof health.state, 'string');
  assert.equal(health.state, 'down');
});

test('probeHealth reports state=up for a matching-repo healthy sidecar', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    workspaceRoot: 'C:/repo',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ok',
        repoRoot: 'C:/repo',
        version: EXPECTED_VERSION,
        storeBackend: 'azure-blob',
      }),
    }),
  });
  const health = await client.probeHealth();
  assert.equal(health.state, 'up');
});

test('probeHealth reports state=down when azure controllers are not ready', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    workspaceRoot: 'C:/repo',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ok',
        repoRoot: 'C:/repo',
        version: EXPECTED_VERSION,
        queueBackend: 'azure-queue',
        worker: { running: false },
        issueIngester: { running: true },
      }),
    }),
  });
  const health = await client.probeHealth();
  assert.equal(health.state, 'down');
});

test('probeHealth reports state=down for a stale incompatible sidecar version', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    workspaceRoot: 'C:/repo',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ok',
        repoRoot: 'C:/repo',
        version: '0.2.0-workflow',
        queueBackend: 'azure-queue',
        worker: { running: true },
        issueIngester: { running: true },
      }),
    }),
  });
  const health = await client.probeHealth();
  assert.equal(health.state, 'down');
});
