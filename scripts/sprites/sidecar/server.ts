/**
 * Fastify-based sidecar for the sprite gallery lab.
 *
 * Responsibilities:
 *   - GET  /api/health                                                       — readiness probe
 *   - GET  /api/runs                                                         — list all runs
 *   - GET  /api/runs/:briefId/:runId                                         — full RunSummary JSON
 *   - GET  /api/runs/:briefId/:runId/sheets                                  — list source sheet PNGs
 *   - GET  /api/runs/:briefId/:runId/sheet/:filename                         — source sheet PNG bytes
 *   - GET  /api/runs/:briefId/:runId/processed/:filename                     — static-file from run dir
 *   - GET  /api/runs/:briefId/:runId/raw/:filename                           — raw (pre-pipeline) cell PNG
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

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { approveVariant, ApproveError, type ManifestEntry } from '../approve.js';
import { SPRITE_TYPES, type Brief } from '../brief-schema.js';
import { generateOne } from '../generate-one.js';
import {
  DEFAULT_CATALOG_PATH,
  resolveProvider,
  runMetadataPipeline,
  type MetadataProviderMode,
} from '../metadata-pipeline.js';
import {
  createImageProvider,
  createSynthProvider,
  createTextProvider,
  createVisionProvider,
} from '../provider/factory.js';
import { NoopAssetQueue } from '../queue/noop-queue.js';
import type { AssetQueue } from '../queue/types.js';
import { computeSliceMapV2 } from '../slice-sheet.js';
import { synthesizeBrief } from '../synthesize-brief.js';
import { loadBrief } from '../load-brief.js';
import { parseSpriteCatalog } from '../../../src/shared/sprite-catalog.js';
import { LocalRunStore } from '../store/local-store.js';
import type { RunStore } from '../store/types.js';

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
   * Absolute path to `src/shared/data/sprite-catalog.json`. Defaults to
   * `<repoRoot>/src/shared/data/sprite-catalog.json`.
   */
  readonly catalogPath?: string;
  /**
   * Environment snapshot the approve route consults for the CI refusal.
   * Defaults to `process.env`. Inject `{}` (or `{ CI: undefined }`) in
   * tests to exercise the non-CI path even when the host runs in CI.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * RunStore used to list and serve run artifacts. Defaults to a
   * `LocalRunStore` rooted at `runsDir` so existing local workflows are
   * unaffected. Pass an `AzureBlobRunStore` to read from Azure Blob Storage.
   */
  readonly store?: RunStore;
  /**
   * AssetQueue used to submit generation requests. Defaults to a no-op queue
   * so local sidecar usage keeps the prior synchronous generate behavior.
   */
  readonly queue?: AssetQueue;
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

interface WorkflowSynthesizeBody {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly candidates?: unknown;
}

interface WorkflowPromoteBody {
  readonly sourceYamlPath?: unknown;
  readonly type?: unknown;
  readonly name?: unknown;
  readonly target?: unknown;
}

interface WorkflowGenerateBody {
  readonly briefPath?: unknown;
}

