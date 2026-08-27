/**
 * screenshot-viewer — canvas extension that shows a gallery of screenshots
 * taken by agents during a session.
 *
 * Screenshot sources:
 *   1. Live tracking: `onPostToolUse` intercepts `playwright-browser_take_screenshot`
 *      and records the absolute path of every screenshot as it lands.
 *   2. On-demand scan: `POST /api/refresh` (or the agent `refresh` action) scans
 *      common screenshot directories under the workspace:
 *        - <workspace>/files/visual-review/**
 *        - <workspace>/**  (png/jpg/jpeg/webp files up to 1 level deep)
 *        - CWD /** (same depth)
 *
 * Images are served from the local loopback server at GET /img?path=<encoded>.
 * Path access is validated against the discovered screenshot registry and allowed
 * image extensions so the server cannot be used as an arbitrary filesystem relay.
 */

import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, basename, join, resolve, normalize } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

import { createCanvas, joinSession } from '@github/copilot-sdk/extension';

import { renderHtml } from './renderer.mjs';

const POLL_INTERVAL_MS = 10_000;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** Sub-directories inside the workspace to scan for screenshots. */
const SCAN_SUBDIRS = ['files/visual-review', 'files'];
const SCENARIO_MANIFEST = 'docs/knowledge/ux-baselines/manifest.json';
const LIVE_DEV_VERSION = 'live-dev';
const SEMVER_VERSION = /^v\d+\.\d+\.\d+$/;
const FEEDBACK_DIR = 'files/visual-review/feedback';
const FEEDBACK_FILE = 'before-after-feedback.jsonl';
const PROMOTION_DIR = 'docs/knowledge/ux-feedback';
const FEEDBACK_TARGETS = new Set([
  'ux-agent',
  'visual-review-skill',
  'deterministic-eval',
  'workflow',
]);

const AXIS_LABELS = {
  layout_consistency: 'Layout consistency',
  spacing_balance: 'Spacing balance',
  visual_hierarchy: 'Visual hierarchy',
  readability: 'Readability',
  icon_usage: 'Icon usage',
  typography_clarity: 'Typography clarity',
  thematic_fidelity: 'Thematic fidelity',
  task_readiness: 'Task readiness',
  decision_delta: 'Decision delta',
  legibility: 'Legibility',
  semantic_grammar: 'Semantic grammar',
  workspace_use: 'Workspace use',
  whitespace_quality: 'Whitespace quality',
  visible_input_affordance: 'Visible input affordance',
  ownership_context: 'Ownership and context',
  accessibility_robustness: 'Accessibility robustness',
};

/** Maximum depth when scanning a directory (1 = immediate children only). */
const SCAN_MAX_DEPTH = 5;

/** Maximum size of a request body (16 KiB). */
const MAX_BODY_BYTES = 16_384;

const servers = new Map(); // instanceId → { server, url, token, sseClients }
const states = new Map(); // instanceId → state object

// ── tracked workspace paths ────────────────────────────────────────────────
let trackedWorkspacePath = null;
let trackedCwd = null;

function rememberPaths(input) {
  if (typeof input?.workingDirectory === 'string' && input.workingDirectory.trim()) {
    trackedCwd = input.workingDirectory.trim();
    trackedWorkspacePath = trackedCwd;
  }
}

function getWorkspacePath() {
  return trackedWorkspacePath;
}

// ── screenshot registry ────────────────────────────────────────────────────

/**
 * @typedef {{ path: string, filename: string, takenAt: string, source: 'live'|'scanned' }} Screenshot
 */

/** Global ordered list of known screenshots (newest first). */
const screenshotRegistry = new Map(); // path → Screenshot
let lastScannedAt = null;

