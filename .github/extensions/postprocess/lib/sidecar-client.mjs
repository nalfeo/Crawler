/**
 * sidecar-client.mjs — DOMAIN adapter for the sprite pipeline sidecar.
 *
 * This is the sprite-specific layer that sits on top of the generic
 * `canvas-harness.mjs`. It is a faithful node port of the browser sidecar client
 * the DevTools monolith uses (`src/devtools/sprite-approval-api.ts` +
 * `src/devtools/sprite-workflow-queue.ts` + the `toJudgeSummary`/`toSensorResults`
 * normalizers in `src/devtools-main.ts`). Slices B–E that also talk to the sprite
 * sidecar copy this file verbatim; tools that don't touch the sidecar omit it.
 *
 * Everything here is dependency-injectable (`fetchImpl`) and side-effect-free
 * except the network calls, so the whole module is unit-testable with a fake
 * fetch and no live sidecar.
 *
 * @module sprite-review/sidecar-client
 */

import {
  getSessionServerPorts,
  normalizeWorkspaceKey,
} from '../../../../scripts/shared/session-server-ports.js';

/**
 * Legacy fixed port the monolith falls back to when no per-worktree port can be
 * derived. Mirrors `LEGACY_SPRITE_SIDECAR_FALLBACK` in
 * `src/shared/session-server-env.ts`. In practice `npm run sprites:gallery` binds
 * the sidecar to the deterministic per-worktree port from `getSessionServerPorts`,
 * so this only ever applies if that derivation throws.
 */
export const LEGACY_SIDECAR_FALLBACK = 'http://127.0.0.1:3010';