interface WorkflowMetadataBody {
  readonly ids?: unknown;
  readonly force?: unknown;
  readonly provider?: unknown;
  readonly minScore?: unknown;
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
  // Default to a LocalRunStore rooted at runsDir — same layout as before.
  const store: RunStore = deps.store ?? new LocalRunStore(deps.runsDir);
  const queue: AssetQueue = deps.queue ?? new NoopAssetQueue();

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
    storeBackend: store.backend,
    queueBackend: queue.backend,
  }));

  app.get('/api/runs', async () => ({ runs: await listRunsFromStore(store) }));

  app.get<{ Params: { briefId: string; runId: string } }>(
    '/api/runs/:briefId/:runId',
    async (req, reply) => {
      const { briefId, runId } = req.params;
      // safeJoin validates that briefId/runId contain no path separators,
      // traversal sequences, or absolute-path components before we interpolate
      // them into a store key. The returned path is discarded — only the
      // null/non-null result matters as the security gate.
      if (safeJoin(deps.runsDir, [briefId, runId, 'summary.json']) === null) {
        reply.code(403);
        return { error: 'forbidden-path' };
      }
      const summaryKey = `${briefId}/${runId}/summary.json`;
      if (!(await store.has(summaryKey))) {
        reply.code(404);
        return { error: 'run-not-found', briefId, runId };
      }
      let raw: string;
      try {
        raw = (await store.get(summaryKey)).toString('utf8');
      } catch {
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
      // safeJoin as segment validator — see /api/runs/:briefId/:runId for rationale.
      if (safeJoin(deps.runsDir, [briefId, runId, 'summary.json']) === null) {
        reply.code(403);
        return { error: 'forbidden-path' };
      }
      const summaryKey = `${briefId}/${runId}/summary.json`;
      if (!(await store.has(summaryKey))) {
        reply.code(404);
        return { error: 'run-not-found', briefId, runId };
      }
      let summary: { briefPath?: string; prompt?: string };
      try {
        summary = JSON.parse((await store.get(summaryKey)).toString('utf8'));
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
    '/api/runs/:briefId/:runId/sheet/:filename',
    async (req, reply) => {
      const { briefId, runId, filename } = req.params;
      if (!/^sheet-\d+\.png$/i.test(filename)) {
        reply.code(415);
        return { error: 'unsupported-sheet-filename', filename };
      }
      // safeJoin as segment validator — see /api/runs/:briefId/:runId for rationale.
      if (safeJoin(deps.runsDir, [briefId, runId, filename]) === null) {
        reply.code(403);
        return { error: 'forbidden-path' };
      }
      const fileKey = `${briefId}/${runId}/${filename}`;
      if (!(await store.has(fileKey))) {
        reply.code(404);
        return { error: 'file-not-found', filename };
      }
      let fileData: Buffer;
      try {
        fileData = await store.get(fileKey);
      } catch {
        reply.code(404);
        return { error: 'file-not-found', filename };
      }
      reply.header('Content-Type', 'image/png');
      return reply.send(fileData);
    },
  );

  app.get<{ Params: { briefId: string; runId: string } }>(
    '/api/runs/:briefId/:runId/sheets',
    async (req, reply) => {
      const { briefId, runId } = req.params;
      // safeJoin as segment validator — see /api/runs/:briefId/:runId for rationale.
      if (safeJoin(deps.runsDir, [briefId, runId, 'summary.json']) === null) {
        reply.code(403);
        return { error: 'forbidden-path' };
      }
      const runPrefix = `${briefId}/${runId}/`;
      const keys = await store.list(runPrefix);
      const files = keys
        .filter((key) => /^sheet-\d+\.png$/i.test(key.slice(runPrefix.length)))
        .map((key) => key.slice(runPrefix.length))
        .sort((a, b) => a.localeCompare(b));
      return { files };
    },
  );

  app.get<{ Params: { briefId: string; runId: string }; Querystring: { sheet?: string } }>(
    '/api/runs/:briefId/:runId/slice-map',
    async (req, reply) => {
      const { briefId, runId } = req.params;
      if (safeJoin(deps.runsDir, [briefId, runId, 'summary.json']) === null) {
        reply.code(403);
        return { error: 'forbidden-path' };
      }
      const summaryKey = `${briefId}/${runId}/summary.json`;
      if (!(await store.has(summaryKey))) {
        reply.code(404);
        return { error: 'run-not-found', briefId, runId };
      }
      let summary: { briefPath?: string };
      try {
        summary = JSON.parse((await store.get(summaryKey)).toString('utf8'));
      } catch {
        reply.code(500);
        return { error: 'summary-invalid' };
      }
      if (typeof summary.briefPath !== 'string') {
        reply.code(404);
        return { error: 'brief-path-missing' };
      }
      const resolved = path.isAbsolute(summary.briefPath)
        ? summary.briefPath
        : path.resolve(deps.repoRoot, summary.briefPath);
      const rel = path.relative(deps.repoRoot, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        reply.code(403);
        return { error: 'forbidden-brief-path' };
      }
      let brief: Brief;
      try {
        brief = loadBrief(resolved).brief;
      } catch {
        reply.code(500);
        return { error: 'brief-load-failed' };
      }
      const runPrefix = `${briefId}/${runId}/`;
      const keys = await store.list(runPrefix);
      const sheetFiles = keys
        .filter((key) => /^sheet-\d+\.png$/i.test(key.slice(runPrefix.length)))
        .map((key) => key.slice(runPrefix.length))
        .sort((a, b) => a.localeCompare(b));
      if (sheetFiles.length === 0) {
        reply.code(404);
        return { error: 'sheet-not-found' };
      }
      const requestedSheet = req.query.sheet;
      let sheetFile = sheetFiles[sheetFiles.length - 1]!;
      if (typeof requestedSheet === 'string' && requestedSheet.length > 0) {
        if (!/^sheet-\d+\.png$/i.test(requestedSheet)) {
          reply.code(415);
          return { error: 'unsupported-sheet-filename', sheet: requestedSheet };
        }
        if (!sheetFiles.includes(requestedSheet)) {
          reply.code(404);
          return { error: 'sheet-not-found', sheet: requestedSheet };
        }
        sheetFile = requestedSheet;
      }
      const sheetKey = `${briefId}/${runId}/${sheetFile}`;
      let sheetPng: Buffer;
      try {
        sheetPng = await store.get(sheetKey);
      } catch {
        reply.code(404);
        return { error: 'sheet-not-found' };
      }
      try {
        const sliceMap = computeSliceMapV2(sheetPng, {
          emptyCells: brief.generation.sheet.emptyCells,
        });
        return { ...sliceMap, sheetFile, algorithm: 'v2' };
      } catch (err) {
        reply.code(500);
        return { error: 'slice-failed', message: String(err) };
      }
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
      // safeJoin as segment validator — see /api/runs/:briefId/:runId for rationale.
      if (safeJoin(deps.runsDir, [briefId, runId, 'processed', filename]) === null) {
        reply.code(403);
        return { error: 'forbidden-path' };
      }
      const fileKey = `${briefId}/${runId}/processed/${filename}`;
      if (!(await store.has(fileKey))) {
        reply.code(404);
        return { error: 'file-not-found', filename };
      }
      let fileData: Buffer;
      try {
        fileData = await store.get(fileKey);
      } catch {
        reply.code(404);
        return { error: 'file-not-found', filename };
      }
      reply.header('Content-Type', mime);
      return reply.send(fileData);
    },
  );

  app.get<{ Params: { briefId: string; runId: string; filename: string } }>(
    '/api/runs/:briefId/:runId/raw/:filename',
    async (req, reply) => {
      const { briefId, runId, filename } = req.params;
      const ext = path.extname(filename).toLowerCase();
      if (ext !== '.png') {
        reply.code(415);
        return { error: 'unsupported-extension', filename };
      }
      if (safeJoin(deps.runsDir, [briefId, runId, 'raw', filename]) === null) {
        reply.code(403);
        return { error: 'forbidden-path' };
      }
      const fileKey = `${briefId}/${runId}/raw/${filename}`;
      if (!(await store.has(fileKey))) {
        reply.code(404);
        return { error: 'file-not-found', filename };
      }
      let fileData: Buffer;
      try {
        fileData = await store.get(fileKey);
      } catch {
        reply.code(404);
        return { error: 'file-not-found', filename };
      }
      reply.header('Content-Type', 'image/png');
      return reply.send(fileData);
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
    if (safeJoin(deps.runsDir, [briefId, runId, 'summary.json']) === null) {
      reply.code(403);
      return { error: 'forbidden-path' };
    }
    const summaryKey = `${briefId}/${runId}/summary.json`;
    if (!(await store.has(summaryKey))) {
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
    const catalogPath =
      deps.catalogPath ?? path.join(deps.repoRoot, 'src', 'shared', 'data', 'sprite-catalog.json');

    let hydrated: HydratedRunDir | null = null;
    let entry: ManifestEntry;
    try {
      hydrated =
        store.backend === 'local' ? null : await hydrateRunDirFromStore(store, briefId, runId);
      const runDir = hydrated?.runDir ?? safeJoin(deps.runsDir, [briefId, runId]);
      if (runDir === null) {
        reply.code(403);
        return { error: 'forbidden-path' };
      }
      entry = approveVariant({
        runDir,
        variantIndex,
        manifestPath,
        catalogPath,
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
    } finally {
      hydrated?.cleanup();
    }

    return entry;
  });

  app.post<{ Body: WorkflowSynthesizeBody }>('/api/workflow/synthesize', async (req, reply) => {
    const body = (req.body ?? {}) as WorkflowSynthesizeBody;
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      reply.code(400);
      return { error: 'bad-request', message: 'body.name must be a non-empty string' };
    }
    let type: Brief['type'] | undefined;
    if (body.type !== undefined) {
      if (typeof body.type !== 'string' || !SPRITE_TYPES.includes(body.type as Brief['type'])) {
        reply.code(400);
        return {
          error: 'bad-request',
          message: `body.type must be one of ${SPRITE_TYPES.join(', ')}`,
        };
      }
      type = body.type as Brief['type'];
    }
    let candidates = 3;
    if (body.candidates !== undefined) {
      if (
        typeof body.candidates !== 'number' ||
        !Number.isInteger(body.candidates) ||
        body.candidates < 1 ||
        body.candidates > 5
      ) {
        reply.code(400);
        return {
          error: 'bad-request',
          message: 'body.candidates must be an integer in [1, 5]',
        };
      }
      candidates = body.candidates;
    }

    try {
      const env = deps.env ?? process.env;
      const provider = createSynthProvider({ env });
      const result = await synthesizeBrief({
        name: body.name,
        ...(type ? { type } : {}),
        candidates,
        partial: true,
        provider,
        repoRoot: deps.repoRoot,
        env,
      });
      return {
        name: result.name,
        type: result.type,
        written: result.written.map((candidate) => ({
          id: candidate.id,
          yamlPath: toRepoRelativePath(deps.repoRoot, candidate.yamlPath),
          description: candidate.description,
          yaml: readFileSync(candidate.yamlPath, 'utf8'),
        })),
        rejected: result.rejected,
      };
    } catch (err) {
      reply.code(500);
      return {
        error: 'synthesize-failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  app.post<{ Body: WorkflowPromoteBody }>('/api/workflow/promote-brief', async (req, reply) => {
    const body = (req.body ?? {}) as WorkflowPromoteBody;
    if (typeof body.sourceYamlPath !== 'string' || body.sourceYamlPath.trim() === '') {
      reply.code(400);
      return { error: 'bad-request', message: 'body.sourceYamlPath must be a non-empty string' };
    }
    if (typeof body.type !== 'string' || !SPRITE_TYPES.includes(body.type as Brief['type'])) {
      reply.code(400);
      return {
        error: 'bad-request',
        message: `body.type must be one of ${SPRITE_TYPES.join(', ')}`,
      };
    }
    if (
      typeof body.name !== 'string' ||
      !/^[a-z0-9][a-z0-9-]*$/.test(body.name) ||
      body.name.length > 64
    ) {
      reply.code(400);
      return {
        error: 'bad-request',
        message: 'body.name must be kebab-case (letters, digits, and dashes only)',
      };
    }
    const target = body.target === 'committed' ? 'committed' : 'draft';
    const sourceAbs = resolveRepoPath(deps.repoRoot, body.sourceYamlPath);
    if (!sourceAbs || !existsSync(sourceAbs)) {
      reply.code(404);
      return { error: 'source-not-found', message: 'sourceYamlPath does not exist in repo' };
    }
    const destRel =
      target === 'draft'
        ? path.join('briefs', 'draft', `${body.type}s`, `${body.name}.yaml`)
        : path.join('briefs', `${body.type}s`, `${body.name}.yaml`);
    const destAbs = path.resolve(deps.repoRoot, destRel);
    mkdirSync(path.dirname(destAbs), { recursive: true });
    copyFileSync(sourceAbs, destAbs);
    return {
      briefPath: toRepoRelativePath(deps.repoRoot, destAbs),
      target,
    };
  });

  app.post<{ Body: WorkflowGenerateBody }>('/api/workflow/generate', async (req, reply) => {
    const body = (req.body ?? {}) as WorkflowGenerateBody;
    if (typeof body.briefPath !== 'string' || body.briefPath.trim() === '') {
      reply.code(400);
      return { error: 'bad-request', message: 'body.briefPath must be a non-empty string' };
    }
    const briefPath = resolveRepoPath(deps.repoRoot, body.briefPath);
    if (!briefPath || !existsSync(briefPath)) {
      reply.code(404);
      return { error: 'brief-not-found', message: 'briefPath does not exist in repo' };
    }
    try {
      const env = deps.env ?? process.env;
      const briefId = path.basename(briefPath, path.extname(briefPath));
      if (queue.backend !== 'noop') {
        const requestedAt = new Date().toISOString();
        await queue.enqueue({
          briefId,
          briefPath: toRepoRelativePath(deps.repoRoot, briefPath),
          requestedBy: workflowRequestedBy(env),
          requestedAt,
          priority: 'normal',
        });
        reply.code(202);
        return {
          status: 'queued' as const,
          briefId,
          briefPath: toRepoRelativePath(deps.repoRoot, briefPath),
          requestedAt,
          queueBackend: queue.backend,
        };
      }
      const result = await generateOne({
        briefPath,
        provider: createImageProvider({ env }),
        textProvider: createTextProvider({ env }),
        visionProvider: createVisionProvider({ env }),
        repoRoot: deps.repoRoot,
        env,
        store,
      });
      return {
        status: 'completed' as const,
        briefPath: toRepoRelativePath(deps.repoRoot, briefPath),
        runId: result.summary.runId,
        briefId: result.summary.brief,
        runDir: toRepoRelativePath(deps.repoRoot, result.runDir),
        summary: result.summary,
      };
    } catch (err) {
      reply.code(500);
      return {
        error: 'generate-failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  app.post<{ Body: WorkflowMetadataBody }>('/api/workflow/metadata', async (req, reply) => {
    const body = (req.body ?? {}) as WorkflowMetadataBody;
    const providerMode = (body.provider ?? 'auto') as MetadataProviderMode;
    if (!['auto', 'heuristic', 'openai'].includes(providerMode)) {
      reply.code(400);
      return { error: 'bad-request', message: 'body.provider must be auto, heuristic, or openai' };
    }
    let ids: string[] | undefined;
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string' || id === '')) {
        reply.code(400);
        return { error: 'bad-request', message: 'body.ids must be an array of non-empty strings' };
      }
      ids = body.ids;
    }
    const force = body.force === true;
    let minScore: number | undefined;
    if (body.minScore !== undefined) {
      if (
        typeof body.minScore !== 'number' ||
        !Number.isInteger(body.minScore) ||
        body.minScore < 0 ||
        body.minScore > 100
      ) {
        reply.code(400);
        return { error: 'bad-request', message: 'body.minScore must be an integer in [0,100]' };
      }
      minScore = body.minScore;
    }

    try {
      const catalogAbs = path.resolve(deps.repoRoot, DEFAULT_CATALOG_PATH);
      const catalog = parseSpriteCatalog(JSON.parse(readFileSync(catalogAbs, 'utf8')) as unknown);
      const provider = await resolveProvider(providerMode);
      const result = await runMetadataPipeline(catalog, { provider, ids, force, minScore });
      writeFileSync(catalogAbs, `${JSON.stringify(result.updated, null, 2)}\n`, 'utf8');
      return {
        provider: provider.name,
        changedCount: result.changedCount,
        processedCount: result.processedCount,
        rejectedCount: result.rejectedCount,
        skippedCount: result.skippedCount,
      };
    } catch (err) {
      reply.code(500);
      return {
        error: 'metadata-failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  app.post<{
    Body: { briefPath?: unknown; rawPng?: unknown; options?: unknown };
  }>('/api/postprocess', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.briefPath !== 'string' || body.briefPath.trim() === '') {
      reply.code(400);
      return { error: 'bad-request', message: 'body.briefPath must be a non-empty string' };
    }
    if (typeof body.rawPng !== 'string' || body.rawPng.trim() === '') {
      reply.code(400);
      return { error: 'bad-request', message: 'body.rawPng must be a base64-encoded string' };
    }
    const briefPath = resolveRepoPath(deps.repoRoot, body.briefPath);
    if (!briefPath) {
      reply.code(400);
      return { error: 'bad-request', message: 'body.briefPath must be a repo-relative path' };
    }
    if (!existsSync(briefPath)) {
      reply.code(404);
      return { error: 'brief-not-found', message: 'briefPath does not exist in repo' };
    }
    try {
      const loaded = loadBrief(briefPath, { projectRoot: deps.repoRoot });
      const { postprocessWithTrace } = await import('../postprocess.js');
      const rawPngBuffer = Buffer.from(body.rawPng, 'base64');
      const traced = postprocessWithTrace(rawPngBuffer, loaded.brief, loaded.palette, {
        ...(typeof body.options === 'object' && body.options !== null
          ? (body.options as Record<string, unknown>)
          : {}),
      });
      return {
        finalPng: traced.finalPng.toString('base64'),
        steps: traced.steps.map((step) => ({
          id: step.id,
          label: step.label,
          png: step.png.toString('base64'),
        })),
      };
    } catch (err) {
      reply.code(500);
      return {
        error: 'postprocess-failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // DELETE /api/runs/:briefId/:runId — remove an entire run directory.
  // Used by the gallery UI to dismiss/cleanup experiments that are done.
  app.delete<{ Params: { briefId: string; runId: string } }>(
    '/api/runs/:briefId/:runId',
    async (req, reply) => {
      const { briefId, runId } = req.params;
      if (safeJoin(deps.runsDir, [briefId, runId, 'summary.json']) === null) {
        reply.code(403);
        return { error: 'forbidden-path' };
      }
      const runPrefix = `${briefId}/${runId}/`;
      const runKeys = await store.list(runPrefix);
      if (runKeys.length === 0) {
        reply.code(404);
        return { error: 'run-not-found', briefId, runId };
      }
      if (store.backend === 'local') {
        await store.remove(`${briefId}/${runId}`);
      } else {
        await Promise.all(runKeys.map((key) => store.remove(key)));
      }
      if ((await store.list(`${briefId}/`)).length === 0) {
        await store.remove(briefId);
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

function resolveRepoPath(repoRoot: string, relativePath: string): string | null {
  const trimmed = relativePath.trim();
  if (trimmed === '' || path.isAbsolute(trimmed)) {
    return null;
  }
  const resolved = path.resolve(repoRoot, trimmed);
  const rel = path.relative(repoRoot, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
}

function toRepoRelativePath(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).replace(/\\/g, '/');
}

function safeStoreJoin(base: string, relativePath: string): string | null {
  const normalized = path.normalize(relativePath);
  const segments = normalized.split(path.sep).filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return null;
  }
  return safeJoin(base, segments);
}

interface HydratedRunDir {
  readonly runDir: string;
  cleanup(): void;
}

async function hydrateRunDirFromStore(
  store: RunStore,
  briefId: string,
  runId: string,
): Promise<HydratedRunDir | null> {
  const prefix = `${briefId}/${runId}/`;
  const keys = await store.list(prefix);
  if (keys.length === 0) {
    return null;
  }
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'crawler-sidecar-run-'));
  const runDir = safeJoin(tempRoot, [briefId, runId]);
  if (runDir === null) {
    rmSync(tempRoot, { recursive: true, force: true });
    return null;
  }
  mkdirSync(runDir, { recursive: true });
  for (const key of keys) {
    const rel = key.slice(prefix.length);
    if (rel === '') continue;
    const target = safeStoreJoin(runDir, rel);
    if (target === null) {
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, await store.get(key));
  }
  return {
    runDir,
    cleanup: () => {
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function workflowRequestedBy(env: NodeJS.ProcessEnv): string {
  return (
    env['SPRITES_REQUESTED_BY'] ??
    env['GITHUB_USER'] ??
    env['USER'] ??
    env['USERNAME'] ??
    'sprite-gallery-sidecar'
  );
}

/**
 * Enumerate runs by listing all `<briefId>/<runId>/summary.json` keys in the
 * store. Works for both local and Azure backends. Returns an empty list when
 * the store has no entries. Skips keys whose summary is unparseable rather
 * than failing the whole endpoint.
 *
 * Sorted newest-first by runId (timestamp-prefixed).
 */
async function listRunsFromStore(store: RunStore): Promise<RunListEntry[]> {
  const allKeys = await store.list('');
  // Keep only keys of the shape <briefId>/<runId>/summary.json (exactly 3 parts).
  const summaryKeys = allKeys.filter((k) => {
    const parts = k.split('/');
    return parts.length === 3 && parts[2] === 'summary.json';
  });

  const entries: RunListEntry[] = [];
  for (const key of summaryKeys) {
    const parts = key.split('/');
    const briefId = parts[0]!;
    const runId = parts[1]!;
    let summary: RunSummaryShape | null = null;
    try {
      summary = JSON.parse((await store.get(key)).toString('utf8')) as RunSummaryShape;
    } catch {
      // Leave summary as null — unparseable entry is skipped gracefully.
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
  entries.sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
  return entries;
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