function registerScreenshot(absPath, source) {
  const normalizedPath = normalize(resolve(absPath));
  if (screenshotRegistry.has(normalizedPath)) {
    // Update source to 'live' if we're seeing it live
    if (source === 'live') {
      screenshotRegistry.get(normalizedPath).source = 'live';
    }
    return;
  }
  screenshotRegistry.set(normalizedPath, {
    path: normalizedPath,
    filename: basename(normalizedPath),
    takenAt: new Date().toISOString(),
    source,
  });
}

function sortedScreenshots() {
  return [...screenshotRegistry.values()].sort(
    (a, b) => new Date(b.takenAt).getTime() - new Date(a.takenAt).getTime(),
  );
}

function feedbackPath() {
  const workspacePath = getWorkspacePath();
  return workspacePath ? join(workspacePath, FEEDBACK_DIR, FEEDBACK_FILE) : null;
}

function readFeedback() {
  const path = feedbackPath();
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function cleanStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

function reviewDetails(review, isWrappedReview, scale) {
  const overall = isWrappedReview
    ? { verdict: review.verdict ?? null, summary: review.summary ?? null, rawScore: null }
    : {
        verdict: review.overall?.verdict ?? null,
        summary: review.overall?.summary ?? null,
        rawScore: review.overall?.raw_score ?? null,
      };
  const axes = Object.entries(review?.axes ?? {})
    .filter(([, axis]) => axis && typeof axis === 'object')
    .map(([id, axis]) => ({
      id,
      label: AXIS_LABELS[id] ?? id.replaceAll('_', ' '),
      score: Number.isFinite(Number(axis.score)) ? Number(axis.score) : null,
      strengths: cleanStringList(axis.strengths),
      issues: cleanStringList(axis.issues),
    }));
  const preciseFixes = Array.isArray(review?.precise_fixes)
    ? review.precise_fixes
        .filter((fix) => fix && typeof fix === 'object')
        .map((fix) => ({
          element: typeof fix.element === 'string' ? fix.element : '',
          action: typeof fix.action === 'string' ? fix.action : '',
          dx: Number.isFinite(Number(fix.dx)) ? Number(fix.dx) : null,
          dy: Number.isFinite(Number(fix.dy)) ? Number(fix.dy) : null,
          dw: Number.isFinite(Number(fix.dw)) ? Number(fix.dw) : null,
          dh: Number.isFinite(Number(fix.dh)) ? Number(fix.dh) : null,
          reason: typeof fix.reason === 'string' ? fix.reason : '',
        }))
    : [];
  return {
    scale,
    verdict: overall.verdict,
    summary: overall.summary,
    rawScore: overall.rawScore,
    axes,
    scoreDerivation: review.score_derivation ?? null,
    deterministicFindings: cleanStringList(review.deterministic_blocking_findings),
    blockingFindings: cleanStringList(review.blocking_findings),
    recommendedFixes: cleanStringList(review.recommended_fixes),
    preciseFixes,
    rawReview: review,
  };
}

function reviewResults() {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) return new Map();
  const root = join(workspacePath, 'files', 'visual-review');
  const results = new Map();
  const scan = (directory, depth) => {
    if (depth <= 0 || !existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path, depth - 1);
      if (!entry.isFile() || !entry.name.endsWith('.review.json')) continue;
      try {
        const review = JSON.parse(readFileSync(path, 'utf8'));
        const isWrappedReview = review?.schemaVersion === 1 && typeof review.image === 'string';
        const isRawAzureReview =
          Number.isFinite(review?.overall?.score) &&
          review.overall.score >= 0 &&
          review.overall.score <= 100;
        if (!isWrappedReview && !isRawAzureReview) continue;
        // Legacy raw reviews were scored 1-5; current ones are 0-100. Axis scores
        // disambiguate the two, since a genuine 0-100 surface scoring <=5 on every
        // axis is indistinguishable from a legacy review by the overall score alone.
        const axisScores = Object.values(review?.axes ?? {})
          .map((axis) => Number(axis?.score))
          .filter((value) => Number.isFinite(value));
        const isLegacyFiveScale =
          !isWrappedReview &&
          review.overall.score <= 5 &&
          axisScores.length > 0 &&
          axisScores.every((value) => value <= 5);
        const rawScale = isLegacyFiveScale ? 5 : 100;
        const imagePath = isWrappedReview
          ? review.image
          : join(resolve(path, '..'), entry.name.replace(/\.review\.json$/, '.png'));
        const score = isWrappedReview ? review.score : review.overall.score;
        const findings = isWrappedReview
          ? Array.isArray(review.prioritizedFindings)
            ? review.prioritizedFindings
            : []
          : Array.isArray(review.blocking_findings)
            ? review.blocking_findings
            : Array.isArray(review.recommended_fixes)
              ? review.recommended_fixes
              : [];
        results.set(normalize(resolve(imagePath)), {
          path,
          score,
          scale: isWrappedReview ? 100 : rawScale,
          coverage: isWrappedReview ? review.coverage : 100,
          hardFailures: Array.isArray(review.hardFailures) ? review.hardFailures : [],
          findings,
          details: reviewDetails(review, isWrappedReview, isWrappedReview ? 100 : rawScale),
        });
      } catch {
        // A partially-written optional review artifact must not break screenshot browsing.
      }
    }
  };
  scan(root, SCAN_MAX_DEPTH);
  return results;
}