/** Strip a single trailing slash so URL joins never double up. */
function trimTrailingSlash(url) {
  return typeof url === 'string' && url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Resolve the sidecar base URL for a node context, mirroring the monolith's
 * precedence but computing the per-worktree port directly (the browser build
 * gets it injected at build time via Vite; node has no such injection):
 *   1. `VITE_SPRITES_SIDECAR_BASE_URL` (explicit override — highest precedence)
 *   2. `getSessionServerPorts({ cwd: workspacePath, env }).sidecarBaseUrl`
 *      (deterministic per-worktree port; also folds in `SPRITES_SIDECAR_PORT`)
 *   3. legacy `http://127.0.0.1:3010`
 *
 * @param {{ workspacePath?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {string}
 */
export function resolveSidecarBaseUrl(options = {}) {
  const env = options.env ?? {};
  const override = env.VITE_SPRITES_SIDECAR_BASE_URL;
  if (typeof override === 'string' && override.trim().length > 0) {
    return trimTrailingSlash(override.trim());
  }
  try {
    const cwd = options.workspacePath ?? globalThis.process?.cwd?.() ?? '.';
    const ports = getSessionServerPorts({ cwd, env });
    if (ports && typeof ports.sidecarBaseUrl === 'string') {
      return trimTrailingSlash(ports.sidecarBaseUrl);
    }
  } catch {
    // Fall through to the legacy fixed port.
  }
  return LEGACY_SIDECAR_FALLBACK;
}

// ---------------------------------------------------------------------------
// URL builders (pure). Kept 1:1 with the sidecar route table in
// `scripts/sprites/sidecar/server.ts`.
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;

export function healthUrl(baseUrl) {
  return `${baseUrl}/api/health`;
}

export function runsUrl(baseUrl, options = {}) {
  const params = new URLSearchParams();
  if (options.promoted && options.promoted !== 'all') {
    params.set('promoted', options.promoted);
  }
  const query = params.toString();
  return query ? `${baseUrl}/api/runs?${query}` : `${baseUrl}/api/runs`;
}

export function runSummaryUrl(baseUrl, briefId, runId) {
  return `${baseUrl}/api/runs/${enc(briefId)}/${enc(runId)}`;
}

/**
 * Persist-postprocess endpoint for a run. The monolith `renderPostprocessDebugger`
 * "Apply changes" POSTs its override payload here (`src/devtools-main.ts` ~5729);
 * the sidecar writes `postprocessOverrides` onto the run (`server.ts` ~1029).
 */
export function runPostprocessUrl(baseUrl, briefId, runId) {
  return `${runSummaryUrl(baseUrl, briefId, runId)}/postprocess`;
}

export function sheetsUrl(baseUrl, briefId, runId) {
  return `${runSummaryUrl(baseUrl, briefId, runId)}/sheets`;
}

export function sheetUrl(baseUrl, briefId, runId, filename) {
  return `${runSummaryUrl(baseUrl, briefId, runId)}/sheet/${enc(filename)}`;
}

export function processedUrl(baseUrl, briefId, runId, filename) {
  return `${runSummaryUrl(baseUrl, briefId, runId)}/processed/${enc(filename)}`;
}

export function rawUrl(baseUrl, briefId, runId, filename) {
  return `${runSummaryUrl(baseUrl, briefId, runId)}/raw/${enc(filename)}`;
}

export function sliceMapUrl(baseUrl, briefId, runId, sheet) {
  const base = `${runSummaryUrl(baseUrl, briefId, runId)}/slice-map`;
  if (typeof sheet === 'string' && sheet.length > 0) {
    return `${base}?sheet=${enc(sheet)}`;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Normalizers (pure). Ported verbatim from the DevTools monolith so the canvas
// shows exactly the same numbers, labels, and verdicts.
// ---------------------------------------------------------------------------

/** Judge axes, in display order. Mirrors `JUDGE_AXES` in `src/devtools-main.ts`. */
export const JUDGE_AXES = Object.freeze([
  { key: 'designLanguage', label: 'Design language' },
  { key: 'referenceStyleMatch', label: 'Reference style' },
  { key: 'briefMatch', label: 'Brief match' },
  { key: 'readability', label: 'Readability' },
  { key: 'poseOrientation', label: 'Pose orientation' },
  { key: 'bossPresence', label: 'Boss presence' },
  { key: 'presentation', label: 'Presentation' },
  { key: 'themeAdherence', label: 'Theme adherence' },
]);

/** A judge axis passes when its score is >= 3. */
export const JUDGE_AXIS_PASS_THRESHOLD = 3;

/** Status pill colors, mirroring `STATUS_KIND_COLORS` in `src/devtools-main.ts`. */
export const STATUS_KIND_COLORS = Object.freeze({
  pass: '#86efac',
  'sensor-failed': '#fca5a5',
  'judge-rejected': '#fca5a5',
  unjudged: '#94a3b8',
});

/**
 * Classify a normalized candidate. Ported from `candidateStatus` in
 * `src/devtools/sprite-workflow-queue.ts`.
 * @returns {{ kind: 'pass'|'sensor-failed'|'judge-rejected'|'unjudged', label: string }}
 */
export function candidateStatus(candidate) {
  if (candidate.combinedPassed) return { kind: 'pass', label: 'PASS' };
  if (!candidate.passed) return { kind: 'sensor-failed', label: 'sensor fail' };
  if (candidate.judge && !candidate.judge.passed) {
    return { kind: 'judge-rejected', label: 'judge fail' };
  }
  return { kind: 'unjudged', label: 'not judged' };
}

/**
 * Operator-facing explanation for an unjudged variant. Ported from
 * `describeJudgeSkipReason` in `src/devtools/sprite-workflow-queue.ts`.
 * @returns {string | null}
 */
export function describeJudgeSkipReason(reason, judged) {
  if (judged) return null;
  switch (reason) {
    case 'sensor-failed':
      return 'Not judged — this run used legacy sensor-gated judging.';
    case 'over-cap':
      return 'Not judged — only the top variants (by sensor score) are judged to bound cost. Raise the brief’s judge.maxVariants to judge more.';
    case 'over-budget':
      return 'Not judged — the run’s judge budget was exhausted.';
    case 'judge-disabled':
      return 'Not judged — judging is disabled for this brief.';
    default:
      return 'Not judged yet — run Judge to score this variant.';
  }
}

/**
 * Normalize a raw candidate's `judgeScorecard` into the compact display summary.
 * Ported from `toJudgeSummary` in `src/devtools-main.ts`.
 * @returns {{ passed: boolean, minScore: number, styleMatch: number, briefMatch: number, readability: number, rejectedBy: string[] } | null}
 */
export function toJudgeSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const axisScore = (axis) =>
    axis && typeof axis === 'object' && typeof axis.score === 'number' ? axis.score : 0;
  return {
    passed: raw.passed === true,
    minScore: typeof raw.minScore === 'number' ? raw.minScore : 0,
    designLanguage: axisScore(raw.designLanguage),
    referenceStyleMatch: axisScore(raw.referenceStyleMatch ?? raw.styleMatch),
    styleMatch: axisScore(raw.styleMatch),
    briefMatch: axisScore(raw.briefMatch),
    readability: axisScore(raw.readability),
    poseOrientation: axisScore(raw.poseOrientation),
    bossPresence: axisScore(raw.bossPresence),
    presentation: axisScore(raw.presentation),
    themeAdherence: axisScore(raw.themeAdherence),
    rejectedBy: Array.isArray(raw.rejectedBy)
      ? raw.rejectedBy.filter((r) => typeof r === 'string')
      : [],
  };
}

/**
 * Normalize a raw candidate's `breakdown` into sensor rows. Ported from
 * `toSensorResults` in `src/devtools-main.ts` — `pixelCount` is the length of the
 * offending-pixel array.
 * @returns {Array<{ sensor: string, ok: boolean, reason: string | null, pixelCount: number | null }>}
 */
export function toSensorResults(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry.sensor !== 'string') continue;
    out.push({
      sensor: entry.sensor,
      ok: entry.ok === true,
      reason: typeof entry.reason === 'string' ? entry.reason : null,
      pixelCount: Array.isArray(entry.pixels) ? entry.pixels.length : null,
    });
  }
  return out;
}

/**
 * Extract the enriched judge detail (per-axis rationale + provenance + skip
 * reason). Ported from `parseSummaryCandidate` in `src/devtools-main.ts`.
 * @returns {{ judge: object | null, judgeSkipReason: string | null }}
 */
export function parseCandidateDetail(raw) {
  const scorecard =
    raw && typeof raw.judgeScorecard === 'object' && raw.judgeScorecard !== null
      ? raw.judgeScorecard
      : null;
  const axisRationale = (key) => {
    const axis = scorecard && typeof scorecard[key] === 'object' ? scorecard[key] : null;
    return axis && typeof axis.rationale === 'string' ? axis.rationale : null;
  };
  const judge = scorecard
    ? {
        passed: scorecard.passed === true,
        minScore: typeof scorecard.minScore === 'number' ? scorecard.minScore : 0,
        rejectedBy: Array.isArray(scorecard.rejectedBy)
          ? scorecard.rejectedBy.filter((r) => typeof r === 'string')
          : [],
        rationale: {
          designLanguage: axisRationale('designLanguage'),
          referenceStyleMatch: axisRationale('referenceStyleMatch') ?? axisRationale('styleMatch'),
          styleMatch: axisRationale('styleMatch'),
          briefMatch: axisRationale('briefMatch'),
          readability: axisRationale('readability'),
          poseOrientation: axisRationale('poseOrientation'),
          bossPresence: axisRationale('bossPresence'),
          presentation: axisRationale('presentation'),
          themeAdherence: axisRationale('themeAdherence'),
        },
        modelDeployment:
          typeof scorecard.modelDeployment === 'string' ? scorecard.modelDeployment : null,
        judgedAt: typeof scorecard.judgedAt === 'string' ? scorecard.judgedAt : null,
      }
    : null;
  return {
    judge,
    judgeSkipReason: raw && typeof raw.judgeSkipReason === 'string' ? raw.judgeSkipReason : null,
  };
}

/**
 * Merge the compact + enriched views into one display candidate the renderer
 * consumes. Combines the monolith's `WorkflowRunCandidate` and
 * `SummaryCandidateDetail`.
 */
export function normalizeCandidate(raw) {
  const detail = parseCandidateDetail(raw);
  return {
    index: typeof raw.index === 'number' ? raw.index : 0,
    score: typeof raw.score === 'number' ? raw.score : 0,
    outOf: typeof raw.outOf === 'number' ? raw.outOf : 0,
    passed: raw.passed === true,
    combinedPassed: raw.combinedPassed === true,
    judge: toJudgeSummary(raw.judgeScorecard),
    sensors: toSensorResults(raw.breakdown),
    rationale: detail.judge ? detail.judge.rationale : null,
    modelDeployment: detail.judge ? detail.judge.modelDeployment : null,
    judgedAt: detail.judge ? detail.judge.judgedAt : null,
    judgeSkipReason: detail.judgeSkipReason,
  };
}

/** Normalize every candidate in a run summary, sorted by ascending index. */
export function normalizeCandidates(summary) {
  const candidates = summary && Array.isArray(summary.candidates) ? summary.candidates : [];
  return candidates
    .filter((c) => c && typeof c === 'object')
    .map((c) => normalizeCandidate(c))
    .sort((a, b) => a.index - b.index);
}

/**
 * Deduped, order-preserving list of variant indices in a run summary. Ported
 * from `extractVariantIndices` in `src/devtools/sprite-approval-api.ts`.
 * @returns {number[]}
 */
export function extractVariantIndices(summary) {
  const candidates = summary && Array.isArray(summary.candidates) ? summary.candidates : [];
  const indices = [];
  candidates.forEach((candidate, fallbackIndex) => {
    if (candidate && typeof candidate === 'object') {
      const value = candidate.index;
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        indices.push(value);
        return;
      }
    }
    indices.push(fallbackIndex);
  });
  return [...new Set(indices)];
}

/**
 * Normalize a slice-map response into the full schema the overlay needs. Handles
 * both the healthy shape (from `computeSliceMap`) and the degraded/error shapes.
 * When `emptyCellsApplied === false` the brief could not be loaded, so
 * `cell.index` is a sequential number that no longer equals the run's
 * `variantIndex` — the renderer must treat the map as degraded and NOT trust
 * cell indices for selection/highlight.
 * @returns {{ ok: boolean, error: string | null, sheetW: number, sheetH: number, rows: number, cols: number, cellW: number, cellH: number, rowOffsets: number[], colOffsets: number[], cells: Array<object>, sheetFile: string | null, algorithm: string | null, emptyCellsApplied: boolean }}
 */
export function normalizeSliceMap(raw) {
  const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const numArray = (v) => (Array.isArray(v) ? v.map((n) => num(n)) : []);
  if (!raw || typeof raw !== 'object' || typeof raw.error === 'string') {
    return {
      ok: false,
      error: raw && typeof raw.error === 'string' ? raw.error : 'slice-map-unavailable',
      sheetW: 0,
      sheetH: 0,
      rows: 0,
      cols: 0,
      cellW: 0,
      cellH: 0,
      rowOffsets: [],
      colOffsets: [],
      cells: [],
      sheetFile: raw && typeof raw.sheetFile === 'string' ? raw.sheetFile : null,
      algorithm: null,
      emptyCellsApplied: false,
    };
  }
  const cells = Array.isArray(raw.cells)
    ? raw.cells
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({
          index: typeof c.index === 'number' ? c.index : -1,
          row: num(c.row),
          col: num(c.col),
          x0: num(c.x0),
          y0: num(c.y0),
          w: num(c.w),
          h: num(c.h),
          empty: c.empty === true,
        }))
    : [];
  return {
    ok: true,
    error: null,
    sheetW: num(raw.sheetW),
    sheetH: num(raw.sheetH),
    rows: num(raw.rows),
    cols: num(raw.cols),
    cellW: num(raw.cellW),
    cellH: num(raw.cellH),
    rowOffsets: numArray(raw.rowOffsets),
    colOffsets: numArray(raw.colOffsets),
    cells,
    sheetFile: typeof raw.sheetFile === 'string' ? raw.sheetFile : null,
    algorithm: typeof raw.algorithm === 'string' ? raw.algorithm : null,
    // Absent => treat as degraded (do not trust cell indices).
    emptyCellsApplied: raw.emptyCellsApplied === true,
  };
}

