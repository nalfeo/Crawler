/**
 * sprite-review — a review and feedback canvas for the Crawler sprite pipeline.
 *
 * Functional parity with the `?page=sprite-review` DevTool in the monolith
 * (`DEVTOOLS_PAGE_SPRITE_REVIEW` in `src/devtools-main.ts`): it shows approved /
 * generated sprite RUNS, the FIRST source sheet (with a slice-map cell overlay),
 * and per-variant pipeline traces (judge scorecard + sensor results). It never
 * mutates anything — no approve / checkin / postprocess / judge actions.
 *
 * Architecture (the pattern slices B–E copy):
 *   - `lib/canvas-harness.mjs`  — GENERIC loopback HTTP server (vendored, do not
 *     hand-edit; single source of truth is `scripts/canvas-harness/`).
 *   - `lib/sidecar-client.mjs`  — DOMAIN sidecar adapter (this tool's data source).
 *   - `lib/yaml-reader.mjs`     — reusable fs reader for `plans/` + `briefs/`.
 *   - `renderer.mjs`            — the iframe document (state-driven, SSE).
 *   - `extension.mjs` (this)    — wires them: resolve sidecar URL, start one
 *     server per instance, build state, expose trace routes + feedback writes.
 *
 * stdout is reserved for JSON-RPC — we log via `session.log`, never `console.log`.
 *
 * @module sprite-review/extension
 */

import process from 'node:process';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { createCanvas, CanvasError, joinSession } from '@github/copilot-sdk/extension';

import { startCanvasServer } from './lib/canvas-harness.mjs';
import { createImageCache, resolveExtCacheDir } from './lib/image-cache.mjs';
import { renderHtml } from './renderer.mjs';
import { feedbackForRun, readFeedback, saveFeedback } from './lib/feedback-store.mjs';
import {
  resolveSidecarBaseUrl,
  createSidecarClient,
  normalizeCandidates,
  describeJudgeSkipReason,
} from './lib/sidecar-client.mjs';

/**
 * Repo root, derived from THIS file's location. The extension physically lives
 * at `<repoRoot>/.github/extensions/sprite-review/extension.mjs`, so three `..`
 * hops off our own directory land on the checkout the sidecar
 * (`npm run sprites:gallery`) was launched from — which is what makes its
 * deterministic per-worktree port and `repoRoot` match ours.
 *
 * We deliberately do NOT use `session.workspacePath` for this: in the CLI
 * worktree runtime that resolves to the session-state directory, which derives
 * the WRONG sidecar port and fails the repo-match health check.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FEEDBACK_PATH = path.join(
  REPO_ROOT,
  'public',
  'assets',
  'generated',
  'sprite-review-feedback.json',
);

/** @type {import('@github/copilot-sdk/extension').CopilotSession | null} */
let sessionRef = null;

