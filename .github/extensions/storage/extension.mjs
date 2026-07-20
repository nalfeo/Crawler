/**
 * storage — a canvas port of the `?page=storage` DevTool (Slice E).
 *
 * Functional parity with `renderStorageLifecyclePage` in `src/devtools-main.ts`
 * (`DEVTOOLS_PAGE_STORAGE`): list / search / sort / filter sprite-run blobs in
 * Azure across the `active` and `archive` scopes, plus the two DESTRUCTIVE ops
 * archive + delete.
 *
 * Architecture (client-authoritative + STATELESS proxy routes — the client owns
 * scope/search/selection exactly like the monolith; this server just proxies the
 * sidecar's `/api/storage/*` routes, adding safety it can only make STRICTER,
 * never looser):
 *   - `lib/canvas-harness.mjs` — GENERIC loopback HTTP server (vendored; single
 *     source of truth is `scripts/canvas-harness/`, do not hand-edit).
 *   - `lib/sidecar-client.mjs` — copied verbatim; used only for repo-match health
 *     (`probeHealth`) + image URLs (`urls.sheet`/`urls.processed`).
 *   - `lib/storage-client.mjs` — DOMAIN adapter for `/api/storage/*` (list / enrich
 *     / archive / delete) + pure key validators/normalizers.
 *   - `renderer.mjs`           — the iframe document (faithful monolith UI port).
 *   - `extension.mjs` (this)   — wires them together.
 *
 * DESTRUCTIVE-OPS CARE (project rule #12 — never make delete easier than the
 * monolith): the archive/delete routes are STRICTER than the monolith's path —
 * they require a per-instance mutation token minted into the iframe HTML, they
 * re-probe sidecar health and refuse (409) when it is not `up`, and they validate
 * every key with the same parse the sidecar uses (rejecting a whole batch with the
 * offending keys on any malformed entry). There are NO destructive canvas actions;
 * archive/delete are reachable only through the iframe's `window.confirm` guards.
 *
 * stdout is reserved for JSON-RPC — we log via `session.log`, never `console.log`.
 *
 * @module storage/extension
 */

import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createCanvas, CanvasError, joinSession } from '@github/copilot-sdk/extension';

import { startCanvasServer } from './lib/canvas-harness.mjs';
import { beginSpriteSidecarStartup } from '../shared/sprite-sidecar-service.mjs';
import { createImageCache, resolveExtCacheDir } from './lib/image-cache.mjs';
import { renderHtml } from './renderer.mjs';
import { resolveSidecarBaseUrl, createSidecarClient } from './lib/sidecar-client.mjs';
import { createStorageClient } from './lib/storage-client.mjs';
import { decideMutation, bodyErrorResult } from './lib/mutation-guard.mjs';

/**
 * Repo root, derived from THIS file's location. The extension lives at
 * `<repoRoot>/.github/extensions/storage/extension.mjs`, so three `..` hops off
 * our own directory land on the checkout the sidecar (`npm run sprites:gallery`)
 * was launched from — which makes its deterministic per-worktree port and
 * `repoRoot` match ours. We deliberately do NOT use `session.workspacePath`: in
 * the CLI worktree runtime that resolves to the session-state directory, which
 * derives the WRONG sidecar port and fails the repo-match health check.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Max destructive/enrich request body we will read before replying 413. */
const MAX_BODY_BYTES = 64 * 1024;

/** @type {import('@github/copilot-sdk/extension').CopilotSession | null} */
let sessionRef = null;

/**
 * Per-open-instance server + sidecar/storage clients.
 * @type {Map<string, {
 *   url: string,
 *   sidecarClient: ReturnType<typeof createSidecarClient>,
 *   storageClient: ReturnType<typeof createStorageClient>,
 *   baseUrl: string,
 *   workspaceRoot: string,
 *   mutationToken: string,
 *   pushState: (state?: unknown) => Promise<unknown>,
 *   close: () => Promise<void>,
 * }>}
 */
const instances = new Map();

// In-flight startup promises keyed by instanceId — a second `open` for the same
// instance while the first is still starting shares the promise instead of racing
// a second server; on failure the promise is dropped so a later `open` can retry.
const pendingStartups = new Map();

function log(message, level = 'info') {
  try {
    sessionRef?.log?.(`[storage] ${message}`, { level });
  } catch {
    // logging must never take down a handler
  }
}

/**
 * Shared, outside-of-worktree image cache. Sidecar runs are timestamped +
 * immutable, so a `(kind, briefId, runId, file)` tuple never changes — the cache
 * lives under `$COPILOT_HOME` so every worktree on the machine shares it. A
 * broken/disabled cache degrades to a transparent pass-through (never throws).
 */
const imageCache = createImageCache({ dir: resolveExtCacheDir('storage'), log });

