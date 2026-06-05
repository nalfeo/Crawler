/**
 * Fastify-based read-only sidecar for the sprite gallery lab.
 *
 * Responsibilities (this PR — read-only):
 *   - GET  /api/health                                                       — readiness probe
 *   - GET  /api/runs                                                         — list all runs
 *   - GET  /api/runs/:briefId/:runId                                         — full RunSummary JSON
 *   - GET  /api/runs/:briefId/:runId/processed/:filename                     — static-file from run dir
 *
 * Security contract (spec §F8):
 *   - The HTTP server MUST bind to 127.0.0.1 only. Binding is the CLI's job
 *     (`./cli.ts`); this module exposes only `buildServer(deps)` so tests
 *     can run requests through `inject()` without ever opening a socket.
 *   - The static-file route MUST validate that the resolved path stays
 *     inside the configured runsDir. A request like `../../etc/passwd`
 *     would otherwise expose the whole filesystem.
 *
 * No business logic lives here. The sidecar is a thin HTTP shell over file
 * IO — every meaningful piece is implemented (and unit-tested) in the
 * `scripts/sprites/` modules that the orchestrator already uses.
 */

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

export interface SidecarDeps {
  /** Repository root — used in /api/health for operator visibility. */
  readonly repoRoot: string;
  /** Absolute path to the runs directory (typically `<repoRoot>/generated/runs`). */
  readonly runsDir: string;
  /** Version string surfaced by /api/health for log correlation. */
  readonly version: string;
  /** Optional logger toggle. Defaults to off for tests, on for CLI. */
  readonly logger?: boolean;
}

export interface RunListEntry {
  readonly briefId: string;
  readonly runId: string;
  /** ISO timestamp parsed from the run-id prefix; null when unparseable. */
  readonly timestamp: string | null;
  /** Short prompt hash from `summary.json` when available. */
  readonly briefHash: string | null;
  /** Chosen variant index from `summary.json` when available. */
  readonly chosenIndex: number | null;
  /** Number of candidates in `summary.json` when available. */
  readonly candidateCount: number | null;
  /** True iff any candidate has a non-null judgeScorecard. */
  readonly hasJudge: boolean;
}

interface RunSummaryShape {
  readonly promptHash?: string;
  readonly chosen?: { readonly index?: number } | null;
  readonly candidates?: ReadonlyArray<{ readonly judgeScorecard?: unknown }>;
}

/**
 * Mime-type table for the only artifact types the gallery serves. Kept
 * tight on purpose — anything else returns 415 so an attacker can't trick
 * the sidecar into serving e.g. a `.bash_history` even if directory
 * traversal slipped past the guard.
 */
const ALLOWED_EXTENSIONS: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Build the Fastify instance. Does NOT call `.listen()` — that's the CLI's
 * job. Returning an unstarted instance keeps tests fast: they can use
 * `app.inject()` to fire requests through the router without ever opening
 * a port (and without the flakiness of port-in-use races).
 */
export function buildServer(deps: SidecarDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });

  // Permissive CORS for the lab dev server on localhost. We bind to 127.0.0.1
  // anyway so the only callers are local browsers, but Vite serves the lab
  // from a different port (e.g. 3002), so without CORS the browser refuses
  // the cross-origin fetch. Origin reflection is safe given the bind.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type');
      reply.code(204).send();
    }
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    repoRoot: deps.repoRoot,
    runsDir: deps.runsDir,
    version: deps.version,
  }));

  app.get('/api/runs', async () => ({ runs: listRuns(deps.runsDir) }));

  app.get<{ Params: { briefId: string; runId: string } }>(
    '/api/runs/:briefId/:runId',
    async (req, reply) => {
      const { briefId, runId } = req.params;
      const summaryPath = safeJoin(deps.runsDir, [briefId, runId, 'summary.json']);
      if (summaryPath === null || !existsSync(summaryPath)) {
        reply.code(404);
        return { error: 'run-not-found', briefId, runId };
      }
      const json = JSON.parse(readFileSync(summaryPath, 'utf8'));
      return json;
    },
  );

  app.get<{ Params: { briefId: string; runId: string; filename: string } }>(
    '/api/runs/:briefId/:runId/processed/:filename',
    async (req, reply) => {
      const { briefId, runId, filename } = req.params;
      const ext = path.extname(filename).toLowerCase();
      const mime = ALLOWED_EXTENSIONS[ext];
      if (!mime) {
        reply.code(415);
        return { error: 'unsupported-extension', filename };
      }
      const target = safeJoin(deps.runsDir, [briefId, runId, 'processed', filename]);
      if (target === null) {
        // safeJoin returns null on any traversal attempt — fail closed.
        reply.code(403);
        return { error: 'forbidden-path' };
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        reply.code(404);
        return { error: 'file-not-found', filename };
      }
      reply.header('Content-Type', mime);
      return reply.send(createReadStream(target));
    },
  );

  return app;
}

