/**
 * Fastify-based sidecar for the sprite gallery lab.
 *
 * Responsibilities:
 *   - GET  /api/health                                                       — readiness probe
 *   - GET  /api/runs                                                         — list all runs
 *   - GET  /api/runs/:briefId/:runId                                         — full RunSummary JSON
 *   - GET  /api/runs/:briefId/:runId/processed/:filename                     — static-file from run dir
 *   - POST /api/runs/:briefId/:runId/approve                                 — approve a variant (mutating)
 *
 * Security contract (spec §F8):
 *   - The HTTP server MUST bind to 127.0.0.1 only. Binding is the CLI's job
 *     (`./cli.ts`); this module exposes only `buildServer(deps)` so tests
 *     can run requests through `inject()` without ever opening a socket.
 *   - The static-file route MUST validate that the resolved path stays
 *     inside the configured runsDir. A request like `../../etc/passwd`
 *     would otherwise expose the whole filesystem.
 *   - The approve route MUST refuse when `process.env.CI` is set
 *     (Constitutional §3 — no LLM-as-judge / no checked-in mutation from
 *     CI gates). Same pattern as `judge.ts`.
 *
 * No business logic lives here. The sidecar is a thin HTTP shell over file
 * IO — every meaningful piece is implemented (and unit-tested) in the
 * `scripts/sprites/` modules that the orchestrator already uses.
 */

