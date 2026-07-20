/**
 * workflow — inspect sprite runs and accept selected variants into the asset queue.
 *
 * Functional parity with the READ surface of the `?page=sprite-generation-workflow`
 * DevTool in the monolith (`DEVTOOLS_PAGE_SPRITE_WORKFLOW` in `src/devtools-main.ts`):
 * it browses the asset BACKLOG (per-plan status + integration column), the
 * PLANS/BRIEFS YAML, and generated RUNS (variants + judge + sensors + sheet/slice-map).
 * It never mutates anything — the durable QUEUE + asset-REQUEST manifest (their
 * status reads AND controls) and the write half of the workflow (synthesize /
 * generate / judge / approve / checkin / metadata, worker & issues start-stop, and
 * the interactive queue state machine) are the documented follow-up slice (B2).
 *
 * Architecture (the pattern shared with sprite-review / slices B–E):
 *   - `lib/canvas-harness.mjs`  — GENERIC loopback HTTP server (vendored; single
 *     source of truth is `scripts/canvas-harness/`; do not hand-edit).
 *   - `lib/image-cache.mjs`     — vendored outside-worktree on-disk image cache.
 *   - `lib/sidecar-client.mjs`  — DOMAIN sidecar adapter (runs + image URL builders).
 *   - `lib/yaml-reader.mjs`     — fs reader for `plans/**` + `briefs/**`.
 *   - `lib/registry-ids.mjs`    — best-effort sprite/item registry id loader.
 *   - `lib/workflow-model.mjs`  — 1:1 port of the monolith's backlog/report logic.
 *   - `renderer.mjs`            — the iframe document (state-driven, SSE).
 *   - `extension.mjs` (this)    — wires them together.
 *
 * stdout is reserved for JSON-RPC — we log via `session.log`, never `console.log`.
 *
 * @module workflow/extension
 */

import process from 'node:process';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCanvas, CanvasError, joinSession } from '@github/copilot-sdk/extension';

import { startCanvasServer } from './lib/canvas-harness.mjs';
import { createImageCache, resolveExtCacheDir } from './lib/image-cache.mjs';
import { renderHtml } from './renderer.mjs';
import {
  resolveSidecarBaseUrl,
  createSidecarClient,
  normalizeCandidates,
  describeJudgeSkipReason,
} from './lib/sidecar-client.mjs';
import { listArtPlans, listBriefs } from './lib/yaml-reader.mjs';
import { loadRegistryIds } from './lib/registry-ids.mjs';
import { loadBacklog } from './lib/workflow-model.mjs';
import { readJsonBody, tokensMatch } from './lib/mutation-security.mjs';

/**
 * Repo root, derived from THIS file's location. The extension physically lives
 * at `<repoRoot>/.github/extensions/workflow/extension.mjs`, so three `..` hops
 * off our own directory land on the checkout the sidecar
 * (`npm run sprites:gallery`) was launched from — which is what makes its
 * deterministic per-worktree port and `repoRoot` match ours.
 *
 * We deliberately do NOT use `session.workspacePath`: in the CLI worktree runtime
 * that resolves to the session-state directory, which derives the WRONG sidecar
 * port and fails the repo-match health check.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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
 *   mutationToken: string,
 *   acceptance: Map<string, object>,
 *   cache: null | {
 *     registryError: string | null,
 *     backlog: object,
 *     promotedRunIds: Set<string>,
 *     files: { plans: object[], briefs: object[], error: string | null },
 *     allowlist: Map<string, { path: string, kind: 'plan' | 'brief' }>,
 *   },
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

function acceptanceKey(briefId, runId, variantIndex) {
  return `${briefId}/${runId}/${variantIndex}`;
}

function log(message, level = 'info') {
  try {
    sessionRef?.log?.(`[workflow] ${message}`, { level });
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
const imageCache = createImageCache({ dir: resolveExtCacheDir('workflow'), log });

/** Attach the operator-facing skip message the monolith shows for unjudged variants. */
function withSkipMessages(candidates) {
  return candidates.map((candidate) => ({
    ...candidate,
    judgeSkipMessage: describeJudgeSkipReason(candidate.judgeSkipReason, Boolean(candidate.judge)),
  }));
}

/**
 * Compute (and memoise per instance) the fs-static part of the view model: the
 * backlog report, the plan/brief file listing, the plan/brief content allowlist,
 * and the promoted-run id set. This is the expensive part (esbuild-transforming
 * the registry + parsing ~40 YAML files), so it is cached and recomputed ONLY on
 * an explicit reload (`entry.cache = null`). Live sidecar reads stay per-buildState.
 */