/**
 * A|B scenarios are deliberately declared, never inferred from capture paths.
 * Files whose basename is not an enabled manifest id stay in All Screenshots.
 */
function scenarioRegistry() {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) return new Map();
  try {
    const entries = JSON.parse(readFileSync(join(workspacePath, SCENARIO_MANIFEST), 'utf8'));
    if (!Array.isArray(entries)) return new Map();
    return new Map(
      entries
        .filter(
          (entry) =>
            entry?.enabled === true &&
            typeof entry.id === 'string' &&
            typeof entry.label === 'string',
        )
        .map((entry) => [entry.id, { id: entry.id, label: entry.label }]),
    );
  } catch {
    return new Map();
  }
}

function isLineageVersion(value) {
  return value === LIVE_DEV_VERSION || SEMVER_VERSION.test(value);
}

function compareLineageVersions(left, right) {
  if (left === LIVE_DEV_VERSION) return right === LIVE_DEV_VERSION ? 0 : -1;
  if (right === LIVE_DEV_VERSION) return 1;
  const leftParts = left.slice(1).split('.').map(Number);
  const rightParts = right.slice(1).split('.').map(Number);
  return (
    leftParts[0] - rightParts[0] || leftParts[1] - rightParts[1] || leftParts[2] - rightParts[2]
  );
}

