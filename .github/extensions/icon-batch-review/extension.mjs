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
            return {
              status: 404,
              headers: { 'Content-Type': 'text/plain' },
              body: Buffer.from('not found'),
            };
          const iconId = decodeURIComponent(m[1]);
          // Basic sanitization: only allow safe filename chars.
          if (!/^[a-z0-9][a-z0-9-]*$/.test(iconId)) {
            return {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
              body: Buffer.from('invalid id'),
            };
          }
          const buf = bridge.getIconPng(iconId);
          if (!buf)
            return {
              status: 404,
              headers: { 'Content-Type': 'text/plain' },
              body: Buffer.from('not found'),
            };
          return { status: 200, headers: { 'Content-Type': 'image/png' }, body: buf };
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
  displayName: 'Icon Batch Review',
  description: 'Review and dispatch icon batch generation for achievements and abilities.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  actions: [
    {
      name: 'get_state',
      description: 'Return current batch status (briefs, approved counts, errors).',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (_ctx) => {
        return await buildState();
      },
    },
    {
      name: 'dispatch_generate_briefs',
      description: 'Trigger workflow_dispatch for generate-briefs action.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (_ctx) => {
        const bridge = createBridge(REPO_ROOT, { warn: (m) => log(m, 'warn') });
        await bridge.dispatchWorkflow('generate-briefs');
        return { ok: true };
      },
    },
    {
      name: 'dispatch_run',
      description: 'Trigger workflow_dispatch to run specific batches.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['batchIds'],
        properties: {
          batchIds: { type: 'array', items: { type: 'string' }, description: 'Batch IDs to run.' },
        },
      },
      handler: async (ctx) => {
        const batchIds = ctx.input?.batchIds;
        if (!batchIds?.length)
          throw new CanvasError('missing_batch_ids', 'dispatch_run requires batchIds');
        const bridge = createBridge(REPO_ROOT, { warn: (m) => log(m, 'warn') });
        await bridge.dispatchWorkflow('run', batchIds);
        return { ok: true };
      },
    },
    {
      name: 'dispatch_run_all',
      description: 'Trigger workflow_dispatch to run all pending batches.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (_ctx) => {
        const bridge = createBridge(REPO_ROOT, { warn: (m) => log(m, 'warn') });
        await bridge.dispatchWorkflow('run-all');
        return { ok: true };
      },
    },
  ],
  open: async (ctx) => {
    sessionRef = ctx.session ?? sessionRef;
    log(`open instanceId=${ctx.instanceId}`);
    try {
      const url = await startInstance(ctx.instanceId);
      return { title: 'Icon Batch Review', url };
    } catch (err) {
      log(`open failed: ${err?.message ?? err}`, 'error');
      throw new CanvasError('open_failed', err?.message ?? String(err));
    }
  },
  onClose: async (ctx) => {
    log(`onClose instanceId=${ctx.instanceId}`);
    const server = instances.get(ctx.instanceId);
    if (server) {
      instances.delete(ctx.instanceId);
      try {
        await server.close();
      } catch {
        /* ignore */
      }
    }
  },
});

sessionRef = await joinSession({ canvases: [canvas] });
log('icon-batch-review canvas provider registered');
