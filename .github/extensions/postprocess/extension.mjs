/**
 * postprocess — a canvas debugger + authoring surface for the Crawler
 * sprite-postprocess pipeline.
 *
 * Functional parity with the `?page=postprocess` DevTool in the monolith
 * (`renderPostprocessDebugger` in `src/devtools-main.ts`): it shows a run's
 * source sheet, the slice-map cell overlay (click a cell to select its variant),
 * and the postprocess pipeline step-by-step — a LIVE trace via the sidecar
 * `POST /api/postprocess` with adjustable background tolerances (Apply / Reset,
 * non-persisting preview), falling back to the pre-baked `<padded>.pipeline.json`
 * manifest.
 *
 * It also PERSISTS overrides — the monolith "Apply changes" write. The
 * authoring panel stages background tolerances, facing (left/right), a manual
 * anchor (click the final image or type x/y), and an apply-scope (this variant /
 * all variants); "Apply changes" POSTs to the sidecar
 * `POST /api/runs/:briefId/:runId/postprocess` (mode `replace`), and
 * "Reset to defaults" clears them (mode `reset`). Destructive persists
 * (all-variants or reset) are confirm-guarded, and the payload is always
 * re-validated + rebuilt server-side (never trusting the client body).
 *
 * Architecture (the pattern from slice A / sprite-review):
 *   - `lib/canvas-harness.mjs`     — GENERIC loopback HTTP server (vendored, do
 *     not hand-edit; source of truth is `scripts/canvas-harness/`).
 *   - `lib/image-cache.mjs`        — shared immutable image cache (vendored).
 *   - `lib/sidecar-client.mjs`     — DOMAIN sidecar adapter (copied verbatim from
 *     sprite-review: runs / summary / sheets / slice-map / image URLs + health).
 *   - `lib/postprocess-client.mjs` — layer-2 orchestration composing the sidecar
 *     client: live-postprocess relay + persist relay + pre-baked manifest.
 *   - `lib/slice-overlay.mjs`      — pure overlay geometry/selection/status math.
 *   - `lib/anchor.mjs`             — pure final-image click → anchor pixel + marker
 *     percent math (serialized into the iframe client).
 *   - `renderer.mjs`               — the iframe document (state-driven, SSE).
 *   - `extension.mjs` (this)       — wires them: resolve sidecar URL, start one
 *     server per instance, build state, expose read + persist routes + actions.
 *
 * stdout is reserved for JSON-RPC — we log via `session.log`, never `console.log`.
 *
 * @module postprocess/extension
 */

import process from 'node:process';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { createCanvas, CanvasError, joinSession } from '@github/copilot-sdk/extension';

import { startCanvasServer } from './lib/canvas-harness.mjs';
import { beginSpriteSidecarStartup } from '../shared/sprite-sidecar-service.mjs';
import { createImageCache, resolveExtCacheDir } from './lib/image-cache.mjs';
import { renderHtml } from './renderer.mjs';
import { resolveSidecarBaseUrl, createSidecarClient } from './lib/sidecar-client.mjs';
import {
  createPostprocessClient,
  extractAppliedBackgroundTweaks,
  extractAppliedFacing,
  extractAppliedManualAnchor,
  normalizePersistRequest,
  buildPersistPostprocessPayload,
  padVariant,
  clampTolerance,
  DEFAULT_BACKGROUND_TWEAKS,
} from './lib/postprocess-client.mjs';

/**
 * Repo root, derived from THIS file's location. The extension physically lives
 * at `<repoRoot>/.github/extensions/postprocess/extension.mjs`, so three `..`
 * hops off our own directory land on the checkout the sidecar
 * (`npm run sprites:gallery`) was launched from — which is what makes its
 * deterministic per-worktree port and `repoRoot` match ours.
 *
 * We deliberately do NOT use `session.workspacePath` for this: in the CLI
 * worktree runtime that resolves to the session-state directory, which derives
 * the WRONG sidecar port and fails the repo-match health check.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** @type {import('@github/copilot-sdk/extension').CopilotSession | null} */
let sessionRef = null;

