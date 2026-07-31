/**
 * extension.mjs — icon-batch-review canvas extension.
 *
 * Architecture (canvas harness pattern):
 *   - `lib/canvas-harness.mjs`  — vendored generic loopback HTTP server
 *   - `lib/image-cache.mjs`     — vendored with harness (byte-copy contract)
 *   - `lib/bridge.mjs`          — reads brief files + manifest shards; dispatches GH workflow
 *   - `renderer.mjs`            — HTML document for the iframe
 *   - `extension.mjs` (this)    — wires everything; one server per instance
 *
 * @module icon-batch-review/extension
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, CanvasError, joinSession } from '@github/copilot-sdk/extension';

import { startCanvasServer } from './lib/canvas-harness.mjs';
import { renderHtml } from './renderer.mjs';
import { createBridge } from './lib/bridge.mjs';

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(EXT_DIR, '..', '..', '..');

/** @type {import('@github/copilot-sdk/extension').CopilotSession | null} */
let sessionRef = null;

/**
 * Per-open-instance server handle.
 * @type {Map<string, { url: string, close: () => Promise<void> }>}
 */
const instances = new Map();
const pendingStartups = new Map();

function log(message, level = 'info') {
  try {
    sessionRef?.log?.(`[icon-batch-review] ${message}`, { level });
  } catch {
    // logging must never take down a handler
  }
}

/** Read + JSON-parse a request body; malformed/oversized input degrades to {}. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      data += chunk;
      if (data.length > 1_000_000) {
        tooBig = true;
        data = '';
      }
    });
    req.on('end', () => {
      if (tooBig) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

async function buildState() {
  const bridge = createBridge(REPO_ROOT, { warn: (m) => log(m, 'warn') });
  try {
    const batches = await bridge.listBatches();
    return { batches, error: null };
  } catch (err) {
    log(`buildState failed: ${err?.message ?? err}`, 'warn');
    return { batches: [], error: err?.message ?? String(err) };
  }
}

function makeRoutes() {
  const bridge = createBridge(REPO_ROOT, { warn: (m) => log(m, 'warn') });

  return {
    jsonRoutes: [
      {
        method: 'POST',
        path: '/_action',
        handler: async ({ req }) => {
          const body = await readJsonBody(req);
          const action = body?.action;

          if (action === 'dispatch') {
            const workflowAction = body?.workflowAction;
            const batchIds = body?.batchIds;
            if (!workflowAction) {
              return { status: 400, json: { error: 'Missing workflowAction' } };
            }
            try {
              await bridge.dispatchWorkflow(workflowAction, batchIds);
              return { json: { ok: true, message: `Dispatched ${workflowAction}` } };
            } catch (err) {
              log(`dispatchWorkflow error: ${err?.message ?? err}`, 'warn');
              return { status: 500, json: { error: err?.message ?? String(err) } };
            }
          }

          return { status: 400, json: { error: `Unknown action: ${action}` } };
        },
      },
    ],

    binaryRoutes: [
      {
        method: 'GET',
        path: /^\/icon\/(.+)$/,
        handler: ({ url }) => {
          const m = url.pathname.match(/^\/icon\/(.+)$/);
          if (!m)
            return { status: 404, buffer: Buffer.from('not found'), contentType: 'text/plain' };
          const iconId = decodeURIComponent(m[1]);
          // Basic sanitization: only allow safe filename chars.
          if (!/^[a-z0-9][a-z0-9-]*$/.test(iconId)) {
            return { status: 400, buffer: Buffer.from('invalid id'), contentType: 'text/plain' };
          }
          const buf = bridge.getIconPng(iconId);
          if (!buf)
            return { status: 404, buffer: Buffer.from('not found'), contentType: 'text/plain' };
          return { buffer: buf, contentType: 'image/png' };
        },
      },
    ],
  };
}

/** Start the loopback HTTP server for one canvas instance. */
async function startInstance(instanceId) {
  if (instances.has(instanceId)) return instances.get(instanceId).url;

  const existing = pendingStartups.get(instanceId);
  if (existing) return existing;

  const startPromise = (async () => {
    const state = await buildState();
    const { jsonRoutes, binaryRoutes } = makeRoutes();

    const server = await startCanvasServer({
      instanceId,
      // The harness calls renderHtml(instanceId) lazily at request time.
      // Close over `serverUrl` which is set after the server resolves below.
      renderHtml: (_id) => renderHtml({ batches: state.batches, baseUrl: serverUrl }),
      jsonRoutes,
      binaryRoutes,
      log: (msg, level) => log(`[canvas-server] ${msg}`, level),
    });

    let serverUrl = server.url;

    instances.set(instanceId, server);
    pendingStartups.delete(instanceId);
    log(`instance ${instanceId} started at ${serverUrl}`);
    return serverUrl;
  })();

  pendingStartups.set(instanceId, startPromise);
  startPromise.catch(() => pendingStartups.delete(instanceId));
  return startPromise;
}

// ── Canvas registration ────────────────────────────────────────────────────

const canvas = createCanvas({
  id: 'icon-batch-review',
  name: 'Icon Batch Review',
  description: 'Review and dispatch icon batch generation for achievements and abilities.',
});

canvas.onOpen(async ({ instanceId, session }) => {
  sessionRef = session;
  log(`onOpen instanceId=${instanceId}`);
  try {
    const url = await startInstance(instanceId);
    return { type: 'iframe', url };
  } catch (err) {
    log(`onOpen failed: ${err?.message ?? err}`, 'error');
    throw new CanvasError(err?.message ?? String(err));
  }
});

canvas.onAction(async ({ instanceId, action, payload }) => {
  log(`onAction instanceId=${instanceId} action=${action}`);

  if (action === 'get_state') {
    const state = await buildState();
    return state;
  }

  if (action === 'dispatch_generate_briefs') {
    const bridge = createBridge(REPO_ROOT, { warn: (m) => log(m, 'warn') });
    await bridge.dispatchWorkflow('generate-briefs');
    return { ok: true };
  }

  if (action === 'dispatch_run') {
    const batchIds = payload?.batchIds;
    if (!batchIds) throw new CanvasError('dispatch_run requires payload.batchIds');
    const bridge = createBridge(REPO_ROOT, { warn: (m) => log(m, 'warn') });
    await bridge.dispatchWorkflow('run', batchIds);
    return { ok: true };
  }

  if (action === 'dispatch_run_all') {
    const bridge = createBridge(REPO_ROOT, { warn: (m) => log(m, 'warn') });
    await bridge.dispatchWorkflow('run-all');
    return { ok: true };
  }

  throw new CanvasError(`Unknown action: ${action}`);
});

canvas.onClose(async ({ instanceId }) => {
  log(`onClose instanceId=${instanceId}`);
  const server = instances.get(instanceId);
  if (server) {
    instances.delete(instanceId);
    try {
      await server.close();
    } catch {
      /* ignore */
    }
  }
});

joinSession(canvas);