/**
 * Read + JSON-parse a request body with a hard size cap. Returns the parsed value
 * (or `{}` for an empty body). Throws an `Error` with a `.statusCode` (413 for an
 * oversized body, 400 for malformed JSON) so the caller can map it to a response
 * without the harness's generic 502.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error('Request body too large.');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    const err = new Error('Invalid JSON body.');
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Minimal state snapshot for the harness `/api/state` + initial SSE frame. The
 * iframe client is fetch-driven (it does NOT consume SSE), so this only needs to
 * report health; it never throws.
 */
async function buildState(instanceId) {
  const entry = instances.get(instanceId);
  if (!entry) return { error: 'instance not found' };
  try {
    const health = await entry.sidecarClient.probeHealth();
    return { health, baseUrl: entry.baseUrl, sidecarStartup: entry.sidecarStartup };
  } catch (err) {
    return {
      health: { state: 'down' },
      baseUrl: entry.baseUrl,
      sidecarStartup: entry.sidecarStartup,
      error: String(err?.message ?? err),
    };
  }
}

/** Relay a sidecar image (sheet / processed) as a cached / streamed web Response. */
function imageRoute(pathname, kind) {
  return {
    method: 'GET',
    path: pathname,
    handler: async ({ url, instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) return null;
      const briefId = url.searchParams.get('briefId');
      const runId = url.searchParams.get('runId');
      const file = url.searchParams.get('file');
      if (!briefId || !runId || !file) return null;
      const target =
        kind === 'sheet'
          ? entry.sidecarClient.urls.sheet(briefId, runId, file)
          : entry.sidecarClient.urls.processed(briefId, runId, file);
      // Serve immutable bytes from the shared on-disk cache when present; on a
      // miss, fetch from the sidecar, cache a successful body, and relay it.
      // Non-OK / bodyless upstream responses pass straight through (uncached).
      const result = await imageCache.fetchThrough([kind, briefId, runId, file], () =>
        fetch(target, { cache: 'no-store' }),
      );
      if (result.response !== undefined) {
        return result.response;
      }
      return {
        status: 200,
        headers: { 'Content-Type': result.contentType, 'X-Cache': result.hit ? 'HIT' : 'MISS' },
        body: result.bytes,
      };
    },
  };
}

const jsonRoutes = [
  {
    // Read-only LIST. Health travels with every list so the client can
    // enable/disable the destructive buttons per the sidecar's real state.
    method: 'GET',
    path: '/api/runs',
    handler: async ({ url, instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) return { status: 404, json: { error: 'instance not found' } };
      const scope = url.searchParams.get('scope') === 'archive' ? 'archive' : 'active';
      const search = url.searchParams.get('search') ?? '';
      const health = await entry.sidecarClient.probeHealth();
      if (health.state !== 'up') {
        return {
          json: {
            health,
            scope,
            search,
            runs: [],
            sidecarStartup: entry.sidecarStartup ?? null,
          },
        };
      }
      try {
        const runs = await entry.storageClient.listRuns({ scope, search });
        return { json: { health, scope, search, runs } };
      } catch (err) {
        return {
          json: {
            health,
            scope,
            search,
            runs: [],
            error: `Failed to load runs: ${err?.message ?? err}`,
          },
        };
      }
    },
  },
  {
    // Read-only ENRICH (two-phase second fetch). No token — non-mutating.
    method: 'POST',
    path: '/api/enrich',
    handler: async ({ req, instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) return { status: 404, json: { error: 'instance not found' } };
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return bodyErrorResult(err);
      }
      const scope = body.scope === 'archive' ? 'archive' : 'active';
      const runs = Array.isArray(body.runs) ? body.runs : [];
      try {
        const enriched = await entry.storageClient.enrichRuns(scope, runs);
        return { json: { scope, enriched } };
      } catch (err) {
        return {
          status: 502,
          json: { error: 'enrich-failed', message: String(err?.message ?? err) },
        };
      }
    },
  },
  {
    // DESTRUCTIVE: archive selected ACTIVE runs. token → validate → health-gate.
    method: 'POST',
    path: '/api/archive',
    handler: async ({ req, instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) return { status: 404, json: { error: 'instance not found' } };
      // Archive is ACTIVE-only, matching the monolith (archive-prefixed keys rejected).
      return decideMutation({
        token: req.headers['x-storage-mutation-token'],
        expectedToken: entry.mutationToken,
        readBody: () => readJsonBody(req),
        allowArchive: false,
        probeHealth: () => entry.sidecarClient.probeHealth(),
        execute: async (keys) => {
          const result = await entry.storageClient.archiveRuns(keys);
          log(
            `archived ${result.archived.length}, skipped ${result.skipped.length} (instance ${instanceId})`,
          );
          return result;
        },
        verb: 'archive',
      });
    },
  },
  {
    // DESTRUCTIVE: permanently delete selected runs (active or archive).
    method: 'POST',
    path: '/api/delete',
    handler: async ({ req, instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) return { status: 404, json: { error: 'instance not found' } };
      return decideMutation({
        token: req.headers['x-storage-mutation-token'],
        expectedToken: entry.mutationToken,
        readBody: () => readJsonBody(req),
        allowArchive: true,
        probeHealth: () => entry.sidecarClient.probeHealth(),
        execute: async (keys) => {
          const result = await entry.storageClient.deleteRuns(keys);
          log(`deleted ${result.deleted.length} run(s) (instance ${instanceId})`, 'warn');
          return result;
        },
        verb: 'delete',
      });
    },
  },
];