/**
 * Per-open-instance server + selection state.
 * @type {Map<string, {
 *   url: string,
 *   client: ReturnType<typeof createSidecarClient>,
 *   postprocessClient: ReturnType<typeof createPostprocessClient>,
 *   baseUrl: string,
 *   workspaceRoot: string,
 *   requested: { briefId: string | null, runId: string | null, variantIndex: number | null },
 *   selected: { briefId: string, runId: string, variantIndex: number, sheet: string | null } | null,
 *   pushState: (state?: unknown) => Promise<unknown>,
 *   close: () => Promise<void>,
 * }>}
 */
const instances = new Map();

// In-flight startup promises keyed by instanceId. A second `open` for the same
// instance while the first is still starting shares the same promise instead of
// racing a second server; on failure the promise is dropped so a later `open`
// can retry cleanly (no poisoned map entry).
const pendingStartups = new Map();

function log(message, level = 'info') {
  try {
    sessionRef?.log?.(`[postprocess] ${message}`, { level });
  } catch {
    // logging must never take down a handler
  }
}

/**
 * Shared, outside-of-worktree image cache. Sidecar runs are timestamped +
 * immutable, so a `(kind, briefId, runId, file)` tuple never changes — the
 * cache lives under `$COPILOT_HOME` so every worktree on the machine shares it.
 * A broken/disabled cache degrades to a transparent pass-through (never throws).
 */
const imageCache = createImageCache({ dir: resolveExtCacheDir('postprocess'), log });