async function getStatic(entry) {
  if (entry.cache) return entry.cache;

  // Best-effort, async (esbuild-transforms two TS data modules). Any failure
  // degrades to `{ spriteIds:null, itemIds:null, error }` — never throws.
  const registry = await loadRegistryIds(entry.workspaceRoot);

  let backlogClient;
  let promotedRunIds = new Set();
  try {
    const backlog = loadBacklog({
      repoRoot: entry.workspaceRoot,
      spriteIds: registry.spriteIds,
      itemIds: registry.itemIds,
    });
    promotedRunIds = backlog.promotedRunIds ?? new Set();
    backlogClient = {
      reports: backlog.reports,
      planCount: backlog.planCount,
      totals: backlog.totals,
      unresolvedPlaceholders: backlog.unresolvedPlaceholders,
      integrationResolved: backlog.integrationResolved,
      error: null,
    };
  } catch (err) {
    backlogClient = { reports: [], error: err?.message ?? String(err) };
  }

  const allowlist = new Map();
  let files;
  try {
    const plans = listArtPlans({ repoRoot: entry.workspaceRoot });
    const briefs = listBriefs({ repoRoot: entry.workspaceRoot });
    for (const p of plans) allowlist.set(p.relPath, { path: p.path, kind: 'plan' });
    for (const b of briefs) allowlist.set(b.relPath, { path: b.path, kind: 'brief' });
    files = {
      plans: plans.map((p) => ({ relPath: p.relPath, name: p.id })),
      briefs: briefs.map((b) => ({
        relPath: b.relPath,
        name: b.id,
        draft: b.relPath.toLowerCase().includes('/draft/'),
      })),
      error: null,
    };
  } catch (err) {
    files = { plans: [], briefs: [], error: err?.message ?? String(err) };
  }

  entry.cache = {
    registryError: registry.error ?? null,
    backlog: backlogClient,
    promotedRunIds,
    files,
    allowlist,
  };
  return entry.cache;
}

/**
 * Build the full read view model for one instance. Never throws — every failure
 * is folded into a structured, renderable state (health badge + degrade panels +
 * per-section error strings), mirroring the monolith's graceful-degrade page.
 * Backlog + plan/brief browsing work even when the sidecar is DOWN (fs-only).
 */
async function buildState(instanceId) {
  const entry = instances.get(instanceId);
  if (!entry) return { error: 'instance not found' };
  const baseUrl = entry.baseUrl;

  const stat = await getStatic(entry);
  const backlog = stat.backlog;
  const files = stat.files;

  const health = await entry.client.probeHealth();
  if (health.state !== 'up') {
    // Sidecar down/wrong-repo: fs-backed backlog + plan/brief browsing still work;
    // the sidecar-backed Runs tab renders a degrade panel.
    return {
      health,
      baseUrl,
      backlog,
      files,
      runs: [],
      selected: null,
      acceptance: Object.fromEntries(entry.acceptance),
    };
  }

  let runs = [];
  let runsError = null;
  try {
    const raw = await entry.client.listRuns();
    runs = raw
      .filter((run) => run && typeof run.briefId === 'string' && typeof run.runId === 'string')
      .map((run) => ({
        briefId: run.briefId,
        runId: run.runId,
        candidateCount: typeof run.candidateCount === 'number' ? run.candidateCount : null,
        // Key by `<briefId>/<runId>` to match the sidecar's canonical promotion
        // keying (workflow-model normalizes sourceRun the same way).
        promoted: stat.promotedRunIds.has(`${run.briefId}/${run.runId}`),
      }));
  } catch (err) {
    runsError = `Failed to list runs: ${err?.message ?? err}`;
  }

  // Resolve the selected run (mirrors the monolith: honour a requested
  // briefId/runId when it resolves to a real run; otherwise auto-select latest).
  let autoSelectedLatest = false;
  let selected = entry.selected;
  let sheets = [];
  let candidates = [];
  let sliceMap = null;
  let summaryError = null;

  if (runs.length > 0) {
    const findRun = (briefId, runId) =>
      runs.find((run) => run.briefId === briefId && run.runId === runId) ?? null;
    if (selected && !findRun(selected.briefId, selected.runId)) selected = null;
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

    try {
      const summary = await entry.client.fetchRunSummary(selected.briefId, selected.runId);
      candidates = withSkipMessages(normalizeCandidates(summary));
    } catch (err) {
      summaryError = `Failed to load run summary: ${err?.message ?? err}`;
    }
    try {
      sheets = await entry.client.fetchSheets(selected.briefId, selected.runId);
    } catch (err) {
      log(
        `fetchSheets failed for ${selected.briefId}/${selected.runId}: ${err?.message ?? err}`,
        'warn',
      );
      sheets = [];
    }
    const currentSheet =
      selected.sheet && sheets.includes(selected.sheet) ? selected.sheet : (sheets[0] ?? null);
    entry.selected = { briefId: selected.briefId, runId: selected.runId, sheet: currentSheet };
    selected = entry.selected;
    if (currentSheet) {
      try {
        sliceMap = await entry.client.fetchSliceMap(selected.briefId, selected.runId, currentSheet);
      } catch (err) {
        sliceMap = { ok: false, error: `slice-map fetch failed: ${err?.message ?? err}` };
      }
    }
  } else {
    entry.selected = null;
    selected = null;
  }

  return {
    health,
    baseUrl,
    backlog,
    files,
    runs,
    selected,
    autoSelectedLatest,
    sheets,
    candidates,
    sliceMap,
    acceptance: Object.fromEntries(entry.acceptance),
    error: summaryError ?? runsError ?? null,
  };
}

