// Extension: sweep-results-viewer
// Canvas for viewing weapon-sweep results (300-run Floor 1 sweeps): per-weapon
// win rate, score, and per-seed detail. Reads the JSON emitted by
// `npm run ai:weapon-sweep` (scripts/agent/perf/weapon-sweep.ts, default
// output /tmp/weapon-sweep.json).

import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { joinSession, createCanvas, CanvasError } from '@github/copilot-sdk/extension';
import { renderHtml } from './renderer.mjs';

const DEFAULT_PATH = '/tmp/weapon-sweep.json';

const servers = new Map(); // instanceId → { server, url }
const states = new Map(); // instanceId → { path, data, error, loadedAt }
const sseClients = new Map(); // instanceId → Set<res>

async function loadData(path) {
  const stats = await stat(path);
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw);
  return { data: parsed, loadedAt: stats.mtimeMs };
}

function stateSnapshot(state) {
  return {
    path: state.path,
    error: state.error ?? null,
    loadedAt: state.loadedAt ?? null,
    data: state.data ?? null,
  };
}

function notifyClients(instanceId) {
  const clients = sseClients.get(instanceId);
  if (!clients || clients.size === 0) return;
  const state = states.get(instanceId);
  if (!state) return;
  const payload = `data: ${JSON.stringify(stateSnapshot(state))}\n\n`;
  for (const res of clients) res.write(payload);
}

async function refreshState(instanceId, path) {
  const state = states.get(instanceId) ?? { path };
  state.path = path;
  try {
    const { data, loadedAt } = await loadData(path);
    state.data = data;
    state.loadedAt = loadedAt;
    state.error = null;
  } catch (err) {
    state.data = null;
    state.loadedAt = null;
    state.error = err instanceof Error ? err.message : String(err);
  }
  states.set(instanceId, state);
  notifyClients(instanceId);
  return state;
}

async function startServer(instanceId) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      if (!sseClients.has(instanceId)) sseClients.set(instanceId, new Set());
      sseClients.get(instanceId).add(res);
      req.on('close', () => sseClients.get(instanceId)?.delete(res));
      const state = states.get(instanceId);
      if (state) res.write(`data: ${JSON.stringify(stateSnapshot(state))}\n\n`);
      return;
    }

    if (url.pathname === '/api/state') {
      res.setHeader('Content-Type', 'application/json');
      const state = states.get(instanceId);
      res.end(JSON.stringify(state ? stateSnapshot(state) : { data: null, error: 'not_open' }));
      return;
    }

    if (url.pathname === '/api/reload' && req.method === 'POST') {
      const state = states.get(instanceId);
      if (!state) {
        res.statusCode = 404;
        res.end('{"error":"not_open"}');
        return;
      }
      refreshState(instanceId, state.path).then((s) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(stateSnapshot(s)));
      });
      return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderHtml(instanceId));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
  canvases: [
    createCanvas({
      id: 'sweep-results-viewer',
      displayName: 'Sweep Results Viewer',
      description:
        'View weapon-sweep results (per-weapon win rate + per-seed drill-down). ' +
        'Reads the JSON emitted by `npm run ai:weapon-sweep` (default /tmp/weapon-sweep.json).',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Absolute path to a weapon-sweep JSON file. Defaults to /tmp/weapon-sweep.json.',
          },
        },
      },
      actions: [
        {
          name: 'load_file',
          description: 'Load (or reload) a weapon-sweep JSON file into this canvas.',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Absolute path to the JSON file to load.',
              },
            },
            required: ['path'],
          },
          handler: async (ctx) => {
            if (!states.has(ctx.instanceId)) {
              throw new CanvasError('no_state', 'Canvas not open');
            }
            const state = await refreshState(ctx.instanceId, ctx.input.path);
            return {
              ok: !state.error,
              error: state.error,
              path: state.path,
              summaries: state.data?.summaries?.map((s) => ({
                weapon: s.weapon,
                runs: s.runs,
                winRate: s.winRate,
                meanScore: s.meanScore,
              })),
            };
          },
        },
        {
          name: 'reload',
          description: 'Reload the current file from disk.',
          handler: async (ctx) => {
            const state = states.get(ctx.instanceId);
            if (!state) throw new CanvasError('no_state', 'Canvas not open');
            const refreshed = await refreshState(ctx.instanceId, state.path);
            return { ok: !refreshed.error, error: refreshed.error, path: refreshed.path };
          },
        },
        {
          name: 'get_summary',
          description: 'Get per-weapon summary rows for the currently loaded sweep.',
          handler: async (ctx) => {
            const state = states.get(ctx.instanceId);
            if (!state) throw new CanvasError('no_state', 'Canvas not open');
            if (!state.data) return { ok: false, error: state.error ?? 'no_data' };
            return {
              ok: true,
              path: state.path,
              runAt: state.data.runAt,
              seeds: state.data.seeds,
              weapons: state.data.weapons,
              summaries: state.data.summaries?.map((s) => ({
                weapon: s.weapon,
                runs: s.runs,
                victories: s.victories,
                winRate: s.winRate,
                meanScore: s.meanScore,
                meanGameTimeSec: s.meanGameTimeSec,
                meanLevel: s.meanLevel,
                meanKills: s.meanKills,
                meanMinHealthPct: s.meanMinHealthPct,
              })),
            };
          },
        },
      ],
      open: async (ctx) => {
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          entry = await startServer(ctx.instanceId);
          servers.set(ctx.instanceId, entry);
        }
        const path = ctx.input?.path ?? DEFAULT_PATH;
        await refreshState(ctx.instanceId, path);
        return { title: '🗡️ Sweep Results', url: entry.url };
      },
      onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (entry) {
          servers.delete(ctx.instanceId);
          await new Promise((r) => entry.server.close(() => r()));
        }
        states.delete(ctx.instanceId);
        sseClients.delete(ctx.instanceId);
      },
    }),
  ],
});

// Keep the session reference alive.
void session;