function pairs(reviews = reviewResults(), scenarios = scenarioRegistry()) {
  const byKey = new Map();
  for (const screenshot of sortedScreenshots()) {
    const normalized = screenshot.path.replaceAll('\\', '/');
    if (/(^|\/)archive(\/|$)/i.test(normalized)) continue;
    const match = normalized.match(/\/(before|after)\/(?:([^/]+)\/)?([^/]+)$/i);
    if (!match) continue;
    const side = match[1].toLowerCase();
    const state = match[2] ?? (side === 'before' ? LIVE_DEV_VERSION : null);
    if (!state || !isLineageVersion(state)) continue;
    const scenarioId = match[3].replace(/\.[^.]+$/, '');
    const scenario = scenarios.get(scenarioId);
    if (!scenario) continue;
    const group = byKey.get(scenarioId) ?? { scenario, before: new Map(), after: new Map() };
    const review = reviews.get(normalize(resolve(screenshot.path))) ?? null;
    group[side].set(state.toLowerCase(), { screenshot, review, state });
    byKey.set(scenarioId, group);
  }

  const result = [];
  for (const [scenarioId, group] of byKey) {
    const afterStates = [...group.after.keys()].sort(compareLineageVersions);
    const beforeOnlyStates = [...group.before.keys()].filter(
      (state) => !group.after.has(state) && !(state === LIVE_DEV_VERSION && afterStates.length > 0),
    );
    for (const [index, state] of afterStates.entries()) {
      const before =
        index > 0
          ? (group.after.get(afterStates[index - 1]) ?? null)
          : (group.before.get(state) ?? group.before.get(LIVE_DEV_VERSION) ?? null);
      const after = group.after.get(state) ?? null;
      result.push({
        key: `${group.scenario.label} · ${state}`,
        scenarioId,
        scenarioLabel: group.scenario.label,
        before: before?.screenshot ?? null,
        after: after?.screenshot ?? null,
        states: { before: before?.state ?? null, after: after?.state ?? null },
        reviews: {
          before: before?.review ?? null,
          after: after?.review ?? null,
        },
      });
    }
    for (const state of beforeOnlyStates) {
      const before = group.before.get(state) ?? null;
      result.push({
        key: `${group.scenario.label} · ${state}`,
        scenarioId,
        scenarioLabel: group.scenario.label,
        before: before?.screenshot ?? null,
        after: null,
        states: { before: before?.state ?? null, after: null },
        reviews: { before: before?.review ?? null, after: null },
      });
    }
  }
  // Emit newest-first, with a live-dev-to-latest overview leading each scenario, so
  // display order is authoritative here rather than a client-side concern.
  const ordered = [];
  const comparable = result.filter((pair) => pair.before && pair.after);
  const takenTime = (shot) => {
    const parsed = shot?.takenAt ? new Date(shot.takenAt).getTime() : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const scenarioOf = (pair) => pair.scenarioId;
  for (const scenario of [...new Set(comparable.map(scenarioOf))]) {
    const lineage = comparable
      .filter((pair) => scenarioOf(pair) === scenario)
      .sort((a, b) => takenTime(a.after) - takenTime(b.after));
    const first = lineage[0];
    const last = lineage[lineage.length - 1];
    if (lineage.length > 1 && first.states.before === LIVE_DEV_VERSION) {
      ordered.push({
        ...last,
        key: `${last.scenarioLabel} · ${last.states.after}`,
        before: first.before,
        states: { before: first.states.before, after: last.states.after },
        reviews: { before: first.reviews.before, after: last.reviews.after },
      });
    }
    ordered.push(...lineage.reverse());
  }
  ordered.push(...result.filter((pair) => !(pair.before && pair.after)));
  return ordered;
}

// ── live tool-use tracking ─────────────────────────────────────────────────

/**
 * Extract the absolute screenshot path from a playwright tool call result.
 * The Playwright `browser_take_screenshot` tool returns result text that
 * mentions the saved filename.  We prefer the `filename` arg from toolArgs
 * because it's authoritative; if not given, we fall back to the default
 * `page-{timestamp}.png` pattern.
 */
function extractScreenshotPath(toolName, toolArgs, toolResult, cwd) {
  if (toolName !== 'playwright-browser_take_screenshot') return null;

  // 1. Explicit filename arg
  const filename =
    toolArgs && typeof toolArgs.filename === 'string' && toolArgs.filename.trim()
      ? toolArgs.filename.trim()
      : null;

  if (filename) {
    const absPath = resolve(cwd || trackedCwd || process.cwd(), filename);
    if (existsSync(absPath)) return absPath;
    // May already be absolute
    if (filename.startsWith('/') || /^[A-Za-z]:[/\\]/.test(filename)) {
      return existsSync(filename) ? filename : null;
    }
    return absPath;
  }

  // 2. Try to extract path from result text e.g. "Screenshot saved to page-...png"
  const resultText =
    typeof toolResult === 'string' ? toolResult : (toolResult?.content ?? toolResult?.text ?? '');
  const match =
    typeof resultText === 'string'
      ? resultText.match(/page-\d[^"'\s)]+\.(?:png|jpg|jpeg|webp)/i)
      : null;
  if (match) {
    const candidate = resolve(cwd || trackedCwd || process.cwd(), match[0]);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

// ── directory scanning ─────────────────────────────────────────────────────

async function scanDir(dirPath, maxDepth, foundPaths) {
  if (maxDepth <= 0) return;
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (maxDepth > 1) await scanDir(fullPath, maxDepth - 1, foundPaths);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        foundPaths.push(fullPath);
      }
    }
  }
}

async function scanWorkspace(workspacePath) {
  if (!workspacePath) return;

  const found = [];

  // Scan specific well-known subdirectories first (deeper scan)
  for (const subdir of SCAN_SUBDIRS) {
    const dirPath = join(workspacePath, subdir);
    await scanDir(dirPath, SCAN_MAX_DEPTH, found);
  }

  // Scan workspace root (shallow — immediate children only)
  await scanDir(workspacePath, 1, found);

  // Also scan CWD if different from workspace
  if (trackedCwd && trackedCwd !== workspacePath) {
    await scanDir(trackedCwd, 1, found);
  }

  // Assign filesystem mtime as takenAt for scanned files
  for (const p of found) {
    const normalizedPath = normalize(resolve(p));
    if (!screenshotRegistry.has(normalizedPath)) {
      let takenAt = new Date().toISOString();
      try {
        const s = await stat(normalizedPath);
        takenAt = s.mtime.toISOString();
      } catch {
        // The filesystem timestamp is optional metadata.
      }
      screenshotRegistry.set(normalizedPath, {
        path: normalizedPath,
        filename: basename(normalizedPath),
        takenAt,
        source: 'scanned',
      });
    }
  }
  // Drop registry entries whose file no longer exists, so a deleted capture
  // stops producing a phantom before/after state in the pair lineage.
  const seen = new Set(found.map((p) => normalize(resolve(p))));
  for (const [path, entry] of screenshotRegistry) {
    if (entry.source === 'scanned' && !seen.has(path)) screenshotRegistry.delete(path);
  }

  lastScannedAt = new Date().toISOString();
}

// ── state helpers ──────────────────────────────────────────────────────────

function buildState(instanceId) {
  const workspacePath = getWorkspacePath();
  return {
    instanceId,
    workspacePath: workspacePath ?? null,
    screenshots: sortedScreenshots(),
    scenarios: [...scenarioRegistry().values()],
    pairs: pairs(),
    feedback: readFeedback(),
    liveTracking: true,
    scannedAt: lastScannedAt,
    error: null,
  };
}

function normalizeFeedback(entry) {
  if (!entry || typeof entry.comment !== 'string' || !entry.comment.trim()) {
    throw new Error('comment is required');
  }
  const scope = entry.scope === 'reusable' ? 'reusable' : 'task';
  const target = scope === 'reusable' && FEEDBACK_TARGETS.has(entry.target) ? entry.target : null;
  if (scope === 'reusable' && !target) {
    throw new Error('reusable feedback requires a valid target');
  }
  return {
    comment: entry.comment.trim(),
    scope,
    target,
    pairKey:
      typeof entry.pairKey === 'string' && entry.pairKey.trim() ? entry.pairKey.trim() : null,
    findingId:
      typeof entry.findingId === 'string' && entry.findingId.trim() ? entry.findingId.trim() : null,
  };
}

function saveFeedback(entry) {
  const path = feedbackPath();
  if (!path) throw new Error('Workspace path is not available.');
  const dir = join(getWorkspacePath(), FEEDBACK_DIR);
  mkdirSync(dir, { recursive: true });
  const record = {
    schemaVersion: 1,
    ...normalizeFeedback(entry),
    id: randomBytes(8).toString('hex'),
    createdAt: new Date().toISOString(),
    status: entry.scope === 'reusable' ? 'proposed' : 'recorded',
  };
  writeFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
  if (record.scope === 'reusable') {
    const durableDir = join(getWorkspacePath(), PROMOTION_DIR);
    mkdirSync(durableDir, { recursive: true });
    writeFileSync(
      join(durableDir, `${record.createdAt.slice(0, 10)}-${record.id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    );
  }
  return record;
}

// ── SSE broadcast ──────────────────────────────────────────────────────────

function notifyClients(instanceId) {
  const entry = servers.get(instanceId);
  if (!entry) return;
  const payload = `data: ${JSON.stringify(buildState(instanceId))}\n\n`;
  for (const res of entry.sseClients) {
    try {
      res.write(payload);
    } catch {
      entry.sseClients.delete(res);
    }
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

function tokensMatch(actual, expected) {
  if (!actual || !expected) return false;
  const a = Buffer.from(String(actual));
  const b = Buffer.from(String(expected));
  if (a.byteLength !== b.byteLength) return false;
  // Constant-time compare
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function jsonResponse(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES)
      throw Object.assign(new Error('Request body too large.'), { code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

// ── path allowlist for image serving ──────────────────────────────────────

/**
 * Return true iff `absPath` is a known screenshot with an allowed extension.
 * Prevents the /img route from acting as an arbitrary filesystem relay.
 */
function isAllowedPath(absPath) {
  const normalized = normalize(resolve(absPath));
  const ext = extname(normalized).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) && screenshotRegistry.has(normalized);
}

// ── image MIME type ────────────────────────────────────────────────────────

function mimeForExt(ext) {
  switch (ext.toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

// ── HTTP request handler ───────────────────────────────────────────────────

async function handleRequest(instanceId, token, req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (!tokensMatch(url.searchParams.get('token'), token)) {
    jsonResponse(res, 403, { error: 'forbidden' });
    return;
  }

  // GET / — HTML shell
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'self'",
    });
    res.end(renderHtml({ instanceId, pollIntervalMs: POLL_INTERVAL_MS }));
    return;
  }

  // GET /events — SSE
  if (url.pathname === '/events' && req.method === 'GET') {
    const entry = servers.get(instanceId);
    if (!entry) {
      jsonResponse(res, 404, { error: 'not_open' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
    });
    entry.sseClients.add(res);
    req.on('close', () => entry.sseClients.delete(res));
    res.write(`data: ${JSON.stringify(buildState(instanceId))}\n\n`);
    return;
  }

  // GET /api/state
  if (url.pathname === '/api/state' && req.method === 'GET') {
    jsonResponse(res, 200, buildState(instanceId));
    return;
  }

  // POST /api/refresh — re-scan directories
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    const workspacePath = getWorkspacePath();
    await scanWorkspace(workspacePath);
    const state = buildState(instanceId);
    notifyClients(instanceId);
    jsonResponse(res, 200, state);
    return;
  }

  if (url.pathname === '/api/feedback' && req.method === 'POST') {
    const body = await readJsonBody(req);
    let record;
    try {
      record = saveFeedback(body);
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    notifyClients(instanceId);
    jsonResponse(res, 201, record);
    return;
  }

  // GET /img?path=<encoded> — serve image binary
  if (url.pathname === '/img' && req.method === 'GET') {
    const rawPath = url.searchParams.get('path');
    if (!rawPath) {
      jsonResponse(res, 400, { error: 'missing path' });
      return;
    }

    const absPath = normalize(resolve(rawPath));
    if (!isAllowedPath(absPath)) {
      jsonResponse(res, 403, { error: 'path not allowed' });
      return;
    }

    let bytes;
    try {
      bytes = readFileSync(absPath);
    } catch {
      jsonResponse(res, 404, { error: 'not found' });
      return;
    }

    const mime = mimeForExt(extname(absPath));
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-store',
      'Content-Length': bytes.byteLength,
    });
    res.end(bytes);
    return;
  }

  jsonResponse(res, 404, { error: 'not_found' });
}

// ── server lifecycle ───────────────────────────────────────────────────────

async function startServer(instanceId, token) {
  const sseClients = new Set();
  const server = createServer((req, res) => {
    handleRequest(instanceId, token, req, res).catch((err) => {
      if (!res.headersSent) jsonResponse(res, 500, { error: err?.message ?? String(err) });
      else res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      server.removeAllListeners('error');
      reject(err);
    });
    server.listen(0, '127.0.0.1', () => {
      server.removeAllListeners('error');
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, sseClients, token, url: `http://127.0.0.1:${port}/` };
}

async function closeServer(entry) {
  for (const res of entry.sseClients) res.end();
  entry.sseClients.clear();
  await new Promise((resolve) => {
    entry.server.close(() => resolve());
    entry.server.closeAllConnections?.();
  });
}

// ── main ───────────────────────────────────────────────────────────────────

await joinSession({
  hooks: {
    onSessionStart: async (input) => {
      rememberPaths(input);
    },
    onUserPromptSubmitted: async (input) => {
      rememberPaths(input);
    },
    onPreToolUse: async (input) => {
      rememberPaths(input);
    },
    onPostToolUse: async (input) => {
      rememberPaths(input);
      // Track Playwright screenshots as they happen
      const absPath = extractScreenshotPath(
        input.toolName,
        input.toolArgs,
        input.toolResult,
        input.workingDirectory,
      );
      if (absPath) {
        registerScreenshot(absPath, 'live');
        // Notify all open canvas instances
        for (const instanceId of servers.keys()) {
          notifyClients(instanceId);
        }
      }
    },
    onPostToolUseFailure: async (input) => {
      rememberPaths(input);
    },
  },
  canvases: [
    createCanvas({
      id: 'ab-ux-testing',
      displayName: 'A|B UX Testing',
      description:
        'Compare tracked UX screenshot lineages, evaluator results, and review feedback alongside the complete screenshot gallery.',
      actions: [
        {
          name: 'list_screenshots',
          description: 'Return the list of all screenshots discovered in the current session.',
          handler: async () => {
            const workspacePath = getWorkspacePath();
            await scanWorkspace(workspacePath);
            return {
              screenshots: sortedScreenshots(),
              workspacePath: workspacePath ?? null,
              count: screenshotRegistry.size,
            };
          },
        },
        {
          name: 'refresh',
          description: 'Re-scan screenshot directories and return the updated list.',
          handler: async () => {
            const workspacePath = getWorkspacePath();
            await scanWorkspace(workspacePath);
            const screenshots = sortedScreenshots();
            for (const instanceId of servers.keys()) notifyClients(instanceId);
            return { screenshots, count: screenshots.length };
          },
        },
        {
          name: 'save_feedback',
          description:
            'Store feedback for a Before/After screenshot pair as task-specific or reusable guidance.',
          handler: async (input) => {
            const record = saveFeedback(input ?? {});
            for (const instanceId of servers.keys()) notifyClients(instanceId);
            return record;
          },
        },
      ],
      open: async (ctx) => {
        const token = randomBytes(16).toString('hex');
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          entry = await startServer(ctx.instanceId, token);
          servers.set(ctx.instanceId, entry);
        }
        // Initial scan
        const workspacePath = getWorkspacePath();
        await scanWorkspace(workspacePath);

        const count = screenshotRegistry.size;
        return {
          title: 'A|B UX Testing',
          status:
            count === 0 ? 'no screenshots yet' : `${count} screenshot${count === 1 ? '' : 's'}`,
          url: entry.url + `?token=${entry.token}`,
        };
      },
      onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (!entry) return;
        servers.delete(ctx.instanceId);
        states.delete(ctx.instanceId);
        await closeServer(entry);
      },
    }),
  ],
});