/** Read + JSON-parse a request body, with a hard size cap. */
function readJsonBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed = text ? JSON.parse(text) : {};
        // Coerce non-object JSON (null / primitives) to {} so downstream field
        // reads (body.briefId, …) yield a clean 400 instead of throwing a 502.
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Collect the sorted, unique variant indices from a run summary's candidates. */
function collectVariantIndices(summary) {
  const candidates =
    summary && typeof summary === 'object' && Array.isArray(summary.candidates)
      ? summary.candidates
      : [];
  const seen = new Set();
  for (const c of candidates) {
    if (c && typeof c === 'object' && typeof c.index === 'number' && c.index >= 0)
      seen.add(c.index);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Build the full view model for one instance. Never throws — every failure is
 * folded into a structured, renderable state (health badge + degrade panels +
 * per-section error strings), mirroring the monolith's graceful-degrade page.
 */
async function buildState(instanceId) {
  const entry = instances.get(instanceId);
  if (!entry) return { error: 'instance not found' };
  const baseUrl = entry.baseUrl;

  const health = await entry.client.probeHealth();
  if (health.state !== 'up') {
    return { health, baseUrl, sidecarStartup: entry.sidecarStartup };
  }

  let runs = [];
  try {
    const raw = await entry.client.listRuns();
    runs = raw
      .filter((run) => run && typeof run.briefId === 'string' && typeof run.runId === 'string')
      .map((run) => ({
        briefId: run.briefId,
        runId: run.runId,
        candidateCount: typeof run.candidateCount === 'number' ? run.candidateCount : null,
      }));
  } catch (err) {
    return { health, baseUrl, runs: [], error: `Failed to list runs: ${err?.message ?? err}` };
  }

  if (runs.length === 0) {
    entry.selected = null;
    return { health, baseUrl, runs: [], selected: null };
  }

  const findRun = (briefId, runId) =>
    runs.find((run) => run.briefId === briefId && run.runId === runId) ?? null;

  // Resolve selection (mirrors the monolith: honour requested briefId/runId when
  // they resolve to a real run; otherwise auto-select the latest = runs[0]).
  let autoSelectedLatest = false;
  let selected = entry.selected;
  if (selected && !findRun(selected.briefId, selected.runId)) {
    selected = null; // previously-selected run vanished (e.g. archived)
  }
  if (!selected) {
    const req = entry.requested;
    const reqRun = req.briefId && req.runId ? findRun(req.briefId, req.runId) : null;
    if (reqRun) {
      selected = {
        briefId: reqRun.briefId,
        runId: reqRun.runId,
        variantIndex: typeof req.variantIndex === 'number' ? req.variantIndex : 0,
        sheet: null,
      };
    } else {
      const latest = runs[0];
      selected = { briefId: latest.briefId, runId: latest.runId, variantIndex: 0, sheet: null };
      autoSelectedLatest = true;
    }
  }

  // Fetch the selected run's summary → briefPath, variant indices, persisted
  // background overrides (initial tolerance knob values).
  let variantIndices = [];
  let briefPath = null;
  let appliedBackground = null;
  let appliedFacing = null;
  let appliedManualAnchor = null;
  let summaryError = null;
  try {
    const summary = await entry.client.fetchRunSummary(selected.briefId, selected.runId);
    variantIndices = collectVariantIndices(summary);
    briefPath =
      summary && typeof summary.briefPath === 'string' && summary.briefPath.length > 0
        ? summary.briefPath
        : null;
    appliedBackground = extractAppliedBackgroundTweaks(summary);
    appliedFacing = extractAppliedFacing(summary);
    appliedManualAnchor = extractAppliedManualAnchor(summary);
  } catch (err) {
    summaryError = `Failed to load run summary: ${err?.message ?? err}`;
  }

  // Clamp the variant to one the run actually has.
  if (variantIndices.length > 0 && !variantIndices.includes(selected.variantIndex)) {
    selected.variantIndex = variantIndices[0];
  }
  const padded = padVariant(selected.variantIndex);

  // Pre-baked pipeline manifest for this variant (also yields sourceRunId used
  // for sheet fallback below).
  const manifest = await entry.postprocessClient.fetchPipelineManifest(
    selected.briefId,
    selected.runId,
    padded,
  );

  // Sheet resolution: sheets live on the run itself; if the run has none, fall
  // back to the manifest's sourceRunId (the run the sheet was sliced from). The
  // active sheet defaults to the LAST sheet (monolith `sheetFiles[len-1]`).
  let sheetRunId = selected.runId;
  let sheets = [];
  try {
    sheets = await entry.client.fetchSheets(selected.briefId, selected.runId);
  } catch (err) {
    log(
      `fetchSheets failed for ${selected.briefId}/${selected.runId}: ${err?.message ?? err}`,
      'warn',
    );
    sheets = [];
  }
  if (sheets.length === 0 && manifest?.sourceRunId) {
    sheetRunId = manifest.sourceRunId;
    try {
      sheets = await entry.client.fetchSheets(selected.briefId, sheetRunId);
    } catch (err) {
      log(
        `fetchSheets (sourceRun) failed for ${selected.briefId}/${sheetRunId}: ${err?.message ?? err}`,
        'warn',
      );
      sheets = [];
    }
  }
  const activeSheet =
    selected.sheet && sheets.includes(selected.sheet)
      ? selected.sheet
      : (sheets[sheets.length - 1] ?? null);

  // Persist the resolved selection (variant clamp + active sheet) for next call.
  entry.selected = {
    briefId: selected.briefId,
    runId: selected.runId,
    variantIndex: selected.variantIndex,
    sheet: activeSheet,
  };

  let sliceMap = null;
  if (activeSheet) {
    try {
      sliceMap = await entry.client.fetchSliceMap(selected.briefId, sheetRunId, activeSheet);
    } catch (err) {
      sliceMap = { ok: false, error: `slice-map fetch failed: ${err?.message ?? err}` };
    }
  }

  return {
    health,
    baseUrl,
    runs,
    autoSelectedLatest,
    sliceMap,
    error: summaryError,
    selected: {
      briefId: selected.briefId,
      runId: selected.runId,
      variantIndex: selected.variantIndex,
      variantIndices,
      briefPath,
      sheetRunId,
      sheets,
      activeSheet,
      manifestSteps: manifest ? manifest.steps : [],
      profile: manifest ? manifest.profile : null,
      appliedBackground,
      appliedFacing,
      appliedManualAnchor,
    },
  };
}

/** Relay a sidecar image (sheet / processed / raw) as a streamed web Response. */
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
          ? entry.client.urls.sheet(briefId, runId, file)
          : kind === 'raw'
            ? entry.client.urls.raw(briefId, runId, file)
            : entry.client.urls.processed(briefId, runId, file);
      // Serve immutable bytes from the shared on-disk cache when present; on a
      // miss, fetch from the sidecar, cache a successful body, and relay it.
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
    method: 'GET',
    path: '/api/select',
    handler: async ({ url, instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) return { status: 404, json: { error: 'instance not found' } };
      const briefId = url.searchParams.get('briefId');
      const runId = url.searchParams.get('runId');
      const sheet = url.searchParams.get('sheet');
      const variantParam = url.searchParams.get('variant');
      const variant =
        variantParam != null && variantParam !== '' && Number.isFinite(Number(variantParam))
          ? Number(variantParam)
          : null;
      if (briefId && runId) {
        const changedRun =
          !entry.selected || entry.selected.briefId !== briefId || entry.selected.runId !== runId;
        entry.requested = {
          briefId,
          runId,
          variantIndex: variant ?? (changedRun ? null : (entry.requested?.variantIndex ?? null)),
        };
        entry.selected = {
          briefId,
          runId,
          variantIndex: variant ?? (changedRun ? 0 : (entry.selected?.variantIndex ?? 0)),
          sheet: sheet ?? (changedRun ? null : (entry.selected?.sheet ?? null)),
        };
      } else if (entry.selected) {
        if (variant != null) entry.selected = { ...entry.selected, variantIndex: variant };
        if (sheet) entry.selected = { ...entry.selected, sheet };
      }
      // The in-iframe client renders this fetch response directly, so we must
      // NOT also broadcast over SSE: a double delivery re-runs render() and
      // (for sheet-less runs) fires a duplicate live /api/postprocess relay.
      // SSE stays reserved for external canvas actions (select/reload) below.
      const state = await buildState(instanceId);
      return { json: state };
    },
  },
  {
    method: 'POST',
    path: '/api/live-postprocess',
    handler: async ({ req, instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) {
        return {
          status: 404,
          json: { ok: false, reason: 'not-open', message: 'instance not found' },
        };
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return {
          status: 400,
          json: { ok: false, reason: 'bad-request', message: err?.message ?? String(err) },
        };
      }
      const briefId = typeof body.briefId === 'string' ? body.briefId : null;
      const runId = typeof body.runId === 'string' ? body.runId : null;
      const rawPngBase64 = typeof body.rawPngBase64 === 'string' ? body.rawPngBase64 : null;
      if (!briefId || !runId || !rawPngBase64) {
        return {
          status: 400,
          json: {
            ok: false,
            reason: 'bad-request',
            message: 'briefId, runId and rawPngBase64 are required',
          },
        };
      }
      const colorToleranceSq = clampTolerance(
        Number(body.colorToleranceSq),
        DEFAULT_BACKGROUND_TWEAKS.colorToleranceSq,
      );
      const fringeToleranceSq = clampTolerance(
        Number(body.fringeToleranceSq),
        DEFAULT_BACKGROUND_TWEAKS.fringeToleranceSq,
      );
      const result = await entry.postprocessClient.relayLivePostprocess({
        briefId,
        runId,
        rawPngBase64,
        options: { background: { colorToleranceSq, fringeToleranceSq } },
      });
      return { json: result };
    },
  },
  {
    method: 'POST',
    path: '/api/persist-postprocess',
    handler: async ({ req, instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) {
        return {
          status: 404,
          json: { ok: false, reason: 'not-open', message: 'instance not found' },
        };
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return {
          status: 400,
          json: { ok: false, reason: 'bad-request', message: err?.message ?? String(err) },
        };
      }
      // NEVER trust the client: validate + rebuild the payload server-side from the
      // raw intent bits (mode / variantIndex / applyToAll / facing / manualAnchor /
      // tolerances). The PURE builder guarantees byte-parity with the monolith body.
      const normalized = normalizePersistRequest(body);
      if (!normalized.ok) {
        return {
          status: 400,
          json: { ok: false, reason: 'bad-request', message: normalized.error },
        };
      }
      const payload = buildPersistPostprocessPayload(normalized.args);
      const result = await entry.postprocessClient.relayPersistPostprocess({
        briefId: normalized.args.briefId,
        runId: normalized.args.runId,
        payload,
      });
      if (!result.ok) return { json: result };
      // Persist succeeded. Return FRESH state (re-fetched summary → re-seeded
      // overrides) so the iframe re-renders exactly ONCE from the response. We do
      // NOT also broadcast over SSE — a double delivery would re-run render() and
      // fire a duplicate live /api/postprocess relay (same rule as /api/select).
      const state = await buildState(instanceId);
      return { json: { ok: true, state } };
    },
  },
  {
    method: 'GET',
    path: '/api/runs',
    handler: async ({ instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) return { status: 404, json: { error: 'instance not found' } };
      const runs = await entry.client.listRuns();
      return { json: { runs } };
    },
  },
];