/**
 * Join a base dir with caller-supplied path segments and refuse anything
 * that escapes `base` after resolution. Returns null on any escape attempt
 * (including absolute-path segments) so callers can fail closed without
 * having to inspect the components themselves.
 *
 * Exported for tests so the path-traversal guard's contract is unit-pinned
 * separately from the routes that consume it.
 */
export function safeJoin(base: string, segments: ReadonlyArray<string>): string | null {
  const resolvedBase = path.resolve(base);
  for (const segment of segments) {
    // Reject anything with a path separator, drive letter, NUL byte, or
    // null/empty segment. Fastify route params normally can't contain `/`
    // but an attacker could URL-encode `%2f` or pass `..` directly.
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\') ||
      segment.includes('\0') ||
      path.isAbsolute(segment)
    ) {
      return null;
    }
  }
  const joined = path.resolve(resolvedBase, ...segments);
  const rel = path.relative(resolvedBase, joined);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return joined;
}

/**
 * Enumerate runs by scanning `<runsDir>/<briefId>/<runId>/summary.json`.
 * Returns an empty list when the directory doesn't exist (fresh checkout
 * with no runs yet). Quietly skips entries whose summary.json is missing
 * or unparseable rather than failing the whole endpoint — gallery should
 * show what's available even if one run is corrupt.
 *
 * Sorted newest-first by runId (timestamp-prefixed), so the gallery
 * naturally surfaces the most recent run at the top.
 */
export function listRuns(runsDir: string): RunListEntry[] {
  if (!existsSync(runsDir)) return [];
  const entries: RunListEntry[] = [];
  for (const briefId of safeReaddir(runsDir)) {
    const briefDir = path.join(runsDir, briefId);
    if (!statSync(briefDir).isDirectory()) continue;
    for (const runId of safeReaddir(briefDir)) {
      const runDir = path.join(briefDir, runId);
      if (!statSync(runDir).isDirectory()) continue;
      const summaryPath = path.join(runDir, 'summary.json');
      let summary: RunSummaryShape | null = null;
      if (existsSync(summaryPath)) {
        try {
          summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as RunSummaryShape;
        } catch {
          summary = null;
        }
      }
      entries.push({
        briefId,
        runId,
        timestamp: parseRunIdTimestamp(runId),
        briefHash: summary?.promptHash ?? null,
        chosenIndex: summary?.chosen?.index ?? null,
        candidateCount: summary?.candidates?.length ?? null,
        hasJudge: (summary?.candidates ?? []).some(
          (c) => c.judgeScorecard !== null && c.judgeScorecard !== undefined,
        ),
      });
    }
  }
  // Newest first: runId prefix is an ISO-ish timestamp, so descending
  // string sort is the right order.
  entries.sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
  return entries;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Parse the leading ISO timestamp out of a runId of the form
 * `YYYY-MM-DDTHH-mm-ss-<hash>`. Returns null when the format doesn't
 * match (e.g. legacy runs or hand-created directories).
 */
function parseRunIdTimestamp(runId: string): string | null {
  const m = runId.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
}
