// Extension: agent-perf-panel
// Visualise where Crawler agent sessions spend time, tokens, and context-window
// budget. All data is local (~/.copilot/session-store.db + per-session
// events.jsonl) — no network calls, no telemetry pushed outward.
//
// The extension boots a loopback HTTP server per open canvas instance. Routes:
//   GET /                      → single-page HTML (renderer.mjs)
//   GET /api/repositories      → distinct repos with session counts
//   GET /api/sessions          → filtered session list
//   GET /api/session/:id       → analyzed summary for one session
//   GET /api/aggregate         → cross-session rollup for a date range
//
// The same three data primitives are also exposed as agent-callable actions
// so subagents can query perf data programmatically.

import { createServer } from 'node:http';
import { joinSession, createCanvas, CanvasError } from '@github/copilot-sdk/extension';
import { renderHtml } from './renderer.mjs';
import { analyzeSession } from './analyzer.mjs';
import { listSessions, getSessionMetadata, listRepositories } from './sessions-db.mjs';
import { aggregate } from './aggregator.mjs';

const servers = new Map(); // instanceId → { server, url }

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function errorResponse(res, status, message) {
  jsonResponse(res, status, { error: message });
}

async function handleRequest(req, res, sessionLogger) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const q = url.searchParams;

    if (p === '/' || p === '/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(renderHtml());
      return;
    }

    if (p === '/api/repositories') {
      return jsonResponse(res, 200, { repositories: listRepositories() });
    }

    if (p === '/api/sessions') {
      const opts = {
        repository: q.get('repository') || undefined,
        sinceIso: q.get('sinceIso') || undefined,
        untilIso: q.get('untilIso') || undefined,
        limit: q.get('limit') ? Math.min(2000, parseInt(q.get('limit'), 10) || 400) : 400,
      };
      return jsonResponse(res, 200, { sessions: listSessions(opts) });
    }

    // /api/session/<id>
    if (p.startsWith('/api/session/')) {
      const id = decodeURIComponent(p.slice('/api/session/'.length));
      if (!id) return errorResponse(res, 400, 'missing session id');
      const meta = getSessionMetadata(id);
      const summary = await analyzeSession(id);
      if (!summary) return errorResponse(res, 404, 'no event log for session ' + id);
      // Fold in repo/branch from the SQLite mirror (chat sessions don't carry it in the log).
      if (meta) {
        summary.repository = summary.repository || meta.repository || null;
        summary.branch = summary.branch || meta.branch || null;
        summary.summaryText = meta.summary || null;
      }
      return jsonResponse(res, 200, summary);
    }

    if (p === '/api/aggregate') {
      const filter = {
        repository: q.get('repository') || undefined,
        sinceIso: q.get('sinceIso') || undefined,
        untilIso: q.get('untilIso') || undefined,
        limit: q.get('limit') ? Math.min(2000, parseInt(q.get('limit'), 10) || 200) : 200,
      };
      const result = await aggregate(filter);
      return jsonResponse(res, 200, result);
    }

    errorResponse(res, 404, 'not found: ' + p);
  } catch (e) {
    sessionLogger?.log?.('agent-perf-panel error: ' + (e?.stack || e?.message || e));
    errorResponse(res, 500, e?.message || String(e));
  }
}

async function startServer(sessionLogger) {
  const server = createServer((req, res) => {
    handleRequest(req, res, sessionLogger);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
  canvases: [
    createCanvas({
      id: 'agent-perf-panel',
      displayName: 'Agent Perf Panel',
      description:
        'Investigate agent/subagent/skill performance: waterfalls, long poles, parallel-vs-serial time, tokens, and context-window budget across Crawler work sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Optional session ID to pre-select on open.' },
          repository: { type: 'string', description: 'Optional repo filter (e.g. "nalfeo/Crawler").' },
        },
      },
      actions: [
        {
          name: 'list_sessions',
          description: 'List Copilot sessions from the local session store, optionally filtered by repository and time range.',
          inputSchema: {
            type: 'object',
            properties: {
              repository: { type: 'string' },
              sinceIso: { type: 'string', description: 'ISO 8601; sessions updated at or after this time.' },
              untilIso: { type: 'string' },
              limit: { type: 'integer', minimum: 1, maximum: 2000 },
            },
          },
          handler: async (ctx) => {
            const sessions = listSessions(ctx.input || {});
            return { sessions };
          },
        },
        {
          name: 'analyze_session',
          description: 'Compute a rich per-session performance summary from the local events.jsonl log.',
          inputSchema: {
            type: 'object',
            properties: { sessionId: { type: 'string' } },
            required: ['sessionId'],
          },
          handler: async (ctx) => {
            const summary = await analyzeSession(ctx.input.sessionId);
            if (!summary) throw new CanvasError('not_found', 'No event log for session ' + ctx.input.sessionId);
            const meta = getSessionMetadata(ctx.input.sessionId);
            if (meta) {
              summary.repository = summary.repository || meta.repository || null;
              summary.branch = summary.branch || meta.branch || null;
              summary.summaryText = meta.summary || null;
            }
            return summary;
          },
        },
        {
          name: 'aggregate',
          description: 'Cross-session rollup (tools, models, totals) for a repository and date range.',
          inputSchema: {
            type: 'object',
            properties: {
              repository: { type: 'string' },
              sinceIso: { type: 'string' },
              untilIso: { type: 'string' },
              limit: { type: 'integer', minimum: 1, maximum: 2000 },
            },
          },
          handler: async (ctx) => aggregate(ctx.input || {}),
        },
      ],
      open: async (ctx) => {
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          entry = await startServer(session);
          servers.set(ctx.instanceId, entry);
        }
        // Pass optional pre-selection via URL fragment so the SPA can read it.
        const frag = [];
        if (ctx.input?.sessionId) frag.push('session=' + encodeURIComponent(ctx.input.sessionId));
        if (ctx.input?.repository) frag.push('repo=' + encodeURIComponent(ctx.input.repository));
        const url = frag.length ? entry.url + '#' + frag.join('&') : entry.url;
        return { title: '⚡ Agent Perf', url };
      },
      onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (entry) {
          servers.delete(ctx.instanceId);
          await new Promise((r) => entry.server.close(() => r()));
        }
      },
    }),
  ],
});