// ---------------------------------------------------------------------------
// Client factory. All I/O funnels through an injectable `fetchImpl`.
// ---------------------------------------------------------------------------

async function readJson(response) {
  return response.json();
}

/**
 * Build a read-only sidecar client bound to `baseUrl`. Every method throws on a
 * non-2xx response (callers in the harness proxy translate that into a controlled
 * degraded state — the canvas never crashes).
 *
 * @param {{ baseUrl: string, fetchImpl?: typeof fetch, workspaceRoot?: string }} options
 */
export function createSidecarClient(options) {
  const baseUrl = trimTrailingSlash(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const workspaceRoot = options.workspaceRoot ?? null;

  async function listRuns(listOptions = {}) {
    const response = await fetchImpl(runsUrl(baseUrl, listOptions), { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to load sidecar runs (${response.status} ${response.statusText})`);
    }
    const payload = await readJson(response);
    return Array.isArray(payload?.runs) ? payload.runs : [];
  }

  async function fetchRunSummary(briefId, runId) {
    const response = await fetchImpl(runSummaryUrl(baseUrl, briefId, runId), {
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`Failed to load run summary (${response.status} ${response.statusText})`);
    }
    return readJson(response);
  }

  async function fetchSheets(briefId, runId) {
    const response = await fetchImpl(sheetsUrl(baseUrl, briefId, runId), { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to load sheets (${response.status} ${response.statusText})`);
    }
    const payload = await readJson(response);
    return Array.isArray(payload?.files) ? payload.files : [];
  }

  async function fetchSliceMap(briefId, runId, sheet) {
    const response = await fetchImpl(sliceMapUrl(baseUrl, briefId, runId, sheet), {
      cache: 'no-store',
    });
    // slice-map returns structured error bodies with non-2xx codes; surface them
    // as a degraded (ok:false) map rather than throwing so the overlay degrades.
    let payload = null;
    try {
      payload = await readJson(response);
    } catch {
      payload = null;
    }
    if (!response.ok) {
      return normalizeSliceMap(payload ?? { error: `http-${response.status}` });
    }
    return normalizeSliceMap(payload);
  }

  /**
   * Repo-aware health probe. Returns `up` only when the sidecar answers AND its
   * `repoRoot` matches this workspace; `wrong-repo` when it answers for a
   * different checkout; `down` on any network/HTTP failure.
   * @returns {Promise<{ state: 'up'|'down'|'wrong-repo', repoRoot: string|null, version: string|null, expectedRepoRoot: string|null, storeBackend: string|null, queueBackend: string|null, httpStatus: number|null }>}
   */
  async function probeHealth() {
    const expectedRepoRoot = workspaceRoot;
    const base = {
      repoRoot: null,
      version: null,
      expectedRepoRoot,
      storeBackend: null,
      queueBackend: null,
      httpStatus: null,
    };
    let response;
    try {
      response = await fetchImpl(healthUrl(baseUrl), { cache: 'no-store' });
    } catch {
      return { ...base, state: 'down' };
    }
    if (!response.ok) {
      return { ...base, state: 'down', httpStatus: response.status };
    }
    let payload;
    try {
      payload = await readJson(response);
    } catch {
      return { ...base, state: 'down', httpStatus: response.status };
    }
    const repoRoot = typeof payload?.repoRoot === 'string' ? payload.repoRoot : null;
    const health = {
      state: 'up',
      repoRoot,
      version: typeof payload?.version === 'string' ? payload.version : null,
      expectedRepoRoot,
      storeBackend: typeof payload?.storeBackend === 'string' ? payload.storeBackend : null,
      queueBackend: typeof payload?.queueBackend === 'string' ? payload.queueBackend : null,
      httpStatus: response.status,
    };
    if (expectedRepoRoot && repoRoot) {
      const match = normalizeWorkspaceKey(repoRoot) === normalizeWorkspaceKey(expectedRepoRoot);
      if (!match) {
        return { ...health, state: 'wrong-repo' };
      }
    }
    return health;
  }

  return {
    baseUrl,
    listRuns,
    fetchRunSummary,
    fetchSheets,
    fetchSliceMap,
    probeHealth,
    urls: {
      health: () => healthUrl(baseUrl),
      runs: (o) => runsUrl(baseUrl, o),
      runSummary: (b, r) => runSummaryUrl(baseUrl, b, r),
      runPostprocess: (b, r) => runPostprocessUrl(baseUrl, b, r),
      sheets: (b, r) => sheetsUrl(baseUrl, b, r),
      sheet: (b, r, f) => sheetUrl(baseUrl, b, r, f),
      processed: (b, r, f) => processedUrl(baseUrl, b, r, f),
      raw: (b, r, f) => rawUrl(baseUrl, b, r, f),
      sliceMap: (b, r, s) => sliceMapUrl(baseUrl, b, r, s),
    },
  };
}
