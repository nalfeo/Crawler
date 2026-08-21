/**
 * workflow — the Sprite Generation Workflow canvas: inspect the asset backlog,
 * plans/briefs, and generated sprite RUNS (variants + judge + sensors +
 * sheet/slice-map), record per-criterion reviewer feedback, view each
 * variant's accept/integration LIFECYCLE, and accept a selected variant into
 * the durable sprite queue (`assets/queue` branch).
 *
 * This canvas ABSORBED the former standalone `sprite-review` canvas's
 * read-only run/variant-inspection surface (judge/sensor traces, sheet +
 * slice-map viewing, per-criterion feedback) once Workflow reached parity with
 * it and its live behavior was verified — sprite-review has been removed.
 * Functional parity with the `?page=sprite-generation-workflow` DevTool in the
 * monolith (`DEVTOOLS_PAGE_SPRITE_WORKFLOW` in `src/devtools-main.ts`) for the
 * backlog/plans/briefs/runs READ surface. The durable QUEUE + asset-REQUEST
 * manifest's full read/control surface (synthesize / generate / judge / worker
 * & issues start-stop, and the interactive queue state machine) beyond the
 * atomic accept-and-check-in below remains the documented follow-up slice.
 *
 * Mutating routes: `POST /api/accept` (approve + durable check-in, atomic and
 * idempotent — see `scripts/sprites/sidecar/server.ts`) and `POST /api/feedback`
 * (criterion/sheet/brief reviewer feedback — a discriminated union on
 * `subjectType`, persisted to `public/assets/generated/
 * sprite-review-feedback.json` — shared schema/keying with the removed
 * sprite-review canvas). Both are guarded by a per-instance mutation token;
 * feedback additionally checks request Origin + Content-Type (see
 * `../shared/sprite-feedback-request.mjs`). `/api/feedback` intentionally does
 * NOT buildState()+pushState() after a save — see the handler for why.
 *
 * EMBEDDED Postprocess Debugger (`/postprocess/*`): the full standalone
 * `postprocess` canvas document (`../postprocess/renderer.mjs`) is mounted
 * verbatim under this SAME loopback server/origin at `/postprocess/*` —
 * HTML root, `/postprocess/api/state|select|runs`, `/postprocess/api/
 * live-postprocess|persist-postprocess`, `/postprocess/img/*`, and
 * `/postprocess/events` (SSE) — parameterized via `renderHtml(instanceId,
 * basePath, mutationToken)`'s `basePath`. This is ONE Workflow-owned server
 * and ONE sidecar connection (`entry.client`, rebound together with
 * `entry.postprocess.client` on sidecar restart) — no second canvas server,
 * no second `beginSpriteSidecarStartup`. Postprocess keeps its OWN versioned
 * selection substate (`entry.postprocess.{requested,selected,
 * selectionVersion}`) so a stale in-flight build can never clobber a newer
 * selection (see `buildPostprocessState`). `renderer.mjs`'s persistent
 * `#postprocess-host` sibling of `#app` lazily creates ONE iframe on first
 * "Open in Post-process Debugger" click (seeded via the initial URL's query
 * string) and RETARGETS it in place via a same-origin `postMessage`
 * `postprocess:select` bridge on later opens — never a `src` reload, so
 * in-progress editor state survives. `/postprocess/api/persist-postprocess`
 * is additionally guarded by the SAME mutation-token + trusted-origin +
 * JSON-content-type + bounded-body checks as `/api/feedback`/`/api/accept`
 * (`live-postprocess` is a non-persisting preview relay; only its origin is
 * checked). The standalone `postprocess` canvas remains registered
 * unchanged pending parity verification.
 *
 * Architecture (the pattern shared with postprocess/achievements/storage):
 *   - `lib/canvas-harness.mjs`     — GENERIC loopback HTTP server (vendored; single
 *     source of truth is `scripts/canvas-harness/`; do not hand-edit).
 *   - `lib/image-cache.mjs`        — vendored outside-worktree on-disk image cache
 *     (pass-through — the sidecar's `CachingRunStore` is the one authoritative cache).
 *   - `lib/sidecar-client.mjs`     — DOMAIN sidecar adapter (runs + image URL builders).
 *   - `lib/yaml-reader.mjs`        — fs reader for `plans/**` + `briefs/**`.
 *   - `lib/registry-ids.mjs`       — best-effort sprite/item registry id loader.
 *   - `lib/workflow-model.mjs`     — 1:1 port of the monolith's backlog/report logic.
 *   - `lib/variant-lifecycle.mjs`  — per-variant unaccepted/accepted-staged/integrated/unverified.
 *   - `lib/run-view-cache.mjs`     — cache-first / background-revalidate run view.
 *   - `../shared/sprite-feedback-store.mjs` / `sprite-feedback-request.mjs` — feedback
 *     persistence + request guards, shared with the (removed) sprite-review canvas.
 *   - `renderer.mjs`               — the iframe document (state-driven, SSE).
 *   - `extension.mjs` (this)       — wires them together.
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
import { setInterval, clearInterval } from 'node:timers';
import { createCanvas, CanvasError, joinSession } from '@github/copilot-sdk/extension';

import { startCanvasServer } from './lib/canvas-harness.mjs';
import { beginSpriteSidecarStartup } from '../shared/sprite-sidecar-service.mjs';
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
import { computeVariantLifecycle } from './lib/variant-lifecycle.mjs';
import { readJsonBody, tokensMatch } from './lib/mutation-security.mjs';
import {
  addRequest,
  emptyQueue,
  mergeChangedItem,
  normalizeQueue,
  rewindItem,
  selectedItem,
  selectItem,
  toQueueRun,
  updateItem,
} from './lib/authoring-state.mjs';
import {
  createRunViewCache,
  resolveCacheFirstState,
  applyFreshRevalidation,
} from './lib/run-view-cache.mjs';
import {
  buildPostprocessParentPatch,
  parentSelectionMatches,
} from './lib/postprocess-parent-sync.mjs';
import {
  briefFeedback,
  feedbackForRun,
  readFeedback,
  saveFeedback,
  sheetFeedback,
} from '../shared/sprite-feedback-store.mjs';
import {
  isJsonContentType,
  isTrustedMutationOrigin,
  readJsonBody as readFeedbackJsonBody,
} from '../shared/sprite-feedback-request.mjs';
import { renderHtml as renderPostprocessHtml } from '../postprocess/renderer.mjs';
import { resolveActiveSheet } from '../postprocess/lib/run-selection.mjs';
import {
  createPostprocessClient,
  extractAppliedBackgroundTweaks,
  extractAppliedDisabledModules,
  extractAppliedFacing,
  extractAppliedManualAnchor,
  normalizeDisabledModuleIds,
  normalizePersistRequest,
  buildPersistPostprocessPayload,
  padVariant,
  clampTolerance,
  collectVariantIndices,
  DEFAULT_BACKGROUND_TWEAKS,
} from '../postprocess/lib/postprocess-client.mjs';

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

/** Durable per-criterion reviewer feedback, shared with the (removed) sprite-review canvas. */
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
 *   selected: { briefId: string, runId: string, sheet: string | null, briefPath: string | null } | null,
 *   mutationToken: string,
 *   acceptance: Map<string, object>,
 *   unapproval: Map<string, object>,
 *   selectionVersion: number,
 *   revalidatingKeys: Set<string>,
 *   cache: null | {
 *     registryError: string | null,
 *     backlog: object,
 *     promotedRunIds: Set<string>,
 *     files: { plans: object[], briefs: object[], error: string | null },
 *     allowlist: Map<string, { path: string, kind: 'plan' | 'brief' }>,
 *   },
 *   postprocess: {
 *     client: ReturnType<typeof createPostprocessClient>,
 *     requested: { briefId: string | null, runId: string | null, variantIndex: number | null, sheet: string | null },
 *     selected: { briefId: string, runId: string, variantIndex: number, sheet: string | null } | null,
 *     selectionVersion: number,
 *     stateCache: Map<string, object>,
 *     revalidatingKeys: Set<string>,
 *     sseClients: Set<import('node:http').ServerResponse>,
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

/**
 * Cross-instance ("cross-surface") cache of the last successfully-rendered
 * run view, keyed by `${briefId}::${runId}`. See `lib/run-view-cache.mjs` for
 * the full cache-first / background-revalidate contract this backs.
 */
const runViewCache = createRunViewCache();
/** Most recently viewed run's key, used as the cache-first target for an
 * instance that has no explicit requested/selected run yet (a bare open). */
let lastRunKey = null;

function runViewKey(briefId, runId) {
  return briefId && runId ? `${briefId}::${runId}` : null;
}

function invalidateRunView(key) {
  runViewCache.invalidate(key);
}

function acceptanceKey(briefId, runId, variantIndex) {
  return `${briefId}/${runId}/${variantIndex}`;
}

function log(message, level = 'info') {
  try {
    const normalizedLevel = level === 'warn' ? 'warning' : level;
    const result = sessionRef?.log?.(`[workflow] ${message}`, { level: normalizedLevel });
    if (result && typeof result.catch === 'function') void result.catch(() => {});
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
  let manifestApprovals = [];
  try {
    const backlog = loadBacklog({
      repoRoot: entry.workspaceRoot,
      spriteIds: registry.spriteIds,
      itemIds: registry.itemIds,
    });
    promotedRunIds = backlog.promotedRunIds ?? new Set();
    manifestApprovals = backlog.manifestApprovals ?? [];
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
    manifestApprovals,
    files,
    allowlist,
  };
  return entry.cache;
}

/**
 * Live (network-hitting) half of the view model: sidecar health probe, run
 * listing, and (once a target run is resolved) its summary/sheets/slice-map.
 * Deliberately takes `requested`/`priorSelected` SNAPSHOTS rather than reading
 * `entry.requested`/`entry.selected` live — this function may run as a
 * detached BACKGROUND revalidation for an older selection while the
 * foreground instance has since navigated elsewhere, and reading the entry's
 * mutable fields mid-flight (after an `await`) would silently resolve against
 * whatever the user has navigated to by then instead of the target this
 * particular call was actually resolving. Never mutates `entry`.
 * @returns {Promise<{
 *   health: object, runs: object[],
 *   selected: { briefId: string, runId: string, sheet: string | null, briefPath: string | null } | null,
 *   autoSelectedLatest: boolean, sheets: string[], candidates: object[],
 *   sliceMap: object | null, error: string | null,
 * }>}
 */
async function liveBuildState(entry, stat, { requested, priorSelected }) {
  const health = await entry.client.probeHealth();
  if (health.state !== 'up') {
    // Sidecar down/wrong-repo: fs-backed backlog + plan/brief browsing still work;
    // the sidecar-backed Runs tab renders a degrade panel. Preserve the prior
    // selection (rather than clearing it) so a transient sidecar blip doesn't
    // lose the operator's place — once it's back up, the resolution logic below
    // re-validates it against the fresh run list anyway.
    return {
      health,
      runs: [],
      selected: priorSelected ?? null,
      autoSelectedLatest: false,
      sheets: [],
      candidates: [],
      sliceMap: null,
      error: null,
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
  let selected = priorSelected;
  let sheets = [];
  let candidates = [];
  let sliceMap = null;
  let summaryError = null;

  if (runs.length > 0) {
    const findRun = (briefId, runId) =>
      runs.find((run) => run.briefId === briefId && run.runId === runId) ?? null;
    if (selected && !findRun(selected.briefId, selected.runId)) selected = null;
    if (!selected) {
      const requestedRun =
        requested.briefId && requested.runId ? findRun(requested.briefId, requested.runId) : null;
      if (requestedRun) {
        selected = { briefId: requestedRun.briefId, runId: requestedRun.runId, sheet: null };
      } else {
        const latest = runs[0];
        selected = { briefId: latest.briefId, runId: latest.runId, sheet: null };
        autoSelectedLatest = true;
      }
    }

    // The run's exact brief path (repo-relative, e.g. `briefs/draft/x.yaml`),
    // as recorded in the run's own summary.json at generation time. Carried
    // through to `selected.briefPath` so "View Brief" can load THIS run's
    // brief by its exact allowlisted path instead of guessing by basename —
    // a basename-only lookup picks the WRONG file when a draft and a
    // committed brief share a basename (see renderer.mjs's `openBriefModal`).
    let briefPath = null;
    try {
      const summary = await entry.client.fetchRunSummary(selected.briefId, selected.runId);
      candidates = withSkipMessages(normalizeCandidates(summary));
      if (typeof summary?.briefPath === 'string' && summary.briefPath.length > 0) {
        briefPath = summary.briefPath;
      }
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
    selected = { briefId: selected.briefId, runId: selected.runId, sheet: currentSheet, briefPath };
    if (currentSheet) {
      try {
        sliceMap = await entry.client.fetchSliceMap(selected.briefId, selected.runId, currentSheet);
      } catch (err) {
        sliceMap = { ok: false, error: `slice-map fetch failed: ${err?.message ?? err}` };
      }
    }
  } else {
    selected = null;
  }

  return {
    health,
    runs,
    selected,
    autoSelectedLatest,
    sheets,
    candidates,
    sliceMap,
    error: summaryError ?? runsError ?? null,
  };
}

/**
 * Merge the fs-static parts (backlog/files), this instance's acceptance map,
 * and — critically — FRESH per-criterion/sheet/brief feedback + per-variant
 * lifecycle onto a run-view (cached or live). Feedback and lifecycle are
 * recomputed on every call regardless of whether `view` came from the cache or
 * the network: both are cheap local reads (fs feedback JSON, in-memory backlog
 * + acceptance map) with no Azure dependency, so a confirmed feedback edit or a
 * just-completed acceptance is reflected immediately even while the run view
 * itself is stale.
 */
function composeState(entry, stat, view) {
  const backlogReports = stat.backlog?.reports ?? [];
  const manifestApprovals = stat.manifestApprovals ?? [];
  const selected = view.selected ?? null;
  let candidates = view.candidates ?? [];
  let sheetFeedbackValue = null;
  let briefFeedbackValue = null;
  if (selected) {
    const store = readFeedback(FEEDBACK_PATH);
    const feedbackByVariant = feedbackForRun(store, selected.briefId, selected.runId);
    candidates = candidates.map((candidate) => ({
      ...candidate,
      feedback: feedbackByVariant[String(candidate.index)] ?? { sensor: {}, judge: {} },
      lifecycle: computeVariantLifecycle({
        backlogReports,
        manifestApprovals,
        acceptanceEntry: entry.acceptance.get(
          acceptanceKey(selected.briefId, selected.runId, candidate.index),
        ),
        briefId: selected.briefId,
        runId: selected.runId,
        variantIndex: candidate.index,
      }),
    }));
    if (selected.sheet) {
      sheetFeedbackValue = sheetFeedback(store, selected.briefId, selected.runId, selected.sheet);
    }
    briefFeedbackValue = briefFeedback(store, selected.briefId, selected.runId);
  }
  return {
    health: view.health,
    baseUrl: entry.baseUrl,
    backlog: stat.backlog,
    files: stat.files,
    runs: view.runs ?? [],
    selected,
    autoSelectedLatest: view.autoSelectedLatest === true,
    sheets: view.sheets ?? [],
    candidates,
    sliceMap: view.sliceMap ?? null,
    sheetFeedback: sheetFeedbackValue,
    briefFeedback: briefFeedbackValue,
    acceptance: Object.fromEntries(entry.acceptance),
    unapproval: Object.fromEntries(entry.unapproval),
    workflow: entry.workflow?.state ?? emptyQueue(),
    workflowLastRefreshAt: entry.workflow?.lastRefreshAt ?? null,
    workflowError: entry.workflow?.error ?? null,
    sidecarStartup: entry.sidecarStartup,
    stale: view.stale === true,
    error: view.error ?? null,
  };
}

async function hydrateWorkflow(entry, { force = false } = {}) {
  if (entry.workflow.loaded && !force) return entry.workflow.state;
  const remote = await entry.client.getWorkflowState();
  entry.workflow.state = normalizeQueue(remote.state);
  entry.workflow.etag = remote.etag;
  entry.workflow.loaded = true;
  entry.workflow.lastRefreshAt = new Date().toISOString();
  entry.workflow.error = null;
  return entry.workflow.state;
}

/**
 * Persist just the changed item against the newest Azure blob. This prevents one
 * canvas instance from dropping unrelated items written by DevTools or another
 * canvas between its last read and its write.
 */
async function saveWorkflowItem(entry, localState, itemId, changedFields = null, options = {}) {
  let state = localState;
  let targetId = itemId;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const remote = await entry.client.getWorkflowState();
    const remoteState = normalizeQueue(remote.state);
    if (options.create && remoteState.items.some((item) => item.id === targetId)) {
      const created = state.items.find((item) => item.id === targetId);
      if (!created) throw new Error(`Workflow item ${targetId} is missing from local state.`);
      const seq = remoteState.nextSeq;
      targetId = `item-${seq}`;
      const reminted = { ...created, id: targetId, seq };
      state = {
        ...state,
        items: state.items.map((item) => (item.id === created.id ? reminted : item)),
        selectedId: state.selectedId === created.id ? targetId : state.selectedId,
        nextSeq: Math.max(state.nextSeq, seq + 1),
      };
    }
    const merged = mergeChangedItem(remoteState, state, targetId, changedFields, options);
    try {
      const saved = await entry.client.putWorkflowState(merged, remote.etag);
      entry.workflow.state = normalizeQueue(merged);
      entry.workflow.etag = saved.etag;
      entry.workflow.loaded = true;
      entry.workflow.lastRefreshAt = new Date().toISOString();
      entry.workflow.error = null;
      return entry.workflow.state;
    } catch (error) {
      if (error?.code !== 'etag-conflict' || attempt === 2) throw error;
      // The next iteration fetches again and re-applies only this item's patch.
    }
  }
  throw new Error('Unable to save workflow state.');
}

async function replaceWorkflowItem(entry, itemId, updater) {
  await hydrateWorkflow(entry, { force: true });
  const current = entry.workflow.state;
  const item = current.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new CanvasError('item_not_found', 'Workflow item no longer exists.');
  const replacement = typeof updater === 'function' ? updater(item) : updater;
  const changedFields = Object.fromEntries(
    Object.entries(replacement).filter(([key, value]) => !Object.is(value, item[key])),
  );
  const next = updateItem(current, itemId, replacement);
  return saveWorkflowItem(entry, next, itemId, changedFields);
}

async function refreshQueuedWorkflowItems(entry) {
  await hydrateWorkflow(entry, { force: true });
  let state = entry.workflow.state;
  let changed = false;
  for (const item of state.items) {
    if (item.stage !== 'generating' || !item.generationRequestedAt) continue;
    const briefIds = [
      ...new Set([item.kebabName, ...item.candidates.map((candidate) => candidate.id)]),
    ];
    let matched = null;
    for (const briefId of briefIds) {
      matched = await entry.client
        .latestWorkflowRun(briefId, item.generationRequestedAt)
        .catch(() => null);
      if (matched?.briefId && matched?.runId) break;
    }
    if (!matched?.briefId || !matched?.runId) continue;
    const summary = await entry.client.fetchRunSummary(matched.briefId, matched.runId);
    const generatedPatch = {
      stage: 'sheet',
      run: toQueueRun(matched.briefId, matched.runId, normalizeCandidates(summary)),
      generationRequestedAt: null,
      generationStartedAt: null,
      lastError: null,
    };
    state = await saveWorkflowItem(
      entry,
      updateItem(state, item.id, generatedPatch),
      item.id,
      generatedPatch,
    );
    changed = true;
  }
  return { state, changed };
}

function workflowMutationAllowed(req, entry) {
  return tokensMatch(req.headers['x-workflow-mutation-token'], entry.mutationToken);
}

async function workflowMutationRoute({ req, instanceId }, mutate) {
  const entry = instances.get(instanceId);
  if (!entry) return { status: 404, json: { error: 'instance-not-found' } };
  if (!isTrustedMutationOrigin(req, entry))
    return { status: 403, json: { error: 'forbidden-origin' } };
  if (!workflowMutationAllowed(req, entry)) {
    return { status: 403, json: { error: 'forbidden', message: 'Invalid mutation token.' } };
  }
  if (!isJsonContentType(req)) {
    return {
      status: 415,
      json: { error: 'unsupported-media-type', message: 'Content-Type must be application/json.' },
    };
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return {
      status: error?.code === 'body-too-large' ? 413 : 400,
      json: {
        error: error?.code === 'body-too-large' ? 'body-too-large' : 'bad-request',
        message: error?.message ?? String(error),
      },
    };
  }
  try {
    const result = await mutate(entry, body ?? {});
    const state = await forceLiveState(instanceId);
    await entry.pushState?.(state);
    return { json: result };
  } catch (error) {
    return {
      status: Number.isInteger(error?.status) ? error.status : 502,
      json: { error: error?.code ?? 'workflow-failed', message: error?.message ?? String(error) },
    };
  }
}

/**
 * Build the full read view model for one instance. Never throws — every failure
 * is folded into a structured, renderable state (health badge + degrade panels +
 * per-section error strings), mirroring the monolith's graceful-degrade page.
 * Backlog + plan/brief browsing work even when the sidecar is DOWN (fs-only).
 *
 * CACHE-FIRST: when the target run has already been rendered once (in ANY
 * instance/surface — `runViewCache` is module-wide), this returns the
 * last-known-good view synchronously (`stale: true`) with NO awaited network
 * call, and schedules a background revalidation that pushes fresh state via
 * SSE once it completes (see `lib/run-view-cache.mjs`). Only a true cold miss
 * (a target never rendered before) awaits the sidecar.
 *
 * @param {string} instanceId
 * @param {{ explicitSheet?: string | null }} [options] `explicitSheet` is the
 *   raw `sheet` query param from an explicit `/api/select?...&sheet=` request
 *   (same run or not). The shared `runViewCache` is keyed ONLY by
 *   `briefId::runId`, not by sheet, so a run that was already rendered under a
 *   DIFFERENT sheet would otherwise replay that STALE sheet + slice-map via
 *   cache-first and silently clobber the just-requested selection — worse, an
 *   already in-flight background revalidation for the OLD sheet can suppress
 *   a fresh fetch entirely (see `resolveCacheFirstState`'s "concurrent
 *   requests never start a second overlapping live fetch" contract). When
 *   `explicitSheet` is set, this call BYPASSES the cache-first read for the
 *   run-view cache (forces the cold/live path) so the response always
 *   reflects the requested sheet, while still overlaying the shared cache
 *   under the run's own resolved key afterwards for later cache-first reads.
 */
async function buildState(instanceId, { explicitSheet = null } = {}) {
  const entry = instances.get(instanceId);
  if (!entry) return { error: 'instance not found' };
  try {
    await hydrateWorkflow(entry);
  } catch (error) {
    // Keep the existing local queue visible alongside the normal sidecar-degraded
    // view; mutations still surface the Azure error explicitly instead of falling
    // back to a local/noop backend.
    entry.workflow.error = error?.message ?? String(error);
    log(`workflow state unavailable: ${error?.message ?? error}`, 'warn');
  }
  const stat = await getStatic(entry);

  const requestedSnapshot = { briefId: entry.requested.briefId, runId: entry.requested.runId };
  const priorSelectedSnapshot = entry.selected;
  const targetBriefId = requestedSnapshot.briefId ?? priorSelectedSnapshot?.briefId ?? null;
  const targetRunId = requestedSnapshot.runId ?? priorSelectedSnapshot?.runId ?? null;
  const naturalKey = runViewKey(targetBriefId, targetRunId) ?? lastRunKey;
  const isEpochCurrent = runViewCache.captureFence();
  // An explicit sheet request forces the bypass key (null), which makes
  // `resolveCacheFirstState` treat this call as a cold miss: it awaits
  // `liveFetch` unconditionally instead of ever replaying a cached snapshot.
  const key = explicitSheet ? null : naturalKey;
  const versionAtCall = entry.selectionVersion;

  const view = await resolveCacheFirstState({
    cache: runViewCache,
    key,
    liveFetch: () =>
      liveBuildState(entry, stat, {
        requested: requestedSnapshot,
        priorSelected: priorSelectedSnapshot,
      }),
    isCurrent: () => entry.selectionVersion === versionAtCall,
    // `applyFreshRevalidation` (lib/run-view-cache.mjs) re-reads the static
    // half of the view model right before mutating/pushing — NEVER reuse the
    // `stat` snapshot captured when this call started. A background
    // revalidation can complete AFTER a static-mutating action
    // (accept-and-queue, an explicit reload) has already invalidated/rebuilt
    // `entry.cache`, and `isCurrent()` only tracks `selectionVersion` (bumped
    // by run/sheet selection), which accept does NOT bump. Pushing with the
    // stale closed-over `stat` would silently clobber the just-rebuilt
    // post-accept backlog/promotedRunIds/manifestApprovals (and therefore
    // per-variant lifecycle) with the pre-accept snapshot even though this
    // completion is still "current". `getStatic` is cheap when `entry.cache`
    // is already populated (memoised read), so this adds no cost on the
    // common path.
    //
    // The inverse race also matters: `entry.selectionVersion` can change
    // WHILE that re-read is in flight (e.g. a user click selects a different
    // run/sheet). `applyFreshRevalidation` re-checks `isCurrent()` AFTER the
    // re-read and BEFORE mutating `entry.selected` or pushing — if the
    // selection moved on during the await, it is a no-op instead of
    // clobbering the newer selection with this now-superseded completion.
    onFresh: async (fresh) => {
      const freshKey = runViewKey(fresh.selected?.briefId ?? null, fresh.selected?.runId ?? null);
      return applyFreshRevalidation({
        isCurrent: () => entry.selectionVersion === versionAtCall && isEpochCurrent(freshKey),
        getStatic: () => getStatic(entry),
        applyMutation: () => {
          entry.selected = fresh.selected ?? null;
        },
        pushState: (currentStat) => entry.pushState?.(composeState(entry, currentStat, fresh)),
      });
    },
    onRevalidateError: (err) =>
      log(`background run-view revalidate failed: ${err?.message ?? err}`, 'warn'),
    isRevalidating: () => (key ? entry.revalidatingKeys.has(key) : false),
    setRevalidating: (value) => {
      if (!key) return;
      if (value) entry.revalidatingKeys.add(key);
      else entry.revalidatingKeys.delete(key);
    },
    // A bare open with no explicit target reads under `lastRunKey` as a GUESS
    // at "whatever was last viewed", but "auto-select latest" may resolve to a
    // DIFFERENT run — always write the fresh result under ITS OWN resolved
    // key, never under the (possibly unrelated) guessed read key.
    deriveWriteKey: (fresh) =>
      runViewKey(fresh.selected?.briefId ?? null, fresh.selected?.runId ?? null),
    canWrite: (writeKey) => isEpochCurrent(writeKey),
  });

  // Persist the run ACTUALLY resolved by this view as the "last viewed run"
  // pointer, not the (possibly null) natural/guessed read key — a first-ever,
  // no-input bootstrap has `naturalKey === null` (nothing requested/selected
  // yet, and `lastRunKey` itself is still null), so using `naturalKey` here
  // would leave the just-resolved run un-discoverable by the NEXT bare open,
  // forcing it to hit Azure again despite the run now being cached. Falling
  // back to `naturalKey` preserves the previous selection when the sidecar is
  // down and `view.selected` is null.
  const resolvedKey =
    runViewKey(view.selected?.briefId ?? null, view.selected?.runId ?? null) ?? naturalKey;
  if (entry.selectionVersion !== versionAtCall || !isEpochCurrent(resolvedKey)) {
    return buildState(instanceId, { explicitSheet: entry.selected?.sheet ?? null });
  }
  if (resolvedKey) lastRunKey = resolvedKey;
  entry.selected = view.selected ?? null;
  return composeState(entry, stat, view);
}

/**
 * Force a live (network) rebuild, bypassing the cache-first read entirely —
 * used by the explicit Refresh action, which the operator expects to actually
 * re-probe the sidecar rather than replay a snapshot. Updates the cache with
 * the fresh result so subsequent cache-first reads pick it up.
 */
async function forceLiveState(instanceId) {
  const entry = instances.get(instanceId);
  if (!entry) return { error: 'instance not found' };
  entry.selectionVersion += 1;
  const versionAtCall = entry.selectionVersion;
  entry.cache = null;
  const requestedSnapshot = { briefId: entry.requested.briefId, runId: entry.requested.runId };
  const priorSelectedSnapshot = entry.selected;
  const targetKey = runViewKey(
    requestedSnapshot.briefId ?? priorSelectedSnapshot?.briefId ?? null,
    requestedSnapshot.runId ?? priorSelectedSnapshot?.runId ?? null,
  );
  invalidateRunView(targetKey);
  const isEpochCurrent = runViewCache.captureFence();
  const stat = await getStatic(entry);
  const view = await liveBuildState(entry, stat, {
    requested: requestedSnapshot,
    priorSelected: priorSelectedSnapshot,
  });
  const key = runViewKey(view.selected?.briefId ?? null, view.selected?.runId ?? null);
  if (entry.selectionVersion !== versionAtCall || !isEpochCurrent(key)) {
    return buildState(instanceId, { explicitSheet: entry.selected?.sheet ?? null });
  }
  if (key && key !== targetKey) invalidateRunView(key);
  if (key) {
    runViewCache.set(key, view);
    lastRunKey = key;
  }
  entry.selected = view.selected ?? null;
  return composeState(entry, stat, { ...view, stale: false });
}

async function refreshWorkflowAfterPostprocessPersist(instanceId, args, persistedSummary) {
  const entry = instances.get(instanceId);
  if (!entry) return null;
  const key = runViewKey(args.briefId, args.runId);
  invalidateRunView(key);
  if (!parentSelectionMatches(entry.selected, args.briefId, args.runId)) return null;

  entry.selectionVersion += 1;
  let candidates;
  if (persistedSummary && typeof persistedSummary === 'object') {
    candidates = withSkipMessages(normalizeCandidates(persistedSummary));
  } else {
    const state = await forceLiveState(instanceId);
    if (state.error || !parentSelectionMatches(state.selected, args.briefId, args.runId)) {
      return null;
    }
    candidates = state.candidates;
  }
  return buildPostprocessParentPatch({
    briefId: args.briefId,
    runId: args.runId,
    mode: args.mode,
    applyToAll: args.applyToAll,
    variantIndex: args.variantIndex,
    candidates,
  });
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

async function unapproveAndEvict(instanceId, variantId) {
  const entry = instances.get(instanceId);
  if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
  entry.unapproval.set(variantId, { state: 'unapproving' });
  await entry.pushState?.(await buildState(instanceId));
  try {
    const result = await entry.client.unapproveVariant(variantId);
    entry.unapproval.set(variantId, { state: 'evicted', entry: result });
    // Invalidate the run-view cache so the lifecycle pill reflects the removal
    // on the next state build.
    entry.cache = null;
    await entry.pushState?.(await buildState(instanceId));
    return result;
  } catch (error) {
    entry.unapproval.set(variantId, {
      state: 'error',
      code: typeof error?.code === 'string' ? error.code : 'unapprove-failed',
      message: error?.message ?? String(error),
    });
    await entry.pushState?.(await buildState(instanceId));
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Embedded Postprocess Debugger (`/postprocess/*`) — see the module header
// for the architecture summary. `buildPostprocessState` is a 1:1 port of
// `postprocess/extension.mjs`'s own `buildState`, but reads/writes
// `entry.postprocess.*` (this canvas's OWN versioned substate — see rule #5
// in the embed-postprocess plan) and calls through `entry.client` (the SAME
// sidecar connection Workflow's own routes use) rather than a second one.
// ---------------------------------------------------------------------------

/**
 * Build the full Postprocess Debugger view model for one Workflow instance.
 * Never throws — every failure folds into a structured, renderable state,
 * mirroring `postprocess/extension.mjs`'s own `buildState`.
 *
 * Ownership guard (plan requirement #5): `versionAtCall` is captured BEFORE
 * any await; if `entry.postprocess.selectionVersion` moved on by the time the
 * sidecar round-trips resolve (a newer select/persist landed while this call
 * was in flight), the computed view is still returned to ITS OWN caller (the
 * HTTP response that awaited it), but `entry.postprocess.selected` is left
 * alone so this now-stale completion can never overwrite a newer selection.
 */
function postprocessStateKey(selection) {
  if (!selection || typeof selection.briefId !== 'string' || typeof selection.runId !== 'string') {
    return null;
  }
  const variantIndex =
    typeof selection.variantIndex === 'number' && selection.variantIndex >= 0
      ? selection.variantIndex
      : 0;
  const sheet = typeof selection.sheet === 'string' ? selection.sheet : '';
  return `${selection.briefId}::${selection.runId}::${variantIndex}::${sheet}`;
}

async function buildPostprocessState(instanceId, { bypassCache = false } = {}) {
  const entry = instances.get(instanceId);
  if (!entry) return { error: 'instance not found' };
  const pp = entry.postprocess;
  const baseUrl = entry.baseUrl;
  const versionAtCall = pp.selectionVersion;
  const requestedSnapshot = { ...pp.requested };
  const selectedSnapshot = pp.selected ? { ...pp.selected } : null;
  const targetSelection = {
    briefId: requestedSnapshot.briefId ?? selectedSnapshot?.briefId ?? null,
    runId: requestedSnapshot.runId ?? selectedSnapshot?.runId ?? null,
    variantIndex:
      typeof requestedSnapshot.variantIndex === 'number'
        ? requestedSnapshot.variantIndex
        : (selectedSnapshot?.variantIndex ?? 0),
    sheet:
      typeof requestedSnapshot.sheet === 'string'
        ? requestedSnapshot.sheet
        : (selectedSnapshot?.sheet ?? null),
  };
  const targetKey = postprocessStateKey(targetSelection);

  if (!bypassCache && targetKey && pp.stateCache.has(targetKey)) {
    const cached = pp.stateCache.get(targetKey);
    pp.selected = cached.selected
      ? {
          briefId: cached.selected.briefId,
          runId: cached.selected.runId,
          variantIndex: cached.selected.variantIndex,
          sheet: cached.selected.activeSheet,
        }
      : null;
    if (!pp.revalidatingKeys.has(targetKey)) {
      pp.revalidatingKeys.add(targetKey);
      void buildPostprocessState(instanceId, { bypassCache: true })
        .catch((error) => {
          log(`postprocess background revalidate failed: ${error?.message ?? error}`, 'warn');
        })
        .finally(() => {
          pp.revalidatingKeys.delete(targetKey);
        });
    }
    return { ...cached, stale: true };
  }

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
    pp.selected = null;
    return { health, baseUrl, runs: [], selected: null };
  }

  const findRun = (briefId, runId) =>
    runs.find((run) => run.briefId === briefId && run.runId === runId) ?? null;

  let autoSelectedLatest = false;
  let selected = selectedSnapshot;
  if (selected && !findRun(selected.briefId, selected.runId)) {
    selected = null; // previously-selected run vanished (e.g. archived)
  }
  if (!selected) {
    const req = requestedSnapshot;
    const reqRun = req.briefId && req.runId ? findRun(req.briefId, req.runId) : null;
    if (reqRun) {
      selected = {
        briefId: reqRun.briefId,
        runId: reqRun.runId,
        variantIndex: typeof req.variantIndex === 'number' ? req.variantIndex : 0,
        sheet: typeof req.sheet === 'string' ? req.sheet : null,
      };
    } else {
      const latest = runs[0];
      selected = { briefId: latest.briefId, runId: latest.runId, variantIndex: 0, sheet: null };
      autoSelectedLatest = true;
    }
  }

  let variantIndices = [];
  let briefPath = null;
  let appliedBackground = null;
  let appliedDisabledModules = [];
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
    appliedDisabledModules = extractAppliedDisabledModules(summary);
    appliedFacing = extractAppliedFacing(summary);
    appliedManualAnchor = extractAppliedManualAnchor(summary);
  } catch (err) {
    summaryError = `Failed to load run summary: ${err?.message ?? err}`;
  }

  if (variantIndices.length > 0 && !variantIndices.includes(selected.variantIndex)) {
    selected.variantIndex = variantIndices[0];
  }
  const padded = padVariant(selected.variantIndex);

  const manifest = await pp.client.fetchPipelineManifest(selected.briefId, selected.runId, padded);

  let sheetRunId = selected.runId;
  let sheets = [];
  try {
    sheets = await entry.client.fetchSheets(selected.briefId, selected.runId);
  } catch (err) {
    log(
      `postprocess fetchSheets failed for ${selected.briefId}/${selected.runId}: ${err?.message ?? err}`,
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
        `postprocess fetchSheets (sourceRun) failed for ${selected.briefId}/${sheetRunId}: ${err?.message ?? err}`,
        'warn',
      );
      sheets = [];
    }
  }
  const activeSheet = resolveActiveSheet(sheets, selected.sheet, sheets[sheets.length - 1] ?? null);

  let sliceMap = null;
  if (activeSheet) {
    try {
      sliceMap = await entry.client.fetchSliceMap(selected.briefId, sheetRunId, activeSheet);
    } catch (err) {
      sliceMap = { ok: false, error: `slice-map fetch failed: ${err?.message ?? err}` };
    }
  }

  // Ownership guard: only commit the resolved selection if nothing newer
  // (another select/persist) has landed while the above awaits were in flight.
  if (pp.selectionVersion === versionAtCall) {
    pp.selected = {
      briefId: selected.briefId,
      runId: selected.runId,
      variantIndex: selected.variantIndex,
      sheet: activeSheet,
    };
  }

  const state = {
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
      appliedDisabledModules,
      appliedFacing,
      appliedManualAnchor,
    },
  };
  const resolvedKey = postprocessStateKey({
    briefId: state.selected.briefId,
    runId: state.selected.runId,
    variantIndex: state.selected.variantIndex,
    sheet: state.selected.activeSheet,
  });
  if (targetKey) pp.stateCache.set(targetKey, state);
  if (resolvedKey) pp.stateCache.set(resolvedKey, state);
  return state;
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
        // A newer selection supersedes any in-flight background revalidation
        // for the PREVIOUS target — bumping the version means that stale
        // completion's `isCurrent()` check will fail and it will be dropped
        // instead of clobbering this (possibly cache-first, possibly live) read.
        entry.selectionVersion += 1;
      } else if (sheet && entry.selected) {
        entry.selected = { ...entry.selected, sheet };
        entry.selectionVersion += 1;
      }
      // `sheet` (when present) is an EXPLICIT request — see buildState()'s
      // `explicitSheet` option doc for why this must bypass the run-view
      // cache-first read rather than risk replaying a stale cached sheet.
      const state = await buildState(instanceId, { explicitSheet: sheet || null });
      await entry.pushState?.(state);
      return { json: state };
    },
  },
  {
    method: 'POST',
    path: '/api/feedback',
    handler: async ({ req, instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) return { status: 404, json: { error: 'instance not found' } };
      if (!isTrustedMutationOrigin(req, entry)) {
        return { status: 403, json: { error: 'forbidden-origin' } };
      }
      if (!tokensMatch(req.headers['x-workflow-mutation-token'], entry.mutationToken)) {
        return { status: 403, json: { error: 'forbidden', message: 'Invalid mutation token.' } };
      }
      if (!isJsonContentType(req)) {
        return {
          status: 415,
          json: {
            error: 'unsupported-media-type',
            message: 'Content-Type must be application/json.',
          },
        };
      }
      let payload;
      try {
        payload = await readFeedbackJsonBody(req);
      } catch (error) {
        if (error?.code === 'body-too-large') {
          return {
            status: 413,
            json: { error: 'body-too-large', message: 'Feedback payload exceeds 16 KiB.' },
          };
        }
        if (error?.code === 'invalid-json') {
          return {
            status: 400,
            json: { error: 'bad-request', message: 'Feedback payload must be valid JSON.' },
          };
        }
        throw error;
      }
      let feedback;
      try {
        feedback = saveFeedback(FEEDBACK_PATH, payload);
      } catch (error) {
        if (error?.code === 'invalid-feedback') {
          return {
            status: 400,
            json: { error: 'bad-request', message: error.message },
          };
        }
        throw error;
      }
      // HARD GATE (ADR: cache-first sheet load must never regress): do NOT
      // buildState()+pushState() here. A full state rebuild would broadcast a
      // brand-new `state` over THIS SAME instance's own SSE connection, whose
      // `render(state)` handler does a full `app.replaceChildren(...)` —
      // recreating the sheet `<img>` (and its loading spinner) on every single
      // criterion/sheet/brief confirm. The response body IS the patch: the
      // calling widget already applies it to its own local draft (see
      // `renderCriterionFeedback`/sheet/brief confirm handlers in
      // renderer.mjs) without any re-render. Other open instances simply pick
      // up the fresh value on their next natural rebuild (select/reload/
      // reconnect) — feedback is read fresh from disk on every buildState call
      // regardless, so no server-side cache goes stale.
      return { json: { feedback } };
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
    method: 'POST',
    path: '/api/unapprove',
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
      const { variantId } = body;
      if (typeof variantId !== 'string' || variantId.length === 0 || /[/\\]/.test(variantId)) {
        return {
          status: 400,
          json: {
            error: 'bad-request',
            message: 'variantId must be a non-empty string with no path separators.',
          },
        };
      }
      try {
        return { json: await unapproveAndEvict(instanceId, variantId) };
      } catch (error) {
        return {
          status: Number.isInteger(error?.status) ? error.status : 502,
          json: {
            error: typeof error?.code === 'string' ? error.code : 'unapprove-failed',
            message: error?.message ?? String(error),
          },
        };
      }
    },
  },
  {
    // Explicit reload: invalidate the fs-static cache, force a LIVE (non
    // cache-first) rebuild, then push. The operator clicking Refresh expects an
    // actual re-probe, not a replayed snapshot.
    method: 'GET',
    path: '/api/reload',
    handler: async ({ instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) return { status: 404, json: { error: 'instance not found' } };
      const state = await forceLiveState(instanceId);
      await entry.pushState?.(state);
      return { json: state };
    },
  },
  fileContentRoute('/api/plan', 'plan'),
  fileContentRoute('/api/brief', 'brief'),

  // ---- Embedded Postprocess Debugger (`/postprocess/*`) ------------------
  // See the module header + `buildPostprocessState` for the architecture.
  {
    // HTML root. Query params (briefId/runId/variantIndex/sheet) seed
    // `entry.postprocess.requested/selected` BEFORE the document is returned,
    // so the client's very first `/postprocess/api/state` fetch already
    // resolves the exact handoff context — no extra select round-trip. Writes
    // directly via `res` (text/html, not the harness's JSON envelope).
    method: 'GET',
    path: '/postprocess/',
    handler: async ({ url, res, instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) return { status: 404, json: { error: 'instance not found' } };
      const pp = entry.postprocess;
      const qBriefId = url.searchParams.get('briefId');
      const qRunId = url.searchParams.get('runId');
      const qVariantRaw = url.searchParams.get('variantIndex');
      const qVariant =
        qVariantRaw != null && qVariantRaw !== '' && Number.isFinite(Number(qVariantRaw))
          ? Number(qVariantRaw)
          : null;
      const qSheet = url.searchParams.get('sheet');
      if (qBriefId && qRunId) {
        const changedRun =
          !pp.selected || pp.selected.briefId !== qBriefId || pp.selected.runId !== qRunId;
        pp.requested = { briefId: qBriefId, runId: qRunId, variantIndex: qVariant, sheet: qSheet };
        pp.selected = {
          briefId: qBriefId,
          runId: qRunId,
          variantIndex: qVariant ?? (changedRun ? 0 : (pp.selected?.variantIndex ?? 0)),
          sheet: qSheet ?? (changedRun ? null : (pp.selected?.sheet ?? null)),
        };
        pp.selectionVersion += 1;
      }
      const html = renderPostprocessHtml(instanceId, '/postprocess', entry.mutationToken);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return undefined;
    },
  },
  {
    method: 'GET',
    path: '/postprocess/api/state',
    handler: async ({ instanceId }) => ({ json: await buildPostprocessState(instanceId) }),
  },
  {
    method: 'GET',
    path: '/postprocess/api/select',
    handler: async ({ url, instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) return { status: 404, json: { error: 'instance not found' } };
      const pp = entry.postprocess;
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
          !pp.selected || pp.selected.briefId !== briefId || pp.selected.runId !== runId;
        pp.requested = {
          briefId,
          runId,
          variantIndex: variant ?? (changedRun ? null : (pp.requested?.variantIndex ?? null)),
        };
        pp.selected = {
          briefId,
          runId,
          variantIndex: variant ?? (changedRun ? 0 : (pp.selected?.variantIndex ?? 0)),
          sheet: sheet ?? (changedRun ? null : (pp.selected?.sheet ?? null)),
        };
      } else if (pp.selected) {
        if (variant != null) pp.selected = { ...pp.selected, variantIndex: variant };
        if (sheet) pp.selected = { ...pp.selected, sheet };
      }
      // A newer selection supersedes any in-flight background build for the
      // PREVIOUS target — see buildPostprocessState's ownership guard.
      pp.selectionVersion += 1;
      // The in-iframe client renders this fetch response directly — do NOT
      // also broadcast over `/postprocess/events` (a double delivery would
      // re-render and fire a duplicate live-postprocess relay), matching the
      // standalone canvas's own `/api/select` route.
      return { json: await buildPostprocessState(instanceId) };
    },
  },
  {
    method: 'GET',
    path: '/postprocess/api/runs',
    handler: async ({ instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) return { status: 404, json: { error: 'instance not found' } };
      return { json: { runs: await entry.client.listRuns() } };
    },
  },
  {
    // Non-persisting preview relay. Only the trusted-origin check applies —
    // no mutation token (nothing is written), matching the standalone canvas.
    method: 'POST',
    path: '/postprocess/api/live-postprocess',
    handler: async ({ req, instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) {
        return {
          status: 404,
          json: { ok: false, reason: 'not-open', message: 'instance not found' },
        };
      }
      if (!isTrustedMutationOrigin(req, entry)) {
        return {
          status: 403,
          json: { ok: false, reason: 'forbidden-origin', message: 'forbidden' },
        };
      }
      let body;
      try {
        // Payload carries a base64 raw PNG crop — needs a larger bound than
        // the 16 KiB default (matches the standalone canvas's 8 MiB limit).
        body = await readJsonBody(req, 8 * 1024 * 1024);
      } catch (error) {
        const tooLarge =
          error?.statusCode === 413 ||
          error?.code === 'body-too-large' ||
          error?.message === 'request body too large';
        return {
          status: tooLarge ? 413 : 400,
          json: {
            ok: false,
            reason: tooLarge ? 'body-too-large' : 'bad-request',
            message: error?.message ?? String(error),
          },
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
      const disabledModules = normalizeDisabledModuleIds(body.disabledModules);
      if (disabledModules === null) {
        return {
          status: 400,
          json: {
            ok: false,
            reason: 'bad-request',
            message: 'disabledModules must contain only canonical module IDs',
          },
        };
      }
      const result = await entry.postprocess.client.relayLivePostprocess({
        briefId,
        runId,
        rawPngBase64,
        options: {
          background: { colorToleranceSq, fringeToleranceSq },
          disabledModules,
        },
      });
      return { json: result };
    },
  },
  {
    // The one WRITING postprocess route — guarded exactly like `/api/feedback`
    // / `/api/accept`: trusted origin, the Workflow mutation token, a strict
    // JSON content-type, and a bounded body (plan requirement #6).
    method: 'POST',
    path: '/postprocess/api/persist-postprocess',
    handler: async ({ req, instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) {
        return {
          status: 404,
          json: { ok: false, reason: 'not-open', message: 'instance not found' },
        };
      }
      if (!isTrustedMutationOrigin(req, entry)) {
        return {
          status: 403,
          json: { ok: false, reason: 'forbidden-origin', message: 'forbidden' },
        };
      }
      if (!tokensMatch(req.headers['x-workflow-mutation-token'], entry.mutationToken)) {
        return {
          status: 403,
          json: { ok: false, reason: 'forbidden', message: 'Invalid mutation token.' },
        };
      }
      if (!isJsonContentType(req)) {
        return {
          status: 415,
          json: {
            ok: false,
            reason: 'unsupported-media-type',
            message: 'Content-Type must be application/json.',
          },
        };
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const tooLarge = error?.statusCode === 413 || error?.code === 'body-too-large';
        return {
          status: tooLarge ? 413 : 400,
          json: {
            ok: false,
            reason: tooLarge ? 'body-too-large' : 'bad-request',
            message: error?.message ?? String(error),
          },
        };
      }
      // NEVER trust the client: validate + rebuild the payload server-side.
      const normalized = normalizePersistRequest(body);
      if (!normalized.ok) {
        return {
          status: 400,
          json: { ok: false, reason: 'bad-request', message: normalized.error },
        };
      }
      const payload = buildPersistPostprocessPayload(normalized.args);
      const result = await entry.postprocess.client.relayPersistPostprocess({
        briefId: normalized.args.briefId,
        runId: normalized.args.runId,
        payload,
      });
      if (!result.ok) return { json: result };
      const pp = entry.postprocess;
      pp.stateCache.clear();
      const changedRun =
        !pp.selected ||
        pp.selected.briefId !== normalized.args.briefId ||
        pp.selected.runId !== normalized.args.runId;
      const targetVariant =
        normalized.args.mode === 'replace'
          ? normalized.args.variantIndex
          : (pp.selected?.variantIndex ?? 0);
      pp.requested = {
        briefId: normalized.args.briefId,
        runId: normalized.args.runId,
        variantIndex: targetVariant,
      };
      pp.selected = {
        briefId: normalized.args.briefId,
        runId: normalized.args.runId,
        variantIndex: targetVariant,
        sheet: changedRun ? null : (pp.selected?.sheet ?? null),
      };
      pp.selectionVersion += 1;
      const workflowPatch = await refreshWorkflowAfterPostprocessPersist(
        instanceId,
        normalized.args,
        result.summary,
      );
      return {
        json: {
          ok: true,
          state: await buildPostprocessState(instanceId),
          workflowPatch,
        },
      };
    },
  },
  {
    // SSE, scoped to this instance's OWN postprocess sub-state — kept
    // separate from the harness's built-in `/events` (which broadcasts
    // Workflow's own `buildState()`). Writes directly via `res` and never
    // ends the response, so `runJsonRoute`'s `res.headersSent` check leaves
    // the connection open (the same pattern `canvas-harness.mjs`'s own
    // `/events` uses). Only the initial connect frame is ever sent here —
    // `/postprocess/api/select` and a successful persist intentionally do NOT
    // also broadcast (the fetch response IS the update; see those handlers).
    method: 'GET',
    path: '/postprocess/events',
    handler: async ({ req, res, instanceId }) => {
      const entry = instances.get(instanceId);
      if (!entry) return { status: 404, json: { error: 'instance not found' } };
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      const initial = await buildPostprocessState(instanceId);
      res.write(`data: ${JSON.stringify({ type: 'state', state: initial })}\n\n`);
      entry.postprocess.sseClients.add(res);
      const heartbeat = setInterval(() => {
        try {
          res.write(': heartbeat\n\n');
        } catch {
          clearInterval(heartbeat);
          entry.postprocess.sseClients.delete(res);
        }
      }, 25000);
      heartbeat.unref?.();
      req.on('close', () => {
        clearInterval(heartbeat);
        entry.postprocess.sseClients.delete(res);
      });
      return undefined;
    },
  },
  {
    method: 'POST',
    path: '/api/workflow/refresh',
    handler: (context) =>
      workflowMutationRoute(context, async (entry) => {
        await refreshQueuedWorkflowItems(entry);
        return { workflow: entry.workflow.state, refreshedAt: entry.workflow.lastRefreshAt };
      }),
  },
  {
    method: 'POST',
    path: '/api/workflow/request',
    handler: (context) =>
      workflowMutationRoute(context, async (entry, body) => {
        await hydrateWorkflow(entry, { force: true });
        const added = addRequest(entry.workflow.state, body);
        await saveWorkflowItem(entry, added.state, added.item.id, null, {
          select: true,
          create: true,
        });
        return { workflow: entry.workflow.state, item: selectedItem(entry.workflow.state) };
      }),
  },
  {
    method: 'POST',
    path: '/api/workflow/select',
    handler: (context) =>
      workflowMutationRoute(context, async (entry, body) => {
        if (typeof body.itemId !== 'string')
          throw new CanvasError('bad-request', 'itemId is required.');
        await hydrateWorkflow(entry, { force: true });
        const next = selectItem(entry.workflow.state, body.itemId);
        entry.workflow.state = await saveWorkflowItem(entry, next, null, null, { select: true });
        return { workflow: entry.workflow.state, item: selectedItem(entry.workflow.state) };
      }),
  },
  {
    method: 'POST',
    path: '/api/workflow/synthesize',
    handler: (context) =>
      workflowMutationRoute(context, async (entry, body) => {
        if (typeof body.itemId !== 'string')
          throw new CanvasError('bad-request', 'itemId is required.');
        await replaceWorkflowItem(entry, body.itemId, { stage: 'synthesizing', lastError: null });
        const item = entry.workflow.state.items.find((candidate) => candidate.id === body.itemId);
        try {
          const result = await entry.client.synthesizeWorkflow({
            name: item.name,
            brief: item.brief,
            type: item.requestedType === 'auto' ? undefined : item.requestedType,
            sizeVariant: item.sizeVariant,
            candidates: body.candidates,
            floor: body.floor,
          });
          const candidates = Array.isArray(result?.written) ? result.written : [];
          await replaceWorkflowItem(entry, body.itemId, {
            stage: 'candidates',
            resolvedType: typeof result?.type === 'string' ? result.type : item.resolvedType,
            candidates,
            chosenCandidatePath: candidates[0]?.yamlPath ?? null,
            lastError: null,
          });
        } catch (error) {
          await replaceWorkflowItem(entry, body.itemId, {
            stage: 'draft',
            lastError: error?.message ?? String(error),
          });
          throw error;
        }
        return { workflow: entry.workflow.state, item: selectedItem(entry.workflow.state) };
      }),
  },
  {
    method: 'POST',
    path: '/api/workflow/brief',
    handler: (context) =>
      workflowMutationRoute(context, async (entry, body) => {
        if (
          typeof body.itemId !== 'string' ||
          typeof body.yamlPath !== 'string' ||
          typeof body.yaml !== 'string'
        ) {
          throw new CanvasError('bad-request', 'itemId, yamlPath, and yaml are required.');
        }
        const saved = await entry.client.saveWorkflowBrief(body.yamlPath, body.yaml);
        await replaceWorkflowItem(entry, body.itemId, (item) => ({
          candidates: item.candidates.map((candidate) =>
            candidate.yamlPath === body.yamlPath
              ? {
                  ...candidate,
                  yaml: saved.yaml ?? body.yaml,
                  description: saved.description ?? candidate.description,
                }
              : candidate,
          ),
          chosenCandidatePath: body.choose === true ? body.yamlPath : item.chosenCandidatePath,
          lastError: null,
        }));
        return { workflow: entry.workflow.state, item: selectedItem(entry.workflow.state) };
      }),
  },
  {
    method: 'POST',
    path: '/api/workflow/generate',
    handler: (context) =>
      workflowMutationRoute(context, async (entry, body) => {
        if (typeof body.itemId !== 'string')
          throw new CanvasError('bad-request', 'itemId is required.');
        await hydrateWorkflow(entry, { force: true });
        let item = entry.workflow.state.items.find((candidate) => candidate.id === body.itemId);
        if (!item) throw new CanvasError('item-not-found', 'Workflow item no longer exists.');
        const selectedPath =
          typeof body.yamlPath === 'string'
            ? body.yamlPath
            : (item.chosenCandidatePath ?? item.candidates[0]?.yamlPath);
        if (!selectedPath)
          throw new CanvasError('missing-brief', 'Choose a synthesized brief before generation.');
        let briefPath = item.briefPath;
        if (!briefPath) {
          const promoted = await entry.client.promoteWorkflowBrief(
            selectedPath,
            item.resolvedType ?? item.requestedType,
            item.kebabName,
          );
          briefPath = promoted.briefPath;
        }
        const result = await entry.client.generateWorkflow(briefPath);
        const patch = {
          briefPath,
          chosenCandidatePath: selectedPath,
          stage: result.status === 'queued' ? 'generating' : 'sheet',
          generationRequestedAt: result.requestedAt ?? null,
          generationStartedAt: result.status === 'queued' ? (result.requestedAt ?? null) : null,
          run:
            result.status === 'completed' && result.briefId && result.runId
              ? toQueueRun(result.briefId, result.runId, normalizeCandidates(result.summary))
              : item.run,
          lastError: null,
        };
        await replaceWorkflowItem(entry, body.itemId, patch);
        if (patch.run) {
          entry.requested = { briefId: patch.run.briefId, runId: patch.run.runId };
          entry.selected = { briefId: patch.run.briefId, runId: patch.run.runId, sheet: null };
          entry.selectionVersion += 1;
        }
        return {
          workflow: entry.workflow.state,
          item: selectedItem(entry.workflow.state),
          generation: result,
        };
      }),
  },
  {
    method: 'POST',
    path: '/api/workflow/postprocess',
    handler: (context) =>
      workflowMutationRoute(context, async (entry, body) => {
        if (typeof body.itemId !== 'string')
          throw new CanvasError('bad-request', 'itemId is required.');
        await hydrateWorkflow(entry, { force: true });
        const item = entry.workflow.state.items.find((candidate) => candidate.id === body.itemId);
        if (!item?.run)
          throw new CanvasError(
            'missing-run',
            'A generated sheet is required before post-processing.',
          );
        await replaceWorkflowItem(entry, item.id, { stage: 'postprocessing', lastError: null });
        try {
          const result = await entry.client.postprocessRun(item.run.briefId, item.run.runId);
          const summary =
            result?.summary ??
            (await entry.client.fetchRunSummary(item.run.briefId, item.run.runId));
          await replaceWorkflowItem(entry, item.id, {
            stage: 'postprocessed',
            run: toQueueRun(item.run.briefId, item.run.runId, normalizeCandidates(summary)),
            lastError: null,
          });
        } catch (error) {
          await replaceWorkflowItem(entry, item.id, {
            stage: 'sheet',
            lastError: error?.message ?? String(error),
          });
          throw error;
        }
        return { workflow: entry.workflow.state, item: selectedItem(entry.workflow.state) };
      }),
  },
  {
    method: 'POST',
    path: '/api/workflow/judge',
    handler: (context) =>
      workflowMutationRoute(context, async (entry, body) => {
        if (typeof body.itemId !== 'string')
          throw new CanvasError('bad-request', 'itemId is required.');
        await hydrateWorkflow(entry, { force: true });
        const item = entry.workflow.state.items.find((candidate) => candidate.id === body.itemId);
        if (!item?.run)
          throw new CanvasError('missing-run', 'A processed sheet is required before judging.');
        await replaceWorkflowItem(entry, item.id, { stage: 'judging', lastError: null });
        try {
          const result = await entry.client.judgeRun(item.run.briefId, item.run.runId);
          const summary =
            result?.summary ??
            (await entry.client.fetchRunSummary(item.run.briefId, item.run.runId));
          await replaceWorkflowItem(entry, item.id, {
            stage: 'variants',
            run: toQueueRun(item.run.briefId, item.run.runId, normalizeCandidates(summary)),
            lastError: null,
          });
        } catch (error) {
          await replaceWorkflowItem(entry, item.id, {
            stage: 'postprocessed',
            lastError: error?.message ?? String(error),
          });
          throw error;
        }
        return { workflow: entry.workflow.state, item: selectedItem(entry.workflow.state) };
      }),
  },
  {
    method: 'POST',
    path: '/api/workflow/approve',
    handler: (context) =>
      workflowMutationRoute(context, async (entry, body) => {
        if (typeof body.itemId !== 'string' || !Number.isInteger(body.variantIndex)) {
          throw new CanvasError('bad-request', 'itemId and variantIndex are required.');
        }
        await hydrateWorkflow(entry, { force: true });
        const item = entry.workflow.state.items.find((candidate) => candidate.id === body.itemId);
        if (!item?.run)
          throw new CanvasError('missing-run', 'A judged run is required before approval.');
        const result = await acceptAndQueue(
          entry.instanceId,
          item.run.briefId,
          item.run.runId,
          body.variantIndex,
        );
        await replaceWorkflowItem(entry, item.id, {
          stage: 'checked-in',
          approvalSummary: `Approved variant ${body.variantIndex}; queued durably on assets/queue.`,
          queueDurability: 'ok',
          lastError: null,
        });
        return {
          workflow: entry.workflow.state,
          item: selectedItem(entry.workflow.state),
          approval: result,
        };
      }),
  },
  {
    method: 'POST',
    path: '/api/workflow/rewind',
    handler: (context) =>
      workflowMutationRoute(context, async (entry, body) => {
        if (
          typeof body.itemId !== 'string' ||
          !['brief', 'sheet', 'postprocess'].includes(body.target)
        ) {
          throw new CanvasError('bad-request', 'itemId and a valid rewind target are required.');
        }
        await hydrateWorkflow(entry, { force: true });
        const item = entry.workflow.state.items.find((candidate) => candidate.id === body.itemId);
        if (!item) throw new CanvasError('item-not-found', 'Workflow item no longer exists.');
        await replaceWorkflowItem(entry, item.id, rewindItem(item, body.target));
        return { workflow: entry.workflow.state, item: selectedItem(entry.workflow.state) };
      }),
  },
];

const binaryRoutes = [
  imageRoute('/img/sheet', 'sheet'),
  imageRoute('/img/processed', 'processed'),
  imageRoute('/img/raw', 'raw'),
  // Same handler, reused verbatim under the embedded namespace — same
  // `entry.client` + shared `imageCache`, no second cache/connection.
  imageRoute('/postprocess/img/sheet', 'sheet'),
  imageRoute('/postprocess/img/processed', 'processed'),
  imageRoute('/postprocess/img/raw', 'raw'),
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
    instanceId: ctx.instanceId,
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
    workflow: {
      state: emptyQueue(),
      etag: null,
      loaded: false,
      lastRefreshAt: null,
      error: null,
    },
    workflowPoll: null,
    acceptance: new Map(),
    unapproval: new Map(),
    selectionVersion: 0,
    revalidatingKeys: new Set(),
    cache: null,
    postprocess: {
      client: createPostprocessClient({ sidecarClient: client }),
      requested: { briefId: null, runId: null, variantIndex: null, sheet: null },
      selected: null,
      selectionVersion: 0,
      stateCache: new Map(),
      revalidatingKeys: new Set(),
      sseClients: new Set(),
    },
    sidecarStartup: { state: 'starting', error: null, logPath: null },
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
  entry.workflowPoll = setInterval(() => {
    refreshQueuedWorkflowItems(entry)
      .then(({ changed }) => (changed ? forceLiveState(ctx.instanceId) : null))
      .then((state) => (state ? entry.pushState(state) : null))
      .catch((error) => log(`workflow Azure refresh failed: ${error?.message ?? error}`, 'warn'));
  }, 10_000);
  entry.workflowPoll.unref?.();
  beginSpriteSidecarStartup(entry, {
    rebindClients: (url) => {
      entry.client = createSidecarClient({ baseUrl: url, workspaceRoot });
      // The embedded Postprocess client composes `entry.client` — rebuild it
      // alongside so it never holds a stale closed-over sidecar client after
      // a restart (ONE sidecar startup/rebind owner for both surfaces).
      entry.postprocess.client = createPostprocessClient({ sidecarClient: entry.client });
    },
  });
  log(`serving instance ${ctx.instanceId} at ${server.url} (sidecar ${baseUrl})`);
  return entry;
}

const canvas = createCanvas({
  id: 'workflow',
  displayName: 'Sprite Generation Workflow',
  description:
    'Inspect the sprite-generation workflow, review judge/sensor traces and record per-criterion feedback, see each variant\u2019s accept/integration lifecycle, and accept a selected run variant into the durable sprite queue (`assets/queue` branch).',
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
        entry.selectionVersion += 1;
        // Thread `sheet` through exactly like the HTTP `/api/select` route:
        // an explicit sheet on the SAME run must bypass the run-view
        // cache-first read (see buildState()'s `explicitSheet` option doc),
        // otherwise this action-path selection can replay an unrelated
        // cached sheet/slice-map for the run instead of the one requested.
        const state = await buildState(ctx.instanceId, { explicitSheet: sheet || null });
        await entry.pushState?.(state);
        return { selected: state.selected, runCount: state.runs?.length ?? 0 };
      },
    },
    {
      name: 'accept_variant',
      description:
        'Approve a generated variant and publish it to the durable sprite queue (`assets/queue` branch) atomically.',
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
      name: 'unapprove_variant',
      description:
        'Evict a previously approved variant: removes its manifest entry, catalog entry, and generated PNG. Use variantId in the form `<briefId>-var-<variantIndex>` (e.g. `goblin-archer-var-0`).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['variantId'],
        properties: {
          variantId: { type: 'string', description: 'Variant ID, e.g. goblin-archer-var-0' },
        },
      },
      handler: async (ctx) => {
        const { variantId } = ctx.input;
        try {
          return await unapproveAndEvict(ctx.instanceId, variantId);
        } catch (error) {
          throw new CanvasError(
            typeof error?.code === 'string' ? error.code : 'unapprove_failed',
            error?.message ?? String(error),
          );
        }
      },
    },
    {
      name: 'reload',
      description:
        'Recompute the fs backlog, refresh durable Azure workflow state, and push fresh state to the iframe.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        await refreshQueuedWorkflowItems(entry);
        const state = await forceLiveState(ctx.instanceId);
        await entry.pushState?.(state);
        return { health: state.health, runCount: state.runs?.length ?? 0 };
      },
    },
    {
      name: 'get_workflow',
      description:
        'Read the complete durable Azure workflow queue, including authoring and completed phases.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        return hydrateWorkflow(entry, { force: true });
      },
    },
    {
      name: 'refresh_workflow',
      description:
        'Immediately refresh externally completed Azure generation work and push the Author tab state.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) throw new CanvasError('not_open', 'Canvas instance is not open.');
        await refreshQueuedWorkflowItems(entry);
        const state = await forceLiveState(ctx.instanceId);
        await entry.pushState(state);
        return { workflow: entry.workflow.state, refreshedAt: entry.workflow.lastRefreshAt };
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
    if (entry.workflowPoll) clearInterval(entry.workflowPoll);
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