const binaryRoutes = [
  imageRoute('/img/sheet', 'sheet'),
  imageRoute('/img/processed', 'processed'),
  imageRoute('/img/raw', 'raw'),
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
  const env = process.env;
  // Anchor on the repo the extension lives in (see REPO_ROOT) so the sidecar
  // port derivation + repo-match check line up with `npm run sprites:gallery`.
  // `session.workspacePath` is the session-state dir here, not the worktree.
  const workspaceRoot = REPO_ROOT;
  const baseUrl = resolveSidecarBaseUrl({ workspacePath: workspaceRoot, env });
  const client = createSidecarClient({ baseUrl, workspaceRoot });
  const postprocessClient = createPostprocessClient({ sidecarClient: client });

  const input = ctx.input ?? {};
  const requestedVariant =
    typeof input.variantIndex === 'number' && Number.isFinite(input.variantIndex)
      ? input.variantIndex
      : null;
  const entry = {
    url: '',
    client,
    postprocessClient,
    baseUrl,
    workspaceRoot,
    requested: {
      briefId: typeof input.briefId === 'string' ? input.briefId : null,
      runId: typeof input.runId === 'string' ? input.runId : null,
      variantIndex: requestedVariant,
    },
    selected: null,
    sidecarStartup: { state: 'starting', error: null, logPath: null },
    pushState: async () => {},
    close: async () => {},
  };

  const server = await startCanvasServer({
    instanceId: ctx.instanceId,
    renderHtml,
    buildState: () => buildState(ctx.instanceId),
    jsonRoutes,
    binaryRoutes,
    log,
  });
  entry.url = server.url;
  entry.pushState = server.pushState;
  entry.close = server.close;
  // Publish only after the server is fully listening — buildState() guards on a
  // missing entry, so an early /api/state request degrades cleanly rather than
  // observing a half-initialized entry.
  instances.set(ctx.instanceId, entry);
  beginSpriteSidecarStartup(entry);
  log(`serving instance ${ctx.instanceId} at ${server.url} (sidecar ${baseUrl})`);
  return entry;
}