async function acceptAndQueue(instanceId, briefId, runId, variantIndex) {
  const entry = instances.get(instanceId);
  if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
  const key = acceptanceKey(briefId, runId, variantIndex);
  entry.acceptance.set(key, { state: 'accepting' });
  await entry.pushState?.(await buildState(instanceId));
  try {
    const result = await entry.client.acceptVariant(briefId, runId, variantIndex);
    if (!result || result.state !== 'queued' || typeof result.issueUrl !== 'string') {
      throw new Error('Sidecar returned an invalid acceptance result.');
    }
    entry.acceptance.set(key, result);
    entry.cache = null;
    await entry.pushState?.(await buildState(instanceId));
    return result;
  } catch (error) {
    entry.acceptance.set(key, {
      state: 'error',
      code: typeof error?.code === 'string' ? error.code : 'accept-failed',
      message: error?.message ?? String(error),
    });
    await entry.pushState?.(await buildState(instanceId));
    throw error;
  }
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

/**
 * Serve allowlisted plan/brief YAML content. Rejects any path not enumerated by
 * yaml-reader — the client NEVER controls a filesystem path we join to the root.
 */
function fileContentRoute(pathname, kind) {
  return {
    method: 'GET',
    path: pathname,
    handler: async ({ url, instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) return { status: 404, json: { error: 'instance not found' } };
      const relPath = url.searchParams.get('relPath');
      const stat = await getStatic(entry);
      const hit = relPath ? stat.allowlist.get(relPath) : null;
      if (!hit || hit.kind !== kind) {
        return { status: 400, json: { error: `unknown ${kind} path` } };
      }
      try {
        const content = readFileSync(hit.path, 'utf8');
        return { json: { relPath, content } };
      } catch (err) {
        return { status: 500, json: { error: `read failed: ${err?.message ?? err}` } };
      }
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
    method: 'POST',
    path: '/api/accept',
    handler: async ({ req, instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) return { status: 404, json: { error: 'instance-not-found' } };
      if (!tokensMatch(req.headers['x-workflow-mutation-token'], entry.mutationToken)) {
        return { status: 403, json: { error: 'forbidden', message: 'Invalid mutation token.' } };
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const tooLarge =
          error?.statusCode === 413 ||
          error?.code === 'body-too-large' ||
          error?.message === 'request body too large';
        return {
          status: tooLarge ? 413 : 400,
          json: {
            error: tooLarge ? 'body-too-large' : 'bad-request',
            message: tooLarge ? error.message : 'Request body must be valid JSON.',
          },
        };
      }
      const { briefId, runId, variantIndex } = body;
      if (
        typeof briefId !== 'string' ||
        typeof runId !== 'string' ||
        typeof variantIndex !== 'number' ||
        !Number.isInteger(variantIndex) ||
        variantIndex < 0
      ) {
        return {
          status: 400,
          json: {
            error: 'bad-request',
            message: 'briefId, runId, and a non-negative integer variantIndex are required.',
          },
        };
      }
      try {
        return { json: await acceptAndQueue(instanceId, briefId, runId, variantIndex) };
      } catch (error) {
        return {
          status: Number.isInteger(error?.status) ? error.status : 502,
          json: {
            error: typeof error?.code === 'string' ? error.code : 'accept-failed',
            message: error?.message ?? String(error),
          },
        };
      }
    },
  },
  {
    // Explicit reload: invalidate the fs-static cache, then rebuild + push.
    method: 'GET',
    path: '/api/reload',
    handler: async ({ instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) return { status: 404, json: { error: 'instance not found' } };
      entry.cache = null;
      const state = await buildState(instanceId);
      await entry.pushState?.(state);
      return { json: state };
    },
  },
  fileContentRoute('/api/plan', 'plan'),
  fileContentRoute('/api/brief', 'brief'),
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
  // Anchor on the repo the extension lives in (see REPO_ROOT) so the sidecar port
  // derivation + repo-match check line up with `npm run sprites:gallery`.
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
    mutationToken: randomBytes(24).toString('hex'),
    acceptance: new Map(),
    cache: null,
    pushState: async () => {},
    close: async () => {},
  };

  const server = await startCanvasServer({
    instanceId: ctx.instanceId,
    renderHtml: () => renderHtml(ctx.instanceId, entry.mutationToken),
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
  id: 'workflow',
  displayName: 'Sprite Generation Workflow',
  description:
    'Inspect the sprite-generation workflow and accept a selected run variant into the durable asset-checkin queue.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      briefId: { type: 'string', description: 'Optional run brief to pre-select on the Runs tab.' },
      runId: { type: 'string', description: 'Optional run to pre-select (requires briefId).' },
    },
  },
  actions: [
    {
      name: 'get_backlog',
      description:
        'The asset backlog: one report per art plan (per-asset status + integration state) plus rolled-up totals.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        return (await getStatic(entry)).backlog;
      },
    },
    {
      name: 'list_plans',
      description: 'List art-plan files (relPath + id) available to browse.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        return { plans: (await getStatic(entry)).files.plans };
      },
    },
    {
      name: 'get_plan',
      description: 'Read one art-plan YAML by its relPath (must be an enumerated plan).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['relPath'],
        properties: { relPath: { type: 'string' } },
      },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        const hit = (await getStatic(entry)).allowlist.get(ctx.input.relPath);
        if (!hit || hit.kind !== 'plan') throw new CanvasError('not_found', 'Unknown plan path.');
        try {
          return { relPath: ctx.input.relPath, content: readFileSync(hit.path, 'utf8') };
        } catch (err) {
          throw new CanvasError('read_failed', `Failed to read plan: ${err?.message ?? err}`);
        }
      },
    },
    {
      name: 'list_briefs',
      description: 'List brief files (relPath + id + draft flag) available to browse.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        return { briefs: (await getStatic(entry)).files.briefs };
      },
    },
    {
      name: 'get_brief',
      description: 'Read one brief YAML by its relPath (must be an enumerated brief).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['relPath'],
        properties: { relPath: { type: 'string' } },
      },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        const hit = (await getStatic(entry)).allowlist.get(ctx.input.relPath);
        if (!hit || hit.kind !== 'brief') throw new CanvasError('not_found', 'Unknown brief path.');
        try {
          return { relPath: ctx.input.relPath, content: readFileSync(hit.path, 'utf8') };
        } catch (err) {
          throw new CanvasError('read_failed', `Failed to read brief: ${err?.message ?? err}`);
        }
      },
    },
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
          ? await entry.client.fetchSliceMap(briefId, runId, chosenSheet).catch((err) => ({
              ok: false,
              error: `slice-map fetch failed: ${err?.message ?? err}`,
            }))
          : null;
        return { briefId, runId, candidates, sheets, sheet: chosenSheet, sliceMap };
      },
    },
    {
      name: 'select_run',
      description: 'Change the run/sheet shown on the Runs tab of the canvas iframe.',
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
      name: 'accept_variant',
      description:
        'Approve a generated variant and publish it to the durable asset-checkin queue atomically.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['briefId', 'runId', 'variantIndex'],
        properties: {
          briefId: { type: 'string' },
          runId: { type: 'string' },
          variantIndex: { type: 'integer', minimum: 0 },
        },
      },
      handler: async (ctx) => {
        const { briefId, runId, variantIndex } = ctx.input;
        try {
          return await acceptAndQueue(ctx.instanceId, briefId, runId, variantIndex);
        } catch (error) {
          throw new CanvasError(
            typeof error?.code === 'string' ? error.code : 'accept_failed',
            error?.message ?? String(error),
          );
        }
      },
    },
    {
      name: 'reload',
      description:
        'Recompute the fs backlog + re-probe the sidecar, then push fresh state to the iframe.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        entry.cache = null;
        const state = await buildState(ctx.instanceId);
        await entry.pushState?.(state);
        return { health: state.health, runCount: state.runs?.length ?? 0 };
      },
    },
  ],
  open: async (ctx) => {
    const entry = await ensureServer(ctx);
    return {
      title: 'Sprite Generation Workflow',
      url: entry.url,
      status: `sidecar ${entry.baseUrl}`,
    };
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
log('workflow canvas provider registered');