const binaryRoutes = [imageRoute('/img/sheet', 'sheet'), imageRoute('/img/processed', 'processed')];

async function ensureServer(ctx) {
  const existing = instances.get(ctx.instanceId);
  if (existing) return existing;

  const inflight = pendingStartups.get(ctx.instanceId);
  if (inflight) return inflight;

  const startup = startServerForInstance(ctx);
  pendingStartups.set(ctx.instanceId, startup);
  try {
    return await startup;
  } finally {
    pendingStartups.delete(ctx.instanceId);
  }
}

async function startServerForInstance(ctx) {
  const env = process.env;
  // Anchor on the repo the extension lives in (see REPO_ROOT) so the sidecar port
  // derivation + repo-match check line up with `npm run sprites:gallery`.
  const workspaceRoot = REPO_ROOT;
  const baseUrl = resolveSidecarBaseUrl({ workspacePath: workspaceRoot, env });
  const sidecarClient = createSidecarClient({ baseUrl, workspaceRoot });
  const storageClient = createStorageClient({ baseUrl });

  const entry = {
    url: '',
    sidecarClient,
    storageClient,
    baseUrl,
    workspaceRoot,
    // Per-instance secret required on the destructive routes; minted BEFORE the
    // server starts so it can be embedded in the iframe HTML via the renderHtml
    // closure below.
    mutationToken: randomUUID(),
    sidecarStartup: { state: 'starting', error: null, logPath: null },
    pushState: async () => {},
    close: async () => {},
  };

  const server = await startCanvasServer({
    instanceId: ctx.instanceId,
    renderHtml: (id) => renderHtml(id, { mutationToken: entry.mutationToken }),
    buildState: () => buildState(ctx.instanceId),
    jsonRoutes,
    binaryRoutes,
    log,
  });
  entry.url = server.url;
  entry.pushState = server.pushState;
  entry.close = server.close;
  // Publish only after the server is fully listening — every route guards on a
  // missing entry, so an early request degrades cleanly rather than observing a
  // half-initialized entry.
  instances.set(ctx.instanceId, entry);
  beginSpriteSidecarStartup(entry);
  log(`serving instance ${ctx.instanceId} at ${server.url} (sidecar ${baseUrl})`);
  return entry;
}

const canvas = createCanvas({
  id: 'storage',
  displayName: 'Storage Lifecycle',
  description:
    'List, search, archive, and delete sprite-run blobs in Azure storage across active and archive scopes.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  actions: [
    {
      name: 'list_runs',
      description: 'List sprite-run blobs in a storage scope (read-only). Newest first.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: {
            type: 'string',
            enum: ['active', 'archive'],
            description: 'Storage scope (default active).',
          },
          search: { type: 'string', description: 'Optional brief/run id substring filter.' },
        },
      },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        const scope = ctx.input?.scope === 'archive' ? 'archive' : 'active';
        const search = typeof ctx.input?.search === 'string' ? ctx.input.search : '';
        return { scope, runs: await entry.storageClient.listRuns({ scope, search }) };
      },
    },
    {
      name: 'enrich',
      description:
        'Enrich runs with variant/approved/brief-stored metadata (read-only). Pass the runs from list_runs.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['runs'],
        properties: {
          scope: { type: 'string', enum: ['active', 'archive'] },
          runs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['briefId', 'runId'],
              properties: { briefId: { type: 'string' }, runId: { type: 'string' } },
            },
          },
        },
      },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        const scope = ctx.input?.scope === 'archive' ? 'archive' : 'active';
        const runs = Array.isArray(ctx.input?.runs) ? ctx.input.runs : [];
        return { scope, enriched: await entry.storageClient.enrichRuns(scope, runs) };
      },
    },
    {
      name: 'check_health',
      description: 'Probe the sprite sidecar health for this worktree (read-only).',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        return { health: await entry.sidecarClient.probeHealth(), baseUrl: entry.baseUrl };
      },
    },
  ],
  open: async (ctx) => {
    const entry = await ensureServer(ctx);
    return { title: 'Storage Lifecycle', url: entry.url, status: `sidecar ${entry.baseUrl}` };
  },
  onClose: async (ctx) => {
    const entry = instances.get(ctx.instanceId);
    if (!entry) return;
    instances.delete(ctx.instanceId);
    try {
      await entry.close();
    } catch (err) {
      log(`error closing instance ${ctx.instanceId}: ${err?.message ?? err}`, 'warn');
    }
  },
});

sessionRef = await joinSession({ canvases: [canvas] });
log('storage canvas provider registered');
