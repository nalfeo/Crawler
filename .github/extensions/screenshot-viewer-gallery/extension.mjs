/**
 * screenshot-viewer — a deliberately simple live screenshot gallery.
 *
 * The A|B UX Testing extension owns lineage pairing, evaluator reports, and
 * feedback. This canvas intentionally does not infer scenarios from filenames.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, extname, join, normalize, resolve } from 'node:path';

import { createCanvas, joinSession } from '@github/copilot-sdk/extension';

import { renderHtml } from './renderer.mjs';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const POLL_INTERVAL_MS = 10_000;
const SCAN_MAX_DEPTH = 5;
const registry = new Map();
const servers = new Map();
let workspacePath = null;

function rememberWorkspace(input) {
  if (typeof input?.workingDirectory === 'string' && input.workingDirectory.trim()) {
    workspacePath = input.workingDirectory.trim();
  }
}

function register(path, source, takenAt = new Date().toISOString()) {
  const absolutePath = normalize(resolve(path));
  const existing = registry.get(absolutePath);
  registry.set(absolutePath, {
    path: absolutePath,
    filename: basename(absolutePath),
    source: source === 'live' || existing?.source === 'live' ? 'live' : 'scanned',
    takenAt: existing?.takenAt ?? takenAt,
  });
}

function screenshots() {
  return [...registry.values()].sort((a, b) => new Date(b.takenAt) - new Date(a.takenAt));
}

async function scanDir(directory, depth, paths) {
  if (depth <= 0) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scanDir(path, depth - 1, paths);
    if (entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) paths.push(path);
  }
}

async function scan() {
  if (!workspacePath) return;
  const paths = [];
  await scanDir(join(workspacePath, 'files'), SCAN_MAX_DEPTH, paths);
  await scanDir(workspacePath, 1, paths);
  const seen = new Set();
  for (const path of paths) {
    const absolutePath = normalize(resolve(path));
    seen.add(absolutePath);
    let takenAt = new Date().toISOString();
    try {
      takenAt = (await stat(absolutePath)).mtime.toISOString();
    } catch {}
    register(absolutePath, 'scanned', takenAt);
  }
  for (const [path, screenshot] of registry) {
    if (screenshot.source === 'scanned' && !seen.has(path)) registry.delete(path);
  }
}

function state() {
  return { screenshots: screenshots(), workspacePath, liveTracking: true, error: null };
}

function allowed(path) {
  const absolutePath = normalize(resolve(path));
  return IMAGE_EXTENSIONS.has(extname(absolutePath).toLowerCase()) && registry.has(absolutePath);
}

function tokenMatches(actual, expected) {
  return Boolean(actual && expected && actual === expected);
}

function respondJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function notify(instanceId) {
  const entry = servers.get(instanceId);
  if (!entry) return;
  const payload = `data: ${JSON.stringify(state())}\n\n`;
  for (const response of entry.clients) response.write(payload);
}

async function handle(instanceId, token, request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (!tokenMatches(url.searchParams.get('token'), token)) {
    respondJson(response, 403, { error: 'forbidden' });
    return;
  }
  if (url.pathname === '/' && request.method === 'GET') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'self'",
    });
    response.end(renderHtml({ instanceId, pollIntervalMs: POLL_INTERVAL_MS }));
    return;
  }
  if (url.pathname === '/events' && request.method === 'GET') {
    const entry = servers.get(instanceId);
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
    });
    entry.clients.add(response);
    request.on('close', () => entry.clients.delete(response));
    response.write(`data: ${JSON.stringify(state())}\n\n`);
    return;
  }
  if (url.pathname === '/api/state' && request.method === 'GET') {
    respondJson(response, 200, state());
    return;
  }
  if (url.pathname === '/api/refresh' && request.method === 'POST') {
    await scan();
    notify(instanceId);
    respondJson(response, 200, state());
    return;
  }
  if (url.pathname === '/img' && request.method === 'GET') {
    const path = url.searchParams.get('path');
    if (!path || !allowed(path)) {
      respondJson(response, 403, { error: 'path not allowed' });
      return;
    }
    const absolutePath = normalize(resolve(path));
    try {
      const bytes = readFileSync(absolutePath);
      response.writeHead(200, {
        'Content-Type':
          extname(absolutePath).toLowerCase() === '.webp' ? 'image/webp' : 'image/png',
        'Content-Length': bytes.byteLength,
        'Cache-Control': 'no-store',
      });
      response.end(bytes);
    } catch {
      respondJson(response, 404, { error: 'not found' });
    }
    return;
  }
  respondJson(response, 404, { error: 'not found' });
}

async function startServer(instanceId, token) {
  const clients = new Set();
  const server = createServer((request, response) => {
    handle(instanceId, token, request, response).catch((error) => {
      respondJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { server, clients, token, url: `http://127.0.0.1:${address.port}/` };
}

await joinSession({
  hooks: {
    onSessionStart: rememberWorkspace,
    onUserPromptSubmitted: rememberWorkspace,
    onPreToolUse: rememberWorkspace,
    onPostToolUse: async (input) => {
      rememberWorkspace(input);
      if (input.toolName !== 'playwright-browser_take_screenshot') return;
      const filename = input.toolArgs?.filename;
      if (typeof filename !== 'string' || !filename.trim()) return;
      const path = resolve(input.workingDirectory ?? workspacePath ?? process.cwd(), filename);
      if (!existsSync(path)) return;
      register(path, 'live');
      for (const instanceId of servers.keys()) notify(instanceId);
    },
  },
  canvases: [
    createCanvas({
      id: 'screenshot-viewer',
      displayName: 'Screenshot Viewer',
      description: 'Simple live gallery of every screenshot captured in this session.',
      actions: [
        {
          name: 'list_screenshots',
          description: 'Return every screenshot discovered in this session.',
          handler: async () => {
            await scan();
            return { screenshots: screenshots(), count: registry.size };
          },
        },
        {
          name: 'refresh',
          description: 'Rescan screenshot files.',
          handler: async () => {
            await scan();
            for (const instanceId of servers.keys()) notify(instanceId);
            return { screenshots: screenshots(), count: registry.size };
          },
        },
      ],
      open: async (ctx) => {
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          entry = await startServer(ctx.instanceId, randomBytes(16).toString('hex'));
          servers.set(ctx.instanceId, entry);
        }
        await scan();
        return {
          title: 'Screenshot Viewer',
          status: registry.size === 1 ? '1 screenshot' : `${registry.size} screenshots`,
          url: `${entry.url}?token=${entry.token}`,
        };
      },
      onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (!entry) return;
        servers.delete(ctx.instanceId);
        for (const response of entry.clients) response.end();
        await new Promise((resolve) => entry.server.close(resolve));
      },
    }),
  ],
});
