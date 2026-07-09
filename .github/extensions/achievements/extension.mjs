/**
 * achievements — a canvas editor for Floor 1 achievements.
 *
 * Functional parity with the `?page=achievements` DevTool in the monolith
 * (`DEVTOOLS_PAGE_ACHIEVEMENTS` / `renderAchievementsEditorPage` in
 * `src/devtools-main.ts`): browse all Floor 1 achievements, filter, edit
 * title/popup/criteria/icon/details/flavor + reward as local OVERRIDES, review
 * the icon + loot-box art backlog, and copy a base+overrides export dump.
 *
 * Architecture (the harness pattern slices A–E share):
 *   - `lib/canvas-harness.mjs`   — GENERIC loopback HTTP server (vendored; the
 *     single source of truth is `scripts/canvas-harness/` — do NOT hand-edit).
 *   - `lib/image-cache.mjs`      — vendored with the harness (unused here; kept so
 *     the harness-drift test's byte-copy contract holds).
 *   - `lib/achievements-data.mjs`— DOMAIN adapter: reads the same catalog JSON the
 *     monolith imports and replicates its transforms (Layer 2).
 *   - `lib/overrides-model.mjs`  — PURE override logic, imported by BOTH the unit
 *     tests and the iframe (served over loopback) so they cannot drift.
 *   - `lib/overrides-store.mjs`  — DURABLE server-side override persistence.
 *   - `renderer.mjs`             — the iframe document (faithful monolith port).
 *   - `extension.mjs` (this)     — wires them: one server per instance, a fresh
 *     state build, a PUT route to persist overrides, and read-only actions.
 *
 * Why a server-side override store when the monolith uses localStorage: the
 * harness binds each instance to `127.0.0.1:0` (a RANDOM port), so the iframe
 * origin changes on every reopen / `extensions_reload`, and browser localStorage
 * is origin-scoped — client-only overrides would vanish. We keep the identical
 * localStorage model in the page (parity) AND persist a durable copy under
 * `$COPILOT_HOME` so edits survive a new port. The client treats the server copy
 * as authoritative and mirrors it back down to localStorage.
 *
 * stdout is reserved for JSON-RPC — we log via `session.log`, never `console.log`.
 *
 * @module achievements/extension
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCanvas, CanvasError, joinSession } from '@github/copilot-sdk/extension';

import { startCanvasServer } from './lib/canvas-harness.mjs';
import { renderHtml } from './renderer.mjs';
import { loadAchievementsData } from './lib/achievements-data.mjs';
import {
  resolveStorePath,
  readOverridesStore,
  writeOverridesStore,
} from './lib/overrides-store.mjs';
import {
  getMergedAchievements,
  filterMergedAchievements,
  sanitizeOverrides,
} from './lib/overrides-model.mjs';

/**
 * Repo root, derived from THIS file's location. The extension physically lives
 * at `<repoRoot>/.github/extensions/achievements/extension.mjs`, so three `..`
 * hops off our own directory land on the git worktree root. We deliberately do
 * NOT use `session.workspacePath` for this: in the CLI worktree runtime that
 * resolves to the session-state directory, which would point the catalog reader
 * and the repo-keyed override store at the wrong place.
 */
const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(EXT_DIR, '..', '..', '..');

/** Durable override file for THIS worktree (repo-keyed under `$COPILOT_HOME`). */
const STORE_PATH = resolveStorePath(REPO_ROOT);

/** The pure override model, served verbatim to the iframe (read once). */
const OVERRIDES_MODEL_PATH = path.join(EXT_DIR, 'lib', 'overrides-model.mjs');
let overridesModelSource = '';
try {
  overridesModelSource = readFileSync(OVERRIDES_MODEL_PATH, 'utf8');
} catch {
  // Surfaced later via the served route returning 500; logged on first open.
}

/** @type {import('@github/copilot-sdk/extension').CopilotSession | null} */
let sessionRef = null;

/**
 * Per-open-instance server handle.
 * @type {Map<string, { url: string, pushState: (state?: unknown) => Promise<unknown>, close: () => Promise<void> }>}
 */
const instances = new Map();

// In-flight startup promises keyed by instanceId. A second `open` for the same
// instance while the first is still starting shares the same promise instead of
// racing a second server; on failure the promise is dropped so a later `open`
// can retry cleanly (no poisoned map entry).
const pendingStartups = new Map();