import { createReadStream, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { approveVariant, ApproveError, type ManifestEntry } from '../approve.js';

export interface SidecarDeps {
  /** Repository root — used in /api/health for operator visibility. */
  readonly repoRoot: string;
  /** Absolute path to the runs directory (typically `<repoRoot>/generated/runs`). */
  readonly runsDir: string;
  /** Version string surfaced by /api/health for log correlation. */
  readonly version: string;
  /** Optional logger toggle. Defaults to off for tests, on for CLI. */
  readonly logger?: boolean;
  /**
   * Absolute path to `public/assets/` (parent of `generated/`). Required
   * for the approve route's PNG copy destination. Defaults to
   * `<repoRoot>/public/assets`. Exposed so tests can point at a tmp dir.
   */
  readonly publicAssetsDir?: string;
  /**
   * Absolute path to `public/assets/generated/manifest.json`. Defaults to
   * `<publicAssetsDir>/generated/manifest.json`.
   */
  readonly manifestPath?: string;
  /**
   * Environment snapshot the approve route consults for the CI refusal.
   * Defaults to `process.env`. Inject `{}` (or `{ CI: undefined }`) in
   * tests to exercise the non-CI path even when the host runs in CI.
   */
  readonly env?: NodeJS.ProcessEnv;
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

  // Vite serves the lab from a different loopback port, so allow CORS only
  // for loopback origins (localhost/127.0.0.1/::1).
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && isAllowedOrigin(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type');
      // `return reply` short-circuits Fastify routing after the preflight
      // is sent so the request can't fall through to a route handler and
      // trigger a "Reply already sent" warning.
      return reply.code(204).send();
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
      if (summaryPath === null) {
        // safeJoin rejected a traversal attempt — mirror the static-file
        // route's 403 so probes are distinguishable from "missing run".
        reply.code(403);
        return { error: 'forbidden-path' };
      }
      if (!existsSync(summaryPath)) {
        reply.code(404);
        return { error: 'run-not-found', briefId, runId };
      }
      let raw: string;
      try {
        raw = readFileSync(summaryPath, 'utf8');
      } catch {
        // TOCTOU: summary may have been deleted between existsSync and readFileSync.
        reply.code(404);
        return { error: 'run-not-found', briefId, runId };
      }
      try {
        return JSON.parse(raw);
      } catch {
        // Corrupt or mid-write JSON (e.g. concurrent sprites:run).
        reply.code(500);
        return { error: 'summary-invalid', briefId, runId };
      }
    },
  );

  app.get<{ Params: { briefId: string; runId: string } }>(
    '/api/runs/:briefId/:runId/brief',
    async (req, reply) => {
      const { briefId, runId } = req.params;
      const summaryPath = safeJoin(deps.runsDir, [briefId, runId, 'summary.json']);
      if (summaryPath === null) {
        reply.code(403);
        return { error: 'forbidden-path' };
      }
      if (!existsSync(summaryPath)) {
        reply.code(404);
        return { error: 'run-not-found', briefId, runId };
      }
      let summary: { briefPath?: string; prompt?: string };
      try {
        summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
      } catch {
        reply.code(500);
        return { error: 'summary-invalid', briefId, runId };
      }

      let briefYaml: string | null = null;
      if (typeof summary.briefPath === 'string' && summary.briefPath !== '') {
        // Resolve brief path safely — must stay under repoRoot.
        const resolved = path.isAbsolute(summary.briefPath)
          ? summary.briefPath
          : path.resolve(deps.repoRoot, summary.briefPath);
        const rel = path.relative(deps.repoRoot, resolved);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
          try {
            briefYaml = readFileSync(resolved, 'utf8');
          } catch {
            briefYaml = null;
          }
        }
      }

      return {
        briefId,
        runId,
        briefYaml,
        promptText: typeof summary.prompt === 'string' ? summary.prompt : null,
      };
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
      if (!existsSync(target)) {
        reply.code(404);
        return { error: 'file-not-found', filename };
      }
      // Single statSync after existsSync, then catch ENOENT racing the
      // existsSync->statSync window. Belt-and-braces against TOCTOU when
      // a run is mid-write or being cleaned up.
      let stat;
      try {
        stat = statSync(target);
      } catch {
        reply.code(404);
        return { error: 'file-not-found', filename };
      }
      if (!stat.isFile()) {
        reply.code(404);
        return { error: 'file-not-found', filename };
      }
      reply.header('Content-Type', mime);
      return reply.send(createReadStream(target));
    },
  );

  app.post<{
    Params: { briefId: string; runId: string };
    Body: { variantIndex?: unknown };
  }>('/api/runs/:briefId/:runId/approve', async (req, reply) => {
    // Constitutional §3 (Deterministic CI Only): the approve route mutates
    // checked-in repo state. We refuse from CI for the same reason
    // judge.ts does — checked-in mutations from a CI gate would let the
    // sidecar become an oracle that drifts away from local repro.
    const env = deps.env ?? process.env;
    if (env.CI !== undefined) {
      reply.code(403);
      return {
        error: 'ci-refused',
        message:
          'Per Constitutional §3, the sprite-pipeline approve endpoint is local-only. ' +
          'It mutates checked-in assets under public/assets/generated/ and the manifest. ' +
          'Run the gallery sidecar locally (npm run sprites:gallery) to approve.',
      };
    }

    const { briefId, runId } = req.params;
    const runDir = safeJoin(deps.runsDir, [briefId, runId]);
    if (runDir === null) {
      reply.code(403);
      return { error: 'forbidden-path' };
    }
    if (!existsSync(path.join(runDir, 'summary.json'))) {
      reply.code(404);
      return { error: 'run-not-found', briefId, runId };
    }

    const body = (req.body ?? {}) as { variantIndex?: unknown };
    const variantIndex = body.variantIndex;
    if (typeof variantIndex !== 'number' || !Number.isInteger(variantIndex) || variantIndex < 0) {
      reply.code(400);
      return {
        error: 'bad-request',
        message: 'body.variantIndex must be a non-negative integer',
      };
    }

    const publicAssetsDir = deps.publicAssetsDir ?? path.join(deps.repoRoot, 'public', 'assets');
    const manifestPath =
      deps.manifestPath ?? path.join(publicAssetsDir, 'generated', 'manifest.json');

    let entry: ManifestEntry;
    try {
      entry = approveVariant({
        runDir,
        variantIndex,
        manifestPath,
        publicAssetsDir,
        repoRoot: deps.repoRoot,
      });
    } catch (err) {
      if (err instanceof ApproveError) {
        // variant-not-found / processed-missing -> 404 (resource missing).
        // summary-invalid / manifest-invalid    -> 500 (server-side data corruption).
        // run-not-found                          -> 404.
        const status =
          err.kind === 'variant-not-found' ||
          err.kind === 'processed-missing' ||
          err.kind === 'run-not-found'
            ? 404
            : 500;
        reply.code(status);
        return { error: err.kind, message: err.message };
      }
      reply.code(500);
      return {
        error: 'approve-failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    return entry;
  });

  // DELETE /api/runs/:briefId/:runId — remove an entire run directory.
  // Used by the gallery UI to dismiss/cleanup experiments that are done.
  app.delete<{ Params: { briefId: string; runId: string } }>(
    '/api/runs/:briefId/:runId',
    async (req, reply) => {
      const { briefId, runId } = req.params;
      const runDir = safeJoin(deps.runsDir, [briefId, runId]);
      if (runDir === null) {
        reply.code(403);
        return { error: 'forbidden-path' };
      }
      if (!existsSync(runDir)) {
        reply.code(404);
        return { error: 'run-not-found', briefId, runId };
      }
      // Recursively remove the run directory.
      rmSync(runDir, { recursive: true, force: true });

      // If the briefId directory is now empty, remove it too.
      const briefDir = path.join(deps.runsDir, briefId);
      if (existsSync(briefDir)) {
        const remaining = readdirSync(briefDir);
        if (remaining.length === 0) {
          rmSync(briefDir, { recursive: true, force: true });
        }
      }

      return { ok: true, deleted: `${briefId}/${runId}` };
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
    if (!safeIsDirectory(briefDir)) continue;
    for (const runId of safeReaddir(briefDir)) {
      const runDir = path.join(briefDir, runId);
      if (!safeIsDirectory(runDir)) continue;
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

function safeIsDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    return (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1'
    );
  } catch {
    return false;
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