/**
 * Per-open-instance server + selection state.
 * @type {Map<string, {
 *   url: string,
 *   client: ReturnType<typeof createSidecarClient>,
 *   baseUrl: string,
 *   workspaceRoot: string,
 *   requested: { briefId: string | null, runId: string | null },
 *   selected: { briefId: string, runId: string, sheet: string | null } | null,
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
    sessionRef?.log?.(`[sprite-review] ${message}`, { level });
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
const imageCache = createImageCache({ dir: resolveExtCacheDir('sprite-review'), log });

/** Attach the operator-facing skip message the monolith shows for unjudged variants. */
function withSkipMessages(candidates) {
  return candidates.map((candidate) => ({
    ...candidate,
    judgeSkipMessage: describeJudgeSkipReason(candidate.judgeSkipReason, Boolean(candidate.judge)),
  }));
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
    return { health, baseUrl };
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
        promotionState: run.promotionState ?? null,
        hasJudge: run.hasJudge === true,
      }));
  } catch (err) {
    return { health, baseUrl, runs: [], error: `Failed to list runs: ${err?.message ?? err}` };
  }

  if (runs.length === 0) {
    entry.selected = null;
    return { health, baseUrl, runs: [], selected: null };
  }

  // Resolve selection (mirrors the monolith: honour ?briefId/?runId when they
  // resolve to a real run; otherwise auto-select the latest = runs[0]).
  const findRun = (briefId, runId) =>
    runs.find((run) => run.briefId === briefId && run.runId === runId) ?? null;

  let autoSelectedLatest = false;
  let selected = entry.selected;
  if (selected && !findRun(selected.briefId, selected.runId)) {
    selected = null; // previously-selected run vanished (e.g. archived)
  }
  if (!selected) {
    const requested =
      entry.requested.briefId && entry.requested.runId
        ? findRun(entry.requested.briefId, entry.requested.runId)
        : null;
    if (requested) {
      selected = { briefId: requested.briefId, runId: requested.runId, sheet: null };
    } else {
      const latest = runs[0];
      selected = { briefId: latest.briefId, runId: latest.runId, sheet: null };
      autoSelectedLatest = true;
    }
  }

  // Fetch the selected run's summary + sheets + slice map.
  let candidates = [];
  let summaryError = null;
  try {
    const summary = await entry.client.fetchRunSummary(selected.briefId, selected.runId);
    const feedback = feedbackForRun(readFeedback(FEEDBACK_PATH), selected.briefId, selected.runId);
    candidates = withSkipMessages(normalizeCandidates(summary)).map((candidate) => ({
      ...candidate,
      feedback: feedback[String(candidate.index)] ?? { sensor: {}, judge: {} },
    }));
  } catch (err) {
    summaryError = `Failed to load run summary: ${err?.message ?? err}`;
  }

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

  // Keep the displayed sheet and the slice-map sheet in lockstep: the monolith's
  // slice-map endpoint defaults to the LAST sheet, but the viewer shows the FIRST
  // — so always pass the currently-shown sheet explicitly.
  const currentSheet =
    selected.sheet && sheets.includes(selected.sheet) ? selected.sheet : (sheets[0] ?? null);
  entry.selected = { briefId: selected.briefId, runId: selected.runId, sheet: currentSheet };

  let sliceMap = null;
  if (currentSheet) {
    try {
      sliceMap = await entry.client.fetchSliceMap(selected.briefId, selected.runId, currentSheet);
    } catch (err) {
      sliceMap = { ok: false, error: `slice-map fetch failed: ${err?.message ?? err}` };
    }
  }

  return {
    health,
    baseUrl,
    runs,
    selected: entry.selected,
    autoSelectedLatest,
    sheets,
    candidates,
    sliceMap,
    error: summaryError,
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
      // Non-OK / bodyless upstream responses pass straight through (uncached) so
      // the harness preserves the real status + Content-Type.
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
    method: 'POST',
    path: '/api/feedback',
    handler: async ({ req, instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) return { status: 404, json: { error: 'instance not found' } };
      const payload = await readJsonBody(req);
      const feedback = saveFeedback(FEEDBACK_PATH, payload);
      const state = await buildState(instanceId);
      await entry.pushState?.(state);
      return { json: { feedback } };
    },
  },
  {
    method: 'GET',
    path: '/api/select',
    handler: async ({ url, instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) return { status: 404, json: { error: 'instance not found' } };
      const briefId = url.searchParams.get('briefId');
      const runId = url.searchParams.get('runId');
      const sheet = url.searchParams.get('sheet');
      if (briefId && runId) {
        const changedRun =
          !entry.selected || entry.selected.briefId !== briefId || entry.selected.runId !== runId;
        entry.requested = { briefId, runId };
        entry.selected = {
          briefId,
          runId,
          sheet: sheet ?? (changedRun ? null : (entry.selected?.sheet ?? null)),
        };
      } else if (sheet && entry.selected) {
        entry.selected = { ...entry.selected, sheet };
      }
      const state = await buildState(instanceId);
      await entry.pushState?.(state);
      return { json: state };
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

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > 16 * 1024) throw new Error('feedback payload exceeds 16 KiB');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

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

  const input = ctx.input ?? {};
  const entry = {
    url: '',
    client,
    baseUrl,
    workspaceRoot,
    requested: {
      briefId: typeof input.briefId === 'string' ? input.briefId : null,
      runId: typeof input.runId === 'string' ? input.runId : null,
    },
    selected: null,
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
  log(`serving instance ${ctx.instanceId} at ${server.url} (sidecar ${baseUrl})`);
  return entry;
}

const canvas = createCanvas({
  id: 'sprite-review',
  displayName: 'Sprite Review',
  description:
    'Review generated sprite runs, inspect judge and sensor traces, and record criterion-level feedback.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      briefId: { type: 'string', description: 'Optional brief to pre-select.' },
      runId: { type: 'string', description: 'Optional run to pre-select (requires briefId).' },
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
      name: 'get_run',
      description:
        'Fetch one run: normalized variant traces (judge + sensors), sheets, and slice map.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['briefId', 'runId'],
        properties: {
          briefId: { type: 'string' },
          runId: { type: 'string' },
          sheet: { type: 'string' },
        },
      },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        const { briefId, runId, sheet } = ctx.input;
        let summary;
        try {
          summary = await entry.client.fetchRunSummary(briefId, runId);
        } catch (err) {
          throw new CanvasError(
            'run_not_found',
            `Could not load ${briefId}/${runId}: ${err?.message ?? err}`,
          );
        }
        const candidates = withSkipMessages(normalizeCandidates(summary));
        const sheets = await entry.client.fetchSheets(briefId, runId).catch(() => []);
        const chosenSheet = sheet && sheets.includes(sheet) ? sheet : (sheets[0] ?? null);
        const sliceMap = chosenSheet
          ? await entry.client.fetchSliceMap(briefId, runId, chosenSheet).catch(() => null)
          : null;
        return { briefId, runId, candidates, sheets, sheet: chosenSheet, sliceMap };
      },
    },
    {
      name: 'select_run',
      description: 'Change the run/sheet shown in the canvas iframe.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['briefId', 'runId'],
        properties: {
          briefId: { type: 'string' },
          runId: { type: 'string' },
          sheet: { type: 'string' },
        },
      },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        const { briefId, runId, sheet } = ctx.input;
        entry.requested = { briefId, runId };
        entry.selected = { briefId, runId, sheet: sheet ?? null };
        const state = await buildState(ctx.instanceId);
        await entry.pushState?.(state);
        return { selected: state.selected, runCount: state.runs?.length ?? 0 };
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
    return { title: 'Sprite Review', url: entry.url, status: `sidecar ${entry.baseUrl}` };
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
log('sprite-review canvas provider registered');
