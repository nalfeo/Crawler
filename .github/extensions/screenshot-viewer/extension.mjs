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
 * Path access is validated against an allowlist (workspace + cwd) so the server
 * cannot be used as an arbitrary filesystem relay.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, basename, join, resolve, normalize } from 'node:path';

import { createCanvas, joinSession } from '@github/copilot-sdk/extension';

import { renderHtml } from './renderer.mjs';

const POLL_INTERVAL_MS = 10_000;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** Sub-directories inside the workspace to scan for screenshots. */
const SCAN_SUBDIRS = ['files/visual-review', 'files'];

/** Maximum depth when scanning a directory (1 = immediate children only). */
const SCAN_MAX_DEPTH = 2;

/** Maximum size of a request body (16 KiB). */
const MAX_BODY_BYTES = 16_384;

const servers = new Map();   // instanceId → { server, url, token, sseClients }
const states = new Map();    // instanceId → state object

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

function registerScreenshot(absPath, source) {
  if (screenshotRegistry.has(absPath)) {
    // Update source to 'live' if we're seeing it live
    if (source === 'live') {
      screenshotRegistry.get(absPath).source = 'live';
    }
    return;
  }
  screenshotRegistry.set(absPath, {
    path: absPath,
    filename: basename(absPath),
    takenAt: new Date().toISOString(),
    source,
  });
}

function sortedScreenshots() {
  return [...screenshotRegistry.values()].sort(
    (a, b) => new Date(b.takenAt).getTime() - new Date(a.takenAt).getTime(),
  );
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
  const filename = toolArgs && typeof toolArgs.filename === 'string' && toolArgs.filename.trim()
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
  const resultText = typeof toolResult === 'string'
    ? toolResult
    : (toolResult?.content ?? toolResult?.text ?? '');
  const match = typeof resultText === 'string'
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
    if (!screenshotRegistry.has(p)) {
      let takenAt = new Date().toISOString();
      try {
        const s = await stat(p);
        takenAt = s.mtime.toISOString();
      } catch {}
      screenshotRegistry.set(p, {
        path: p,
        filename: basename(p),
        takenAt,
        source: 'scanned',
      });
    }
  }
}

// ── state helpers ──────────────────────────────────────────────────────────

function buildState(instanceId) {
  const workspacePath = getWorkspacePath();
  return {
    instanceId,
    workspacePath: workspacePath ?? null,
    screenshots: sortedScreenshots(),
    liveTracking: true,
    scannedAt: new Date().toISOString(),
    error: null,
  };
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
    if (length > MAX_BODY_BYTES) throw Object.assign(new Error('Request body too large.'), { code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

// ── path allowlist for image serving ──────────────────────────────────────

/**
 * Return true iff `absPath` is safely within one of the allowed roots.
 * Prevents the /img route from acting as an arbitrary filesystem relay.
 */
function isAllowedPath(absPath) {
  const normalized = normalize(absPath);
  // Must match a known screenshot in the registry
  if (screenshotRegistry.has(normalized)) return true;
  // Or fall within workspace / cwd
  const roots = [trackedWorkspacePath, trackedCwd].filter(Boolean);
  for (const root of roots) {
    const normalRoot = normalize(root) + (root.endsWith('/') || root.endsWith('\\') ? '' : '/');
    if (normalized.startsWith(normalRoot)) return true;
  }
  return false;
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
    if (!entry) { jsonResponse(res, 404, { error: 'not_open' }); return; }
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

  // GET /img?path=<encoded> — serve image binary
  if (url.pathname === '/img' && req.method === 'GET') {
    const rawPath = url.searchParams.get('path');
    if (!rawPath) { jsonResponse(res, 400, { error: 'missing path' }); return; }

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
    server.once('error', (err) => { server.removeAllListeners('error'); reject(err); });
    server.listen(0, '127.0.0.1', () => { server.removeAllListeners('error'); resolve(); });
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
    onSessionStart: async (input) => { rememberPaths(input); },
    onUserPromptSubmitted: async (input) => { rememberPaths(input); },
    onPreToolUse: async (input) => { rememberPaths(input); },
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
    onPostToolUseFailure: async (input) => { rememberPaths(input); },
  },
  canvases: [
    createCanvas({
      id: 'screenshot-viewer',
      displayName: 'Screenshot Viewer',
      description:
        'Gallery of screenshots taken by agents in this session. Tracks Playwright screenshots live and scans common directories (files/visual-review/, workspace root) on demand.',
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
          title: 'Screenshot Viewer',
          status: count === 0 ? 'no screenshots yet' : `${count} screenshot${count === 1 ? '' : 's'}`,
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