const canvas = createCanvas({
  id: 'postprocess',
  displayName: 'Postprocess Debugger',
  description:
    'Inspect pipeline steps, validate sheet slicing, trace live postprocess output, and persist background / facing / manual-anchor overrides for a generated sprite run.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      briefId: { type: 'string', description: 'Optional brief to pre-select.' },
      runId: { type: 'string', description: 'Optional run to pre-select (requires briefId).' },
      variantIndex: { type: 'number', description: 'Optional variant index to pre-select.' },
    },
  },
  actions: [
    {
      name: 'list_runs',
      description: 'List sprite runs known to the sidecar (newest first).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { promoted: { type: 'string', enum: ['all', 'promoted', 'not-promoted'] } },
      },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        const promoted = ctx.input?.promoted ?? 'all';
        return { runs: await entry.client.listRuns({ promoted }) };
      },
    },
    {
      name: 'select',
      description: 'Change the run / variant / sheet traced in the canvas iframe.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['briefId', 'runId'],
        properties: {
          briefId: { type: 'string' },
          runId: { type: 'string' },
          variantIndex: { type: 'number' },
          sheet: { type: 'string' },
        },
      },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        const { briefId, runId, variantIndex, sheet } = ctx.input;
        entry.requested = {
          briefId,
          runId,
          variantIndex: typeof variantIndex === 'number' ? variantIndex : null,
        };
        entry.selected = {
          briefId,
          runId,
          variantIndex: typeof variantIndex === 'number' ? variantIndex : 0,
          sheet: sheet ?? null,
        };
        const state = await buildState(ctx.instanceId);
        await entry.pushState?.(state);
        return { selected: state.selected, runCount: state.runs?.length ?? 0 };
      },
    },
    {
      name: 'live_postprocess',
      description:
        'Relay a live postprocess for the given run using a base64 raw PNG and background tolerances; returns { finalPng, steps }.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['briefId', 'runId', 'rawPngBase64'],
        properties: {
          briefId: { type: 'string' },
          runId: { type: 'string' },
          rawPngBase64: { type: 'string' },
          colorToleranceSq: { type: 'number' },
          fringeToleranceSq: { type: 'number' },
        },
      },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        const { briefId, runId, rawPngBase64 } = ctx.input;
        const colorToleranceSq = clampTolerance(
          Number(ctx.input.colorToleranceSq),
          DEFAULT_BACKGROUND_TWEAKS.colorToleranceSq,
        );
        const fringeToleranceSq = clampTolerance(
          Number(ctx.input.fringeToleranceSq),
          DEFAULT_BACKGROUND_TWEAKS.fringeToleranceSq,
        );
        return entry.postprocessClient.relayLivePostprocess({
          briefId,
          runId,
          rawPngBase64,
          options: { background: { colorToleranceSq, fringeToleranceSq } },
        });
      },
    },
    {
      name: 'persist_postprocess',
      description:
        'Persist postprocess overrides for a run — the monolith "Apply changes". mode:"replace" writes background tolerances + facing + an optional manual anchor; mode:"reset" clears all overrides. Writes to the sidecar run store, focuses the iframe on that run, and pushes fresh (re-seeded) state.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['briefId', 'runId', 'mode'],
        properties: {
          briefId: { type: 'string' },
          runId: { type: 'string' },
          mode: { type: 'string', enum: ['replace', 'reset'] },
          variantIndex: { type: 'number' },
          applyToAll: { type: 'boolean' },
          facingDirection: { type: 'string', enum: ['left', 'right'] },
          manualAnchorClear: { type: 'boolean' },
          manualAnchor: {
            type: 'object',
            additionalProperties: false,
            properties: { x: { type: 'number' }, y: { type: 'number' } },
          },
          colorToleranceSq: { type: 'number' },
          fringeToleranceSq: { type: 'number' },
        },
      },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        const normalized = normalizePersistRequest(ctx.input);
        if (!normalized.ok) throw new CanvasError('bad_input', normalized.error);
        const payload = buildPersistPostprocessPayload(normalized.args);
        const result = await entry.postprocessClient.relayPersistPostprocess({
          briefId: normalized.args.briefId,
          runId: normalized.args.runId,
          payload,
        });
        if (!result.ok) return result;
        // Focus the iframe on the run we just modified so the pushed state reflects
        // the persisted overrides (mirrors the monolith operating on the shown target).
        const changedRun =
          !entry.selected ||
          entry.selected.briefId !== normalized.args.briefId ||
          entry.selected.runId !== normalized.args.runId;
        const targetVariant =
          normalized.args.mode === 'replace'
            ? normalized.args.variantIndex
            : (entry.selected?.variantIndex ?? 0);
        entry.requested = {
          briefId: normalized.args.briefId,
          runId: normalized.args.runId,
          variantIndex: targetVariant,
        };
        entry.selected = {
          briefId: normalized.args.briefId,
          runId: normalized.args.runId,
          variantIndex: targetVariant,
          sheet: changedRun ? null : (entry.selected?.sheet ?? null),
        };
        const state = await buildState(ctx.instanceId);
        await entry.pushState?.(state);
        return {
          ok: true,
          persisted: {
            background: extractAppliedBackgroundTweaks(result.summary),
            facing: extractAppliedFacing(result.summary),
            manualAnchor: extractAppliedManualAnchor(result.summary),
          },
          selected: state.selected,
        };
      },
    },
    {
      name: 'reload',
      description: 'Re-probe the sidecar and push fresh state to the iframe.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        const state = await buildState(ctx.instanceId);
        await entry.pushState?.(state);
        return { health: state.health, runCount: state.runs?.length ?? 0 };
      },
    },
  ],
  open: async (ctx) => {
    const entry = await ensureServer(ctx);
    return { title: 'Postprocess Debugger', url: entry.url, status: `sidecar ${entry.baseUrl}` };
  },
  onClose: async (ctx) => {
    // A close can arrive while the server is still starting: the entry is only
    // published to `instances` after startCanvasServer() resolves. Await any
    // in-flight startup first so we never leak the loopback server it creates.
    const pending = pendingStartups.get(ctx.instanceId);
    if (pending) {
      try {
        await pending;
      } catch {
        return; // startup failed — nothing was published, nothing to close
      }
    }
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
log('postprocess canvas provider registered');