function log(message, level = 'info') {
  try {
    sessionRef?.log?.(`[achievements] ${message}`, { level });
  } catch {
    // logging must never take down a handler
  }
}

/** Read + JSON-parse a request body; malformed / oversized input degrades to {}. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      data += chunk;
      if (data.length > 2_000_000) {
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

/**
 * Build the full view model for the iframe. Never throws — a missing/corrupt
 * catalog folds into `{ error }` (the renderer shows an error panel), and the
 * override read never throws (bad file → `{}`), mirroring the monolith's
 * graceful `loadAchievementOverrides` fallback.
 */
function buildState() {
  let data;
  try {
    data = loadAchievementsData(REPO_ROOT);
  } catch (err) {
    log(`failed to load catalog: ${err?.message ?? err}`, 'warn');
    return { error: err?.message ?? String(err) };
  }
  return {
    achievements: data.achievements,
    artBacklog: data.artBacklog,
    lootBoxTiers: data.lootBoxTiers,
    storageKey: data.storageKey,
    overrides: readOverridesStore(STORE_PATH),
  };
}

const jsonRoutes = [
  {
    method: 'PUT',
    path: '/api/overrides',
    handler: async ({ req, instanceId }) => {
      const body = await readJsonBody(req);
      const incoming =
        body && typeof body === 'object' && 'overrides' in body ? body.overrides : body;
      const clean = sanitizeOverrides(incoming);
      try {
        writeOverridesStore(STORE_PATH, clean);
      } catch (err) {
        return { status: 500, json: { ok: false, error: err?.message ?? String(err) } };
      }
      const entry = instances.get(instanceId);
      // Push fresh state so any OTHER open instance in this worktree re-syncs.
      await entry?.pushState?.(buildState());
      return { json: { ok: true, overrides: clean } };
    },
  },
];

const binaryRoutes = [
  {
    method: 'GET',
    path: '/lib/overrides-model.mjs',
    handler: () => {
      if (!overridesModelSource) {
        return {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: 'overrides-model.mjs unavailable',
        };
      }
      return {
        status: 200,
        headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
        body: overridesModelSource,
      };
    },
  },
];

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
  const server = await startCanvasServer({
    instanceId: ctx.instanceId,
    renderHtml,
    buildState,
    jsonRoutes,
    binaryRoutes,
    log,
  });
  const entry = { url: server.url, pushState: server.pushState, close: server.close };
  instances.set(ctx.instanceId, entry);
  log(`serving instance ${ctx.instanceId} at ${server.url}`);
  return entry;
}

/** Read the merged (base + persisted overrides) catalog for agent-facing actions. */
function readMergedCatalog() {
  const data = loadAchievementsData(REPO_ROOT);
  const overrides = readOverridesStore(STORE_PATH);
  return {
    merged: getMergedAchievements(data.achievements, overrides),
    overrides,
  };
}

const canvas = createCanvas({
  id: 'achievements',
  displayName: 'Achievements Editor',
  description:
    'View all Floor 1 achievements, edit title/criteria/flavor/reward overrides, and review icon + loot-box art backlog.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  actions: [
    {
      name: 'list_achievements',
      description:
        'List Floor 1 achievements (base merged with any saved overrides), optionally filtered by id/title/criteria.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Optional id/title/criteria filter.' },
        },
      },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        let merged;
        let overrides;
        try {
          ({ merged, overrides } = readMergedCatalog());
        } catch (err) {
          throw new CanvasError('catalog_unavailable', err?.message ?? String(err));
        }
        const query = typeof ctx.input?.query === 'string' ? ctx.input.query : '';
        const achievements = query ? filterMergedAchievements(merged, query) : merged;
        return {
          total: merged.length,
          overriddenCount: Object.keys(overrides).length,
          shown: achievements.length,
          achievements,
        };
      },
    },
    {
      name: 'reload',
      description: 'Re-read the catalog + saved overrides and push fresh state to the iframe.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        const state = buildState();
        await entry.pushState?.(state);
        if (state.error) return { ok: false, error: state.error };
        return {
          ok: true,
          total: state.achievements.length,
          overriddenCount: Object.keys(state.overrides).length,
        };
      },
    },
  ],
  open: async (ctx) => {
    const entry = await ensureServer(ctx);
    return { title: 'Achievements Editor', url: entry.url };
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
log('achievements canvas provider registered');
