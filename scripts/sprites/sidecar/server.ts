/**
 * Fastify-based sidecar for the sprite gallery lab.
 *
 * Responsibilities:
 *   - GET    /api/health                                                       — readiness probe
 *   - GET    /api/runs                                                         — list all runs
 *   - GET    /api/runs/:briefId/:runId                                         — full RunSummary JSON
 *   - GET    /api/runs/:briefId/:runId/sheets                                  — list source sheet PNGs
 *   - GET    /api/runs/:briefId/:runId/sheet/:filename                         — source sheet PNG bytes
 *   - GET    /api/runs/:briefId/:runId/processed/:filename                     — static-file from run dir
 *   - GET    /api/runs/:briefId/:runId/raw/:filename                           — raw (pre-pipeline) cell PNG
 *   - POST   /api/runs/:briefId/:runId/postprocess                             — re-run PostProcess on the stored sheet
 *   - POST   /api/runs/:briefId/:runId/judge                                   — re-run the VLM judge on stored variants
 *   - POST   /api/runs/:briefId/:runId/approve                                 — approve a variant (mutating)
 *   - POST   /api/runs/:briefId/:runId/accept                                  — atomic approve + check-in (mutating; no browser Origin allowed)
 *   - DELETE /api/manifest/:variantId                                          — unapprove/evict an approved variant (mutating)
 *   - POST   /api/checkin                                                       — publish approved art (branch + issue, no PR; mutating; exact trusted browser origins only)
 *   - POST   /api/checkin/prepare                                               — preview what /api/checkin would publish (read-only; browser-reachable)
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
 *   - The atomic accept route, POST /api/checkin, AND POST /api/checkin/prepare
 *     apply an exact per-worktree trusted-origin check (ADR 0066 AMD-006):
 *     loopback binding alone does not stop a browser-issued request — a
 *     `text/plain` (or content-type-less) POST body needs no CORS preflight at
 *     all, so any page could trigger a mutation (or repeated git fetch / gh
 *     issue list calls) just by having the user's browser visit it. Requests
 *     whose `Origin` header is present but NOT in `trustedMutationOrigins`
 *     (the per-worktree gallery/lab/devtools origins supplied by the CLI) are
 *     rejected with 403. Server-side callers (Node-based fetch, no Origin)
 *     remain trusted unconditionally.
 *   - /approve, /checkin, and /accept all run their mutating work through the
 *     same process-wide `withCheckinMutationLock` so concurrent requests
 *     never race the shared art surface or the durable check-in queue.
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
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { parse as parseYaml } from 'yaml';
import {
  approveVariant,
  ApproveError,
  loadApprovedEntry,
  resolveVariantIdentity,
  unapproveVariant,
  UnapproveError,
  type ManifestEntry,
  type VariantIdentity,
} from '../approve.js';
import { runQueueCommit, QueueCommitError, type QueueCommitResult } from '../queue-commit.js';
import { createDefaultQueueCommitDeps } from '../queue-commit-runtime.js';
import {
  runAssetCheckin,
  prepareAssetCheckin,
  reconcileQueuedContent,
  CheckinError,
  type CheckinRunnerDeps,
  type QueuedAssetCheckin,
} from '../checkin.js';
import { createDefaultCheckinDeps } from '../checkin-runtime.js';
import { SPRITE_TYPES, type Brief } from '../brief-schema.js';
import { briefDirectoryForType } from '../brief-paths.js';
import { generateOne } from '../generate-one.js';
import {
  DEFAULT_CATALOG_PATH,
  mergeChangedCatalogEntries,
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
import { computeSliceMap } from '../slice-sheet.js';
import { loadStyleGuide } from '../build-prompt.js';
import { loadRecordedReferencePngs } from '../load-reference-pngs.js';
import { normalizeDisabledModules, type PostprocessOptions } from '../postprocess.js';
import {
  removeManualAnchor,
  removeManualWeaponAnchor,
  writeManualAnchor,
  writeManualWeaponAnchor,
  type ManualAnchorOverride,
  type ManualWeaponAnchorOverride,
} from '../postprocess-overrides.js';
import type { RunSummary } from '../run-artifacts.js';
import {
  loadRunSummary,
  rejudgeRun,
  repostprocessRun,
  RerunError,
  type RerunErrorKind,
} from '../rerun.js';
import { synthesizeBrief } from '../synthesize-brief.js';
import { isSizeVariant, SIZE_VARIANTS, type SizeVariant } from '../size-variants.js';
import { loadBrief, loadBriefFromYaml, type LoadedBrief } from '../load-brief.js';
import {
  isRepoConfined,
  materializeBriefFromStore,
  mirrorBriefToStore,
  toRepoRelativePath,
} from '../brief-durability.js';
import { parseSpriteCatalog, type SpriteCatalog } from '../../../src/shared/sprite-catalog.js';
import { formatJsonFilesSync, writeCatalogJson } from '../catalog-io.js';
import {
  composeFullCatalog,
  GENERATED_ID_PREFIX,
  isGeneratedCatalogId,
} from '../../../src/shared/generated-catalog.js';
import { composeManifestFromShards, readShard, writeShard } from '../generated-shards.js';
import { hasDerivedResourceCache } from '../store/caching-store.js';
import { LocalRunStore } from '../store/local-store.js';
import { StoreConditionalWriteError, StoreNotFoundError, type RunStore } from '../store/types.js';
import { createWorkerController, type WorkerController } from './worker-controller.js';
import {
  createIssueIngesterController,
  type IssueIngesterController,
} from './issue-ingester-controller.js';
import { createGhAssetRequestIssueApi } from './asset-request-issue-api.js';
import type { SidecarServiceControl } from './service-contract.js';
import {
  WORKFLOW_STATE_KEY,
  computeStateEtag,
  etagPreconditionFails,
  ifNoneMatchPreconditionFails,
  isCreateOnlyWrite,
  parseWorkflowState,
  serializeWorkflowState,
  workflowBriefKey,
} from './workflow-state.js';

/**
 * Current content-hash ETag of the durable workflow state, or `null` when no
 * state is stored (or the blob is unreadable/half-written).
 */
async function readWorkflowStateEtag(store: RunStore): Promise<string | null> {
  if (!(await store.has(WORKFLOW_STATE_KEY))) return null;
  try {
    return computeStateEtag(await store.get(WORKFLOW_STATE_KEY));
  } catch {
    return null;
  }
}

async function readCachedJson(store: RunStore, key: string): Promise<unknown | null> {
  if (!hasDerivedResourceCache(store)) return null;
  const bytes = await store.getCachedResource(key);
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}

async function writeCachedJson(store: RunStore, key: string, value: unknown): Promise<void> {
  if (!hasDerivedResourceCache(store)) return;
  await store.setCachedResource(key, Buffer.from(JSON.stringify(value), 'utf8'));
}

async function writeCachedJsonIfAbsent(
  store: RunStore,
  key: string,
  value: unknown,
): Promise<void> {
  if (!hasDerivedResourceCache(store)) return;
  await store.setIfAbsentCachedResource(key, Buffer.from(JSON.stringify(value), 'utf8'));
}

/**
 * Cache key prefix for per-run immutable brief snapshots. Unlike path-level
 * durable keys (`workflow-state/briefs/…`), per-run snapshots capture exactly
 * the brief that was active when the run was generated. They survive global
 * cache invalidation (their key sits outside the `route/` namespace) but are
 * cleared when the run itself is deleted (CachingRunStore.remove removes them
 * on `summary.json` deletion). See `server.ts` brief and slice-map routes.
 */
const PER_RUN_BRIEF_PREFIX = 'brief-snapshot';
const PER_RUN_SLICE_MAP_FINGERPRINT_PREFIX = 'slice-map-fingerprint';

/** Read the per-run brief snapshot bytes, or null if not yet stored. */
async function readPerRunBrief(
  store: RunStore,
  briefId: string,
  runId: string,
): Promise<Buffer | null> {
  if (!hasDerivedResourceCache(store)) return null;
  return store.getCachedResource(`${PER_RUN_BRIEF_PREFIX}/${briefId}/${runId}`);
}

/**
 * Persist the per-run brief snapshot using setIfAbsent so the first writer
 * wins — the bytes are immutable once set (they capture the brief state at
 * generation time). Concurrent writers safely converge on the same content.
 */
async function writePerRunBrief(
  store: RunStore,
  briefId: string,
  runId: string,
  yamlBytes: Buffer,
): Promise<void> {
  if (!hasDerivedResourceCache(store)) return;
  await store.setIfAbsentCachedResource(`${PER_RUN_BRIEF_PREFIX}/${briefId}/${runId}`, yamlBytes);
}

async function readPerRunSliceMapFingerprint(
  store: RunStore,
  briefId: string,
  runId: string,
): Promise<string | null> {
  if (!hasDerivedResourceCache(store)) return null;
  const bytes = await store.getCachedResource(
    `${PER_RUN_SLICE_MAP_FINGERPRINT_PREFIX}/${briefId}/${runId}`,
  );
  if (bytes === null) return null;
  const value = bytes.toString('utf8').trim();
  return value.length > 0 ? value : null;
}

async function writePerRunSliceMapFingerprint(
  store: RunStore,
  briefId: string,
  runId: string,
  fingerprint: string,
): Promise<void> {
  if (!hasDerivedResourceCache(store)) return;
  await store.setIfAbsentCachedResource(
    `${PER_RUN_SLICE_MAP_FINGERPRINT_PREFIX}/${briefId}/${runId}`,
    Buffer.from(fingerprint, 'utf8'),
  );
}

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
  /**
   * In-process queue worker. Defaults to a controller wired to `queue`/`store`.
   * `buildServer` never starts it — the `azure-queue` backend disables the
   * `/api/workflow/worker/start` route (CI is the sole authorized consumer).
   * Inject a fake in tests to assert the worker routes without a loop.
   */
  readonly worker?: WorkerController;
  /**
   * Sidecar-local `asset-request` issue ingester. Polls open GitHub issues and
   * enqueues issue-originated queue jobs with idempotent claims.
   */
  readonly issueIngester?: IssueIngesterController;
  /**
   * Check-in runner deps for `/api/checkin`, the atomic
   * `/api/runs/:briefId/:runId/accept` route, and the unapprove/evict
   * `DELETE /api/manifest/:variantId` endpoint. Defaults to
   * `createDefaultCheckinDeps(repoRoot, env)`. Inject a fake in tests to
   * assert the exact git/gh sequence without a real repo or network.
   */
  readonly checkinDeps?: CheckinRunnerDeps;
  /**
   * Exact browser origins allowed to invoke `/api/checkin`. Production passes
   * only this worktree's deterministic lab/devtools origins. Omit to reject
   * every browser-originated request; server-side callers send no Origin.
   */
  readonly trustedMutationOrigins?: readonly string[];
  /** Optional managed-service provenance and authenticated shutdown hook. */
  readonly service?: SidecarServiceControl;
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
  /** Whether this run has an approved variant promoted into generated manifest content. */
  readonly promotionState: 'promoted' | 'not-promoted';
}

interface RunSummaryShape {
  readonly promptHash?: string;
  readonly chosen?: { readonly index?: number } | null;
  readonly candidates?: ReadonlyArray<{ readonly judgeScorecard?: unknown }>;
}

interface WorkflowSynthesizeBody {
  readonly name?: unknown;
  readonly brief?: unknown;
  readonly type?: unknown;
  readonly candidates?: unknown;
  readonly sizeVariant?: unknown;
  readonly floor?: unknown;
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

interface WorkflowBriefSaveBody {
  readonly yamlPath?: unknown;
  readonly yaml?: unknown;
}

interface WorkflowMetadataBody {
  readonly ids?: unknown;
  readonly force?: unknown;
  readonly provider?: unknown;
  readonly minScore?: unknown;
}

interface WorkflowStateBody {
  readonly state?: unknown;
}

interface LatestRunQuery {
  readonly briefId?: unknown;
  readonly requestedAt?: unknown;
}

interface RunPostprocessBody {
  readonly options?: unknown;
  readonly sheet?: unknown;
  readonly mode?: unknown;
  readonly manualAnchor?: unknown;
  readonly weaponAnchor?: unknown;
  readonly facing?: unknown;
  readonly variantIndexes?: unknown;
}

interface RunManualAnchorBody {
  readonly variantIndex?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
  readonly clear?: unknown;
}

interface RunWeaponAnchorBody {
  readonly variantIndex?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
  readonly applyToAllVariants?: unknown;
  readonly clear?: unknown;
}

interface RunsQuery {
  readonly promoted?: unknown;
}

interface StorageRunsQuery {
  readonly scope?: unknown;
  readonly search?: unknown;
}

interface StorageBatchBody {
  readonly keys?: unknown;
}

interface StorageEnrichBody {
  readonly scope?: unknown;
  readonly runs?: unknown;
}

/** One run's enrichment, as returned by POST /api/storage/runs/enrich. */
interface StorageRunEnrichmentEntry {
  readonly briefId: string;
  readonly runId: string;
  /** Candidate count from summary.json, or null when the summary is missing. */
  readonly variantCount: number | null;
  /** First `sheet-NN.png` for the run (active scope only); null otherwise. */
  readonly sheetFile: string | null;
  /** Number of approved variants recorded for this brief in the manifest. */
  readonly approvedCount: number;
  /** Lowest-index approved variant for the brief, with the run it came from. */
  readonly firstApproved: { readonly runId: string; readonly variantIndex: number } | null;
  /** Whether the run's brief YAML is still on disk or mirrored in the store. */
  readonly briefStored: boolean;
}

interface WorkflowStoreClearBody {
  readonly scope?: unknown;
}

interface WorkflowAssetRequestsQuery {
  readonly state?: unknown;
}

interface WorkflowAssetRequestRejectBody {
  readonly issueNumber?: unknown;
  readonly fingerprint?: unknown;
  readonly reason?: unknown;
}

interface RunJudgeBody {
  readonly variantIndexes?: unknown;
  readonly force?: unknown;
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
 * Process-wide serialization for every route that mutates the shared art
 * surface (`public/assets/generated/**`, `sprite-catalog.json`) or the
 * durable check-in queue: `/approve`, `/checkin`, and the atomic `/accept`
 * route all funnel their mutating work through this single chain so two
 * concurrent requests — from any Fastify instance in this process — never
 * race the same worktree, manifest write, or `gh issue create` call.
 *
 * A promise chain, not a counting semaphore: each link runs only after the
 * previous one SETTLES (fulfilled or rejected), so one call's failure never
 * poisons the queue for the next caller. Callers acquire the lock exactly
 * once at their own route-handler boundary — nothing here calls another
 * locked route internally — so there is no re-entrant nesting and thus no
 * deadlock risk.
 */
let checkinMutationChain: Promise<void> = Promise.resolve();

function withCheckinMutationLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = checkinMutationChain.then(fn, fn);
  checkinMutationChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Map an `approveVariant`/`resolveVariantIdentity` failure to an HTTP body, setting `reply`'s status code. */
function mapApproveError(reply: FastifyReply, err: unknown): { error: string; message: string } {
  if (err instanceof ApproveError) {
    const status =
      err.kind === 'variant-not-found' ||
      err.kind === 'processed-missing' ||
      err.kind === 'run-not-found'
        ? 404
        : err.kind === 'already-approved' || err.kind === 'duplicate-content'
          ? 409
          : err.kind === 'hard-blocked'
            ? 422
            : 500;
    reply.code(status);
    return { error: err.kind, message: err.message };
  }
  reply.code(500);
  return { error: 'approve-failed', message: err instanceof Error ? err.message : String(err) };
}

/**
 * Map a `CheckinError` (or unknown thrown value) from ANY check-in-shaped
 * caller — `/api/checkin`, `/api/checkin/prepare`, the atomic `/accept`
 * route's own check-in step, and its pre-/post-mutation queue-list
 * reconciliation reads — to the SAME structured `{error, message}` body,
 * setting `reply`'s status code. One shared mapper keeps the
 * ci-refused/nothing-to-checkin/content-conflict/ambiguous/git-or-gh-failed
 * status table from drifting between call sites; without it, a `CheckinError`
 * thrown somewhere that forgot to catch it falls through to Fastify's
 * generic (unstructured) 500 instead of this contract.
 */
function mapCheckinError(
  reply: FastifyReply,
  err: unknown,
  fallbackError = 'checkin-failed',
): { error: string; message: string } {
  if (err instanceof CheckinError) {
    const status =
      err.kind === 'ci-refused'
        ? 403
        : err.kind === 'nothing-to-checkin' ||
            err.kind === 'content-conflict' ||
            err.kind === 'ambiguous-queued-content' ||
            err.kind === 'checkin-locked'
          ? 409
          : 502; // git-failed / gh-failed
    reply.code(status);
    return { error: err.kind, message: err.message };
  }
  reply.code(500);
  return { error: fallbackError, message: err instanceof Error ? err.message : String(err) };
}

/** Number of durably-queued assets that share `issueUrl` — the batch size of that check-in. */
function countQueuedForIssue(
  queuedAssets: ReadonlyMap<string, QueuedAssetCheckin>,
  issueUrl: string,
): number {
  let count = 0;
  for (const entry of queuedAssets.values()) {
    if (entry.issueUrl === issueUrl) count += 1;
  }
  return count;
}

/** Successful atomic-accept response shape (either freshly queued or reconciled against an existing queue entry). */
interface AcceptedResponse {
  readonly state: 'queued';
  readonly existing: boolean;
  readonly briefId: string;
  readonly variantIndex: number;
  readonly assetPath: string;
  readonly issueUrl: string;
  readonly assetCount: number;
}

/**
 * Reconcile a variant's identity against the durable check-in queue BEFORE
 * any mutation (ADR 0066 / concern #4): same content hash as the queued entry
 * -> return the existing queued state; different hash -> 409 conflict; queued
 * but the entry predates content hashes -> fail closed (409, ambiguous) since
 * equality can't be established. Returns `undefined` when `identity.assetPath`
 * isn't queued at all, so the caller should proceed with approve + check-in.
 */
function reconcileQueuedAsset(
  reply: FastifyReply,
  queuedAssets: ReadonlyMap<string, QueuedAssetCheckin>,
  identity: VariantIdentity,
  variantIndex: number,
): AcceptedResponse | { error: string; message: string } | undefined {
  const queued = queuedAssets.get(identity.assetPath);
  const reconciliation = reconcileQueuedContent(queued, identity.contentHash);
  if (reconciliation === 'new') return undefined;

  if (reconciliation === 'ambiguous') {
    reply.code(409);
    return {
      error: 'ambiguous-queued-content',
      message:
        `${identity.assetPath} is already queued (${queued!.issueUrl}) by an issue filed ` +
        'before content hashes were recorded, so it cannot be verified against the current ' +
        'content. Resolve the open issue manually before re-accepting this variant.',
    };
  }
  if (reconciliation === 'content-conflict') {
    reply.code(409);
    return {
      error: 'content-conflict',
      message:
        `${identity.assetPath} is already queued (${queued!.issueUrl}) with different content. ` +
        'Approve a different variant, or resolve the existing issue first.',
    };
  }
  return {
    state: 'queued',
    existing: true,
    briefId: identity.briefId,
    variantIndex,
    assetPath: identity.assetPath,
    issueUrl: queued!.issueUrl,
    assetCount: countQueuedForIssue(queuedAssets, queued!.issueUrl),
  };
}
/**
 * Version token for the slice-map cache key. Bump this constant whenever
 * `computeSliceMap` logic or its response schema changes so a worktree with
 * newer code never serves a response produced by an older algorithm from the
 * shared cross-worktree cache.
 */
const SLICE_MAP_SCHEMA_VERSION = 'v1';

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
  // Best-effort brief recovery for the sidecar's READ / degradation paths.
  // `materializeBriefFromStore` now THROWS on a transient store/fs outage (so
  // the queue worker can retry instead of mistaking a blip for a missing
  // brief). These handlers only care whether the brief is on disk now — a
  // transient failure must degrade (404 / brief-less slice map), never 500 —
  // so we swallow the throw and report "not recovered".
  const tryMaterialiseBrief = async (absPath: string): Promise<boolean> => {
    try {
      return await materializeBriefFromStore(store, deps.repoRoot, absPath);
    } catch {
      return false;
    }
  };
  const queue: AssetQueue = deps.queue ?? new NoopAssetQueue();
  // The sidecar owns an in-process worker so a queue consumer always exists
  // wherever the sidecar runs. It is NOT started here — see worker-controller.ts.
  const worker: WorkerController =
    deps.worker ??
    createWorkerController({
      queue,
      store,
      repoRoot: deps.repoRoot,
      ...(deps.env ? { env: deps.env } : {}),
    });
  const issueIngester: IssueIngesterController =
    deps.issueIngester ??
    createIssueIngesterController({
      queue,
      store,
      requestedBy: workflowRequestedBy(deps.env ?? process.env),
      issues: createGhAssetRequestIssueApi(deps.repoRoot),
    });
  // Stop the worker loop when Fastify closes (CLI shutdown / test afterEach).
  // Idempotent: a no-op when the worker was never started.
  app.addHook('onClose', async () => {
    await worker.stop();
    await issueIngester.stop();
  });

  // Vite serves the lab from a different loopback port, so allow CORS only
  // for loopback origins (localhost/127.0.0.1/::1).
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && isAllowedOrigin(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, If-Match, If-None-Match');
      reply.header('Access-Control-Expose-Headers', 'ETag');
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
    worker: worker.status(),
    issueIngester: issueIngester.status(),
    service: deps.service?.identity ?? null,
  }));

  app.post('/api/service/shutdown', async (req, reply) => {
    if (!deps.service) {
      reply.code(404);
      return { error: 'not-managed', message: 'This sprite sidecar is not manager-owned.' };
    }
    const token = req.headers['x-crawler-sidecar-token'];
    if (token !== deps.service.shutdownToken) {
      reply.code(403);
      return { error: 'forbidden', message: 'Invalid managed-service shutdown token.' };
    }
    const instanceId = deps.service.identity.instanceId;
    setImmediate(deps.service.requestShutdown);
    return { ok: true, instanceId };
  });

  app.get<{ Querystring: RunsQuery }>('/api/runs', async (req, reply) => {
    const promotedRaw = req.query.promoted;
    const promotedFilter =
      promotedRaw === undefined || promotedRaw === null || promotedRaw === ''
        ? 'all'
        : promotedRaw === 'promoted' || promotedRaw === 'not-promoted' || promotedRaw === 'all'
          ? promotedRaw
          : null;
    if (promotedFilter === null) {
      reply.code(400);
      return {
        error: 'bad-request',
        message: 'query.promoted must be all, promoted, or not-promoted',
      };
    }
    const publicAssetsDir = deps.publicAssetsDir ?? path.join(deps.repoRoot, 'public', 'assets');
    const manifestPath =
      deps.manifestPath ?? path.join(publicAssetsDir, 'generated', 'manifest.json');
    const promotedRuns = readPromotedRunsFromManifest(manifestPath);
    const runs = await listRunsFromStore(store, promotedRuns);
    return {
      runs:
        promotedFilter === 'all'
          ? runs
          : runs.filter((run) => run.promotionState === promotedFilter),
    };
  });

  app.get<{ Querystring: StorageRunsQuery }>('/api/storage/runs', async (req, reply) => {
    const scope =
      req.query.scope === 'archive'
        ? 'archive'
        : req.query.scope === 'active' || req.query.scope === undefined
          ? 'active'
          : null;
    if (scope === null) {
      reply.code(400);
      return { error: 'bad-request', message: 'query.scope must be active or archive' };
    }
    const search =
      typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
    const allKeys = await store.list(scope === 'archive' ? 'archive/' : '');
    const summaryKeys = allKeys.filter((key) => {
      const parts = key.split('/');
      if (scope === 'archive') {
        return parts.length === 4 && parts[0] === 'archive' && parts[3] === 'summary.json';
      }
      return parts.length === 3 && parts[2] === 'summary.json' && parts[0] !== 'archive';
    });
    const runs = summaryKeys
      .map((key) => {
        const parts = key.split('/');
        const briefId = scope === 'archive' ? parts[1]! : parts[0]!;
        const runId = scope === 'archive' ? parts[2]! : parts[1]!;
        return { key, briefId, runId };
      })
      .filter((run) =>
        search.length === 0
          ? true
          : run.briefId.toLowerCase().includes(search) || run.runId.toLowerCase().includes(search),
      )
      .sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
    return {
      scope,
      runs: runs.map((run) => ({
        briefId: run.briefId,
        runId: run.runId,
        timestamp: parseRunIdTimestamp(run.runId),
        summaryKey: run.key,
      })),
    };
  });

  app.post<{ Body: StorageBatchBody }>('/api/storage/runs/archive', async (req, reply) => {
    const body = (req.body ?? {}) as StorageBatchBody;
    if (!Array.isArray(body.keys) || body.keys.length === 0) {
      reply.code(400);
      return { error: 'bad-request', message: 'body.keys must be a non-empty array' };
    }
    const archived: string[] = [];
    const skipped: string[] = [];
    for (const raw of body.keys) {
      if (typeof raw !== 'string') continue;
      const parts = raw.split('/');
      if (parts.length !== 2) continue;
      const [briefId, runId] = parts;
      if (!briefId || !runId) continue;
      if (safeJoin(deps.runsDir, [briefId, runId, 'summary.json']) === null) continue;
      const fromPrefix = `${briefId}/${runId}/`;
      // Archive enumerates-then-copies-then-removes this exact key set — a
      // stale (SWR fast-path) listing could leave newly-added files behind
      // under the un-archived (original) location, so this MUST see an
      // authoritative, freshly-listed result.
      const keys = await store.list(fromPrefix, { authoritative: true });
      if (keys.length === 0) {
        skipped.push(raw);
        continue;
      }
      const copiedTargets: string[] = [];
      let removePhase = false;
      try {
        for (const key of keys) {
          const target = `archive/${key}`;
          await store.put(target, await store.get(key));
          copiedTargets.push(target);
        }
        removePhase = true;
        for (const key of keys) {
          await store.remove(key);
        }
      } catch (err) {
        if (!removePhase) {
          // Best-effort rollback for copy-phase failures only: remove any
          // copied archive keys so source remains authoritative.
          for (const target of copiedTargets) {
            await store.remove(target);
          }
        }
        reply.code(500);
        return {
          error: 'archive-failed',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      archived.push(raw);
    }
    return { ok: true, archived, skipped };
  });

  app.post<{ Body: StorageBatchBody }>('/api/storage/runs/delete', async (req, reply) => {
    const body = (req.body ?? {}) as StorageBatchBody;
    if (!Array.isArray(body.keys) || body.keys.length === 0) {
      reply.code(400);
      return { error: 'bad-request', message: 'body.keys must be a non-empty array' };
    }
    const deleted: string[] = [];
    for (const raw of body.keys) {
      if (typeof raw !== 'string') continue;
      const archive = raw.startsWith('archive/');
      const parts = raw.split('/');
      const scopeParts = archive ? parts.slice(1) : parts;
      if (scopeParts.length !== 2) continue;
      const [briefId, runId] = scopeParts;
      if (!briefId || !runId) continue;
      if (safeJoin(deps.runsDir, [briefId, runId, 'summary.json']) === null) continue;
      const prefix = `${archive ? 'archive/' : ''}${briefId}/${runId}/`;
      // Delete enumerates-then-removes this exact key set — a stale listing
      // could leave newly-added files behind, undermining "fully deleted".
      for (const key of await store.list(prefix, { authoritative: true })) {
        await store.remove(key);
      }
      deleted.push(raw);
    }
    return { ok: true, deleted };
  });

  app.post<{ Body: StorageEnrichBody }>('/api/storage/runs/enrich', async (req, reply) => {
    const body = (req.body ?? {}) as StorageEnrichBody;
    const scope =
      body.scope === 'archive'
        ? 'archive'
        : body.scope === 'active' || body.scope === undefined
          ? 'active'
          : null;
    if (scope === null) {
      reply.code(400);
      return { error: 'bad-request', message: 'body.scope must be active or archive' };
    }
    if (!Array.isArray(body.runs)) {
      reply.code(400);
      return { error: 'bad-request', message: 'body.runs must be an array' };
    }
    const publicAssetsDir = deps.publicAssetsDir ?? path.join(deps.repoRoot, 'public', 'assets');
    const manifestPath =
      deps.manifestPath ?? path.join(publicAssetsDir, 'generated', 'manifest.json');
    const approvedByBrief = readApprovedVariantsByBrief(manifestPath);
    const prefixRoot = scope === 'archive' ? 'archive/' : '';
    // A single listing serves the whole batch, so per-run sheet lookup adds no
    // extra store IO. Only the active scope shows thumbnails, so skip it for archive.
    const allKeys = scope === 'active' ? await store.list('') : [];
    const briefStoredCache = new Map<string, boolean>();
    const enriched: StorageRunEnrichmentEntry[] = [];
    for (const entry of body.runs) {
      if (!entry || typeof entry !== 'object') continue;
      const briefId = (entry as { briefId?: unknown }).briefId;
      const runId = (entry as { runId?: unknown }).runId;
      if (typeof briefId !== 'string' || typeof runId !== 'string') continue;
      // safeJoin doubles as a segment validator — rejects '/', '..' and escapes.
      if (safeJoin(deps.runsDir, [briefId, runId, 'summary.json']) === null) continue;
      const runPrefix = `${prefixRoot}${briefId}/${runId}/`;

      let variantCount: number | null = null;
      let briefStored = false;
      try {
        const summary = JSON.parse(
          (await store.get(`${runPrefix}summary.json`)).toString('utf8'),
        ) as { briefPath?: unknown; candidates?: ReadonlyArray<unknown> };
        if (Array.isArray(summary.candidates)) variantCount = summary.candidates.length;
        if (typeof summary.briefPath === 'string' && summary.briefPath !== '') {
          const cached = briefStoredCache.get(summary.briefPath);
          if (cached !== undefined) {
            briefStored = cached;
          } else {
            briefStored = await isBriefStored(store, deps.repoRoot, summary.briefPath);
            briefStoredCache.set(summary.briefPath, briefStored);
          }
        }
      } catch {
        // Missing/unparseable summary — leave variantCount null, briefStored false.
      }

      let sheetFile: string | null = null;
      if (scope === 'active') {
        sheetFile =
          allKeys
            .filter((key) => key.startsWith(runPrefix))
            .map((key) => key.slice(runPrefix.length))
            .filter((name) => /^sheet-\d+\.png$/i.test(name))
            .sort((a, b) => a.localeCompare(b))[0] ?? null;
      }

      const approved = approvedByBrief.get(briefId);
      enriched.push({
        briefId,
        runId,
        variantCount,
        sheetFile,
        approvedCount: approved?.count ?? 0,
        firstApproved:
          approved && approved.firstVariantIndex !== null && approved.firstRunId !== null
            ? { runId: approved.firstRunId, variantIndex: approved.firstVariantIndex }
            : null,
        briefStored,
      });
    }
    return { scope, enriched };
  });

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
      const responseCacheKey = `route/brief/${briefId}/${runId}`;
      const cachedResponse = await readCachedJson(store, responseCacheKey);
      if (cachedResponse !== null) return cachedResponse;

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
      // briefYamlBytes tracks the raw buffer so the per-run snapshot write
      // reuses the already-fetched bytes without an extra encoding round-trip.
      let briefYamlBytes: Buffer | null = null;
      // briefIsCanonical is true when briefYaml comes from a durable or per-run
      // snapshot (i.e. not a raw disk read) — it controls whether the assembled
      // response is eligible to be written to the shared derived-resource cache.
      let briefIsCanonical = false;
      if (typeof summary.briefPath === 'string' && summary.briefPath !== '') {
        // Check the per-run immutable snapshot first. It captures the brief
        // bytes that were active when the run was generated, so it is immune
        // to later edits of the brief file (the path-level durable key is a
        // last-writer-wins mirror that would serve the wrong generation config
        // for older runs after the brief is edited).
        const perRunBytes = await readPerRunBrief(store, briefId, runId);
        if (perRunBytes !== null) {
          // Per-run snapshot already established — use it directly. The
          // canonical brief is already persisted so no new snapshot write is
          // needed; briefIsCanonical is set to indicate the response can be
          // stored in the shared derived-resource cache.
          briefYaml = perRunBytes.toString('utf8');
          briefIsCanonical = true;
        } else {
          // Resolve brief path safely — must stay under repoRoot.
          const resolved = path.isAbsolute(summary.briefPath)
            ? summary.briefPath
            : path.resolve(deps.repoRoot, summary.briefPath);
          const rel = path.relative(deps.repoRoot, resolved);
          if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
            const durableKey = workflowBriefKey(toRepoRelativePath(deps.repoRoot, resolved));
            if (await store.has(durableKey)) {
              try {
                // Keep the Buffer directly — avoids a Buffer→string→Buffer
                // round-trip when writing the per-run snapshot below.
                briefYamlBytes = await store.get(durableKey);
                briefYaml = briefYamlBytes.toString('utf8');
                briefIsCanonical = true;
              } catch {
                briefYaml = null;
                briefYamlBytes = null;
              }
            }
            if (briefYaml === null) {
              try {
                // Read as Buffer so the same bytes are passed to
                // writePerRunBrief without re-encoding.
                briefYamlBytes = readFileSync(resolved);
                briefYaml = briefYamlBytes.toString('utf8');
              } catch {
                briefYaml = null;
                briefYamlBytes = null;
              }
            }
            // Persist as the per-run immutable snapshot so future requests
            // for this run always get the same brief regardless of later
            // edits to the brief file.
            if (briefYaml !== null && briefYamlBytes !== null) {
              await writePerRunBrief(store, briefId, runId, briefYamlBytes);
              briefIsCanonical = true;
            }
          }
        }
      }

      const response = {
        briefId,
        runId,
        briefYaml,
        promptText: typeof summary.prompt === 'string' ? summary.prompt : null,
      };
      if (briefYaml !== null && briefIsCanonical) {
        await writeCachedJson(store, responseCacheKey, response);
      }
      return response;
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
      const requestedSheet = req.query.sheet;
      if (
        typeof requestedSheet === 'string' &&
        requestedSheet.length > 0 &&
        !/^sheet-\d+\.png$/i.test(requestedSheet)
      ) {
        reply.code(415);
        return { error: 'unsupported-sheet-filename', sheet: requestedSheet };
      }

      // ── Load summary + brief up-front for provenance-aware caching ──────────
      // The cache key embeds a fingerprint of the brief's resolved generation
      // config (post type-defaults merge) so a change to data/sprite-types or
      // data/palettes that modifies emptyCells produces a different key and
      // forces recomputation. Brief loading adds two small local file reads on
      // the hot path; it is much cheaper than the PNG decode + slice computation.
      //
      // When the brief cannot be loaded (source tree absent in offline mode,
      // invalid YAML, missing type-defaults), we fall back to the
      // non-fingerprinted key so a warmed offline sidecar still serves the
      // cached response without any source-tree inputs.
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
      // Load the brief for fingerprinting and slice-map computation.
      // Priority: (1) per-run immutable snapshot, (2) path-level durable key.
      // Track whether a per-run snapshot already exists so we can persist one
      // after a successful load when it doesn't (first warm of this run).
      const perRunSnapshotBytes = hasDerivedResourceCache(store)
        ? await readPerRunBrief(store, briefId, runId)
        : null;
      let durableBrief: Buffer | null = perRunSnapshotBytes;
      if (durableBrief === null && hasDerivedResourceCache(store)) {
        // Per-run snapshot not yet set — fall back to the path-level durable key
        // (last-writer-wins mirror). Once we load the brief we will persist it
        // as the per-run immutable snapshot so future requests are independent
        // of further edits to the brief file.
        const durableKey = workflowBriefKey(toRepoRelativePath(deps.repoRoot, resolved));
        if (await store.has(durableKey)) {
          try {
            durableBrief = await store.get(durableKey);
          } catch {
            durableBrief = null;
          }
        }
      }
      // Recover a wiped gitignored draft brief from the store before loading.
      await tryMaterialiseBrief(resolved);
      let durableBriefMatches = false;
      if (durableBrief !== null) {
        try {
          durableBriefMatches = readFileSync(resolved).equals(durableBrief);
        } catch {
          durableBriefMatches = false;
        }
      }
      // Load the fully-resolved Brief object for computeSliceMap and
      // fingerprinting. Use the cached bytes when available so the fingerprint
      // is based on the immutable generation config rather than whatever the
      // worktree currently has on disk. Fall back to loading from disk when no
      // cached bytes exist (first warm of this run).
      // diskBytes captures the raw file content when we load from disk so the
      // snapshot-write below can reuse it without a second readFileSync call.
      let brief: Brief | null;
      let diskBytes: Buffer | null = null;
      try {
        if (durableBrief !== null) {
          // Parse from the cached YAML so type-defaults and palette are
          // resolved consistently across worktrees for the same run.
          brief = loadBriefFromYaml(durableBrief.toString('utf8'), {
            projectRoot: deps.repoRoot,
          });
        } else {
          // Read the file once and parse from the buffer; reuse the bytes for
          // the per-run snapshot write below to avoid a second readFileSync.
          diskBytes = readFileSync(resolved);
          brief = loadBriefFromYaml(diskBytes.toString('utf8'), {
            projectRoot: deps.repoRoot,
          });
        }
      } catch {
        brief = null;
      }
      // Persist the per-run immutable snapshot on first successful load so that
      // future requests for this run always use the same brief bytes, even after
      // the brief file on disk is edited or the worktree is switched.
      //
      // Invariant: when brief !== null, snapshotBytes is always non-null.
      // • If durableBrief !== null: brief was parsed from durableBrief → snapshotBytes = durableBrief.
      // • If durableBrief === null: brief was parsed from diskBytes (readFileSync above). If
      //   readFileSync threw, the catch sets brief = null, so we never reach this block. If it
      //   succeeded, diskBytes is non-null → snapshotBytes = diskBytes.
      if (brief !== null && perRunSnapshotBytes === null) {
        const snapshotBytes = durableBrief ?? diskBytes;
        // Defensive null check: per the invariant above snapshotBytes is always
        // non-null when brief !== null, but we guard here to be safe against any
        // future code changes that break that invariant.
        if (snapshotBytes !== null) {
          await writePerRunBrief(store, briefId, runId, snapshotBytes);
        }
      }

      // Stable 16-hex fingerprint of the fully-resolved generation config.
      // Captures the effect of type-defaults and palette on emptyCells: if
      // those files change, the fingerprint changes, the fingerprinted key
      // misses, and the response is recomputed with fresh inputs.
      // The replacer sorts object keys at every depth for deterministic output
      // regardless of property insertion order across Node.js versions or brief
      // loading paths.
      const briefGenFingerprint =
        brief !== null
          ? createHash('sha256')
              .update(
                JSON.stringify(brief.generation, (_key, val: unknown) => {
                  if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
                    const sorted = Object.keys(val as object).sort();
                    return Object.fromEntries(
                      sorted.map((k) => [k, (val as Record<string, unknown>)[k]]),
                    );
                  }
                  return val;
                }),
              )
              .digest('hex')
              .slice(0, 16)
          : null;

      // The route-based portion of the cache key: identifies the specific
      // brief/run/sheet resource. Invalidation prefixes in
      // CachingRunStore.invalidateDerivedResources() key on this prefix.
      const routeCacheKey =
        `route/slice-map/${briefId}/${runId}/` +
        (typeof requestedSheet === 'string' && requestedSheet.length > 0
          ? requestedSheet
          : 'latest');
      const storedPerRunFingerprint =
        briefGenFingerprint === null
          ? await readPerRunSliceMapFingerprint(store, briefId, runId)
          : null;
      const effectiveFingerprint = briefGenFingerprint ?? storedPerRunFingerprint;
      // Per-run fallback key for source-less readers that still have no persisted
      // fingerprint (legacy warmed runs). It is immutable (set-if-absent) so
      // cross-worktree recomputes cannot overwrite the first warmed snapshot.
      const perRunFallbackKey = `${routeCacheKey}:${SLICE_MAP_SCHEMA_VERSION}:run-snapshot`;
      // Primary key: schema version + brief-generation fingerprint for full coherence.
      // Fallback key: immutable per-run snapshot for offline reads where the brief
      // fingerprint cannot be recomputed (source tree absent in a different worktree).
      const responseCacheKey =
        effectiveFingerprint !== null
          ? `${routeCacheKey}:${SLICE_MAP_SCHEMA_VERSION}:${effectiveFingerprint}`
          : perRunFallbackKey;

      // Try the primary (fingerprinted+versioned) key first.
      let cachedResponse = await readCachedJson(store, responseCacheKey);
      // Offline fallback: no fingerprint could be loaded/recovered; try the
      // immutable per-run key warmed by an online worktree.
      if (cachedResponse === null && effectiveFingerprint === null) {
        cachedResponse = await readCachedJson(store, perRunFallbackKey);
      }
      if (cachedResponse !== null) return cachedResponse;

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
      let sheetFile = sheetFiles[sheetFiles.length - 1]!;
      if (typeof requestedSheet === 'string' && requestedSheet.length > 0) {
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
        // Without the brief we cannot honour its `emptyCells`, so computeSliceMap
        // numbers every cell sequentially and `cell.index` no longer lines up with
        // the run's `variantIndex`. Flag that with `emptyCellsApplied:false` so the
        // client stops trusting cell indices (selection / highlight / raw crop).
        const sliceMap = brief
          ? computeSliceMap(sheetPng, { emptyCells: brief.generation.sheet.emptyCells })
          : computeSliceMap(sheetPng, {});
        const response = {
          ...sliceMap,
          sheetFile,
          algorithm: 'content-aware',
          emptyCellsApplied: brief !== null,
        };
        // Only cache when the brief loaded successfully (brief !== null), so
        // a brief-less response is never stored as the canonical snapshot.
        // A per-run immutable brief snapshot is authoritative even when the
        // current worktree file has changed since run generation.
        const hasPerRunSnapshot = perRunSnapshotBytes !== null;
        const briefProvenanceTrusted = hasPerRunSnapshot || durableBriefMatches;
        if (briefProvenanceTrusted && brief !== null && briefGenFingerprint !== null) {
          await Promise.all([
            writeCachedJson(store, responseCacheKey, response),
            writePerRunSliceMapFingerprint(store, briefId, runId, briefGenFingerprint),
            writeCachedJsonIfAbsent(store, perRunFallbackKey, response),
          ]);
        }
        return response;
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

  // Shared brief + summary resolution for the re-run endpoints. Mirrors the
  // slice-map handler (load summary.json → resolve the brief path), plus the
  // generate handler's re-materialisation of a checkpoint-wiped draft brief.
  type RunBriefResolution =
    | { readonly ok: true; readonly summary: RunSummary; readonly loaded: LoadedBrief }
    | { readonly ok: false; readonly status: number; readonly body: Record<string, unknown> };
  const resolveRunForRerun = async (
    briefId: string,
    runId: string,
  ): Promise<RunBriefResolution> => {
    if (safeJoin(deps.runsDir, [briefId, runId, 'summary.json']) === null) {
      return { ok: false, status: 403, body: { error: 'forbidden-path' } };
    }
    let summary: RunSummary;
    try {
      summary = await loadRunSummary(store, briefId, runId);
    } catch (err) {
      if (err instanceof RerunError) {
        return {
          ok: false,
          status: rerunErrorStatus(err.kind),
          body: { error: err.kind, message: err.message },
        };
      }

      throw err;
    }
    if (typeof summary.briefPath !== 'string') {
      return { ok: false, status: 404, body: { error: 'brief-path-missing' } };
    }
    const resolved = path.isAbsolute(summary.briefPath)
      ? summary.briefPath
      : path.resolve(deps.repoRoot, summary.briefPath);
    const rel = path.relative(deps.repoRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, status: 403, body: { error: 'forbidden-brief-path' } };
    }
    // A re-run can happen after a checkpoint wiped the gitignored draft brief:
    // re-materialise it from the store before failing (same as /api/workflow/generate).
    if (!existsSync(resolved) && !(await tryMaterialiseBrief(resolved))) {
      return { ok: false, status: 404, body: { error: 'brief-not-found' } };
    }
    let loaded: LoadedBrief;
    try {
      loaded = loadBrief(resolved, { projectRoot: deps.repoRoot });
    } catch {
      return { ok: false, status: 500, body: { error: 'brief-load-failed' } };
    }
    return { ok: true, summary, loaded };
  };

  const parsePostprocessMode = (
    value: unknown,
    hasOptions: boolean,
  ): 'default' | 'persisted' | 'replace' | 'reset' | null => {
    if (value === undefined || value === null || value === '') {
      return hasOptions ? 'replace' : 'default';
    }
    return value === 'default' || value === 'persisted' || value === 'replace' || value === 'reset'
      ? value
      : null;
  };

  const parsePostprocessOptions = (
    value: unknown,
    loaded: LoadedBrief,
  ): PostprocessOptions | undefined => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('body.options must be an object');
    }
    const raw = value as Record<string, unknown>;
    return {
      ...raw,
      ...(raw.disabledModules !== undefined
        ? { disabledModules: normalizeDisabledModules(raw.disabledModules, loaded.brief) }
        : {}),
    } as PostprocessOptions;
  };

  const parseManualAnchorPayload = (
    value: unknown,
  ): { variantIndex: number; x: number; y: number; applyToAllVariants?: boolean } | null => {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as {
      variantIndex?: unknown;
      x?: unknown;
      y?: unknown;
      applyToAllVariants?: unknown;
    };
    if (
      !Number.isInteger(candidate.variantIndex) ||
      typeof candidate.x !== 'number' ||
      typeof candidate.y !== 'number' ||
      (candidate.applyToAllVariants !== undefined &&
        typeof candidate.applyToAllVariants !== 'boolean')
    ) {
      return null;
    }
    return {
      variantIndex: candidate.variantIndex as number,
      x: candidate.x,
      y: candidate.y,
      ...(candidate.applyToAllVariants === true ? { applyToAllVariants: true } : {}),
    };
  };

  const parseFacingPayload = (
    value: unknown,
  ): { variantIndex: number; direction: 'left' | 'right'; applyToAllVariants?: boolean } | null => {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as {
      variantIndex?: unknown;
      direction?: unknown;
      applyToAllVariants?: unknown;
    };
    if (
      !Number.isInteger(candidate.variantIndex) ||
      (candidate.direction !== 'left' && candidate.direction !== 'right') ||
      (candidate.applyToAllVariants !== undefined &&
        typeof candidate.applyToAllVariants !== 'boolean')
    ) {
      return null;
    }
    return {
      variantIndex: candidate.variantIndex as number,
      direction: candidate.direction,
      ...(candidate.applyToAllVariants === true ? { applyToAllVariants: true } : {}),
    };
  };

  // POST /api/runs/:briefId/:runId/postprocess — re-run PostProcess (content-aware
  // re-slice + re-post-process + re-score) over the STORED sheet with tweakable
  // options, WITHOUT regenerating. Deterministic (no LLM), so it is CI-safe.
  app.post<{
    Params: { briefId: string; runId: string };
    Body: RunPostprocessBody;
  }>('/api/runs/:briefId/:runId/postprocess', async (req, reply) => {
    const { briefId, runId } = req.params;
    const body = (req.body ?? {}) as RunPostprocessBody;
    const mode = parsePostprocessMode(body.mode, body.options !== undefined);
    if (mode === null) {
      reply.code(400);
      return {
        error: 'bad-request',
        message: 'body.mode must be default, persisted, replace, or reset',
      };
    }
    const manualAnchor = parseManualAnchorPayload(body.manualAnchor);
    const clearManualAnchor = body.manualAnchor === null;
    if (body.manualAnchor !== undefined && body.manualAnchor !== null && manualAnchor === null) {
      reply.code(400);
      return {
        error: 'bad-request',
        message: 'body.manualAnchor must be { variantIndex, x, y, applyToAllVariants? }',
      };
    }
    const weaponAnchor = parseManualAnchorPayload(body.weaponAnchor);
    const clearWeaponAnchor = body.weaponAnchor === null;
    if (body.weaponAnchor !== undefined && body.weaponAnchor !== null && weaponAnchor === null) {
      reply.code(400);
      return {
        error: 'bad-request',
        message: 'body.weaponAnchor must be { variantIndex, x, y, applyToAllVariants? }',
      };
    }
    const facing = parseFacingPayload(body.facing);
    const clearFacing = body.facing === null;
    if (body.facing !== undefined && body.facing !== null && facing === null) {
      reply.code(400);
      return {
        error: 'bad-request',
        message: 'body.facing must be { variantIndex, direction: left|right, applyToAllVariants? }',
      };
    }
    let variantIndexes: number[] | undefined;
    if (body.variantIndexes !== undefined) {
      if (
        !Array.isArray(body.variantIndexes) ||
        body.variantIndexes.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < 0)
      ) {
        reply.code(400);
        return {
          error: 'bad-request',
          message: 'body.variantIndexes must be an array of non-negative integers',
        };
      }
      variantIndexes = body.variantIndexes as number[];
    }
    if (body.sheet !== undefined && typeof body.sheet !== 'string') {
      reply.code(400);
      return { error: 'bad-request', message: 'body.sheet must be a sheet-NN.png filename' };
    }
    const sheet = typeof body.sheet === 'string' && body.sheet.length > 0 ? body.sheet : undefined;

    const resolution = await resolveRunForRerun(briefId, runId);
    if (!resolution.ok) {
      reply.code(resolution.status);
      return resolution.body;
    }
    let options: PostprocessOptions | undefined;
    try {
      options = parsePostprocessOptions(body.options, resolution.loaded);
    } catch (error) {
      reply.code(400);
      return {
        error: 'bad-request',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      let persistedManualAnchor: ManualAnchorOverride | null | undefined = undefined;
      if (manualAnchor) {
        persistedManualAnchor = await writeManualAnchor(
          store,
          `${briefId}/${runId}`,
          manualAnchor,
          new Date().toISOString(),
        );
      } else if (clearManualAnchor) {
        await removeManualAnchor(store, `${briefId}/${runId}`);
        persistedManualAnchor = null;
      }
      let persistedWeaponAnchor: ManualWeaponAnchorOverride | null | undefined = undefined;
      if (weaponAnchor) {
        persistedWeaponAnchor = await writeManualWeaponAnchor(
          store,
          `${briefId}/${runId}`,
          weaponAnchor,
          new Date().toISOString(),
        );
      } else if (clearWeaponAnchor) {
        await removeManualWeaponAnchor(store, `${briefId}/${runId}`);
        persistedWeaponAnchor = null;
      }
      const result = await repostprocessRun({
        store,
        briefId,
        runId,
        summary: resolution.summary,
        brief: resolution.loaded.brief,
        palette: resolution.loaded.palette,
        ...(options ? { options } : {}),
        ...(mode ? { optionsMode: mode } : {}),
        ...(persistedManualAnchor !== undefined ? { manualAnchor: persistedManualAnchor } : {}),
        ...(persistedWeaponAnchor !== undefined
          ? { manualWeaponAnchor: persistedWeaponAnchor }
          : {}),
        ...(clearFacing ? { facing: null } : facing ? { facing } : {}),
        ...(variantIndexes ? { variantIndexes } : {}),
        ...(sheet ? { sheetFile: sheet } : {}),
      });
      return {
        status: 'completed' as const,
        briefId,
        runId,
        sheetFile: result.sheetFile,
        summary: result.summary,
      };
    } catch (err) {
      if (err instanceof RerunError) {
        reply.code(rerunErrorStatus(err.kind));
        return { error: err.kind, message: err.message };
      }
      reply.code(500);
      return {
        error: 'postprocess-failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // POST /api/runs/:briefId/:runId/judge — re-run the VLM judge over the STORED
  // processed PNGs (optionally a subset via `variantIndexes`, optionally past a
  // failing sensor via `force`). LLM-as-judge ⇒ refused in CI (Constitutional §3).
  app.post<{
    Params: { briefId: string; runId: string };
    Body: RunJudgeBody;
  }>('/api/runs/:briefId/:runId/judge', async (req, reply) => {
    const env = deps.env ?? process.env;
    if (env.CI !== undefined) {
      reply.code(403);
      return {
        error: 'ci-refused',
        message:
          'Per Constitutional §3, the sprite-pipeline judge endpoint is local-only ' +
          '(LLM-as-judge must not run in CI). Run the gallery sidecar locally to re-judge.',
      };
    }

    const { briefId, runId } = req.params;
    const body = (req.body ?? {}) as RunJudgeBody;
    const force = body.force === true;
    let variantIndexes: number[] | undefined;
    if (body.variantIndexes !== undefined) {
      if (
        !Array.isArray(body.variantIndexes) ||
        body.variantIndexes.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < 0)
      ) {
        reply.code(400);
        return {
          error: 'bad-request',
          message: 'body.variantIndexes must be an array of non-negative integers',
        };
      }
      variantIndexes = body.variantIndexes as number[];
    }

    const resolution = await resolveRunForRerun(briefId, runId);
    if (!resolution.ok) {
      reply.code(resolution.status);
      return resolution.body;
    }
    const visionProvider = createVisionProvider({ env });
    if (!visionProvider) {
      reply.code(400);
      return {
        error: 'vision-not-configured',
        message:
          'No vision provider configured. Set AZURE_OPENAI_VISION_DEPLOYMENT and ' +
          'SPRITES_VISION_PROVIDER=azure-openai to re-judge.',
      };
    }
    try {
      const brief = resolution.loaded.brief;
      // Re-judge against the SAME references the run was generated with (our
      // approved sprites recorded in the summary), never the retired Kenney
      // `brief.references`. Fails loudly if those assets drifted or are absent.
      const referencePngs = loadRecordedReferencePngs({
        summary: resolution.summary,
        repoRoot: deps.repoRoot,
      });
      const result = await rejudgeRun({
        store,
        briefId,
        runId,
        summary: resolution.summary,
        brief,
        referencePngs,
        styleGuide: loadStyleGuide(deps.repoRoot),
        visionProvider,
        force,
        ...(variantIndexes ? { variantIndexes } : {}),
        env,
      });
      return { status: 'completed' as const, briefId, runId, summary: result.summary };
    } catch (err) {
      if (err instanceof RerunError) {
        reply.code(rerunErrorStatus(err.kind));
        return { error: err.kind, message: err.message };
      }
      reply.code(500);
      return {
        error: 'judge-failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  app.post<{
    Params: { briefId: string; runId: string };
    Body: RunManualAnchorBody;
  }>('/api/runs/:briefId/:runId/manual-anchor', async (req, reply) => {
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
    const body = (req.body ?? {}) as RunManualAnchorBody;
    if (body.clear === true) {
      await removeManualAnchor(store, `${briefId}/${runId}`);
      return { status: 'cleared' as const };
    }
    const parsed = parseManualAnchorPayload(body);
    if (!parsed) {
      reply.code(400);
      return {
        error: 'bad-request',
        message: 'body must include clear:true or manual anchor { variantIndex, x, y }',
      };
    }
    const manualAnchor = await writeManualAnchor(
      store,
      `${briefId}/${runId}`,
      parsed,
      new Date().toISOString(),
    );
    return { status: 'set' as const, manualAnchor };
  });

  // POST /api/runs/:briefId/:runId/weapon-anchor — set or clear the run-level
  // weapon anchor. This writes the override file used by repostprocessRun to
  // emit per-variant NN.anchor.weapon.json sidecars on the next postprocess.
  app.post<{
    Params: { briefId: string; runId: string };
    Body: RunWeaponAnchorBody;
  }>('/api/runs/:briefId/:runId/weapon-anchor', async (req, reply) => {
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
    const body = (req.body ?? {}) as RunWeaponAnchorBody;
    if (body.clear === true) {
      await removeManualWeaponAnchor(store, `${briefId}/${runId}`);
      return { status: 'cleared' as const };
    }
    const parsed = parseManualAnchorPayload(body);
    if (!parsed) {
      reply.code(400);
      return {
        error: 'bad-request',
        message:
          'body must include clear:true or weapon anchor { variantIndex, x, y, applyToAllVariants? }',
      };
    }
    const weaponAnchor = await writeManualWeaponAnchor(
      store,
      `${briefId}/${runId}`,
      parsed,
      new Date().toISOString(),
    );
    return { status: 'set' as const, weaponAnchor };
  });

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

    // CSRF guard (same policy as /api/checkin and /api/.../accept, ADR 0066
    // CTX-005): this route now runs `git fetch`/`git push` against the remote
    // assets/queue branch (durable persistence, below), so a cross-origin
    // browser POST must not be able to trigger an authenticated remote push.
    // Reject any request from a browser Origin NOT in the exact per-worktree
    // trusted set; server-side callers (Node fetch, no Origin header) stay
    // trusted, exactly as the sibling mutating routes do.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !deps.trustedMutationOrigins?.includes(origin)) {
      reply.code(403);
      return {
        error: 'forbidden-origin',
        message: 'This browser origin is not allowed to approve sprite assets.',
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

    // Serialized with /checkin and /accept (concern #5, ADR 0066): approve
    // mutates the same manifest/catalog/PNG surface a concurrent check-in
    // worktree operation reads, so both must run under the same process-wide
    // lock. Acquired here, at the route boundary, not nested inside another
    // locked call — avoids deadlock.
    return withCheckinMutationLock(async () => {
      let hydrated: HydratedRunDir | null = null;
      let entry: ManifestEntry;
      let alreadyApproved = false;
      try {
        hydrated =
          store.backend === 'local'
            ? null
            : await hydrateRunDirForApproveFromStore(store, briefId, runId, variantIndex);
        const runDir = hydrated?.runDir ?? safeJoin(deps.runsDir, [briefId, runId]);
        if (runDir === null) {
          reply.code(403);
          return { error: 'forbidden-path' };
        }
        try {
          entry = approveVariant({
            runDir,
            variantIndex,
            manifestPath,
            catalogPath,
            publicAssetsDir,
            repoRoot: deps.repoRoot,
          });
        } catch (err) {
          // Failed-push retry gap: a prior approval succeeded LOCALLY (so this
          // re-approve is a no-op `already-approved`) but its best-effort durable
          // queue-commit may never have pushed to assets/queue. Rather than
          // return a bare 409 that can never re-attempt the push, load the stored
          // manifest entry and fall through to re-run the queue-commit below so a
          // retry actually persists the asset remotely.
          if (err instanceof ApproveError && err.kind === 'already-approved') {
            const stored = loadApprovedEntry({ runDir, variantIndex, manifestPath });
            if (stored === null) {
              // The manifest entry is genuinely gone — nothing to re-queue.
              reply.code(409);
              return { error: err.kind, message: err.message };
            }
            entry = stored;
            alreadyApproved = true;
          } else {
            throw err;
          }
        }
      } catch (err) {
        return mapApproveError(reply, err);
      } finally {
        hydrated?.cleanup();
      }

      // Durably persist the approved asset onto the remote assets/queue branch so
      // the edit survives across sessions/worktrees/processes. Runs on the fresh
      // approval AND on an `already-approved` retry (above) so a previously-failed
      // push can be re-attempted. Best-effort: the local approve already
      // succeeded, so a queue-commit failure is surfaced in the response (and
      // logged) rather than rolling back. The route already refuses on CI above,
      // so the primitive's CI guard never fires here.
      let queueCommit: QueueCommitResult | { status: 'failed'; error: string };
      try {
        queueCommit = await runQueueCommit(
          deps.repoRoot,
          [
            {
              assetPath: entry.assetPath,
              manifestKey: entry.spriteName,
              briefId: entry.briefId,
              variantIndex: entry.variantIndex,
            },
          ],
          createDefaultQueueCommitDeps(deps.repoRoot, env),
          { message: `chore(assets): approve ${entry.spriteName}` },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        req.log.warn(`queue-commit failed for ${entry.spriteName}: ${message}`);
        queueCommit = { status: 'failed', error: message };
      }

      return { ...entry, ...(alreadyApproved ? { alreadyApproved: true } : {}), queueCommit };
    });
  });

  // DELETE /api/manifest/:variantId — evict a previously approved variant.
  // Removes the entry from manifest.json, removes the catalog entry, and
  // deletes the PNG from public/assets/generated/. Serialized under the
  // same mutation lock as /approve and /checkin.
  app.delete<{ Params: { variantId: string } }>('/api/manifest/:variantId', async (req, reply) => {
    // Constitutional §3: same CI refusal as /approve.
    const env = deps.env ?? process.env;
    if (env.CI !== undefined) {
      reply.code(403);
      return {
        error: 'ci-refused',
        message:
          'Per Constitutional §3, the sprite-pipeline unapprove endpoint is local-only. ' +
          'It mutates checked-in assets under public/assets/generated/ and the manifest. ' +
          'Run the gallery sidecar locally (npm run sprites:gallery) to unapprove.',
      };
    }

    const { variantId } = req.params;
    // Basic format check: must be a non-empty slug segment (no path separators).
    if (!variantId || /[/\\]/.test(variantId)) {
      reply.code(400);
      return { error: 'bad-request', message: 'variantId must be a single path segment' };
    }

    const publicAssetsDir = deps.publicAssetsDir ?? path.join(deps.repoRoot, 'public', 'assets');
    const manifestPath =
      deps.manifestPath ?? path.join(publicAssetsDir, 'generated', 'manifest.json');
    const catalogPath =
      deps.catalogPath ?? path.join(deps.repoRoot, 'src', 'shared', 'data', 'sprite-catalog.json');

    return withCheckinMutationLock(async () => {
      // Pre-mutation queue check: if this variant's asset is already in the
      // durable asset-checkin queue (an `assets/*` branch + open issue filed
      // by /accept), evicting the local copy won't remove it from that
      // pipeline. Reject with 409 so the caller can close the issue first.
      const assetPath = `generated/${variantId}.png`;
      const checkinDeps = deps.checkinDeps ?? createDefaultCheckinDeps(deps.repoRoot, env);
      const listQueuedAssets =
        checkinDeps.listQueuedAssets ??
        (() => Promise.resolve(new Map<string, QueuedAssetCheckin>()));
      let queuedAssets: ReadonlyMap<string, QueuedAssetCheckin>;
      try {
        queuedAssets = await listQueuedAssets();
      } catch (err) {
        return mapCheckinError(reply, err, 'unapprove-queue-check-failed');
      }
      const queued = queuedAssets.get(assetPath);
      if (queued) {
        reply.code(409);
        return {
          error: 'queued-conflict',
          message:
            `${assetPath} is already queued for check-in (${queued.issueUrl}). ` +
            'Close or retract that issue before evicting this variant to prevent it ' +
            'from reappearing in the next asset PR.',
        };
      }

      let entry: ManifestEntry;
      try {
        entry = unapproveVariant({
          variantId,
          manifestPath,
          catalogPath,
          publicAssetsDir,
        });
      } catch (err) {
        if (err instanceof UnapproveError) {
          reply.code(err.kind === 'not-found' ? 404 : 500);
          return { error: err.kind, message: err.message };
        }
        reply.code(500);
        return {
          error: 'unapprove-failed',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      return entry;
    });
  });

  app.post<{
    Params: { briefId: string; runId: string };
    Body: { variantIndex?: unknown };
  }>('/api/runs/:briefId/:runId/accept', async (req, reply) => {
    // CSRF guard (concern #1, ADR 0066 CTX-005): this atomic operation
    // approves AND files a GitHub issue in one shot, so binding to 127.0.0.1
    // alone is not enough — modern browsers attach an Origin header to every
    // non-GET request (same-origin or cross-origin), so ANY browser-issued
    // request to this route is distinguishable from the trusted caller, the
    // workflow canvas extension's Node-based `fetch` (which never sends
    // Origin). Refuse outright rather than trying to allowlist origins here.
    // /approve and /checkin (used by browser-based gallery UIs) are untouched.
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      reply.code(403);
      return {
        error: 'forbidden-origin',
        message: 'Direct browser requests are not allowed on this route.',
      };
    }

    // Constitutional §3: same CI refusal as /approve and /checkin, checked
    // before any approval work.
    const env = deps.env ?? process.env;
    if (env.CI !== undefined) {
      reply.code(403);
      return {
        error: 'ci-refused',
        message:
          'Per Constitutional §3, the sprite-pipeline accept endpoint is local-only. ' +
          'It approves checked-in assets and files a GitHub issue. ' +
          'Run the gallery sidecar locally (npm run sprites:gallery) to accept.',
      };
    }

    const { briefId, runId } = req.params;
    if (safeJoin(deps.runsDir, [briefId, runId, 'summary.json']) === null) {
      reply.code(403);
      return { error: 'forbidden-path' };
    }

    const body = (req.body ?? {}) as { variantIndex?: unknown };
    const variantIndex = body.variantIndex;
    if (typeof variantIndex !== 'number' || !Number.isInteger(variantIndex) || variantIndex < 0) {
      reply.code(400);
      return {
        error: 'bad-request',
        message: 'briefId, runId, and a non-negative integer variantIndex are required.',
      };
    }

    const publicAssetsDir = deps.publicAssetsDir ?? path.join(deps.repoRoot, 'public', 'assets');
    const manifestPath =
      deps.manifestPath ?? path.join(publicAssetsDir, 'generated', 'manifest.json');
    const catalogPath =
      deps.catalogPath ?? path.join(deps.repoRoot, 'src', 'shared', 'data', 'sprite-catalog.json');
    const checkinDeps = deps.checkinDeps ?? createDefaultCheckinDeps(deps.repoRoot, env);
    const listQueuedAssets =
      checkinDeps.listQueuedAssets ??
      (() => Promise.resolve(new Map<string, QueuedAssetCheckin>()));

    // Serialized with /approve and /checkin (concern #5) — see
    // withCheckinMutationLock's docstring for why this can't deadlock.
    return withCheckinMutationLock(async () => {
      let hydrated: HydratedRunDir | null = null;
      try {
        hydrated =
          store.backend === 'local'
            ? null
            : await hydrateRunDirForApproveFromStore(store, briefId, runId, variantIndex);
        const runDir = hydrated?.runDir ?? safeJoin(deps.runsDir, [briefId, runId]);
        if (runDir === null) {
          reply.code(403);
          return { error: 'forbidden-path' };
        }

        let identity: VariantIdentity;
        try {
          identity = resolveVariantIdentity(runDir, variantIndex);
        } catch (err) {
          return mapApproveError(reply, err);
        }

        // Reconcile BEFORE mutating (concern #4): an already-queued assetPath
        // short-circuits here — same content hash reports the existing queued
        // state, a different hash (or an un-hashed legacy entry) refuses with
        // 409 WITHOUT ever calling approveVariant/runAssetCheckin below. The
        // queue-list read itself can fail (e.g. `gh issue list` erroring) —
        // that must surface the SAME structured mapping as every other
        // check-in failure, not an uncaught-rejection generic 500.
        let queuedBefore: ReadonlyMap<string, QueuedAssetCheckin>;
        try {
          queuedBefore = await listQueuedAssets();
        } catch (err) {
          return mapCheckinError(reply, err);
        }
        const reconciledBefore = reconcileQueuedAsset(reply, queuedBefore, identity, variantIndex);
        if (reconciledBefore !== undefined) {
          return reconciledBefore;
        }

        try {
          approveVariant({
            runDir,
            variantIndex,
            manifestPath,
            catalogPath,
            publicAssetsDir,
            repoRoot: deps.repoRoot,
          });
        } catch (err) {
          // `already-approved` (exact requested slot already has this exact
          // content) is a safe no-op here: approveVariant throws BEFORE
          // writing anything, so it's fine to fall through to check-in using
          // the identity resolved above — that identity/assetPath IS what's
          // already approved. `duplicate-content` (cross-variant collision)
          // is NOT safe to treat the same way: the requested variantId was
          // refused and never created, so falling through would check in an
          // asset that doesn't exist. Let it (and any other kind) fall to
          // mapApproveError below, which reports it as a genuine 409 failure.
          if (!(err instanceof ApproveError) || err.kind !== 'already-approved') {
            return mapApproveError(reply, err);
          }
        }

        try {
          const result = await runAssetCheckin(deps.repoRoot, checkinDeps, {});
          return {
            state: 'queued' as const,
            existing: false,
            briefId: identity.briefId,
            variantIndex,
            assetPath: identity.assetPath,
            issueUrl: result.issueUrl,
            assetCount: result.plan.assets.length,
          } satisfies AcceptedResponse;
        } catch (err) {
          if (err instanceof CheckinError && err.kind === 'nothing-to-checkin') {
            // Race: another request/process queued this exact asset between
            // our pre-mutation check and now. Reconcile once more before
            // reporting failure — and, same as the pre-mutation read above, a
            // queue-list failure here must map to the SAME structured body
            // instead of an uncaught-rejection generic 500.
            let queuedAfter: ReadonlyMap<string, QueuedAssetCheckin>;
            try {
              queuedAfter = await listQueuedAssets();
            } catch (listErr) {
              return mapCheckinError(reply, listErr);
            }
            const reconciledAfter = reconcileQueuedAsset(
              reply,
              queuedAfter,
              identity,
              variantIndex,
            );
            if (reconciledAfter !== undefined) {
              return reconciledAfter;
            }
          }
          return mapCheckinError(reply, err);
        }
      } finally {
        hydrated?.cleanup();
      }
    });
  });

  app.post<{ Body: { base?: unknown; remote?: unknown } }>(
    '/api/checkin/prepare',
    async (req, reply) => {
      // CSRF guard (same policy as /api/checkin): prepareAssetCheckin runs
      // `git fetch` and `gh issue list`, so a cross-origin POST could
      // repeatedly trigger unbounded local/network work. Allow only the same
      // exact per-worktree trusted origins as the mutating /api/checkin route;
      // server-side callers (Node-based fetch, no Origin header) remain trusted.
      const origin = req.headers.origin;
      if (typeof origin === 'string' && !deps.trustedMutationOrigins?.includes(origin)) {
        reply.code(403);
        return {
          error: 'forbidden-origin',
          message: 'This browser origin is not allowed to trigger asset check-in preparation.',
        };
      }

      // Fast pre-flight check: detect what will be checked in WITHOUT pushing/filing issue.
      // This provides immediate feedback and allows the UI to show progress for the slow parts.
      // Calls the SAME `prepareAssetCheckin`, with the SAME injected deps/options, that
      // `/api/checkin` uses to actually execute — so preview and execution can never diverge
      // (manifest enrichment, queued-content reconciliation, and error mapping included).
      const body = (req.body ?? {}) as { base?: unknown; remote?: unknown };
      const options: { baseBranch?: string; remote?: string } = {};
      if (typeof body.base === 'string' && body.base.trim() !== '') options.baseBranch = body.base;
      if (typeof body.remote === 'string' && body.remote.trim() !== '')
        options.remote = body.remote;

      try {
        const env = deps.env ?? process.env;
        const checkinDeps = deps.checkinDeps ?? createDefaultCheckinDeps(deps.repoRoot, env);
        const prepared = await prepareAssetCheckin(deps.repoRoot, checkinDeps, options);
        const slug = prepared.plan.branch.startsWith('assets/')
          ? prepared.plan.branch.slice('assets/'.length)
          : prepared.plan.branch;

        return {
          assetCount: prepared.plan.assets.length,
          branch: prepared.plan.branch,
          slug,
          assets: prepared.plan.assets,
          estimatedDuration: 'Pushing: ~5s · Filing issue: ~3s',
        };
      } catch (err) {
        return mapCheckinError(reply, err, 'prepare-failed');
      }
    },
  );

  app.post<{ Body: { base?: unknown; remote?: unknown; slug?: unknown } }>(
    '/api/checkin',
    async (req, reply) => {
      // CSRF guard (ADR 0066): this route
      // MUTATES (pushes a branch, files a GitHub issue), and binding to
      // 127.0.0.1 alone is not enough to protect it — a request with a
      // `text/plain` (or content-type-less) body needs no CORS preflight at
      // all, so ANY page, even a non-loopback one, could otherwise trigger a
      // real check-in merely by having the user's browser visit it while the
      // sidecar happens to be running locally. Browser calls are allowed only
      // from the exact per-worktree gallery origins supplied by the CLI.
      // Server-side callers remain trusted because they send no Origin.
      const origin = req.headers.origin;
      if (typeof origin === 'string' && !deps.trustedMutationOrigins?.includes(origin)) {
        reply.code(403);
        return {
          error: 'forbidden-origin',
          message: 'This browser origin is not allowed to publish sprite art.',
        };
      }

      // Check-in publishes locally-approved art as a remote branch + tracking
      // issue (NO PR). Like approve, it is local-only — `runAssetCheckin` refuses
      // when `env.CI` is set; we map that to 403 here for the e2e/gallery caller.
      const body = (req.body ?? {}) as { base?: unknown; remote?: unknown; slug?: unknown };
      const options: { baseBranch?: string; remote?: string; slug?: string } = {};
      if (typeof body.base === 'string' && body.base.trim() !== '') options.baseBranch = body.base;
      if (typeof body.remote === 'string' && body.remote.trim() !== '')
        options.remote = body.remote;
      if (typeof body.slug === 'string' && body.slug.trim() !== '') options.slug = body.slug;

      // Serialized with /approve and /accept (concern #5, ADR 0066) — see
      // withCheckinMutationLock's docstring for why (and why this can't deadlock).
      return withCheckinMutationLock(async () => {
        try {
          const env = deps.env ?? process.env;
          const result = await runAssetCheckin(
            deps.repoRoot,
            deps.checkinDeps ?? createDefaultCheckinDeps(deps.repoRoot, env),
            options,
          );
          return {
            branch: result.branch,
            issueUrl: result.issueUrl,
            issueTitle: result.plan.issueTitle,
            issueBody: result.plan.issueBody,
            assets: result.plan.assets,
          };
        } catch (err) {
          return mapCheckinError(reply, err);
        }
      });
    },
  );

  app.post<{ Body: WorkflowSynthesizeBody }>('/api/workflow/synthesize', async (req, reply) => {
    const body = (req.body ?? {}) as WorkflowSynthesizeBody;
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      reply.code(400);
      return { error: 'bad-request', message: 'body.name must be a non-empty string' };
    }
    let briefHint: string | undefined;
    if (body.brief !== undefined) {
      if (typeof body.brief !== 'string') {
        reply.code(400);
        return { error: 'bad-request', message: 'body.brief must be a string when provided' };
      }
      const trimmed = body.brief.trim();
      if (trimmed !== '') {
        briefHint = trimmed;
      }
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
    let floor = 1;
    if (body.floor !== undefined) {
      if (
        typeof body.floor !== 'number' ||
        !Number.isInteger(body.floor) ||
        body.floor < 1 ||
        body.floor > 20
      ) {
        reply.code(400);
        return {
          error: 'bad-request',
          message: 'body.floor must be an integer in [1, 20]',
        };
      }
      floor = body.floor;
    }
    let sizeVariant: SizeVariant | undefined;
    if (body.sizeVariant !== undefined && body.sizeVariant !== null) {
      if (!isSizeVariant(body.sizeVariant)) {
        reply.code(400);
        return {
          error: 'bad-request',
          message: `body.sizeVariant must be one of ${SIZE_VARIANTS.join(', ')}`,
        };
      }
      sizeVariant = body.sizeVariant;
    }

    try {
      const env = deps.env ?? process.env;
      const provider = createSynthProvider({ env });
      const result = await synthesizeBrief({
        name: body.name,
        ...(briefHint ? { briefHint } : {}),
        ...(type ? { type } : {}),
        ...(sizeVariant ? { sizeVariant } : {}),
        candidates,
        floor,
        partial: true,
        provider,
        repoRoot: deps.repoRoot,
        env,
      });
      // Mirror each candidate YAML into the store so a worktree checkpoint
      // that wipes the gitignored briefs/draft tree can be recovered at
      // promote time (Phase 2 durability).
      for (const candidate of result.written) {
        await mirrorBriefToStore(store, deps.repoRoot, candidate.yamlPath);
      }
      return {
        name: result.name,
        type: result.type,
        sizeVariant: result.sizeVariant,
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
    if (!sourceAbs) {
      reply.code(404);
      return { error: 'source-not-found', message: 'sourceYamlPath does not exist in repo' };
    }
    // The source candidate lives under the gitignored briefs/draft tree, so a
    // worktree checkpoint may have wiped it. Re-materialise it from the store
    // before failing (Phase 2 durability).
    if (!existsSync(sourceAbs) && !(await tryMaterialiseBrief(sourceAbs))) {
      reply.code(404);
      return { error: 'source-not-found', message: 'sourceYamlPath does not exist in repo' };
    }
    const destRel =
      target === 'draft'
        ? path.join(
            'briefs',
            'draft',
            briefDirectoryForType(body.type as Brief['type']),
            `${body.name}.yaml`,
          )
        : path.join(
            'briefs',
            briefDirectoryForType(body.type as Brief['type']),
            `${body.name}.yaml`,
          );
    const destAbs = path.resolve(deps.repoRoot, destRel);
    mkdirSync(path.dirname(destAbs), { recursive: true });
    copyFileSync(sourceAbs, destAbs);
    // Mirror the promoted brief too, so a later generate survives a wipe.
    await mirrorBriefToStore(store, deps.repoRoot, destAbs);
    return {
      briefPath: toRepoRelativePath(deps.repoRoot, destAbs),
      target,
    };
  });

  app.put<{ Body: WorkflowBriefSaveBody }>('/api/workflow/brief', async (req, reply) => {
    const body = (req.body ?? {}) as WorkflowBriefSaveBody;
    if (typeof body.yamlPath !== 'string' || body.yamlPath.trim() === '') {
      reply.code(400);
      return { error: 'bad-request', message: 'body.yamlPath must be a non-empty string' };
    }
    if (typeof body.yaml !== 'string' || body.yaml.trim() === '') {
      reply.code(400);
      return { error: 'bad-request', message: 'body.yaml must be a non-empty string' };
    }
    const abs = resolveRepoPath(deps.repoRoot, body.yamlPath);
    if (!abs) {
      reply.code(400);
      return {
        error: 'bad-request',
        message: 'yamlPath must be a repo-relative path inside the repo',
      };
    }
    // Restrict edits to brief YAML files so this endpoint can never overwrite
    // arbitrary repo files.
    const relPosix = toRepoRelativePath(deps.repoRoot, abs);
    if (!relPosix.startsWith('briefs/') || !relPosix.endsWith('.yaml')) {
      reply.code(400);
      return { error: 'bad-request', message: 'yamlPath must be a briefs/**/*.yaml file' };
    }
    // Validate BEFORE persisting durably: write the candidate text, then run it
    // through the full brief loader (YAML parse + per-type defaults merge + Zod
    // schema). On failure, roll back to the prior content so a bad edit never
    // leaves an invalid brief on disk.
    const previous = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body.yaml, 'utf8');
    let description = '';
    try {
      loadBrief(abs, { projectRoot: deps.repoRoot });
      const parsed = parseYaml(body.yaml) as { description?: unknown; prompt?: unknown };
      if (typeof parsed.description === 'string') {
        description = parsed.description;
      } else if (typeof parsed.prompt === 'string') {
        description = parsed.prompt;
      }
    } catch (err) {
      if (previous === null) {
        rmSync(abs, { force: true });
      } else {
        writeFileSync(abs, previous, 'utf8');
      }
      reply.code(400);
      return {
        error: 'invalid-brief',
        message: err instanceof Error ? err.message : String(err),
      };
    }
    // Mirror the edited brief so a later generate survives a checkpoint wipe.
    await mirrorBriefToStore(store, deps.repoRoot, abs);
    return { yamlPath: relPosix, description, yaml: body.yaml };
  });

  app.post<{ Body: WorkflowGenerateBody }>('/api/workflow/generate', async (req, reply) => {
    const body = (req.body ?? {}) as WorkflowGenerateBody;
    if (typeof body.briefPath !== 'string' || body.briefPath.trim() === '') {
      reply.code(400);
      return { error: 'bad-request', message: 'body.briefPath must be a non-empty string' };
    }
    const briefPath = resolveRepoPath(deps.repoRoot, body.briefPath);
    if (!briefPath) {
      reply.code(404);
      return { error: 'brief-not-found', message: 'briefPath does not exist in repo' };
    }
    // A mid-flight generate must survive a checkpoint that wiped the gitignored
    // draft brief: re-materialise it from the store before failing.
    if (!existsSync(briefPath) && !(await tryMaterialiseBrief(briefPath))) {
      reply.code(404);
      return { error: 'brief-not-found', message: 'briefPath does not exist in repo' };
    }
    // Prevention: now that the brief is confirmed on disk, mirror it into the
    // store so a later checkpoint wipe stays recoverable. Path-level durability
    // (keyed by repo-relative path), idempotent, covering BOTH the queue and the
    // inline branches below.
    await mirrorBriefToStore(store, deps.repoRoot, briefPath);
    try {
      const env = deps.env ?? process.env;
      if (queue.backend !== 'noop') {
        const briefId = resolveQueuedBriefId(briefPath);
        const requestedAt = new Date().toISOString();
        await queue.enqueue({
          kind: 'brief-path',
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
      // Generate stores the raw sheet ONLY (Option B, ADR 0024). PostProcess
      // and Judge are explicit operator-driven steps (POST /api/runs/:briefId/
      // :runId/postprocess and /judge); they are NOT run inline here.
      const result = await generateOne({
        briefPath,
        provider: createImageProvider({ env }),
        textProvider: createTextProvider({ env }),
        repoRoot: deps.repoRoot,
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

  app.post('/api/workflow/worker/start', async (_req, reply) => {
    // The `azure-queue` backend is production. CI (`asset-request.yml`) is the
    // sole authorized consumer — allowing a local sidecar to start a consumer
    // against the same queue creates an off-CI generation path that races CI
    // for messages (issue #1879). Disable the start route for that backend.
    if (queue.backend === 'azure-queue') {
      reply.code(403);
      return {
        error: 'azure-queue-consumer-disabled',
        message:
          'Starting a local worker against the azure-queue backend is disabled. ' +
          'CI (asset-request.yml) is the sole authorized production queue consumer.',
      };
    }
    const result = worker.start();
    return result;
  });

  app.post('/api/workflow/worker/stop', async () => {
    const status = await worker.stop();
    return { stopped: true, status };
  });

  app.get('/api/workflow/worker/status', async () => worker.status());

  app.post('/api/workflow/issues/start', async (_req, reply) => {
    // Same as above — disable the issue ingester start route for the azure-queue
    // backend. CI is the sole authorized ingestion path (issue #1879).
    if (queue.backend === 'azure-queue') {
      reply.code(403);
      return {
        error: 'azure-queue-ingester-disabled',
        message:
          'Starting a local issue ingester against the azure-queue backend is disabled. ' +
          'CI (asset-request.yml) is the sole authorized ingestion path.',
      };
    }
    return issueIngester.start();
  });

  app.post('/api/workflow/issues/stop', async () => {
    const status = await issueIngester.stop();
    return { stopped: true, status };
  });

  app.get('/api/workflow/issues/status', async () => issueIngester.status());

  app.get<{ Querystring: WorkflowAssetRequestsQuery }>(
    '/api/workflow/asset-requests',
    async (req, reply) => {
      const stateRaw = req.query.state;
      const state =
        stateRaw === undefined || stateRaw === null || stateRaw === ''
          ? 'all'
          : stateRaw === 'all' ||
              stateRaw === 'pending' ||
              stateRaw === 'claimed' ||
              stateRaw === 'rejected'
            ? stateRaw
            : null;
      if (state === null) {
        reply.code(400);
        return {
          error: 'bad-request',
          message: 'query.state must be all, pending, claimed, or rejected',
        };
      }
      return { entries: await issueIngester.listRequests(state) };
    },
  );

  app.post<{ Body: WorkflowAssetRequestRejectBody }>(
    '/api/workflow/asset-requests/reject',
    async (req, reply) => {
      const body = (req.body ?? {}) as WorkflowAssetRequestRejectBody;
      const issueNumber = body.issueNumber;
      const fingerprint = body.fingerprint;
      if (typeof issueNumber !== 'number' || !Number.isInteger(issueNumber) || issueNumber < 1) {
        reply.code(400);
        return { error: 'bad-request', message: 'body.issueNumber must be a positive integer' };
      }
      if (typeof fingerprint !== 'string' || fingerprint.trim() === '') {
        reply.code(400);
        return { error: 'bad-request', message: 'body.fingerprint must be a non-empty string' };
      }
      if (body.reason !== undefined && typeof body.reason !== 'string') {
        reply.code(400);
        return { error: 'bad-request', message: 'body.reason must be a string when provided' };
      }
      const entry = await issueIngester.rejectRequest({
        issueNumber,
        fingerprint: fingerprint.trim(),
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      });
      return { ok: true, entry };
    },
  );

  app.get<{ Querystring: LatestRunQuery }>('/api/workflow/latest-run', async (req, reply) => {
    const briefIdRaw = req.query.briefId;
    const requestedAtRaw = req.query.requestedAt;
    if (typeof briefIdRaw !== 'string' || briefIdRaw.trim() === '') {
      reply.code(400);
      return { error: 'bad-request', message: 'briefId must be a non-empty string' };
    }
    if (typeof requestedAtRaw !== 'string' || requestedAtRaw.trim() === '') {
      reply.code(400);
      return { error: 'bad-request', message: 'requestedAt must be a non-empty ISO timestamp' };
    }
    const requestedAtMs = Date.parse(requestedAtRaw);
    if (!Number.isFinite(requestedAtMs)) {
      reply.code(400);
      return { error: 'bad-request', message: 'requestedAt must be a valid ISO timestamp' };
    }
    const latest = await findLatestRunForBriefSince(store, briefIdRaw.trim(), requestedAtMs);
    return { run: latest };
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

    // CSRF guard (mirrors /approve, ADR 0066 CTX-005): this route now runs
    // `git fetch`/`git push` against the remote assets/queue branch (durable
    // re-queue, below), so a cross-origin browser POST must not be able to
    // trigger an authenticated remote push. Server-side callers (Node fetch, no
    // Origin header) stay trusted, exactly as the sibling mutating routes do.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !deps.trustedMutationOrigins?.includes(origin)) {
      reply.code(403);
      return {
        error: 'forbidden-origin',
        message: 'This browser origin is not allowed to run sprite metadata generation.',
      };
    }

    try {
      const publicAssetsDir = deps.publicAssetsDir ?? path.join(deps.repoRoot, 'public', 'assets');
      const generatedDir = path.join(publicAssetsDir, 'generated');
      const catalogAbs = path.resolve(deps.repoRoot, DEFAULT_CATALOG_PATH);
      // Feed the pipeline the FULL catalog: the committed rows PLUS the
      // `generated:` rows DERIVED from the manifest shards. Those generated rows
      // are no longer committed to sprite-catalog.json (they are derived, see
      // src/shared/generated-catalog.ts), so we must compose them here or the
      // pipeline would have no generated sprite to edit.
      const baseCatalog = parseSpriteCatalog(
        JSON.parse(readFileSync(catalogAbs, 'utf8')) as unknown,
      );
      const fullCatalog = composeFullCatalog(baseCatalog, composeManifestFromShards(generatedDir));
      const provider = await resolveProvider(providerMode);
      const result = await runMetadataPipeline(fullCatalog, { provider, ids, force, minScore });

      // Persist the edits under the shared mutation lock, serialized with
      // /approve and /checkin (same asset surface). `generated:` edits are
      // durably persisted as a `catalog` override ON THE MANIFEST SHARD — the
      // single per-asset source of truth — and the changed shards are re-queued.
      // Non-generated edits go to the committed catalog exactly as before.
      const env = deps.env ?? process.env;
      const queueCommit = await withCheckinMutationLock(async () => {
        const generatedChangedIds = result.changedIds.filter((id) => isGeneratedCatalogId(id));
        const nonGeneratedChangedIds = result.changedIds.filter((id) => !isGeneratedCatalogId(id));

        // Non-generated rows: merge into the committed catalog. Re-read INSIDE
        // the lock and overlay ONLY the non-generated ids this run changed, so a
        // concurrent /approve or /checkin edit to a DIFFERENT row is preserved
        // rather than clobbered (read-modify-write race, concern #1a).
        if (nonGeneratedChangedIds.length > 0) {
          let mergedCatalog: SpriteCatalog;
          try {
            const fresh = parseSpriteCatalog(
              JSON.parse(readFileSync(catalogAbs, 'utf8')) as unknown,
            );
            mergedCatalog = parseSpriteCatalog(
              mergeChangedCatalogEntries(fresh, result.updated, nonGeneratedChangedIds),
            );
          } catch (err) {
            // A fresh re-read/parse failure means we cannot safely determine
            // which concurrent rows might have landed since our pre-lock read.
            // Writing a stale snapshot would clobber those, so abort entirely.
            const message = err instanceof Error ? err.message : String(err);
            req.log.warn(`metadata queue-commit: catalog re-read failed: ${message}`);
            return { status: 'failed' as const, error: `catalog re-read failed: ${message}` };
          }
          await writeCatalogJson(catalogAbs, mergedCatalog);
        }

        // Generated rows: write the LLM description/tags as a `catalog` override
        // onto each changed shard (local durability lands here), then durably
        // re-queue the shards whose PNG asset resolves on disk.
        //
        // Two "unresolvable" cases both mean the edit could NOT be durably
        // re-queued and MUST surface as status:'failed' (never null, which the
        // client reads as "preserve prior durability" — a false green, #1c/#7):
        //   (a) the shard vanished between compose and this locked write
        //       (concurrently unapproved), so there is nothing to persist; or
        //   (b) the shard exists (so the local override write lands) but its PNG
        //       asset is missing, so it cannot be staged onto assets/queue.
        const updatedById = new Map(result.updated.map((row) => [row.id, row]));
        const changedAssets: Array<{
          assetPath: string;
          manifestKey: string;
          briefId: string | null;
          variantIndex: number | null;
        }> = [];
        const unresolvedGeneratedIds: string[] = [];
        const writtenShardPaths: string[] = [];
        for (const id of generatedChangedIds) {
          const key = id.slice(GENERATED_ID_PREFIX.length);
          const entry = readShard(generatedDir, key);
          if (!entry) {
            unresolvedGeneratedIds.push(id); // (a) shard concurrently removed
            continue;
          }
          const row = updatedById.get(id);
          if (!row) continue;
          const nextEntry = {
            ...entry,
            catalog: { description: row.description, tags: [...row.tags] },
          };
          writtenShardPaths.push(writeShard(generatedDir, key, nextEntry));
          const assetAbs = path.join(publicAssetsDir, entry.assetPath);
          if (!existsSync(assetAbs)) {
            unresolvedGeneratedIds.push(id); // (b) PNG missing — can't stage
            continue;
          }
          changedAssets.push({
            assetPath: entry.assetPath,
            manifestKey: key,
            briefId: entry.briefId ?? null,
            variantIndex: typeof entry.variantIndex === 'number' ? entry.variantIndex : null,
          });
        }
        // Keep the shard on-disk format Prettier-identical to the committed
        // style so a metadata edit is a value-only diff (no `tags` reflow).
        if (writtenShardPaths.length > 0) {
          formatJsonFilesSync(writtenShardPaths);
        }

        // A changed generated edit that could not be resolved to a stageable
        // asset failed to become durable — report it so the client shows red.
        if (unresolvedGeneratedIds.length > 0) {
          const label = unresolvedGeneratedIds.length === 1 ? 'entry' : 'entries';
          return {
            status: 'failed' as const,
            error: `${unresolvedGeneratedIds.length} changed generated ${label} could not be durably re-queued: ${unresolvedGeneratedIds.join(', ')}`,
          };
        }

        // The ONLY honest `null`: nothing queue-managed changed, so there is
        // genuinely no durable re-queue to do and the client PRESERVES its prior
        // durability (#1c/#7).
        if (changedAssets.length === 0) return null;

        try {
          return await runQueueCommit(
            deps.repoRoot,
            changedAssets,
            createDefaultQueueCommitDeps(deps.repoRoot, env),
            {
              message: `chore(assets): metadata for ${changedAssets.length} sprite(s)`,
            },
          );
        } catch (err) {
          // ci-refused is EXPECTED on CI (the primitive is local-only) — surface
          // it as a skip, not a failure. Any other error is best-effort: the
          // local shard writes already succeeded.
          if (err instanceof QueueCommitError && err.kind === 'ci-refused') {
            return { status: 'skipped' as const, reason: 'ci-refused' as const };
          }
          const message = err instanceof Error ? err.message : String(err);
          req.log.warn(`metadata queue-commit failed: ${message}`);
          return { status: 'failed' as const, error: message };
        }
      });

      return {
        provider: provider.name,
        changedCount: result.changedCount,
        processedCount: result.processedCount,
        rejectedCount: result.rejectedCount,
        skippedCount: result.skippedCount,
        queueCommit,
      };
    } catch (err) {
      reply.code(500);
      return {
        error: 'metadata-failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  app.get('/api/workflow/state', async (_req, reply) => {
    if (!(await store.has(WORKFLOW_STATE_KEY))) {
      return { state: null, etag: null };
    }
    let bytes: Buffer;
    try {
      bytes = await store.get(WORKFLOW_STATE_KEY);
    } catch {
      // Treat a vanished/half-written blob as "no state yet" rather than 500
      // so the client can fall back to its localStorage cache and recover.
      return { state: null, etag: null };
    }
    const etag = computeStateEtag(bytes);
    reply.header('ETag', etag);
    return { state: parseWorkflowState(bytes).state, etag };
  });

  app.put<{ Body: WorkflowStateBody }>('/api/workflow/state', async (req, reply) => {
    const body = (req.body ?? {}) as WorkflowStateBody;
    if (typeof body.state !== 'object' || body.state === null) {
      reply.code(400);
      return { error: 'bad-request', message: 'body.state must be a non-null object' };
    }
    // Optimistic concurrency: compute the current ETag and compare against the
    // caller's If-Match precondition before writing, so a stale tab can't
    // silently clobber a newer queue.
    const currentEtag = await readWorkflowStateEtag(store);
    const rawIfMatch = req.headers['if-match'];
    const ifMatch = Array.isArray(rawIfMatch) ? rawIfMatch[0] : rawIfMatch;
    const rawIfNoneMatch = req.headers['if-none-match'];
    const ifNoneMatch = Array.isArray(rawIfNoneMatch) ? rawIfNoneMatch[0] : rawIfNoneMatch;
    if (
      etagPreconditionFails(ifMatch, currentEtag) ||
      ifNoneMatchPreconditionFails(ifNoneMatch, currentEtag)
    ) {
      reply.code(409);
      return { error: 'etag-conflict', etag: currentEtag };
    }
    const bytes = serializeWorkflowState(body.state);
    // A client with no ETag (nothing stored yet) sends `If-None-Match: *`, so
    // two first writers cannot both create the queue. Where the backing store
    // enforces create-only writes server-side (Azure), use it: the read above
    // is not atomic with this write.
    if (isCreateOnlyWrite(ifNoneMatch) && typeof store.putConditional === 'function') {
      try {
        await store.putConditional(WORKFLOW_STATE_KEY, bytes, { ifNoneMatch: '*' });
      } catch (err) {
        if (!(err instanceof StoreConditionalWriteError)) throw err;
        reply.code(409);
        return { error: 'etag-conflict', etag: await readWorkflowStateEtag(store) };
      }
    } else {
      await store.put(WORKFLOW_STATE_KEY, bytes);
    }
    const etag = computeStateEtag(bytes);
    reply.header('ETag', etag);
    return { ok: true, etag };
  });

  app.post<{ Body: WorkflowStoreClearBody }>('/api/workflow/store/clear', async (req, reply) => {
    const body = (req.body ?? {}) as WorkflowStoreClearBody;
    const scopeRaw = body.scope;
    const scope =
      scopeRaw === undefined || scopeRaw === null || scopeRaw === ''
        ? 'all'
        : scopeRaw === 'all' || scopeRaw === 'runs' || scopeRaw === 'workflow'
          ? scopeRaw
          : null;
    if (scope === null) {
      reply.code(400);
      return { error: 'bad-request', message: 'body.scope must be all, runs, or workflow' };
    }
    const wasWorkerRunning = worker.status().running;
    const wasIssueIngesterRunning = issueIngester.status().running;
    if (wasWorkerRunning) {
      await worker.stop();
    }
    if (wasIssueIngesterRunning) {
      await issueIngester.stop();
    }
    let targetKeys: string[];
    try {
      // Clear-store enumerates-then-removes the filtered key set and reports
      // deletedCount — a stale listing would under-report/under-clear, so
      // this MUST see an authoritative, freshly-listed result.
      const allKeys = await store.list('', { authoritative: true });
      targetKeys = [
        ...new Set(
          allKeys.filter((key) => {
            const isWorkflow = key.startsWith('workflow-state/');
            if (scope === 'all') return true;
            if (scope === 'runs') return !isWorkflow;
            return isWorkflow;
          }),
        ),
      ];
      await Promise.all(targetKeys.map((key) => store.remove(key)));
    } finally {
      if (wasIssueIngesterRunning) {
        issueIngester.start();
      }
      if (wasWorkerRunning) {
        worker.start();
      }
    }
    return {
      ok: true,
      scope,
      deletedCount: targetKeys.length,
    };
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
    // Recover a wiped gitignored draft brief from the store before failing, so
    // live re-processing works for a run whose brief was mirrored (mirrors the
    // /api/workflow/generate recovery path).
    if (!existsSync(briefPath) && !(await tryMaterialiseBrief(briefPath))) {
      reply.code(404);
      return { error: 'brief-not-found', message: 'briefPath does not exist in repo' };
    }
    try {
      const loaded = loadBrief(briefPath, { projectRoot: deps.repoRoot });
      const { postprocessWithTrace } = await import('../postprocess.js');
      const rawPngBuffer = Buffer.from(body.rawPng, 'base64');
      let options: PostprocessOptions | undefined;
      try {
        options = parsePostprocessOptions(body.options, loaded);
      } catch (error) {
        reply.code(400);
        return {
          error: 'bad-request',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      const traced = postprocessWithTrace(rawPngBuffer, loaded.brief, loaded.palette, options);
      return {
        finalPng: traced.finalPng.toString('base64'),
        steps: traced.steps.map((step) => ({
          id: step.id,
          label: step.label,
          moduleId: step.moduleId,
          skipped: step.skipped,
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
      // Delete enumerates-then-removes this exact key set (and the follow-up
      // check below decides whether the brief dir is now empty) — both MUST
      // see an authoritative, freshly-listed result so a stale listing can't
      // leave newly-added files behind or wrongly judge the brief empty.
      const runKeys = await store.list(runPrefix, { authoritative: true });
      if (runKeys.length === 0) {
        reply.code(404);
        return { error: 'run-not-found', briefId, runId };
      }
      if (store.backend === 'local') {
        await store.remove(`${briefId}/${runId}`);
      } else {
        await Promise.all(runKeys.map((key) => store.remove(key)));
      }
      if ((await store.list(`${briefId}/`, { authoritative: true })).length === 0) {
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

/** Map a {@link RerunError} kind to the HTTP status the re-run routes return. */
function rerunErrorStatus(kind: RerunErrorKind): number {
  switch (kind) {
    case 'run-not-found':
    case 'sheet-not-found':
    case 'processed-missing':
      return 404;
    case 'unsupported-sheet-filename':
      return 415;
    case 'variant-index-out-of-range':
      return 400;
    case 'variant-count-mismatch':
      return 422;
    case 'summary-invalid':
    case 'slice-failed':
      return 500;
  }
}

function safeStoreJoin(base: string, relativePath: string): string | null {
  if (
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    path.posix.isAbsolute(relativePath)
  ) {
    return null;
  }
  const normalized = path.normalize(relativePath);
  const segments = normalized.split(path.sep).filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return null;
  }
  return safeJoin(base, segments);
}

function resolveQueuedBriefId(briefPath: string): string {
  const fallback = path.basename(briefPath, path.extname(briefPath));
  try {
    const parsed = parseYaml(readFileSync(briefPath, 'utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      'name' in parsed &&
      typeof parsed['name'] === 'string' &&
      parsed['name'].trim() !== ''
    ) {
      return parsed['name'];
    }
  } catch {
    // fall through to filename-based fallback
  }
  return fallback;
}

interface HydratedRunDir {
  readonly runDir: string;
  cleanup(): void;
}

async function hydrateRunDirForApproveFromStore(
  store: RunStore,
  briefId: string,
  runId: string,
  variantIndex: number,
): Promise<HydratedRunDir | null> {
  const prefix = `${briefId}/${runId}/`;
  const summaryKey = `${prefix}summary.json`;
  const paddedIndex = String(variantIndex).padStart(2, '0');
  const candidateKeys = [
    summaryKey,
    `${prefix}processed/${paddedIndex}.png`,
    `${prefix}processed/${paddedIndex}.anchor.json`,
    `${prefix}processed/${paddedIndex}.anchor.cog.json`,
    `${prefix}processed/${paddedIndex}.anchor.weapon.json`,
  ];
  const runKeys = await store.list(prefix);
  if (runKeys.length === 0) {
    return null;
  }
  const available = new Set(runKeys);
  if (!available.has(summaryKey)) {
    return null;
  }
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'crawler-sidecar-run-'));
  const runDir = safeJoin(tempRoot, [briefId, runId]);
  if (runDir === null) {
    rmSync(tempRoot, { recursive: true, force: true });
    return null;
  }
  try {
    mkdirSync(runDir, { recursive: true });
    for (const key of candidateKeys) {
      if (!available.has(key)) {
        continue;
      }
      const rel = key.slice(prefix.length);
      if (rel === '') continue;
      const target = safeStoreJoin(runDir, rel);
      if (target === null) {
        continue;
      }
      mkdirSync(path.dirname(target), { recursive: true });
      try {
        writeFileSync(target, await store.get(key));
      } catch (err) {
        if (!(err instanceof StoreNotFoundError)) {
          throw err;
        }
        // Optional run files (processed PNG/anchors) may be absent. approveVariant
        // maps that to a user-facing `processed-missing` error.
      }
    }
  } catch (err) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw err;
  }
  return {
    runDir,
    cleanup: () => {
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

async function findLatestRunForBriefSince(
  store: RunStore,
  briefId: string,
  requestedAtMs: number,
): Promise<{ briefId: string; runId: string; timestamp: string | null } | null> {
  // runId timestamps are second-precision; floor requestedAt to the same
  // precision so same-second runs are eligible matches.
  const requestedAtSecondMs = Math.floor(requestedAtMs / 1000) * 1000;
  const prefix = `${briefId}/`;
  const keys = await store.list(prefix);
  const summaryKeys = keys.filter((key) => {
    const parts = key.split('/');
    return parts.length === 3 && parts[0] === briefId && parts[2] === 'summary.json';
  });
  let latest: {
    briefId: string;
    runId: string;
    timestamp: string | null;
  } | null = null;
  for (const key of summaryKeys) {
    const parts = key.split('/');
    const runId = parts[1]!;
    const timestamp = parseRunIdTimestamp(runId);
    if (!timestamp) continue;
    const runTime = Date.parse(timestamp);
    if (!Number.isFinite(runTime) || runTime < requestedAtSecondMs) continue;
    if (!latest || runId > latest.runId) {
      latest = { briefId, runId, timestamp };
    }
  }
  return latest;
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
async function listRunsFromStore(
  store: RunStore,
  promotedRuns: ReadonlySet<string>,
): Promise<RunListEntry[]> {
  const allKeys = await store.list('');
  // Keep only keys of the shape <briefId>/<runId>/summary.json (exactly 3 parts).
  const summaryKeys = allKeys.filter((k) => {
    const parts = k.split('/');
    return parts.length === 3 && parts[2] === 'summary.json' && parts[0] !== 'archive';
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
      promotionState: promotedRuns.has(`${briefId}/${runId}`) ? 'promoted' : 'not-promoted',
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
        promotionState: 'not-promoted',
      });
    }
  }
  // Newest first: runId prefix is an ISO-ish timestamp, so descending
  // string sort is the right order.
  entries.sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
  return entries;
}

interface ApprovedBriefInfo {
  count: number;
  firstRunId: string | null;
  firstVariantIndex: number | null;
}

/**
 * Reads the approval manifest and returns, per briefId, the number of approved
 * variants and the first-approved variant (lowest variantIndex) with the runId
 * it was approved from. Defensive like readPromotedRunsFromManifest — a missing
 * or corrupt manifest yields an empty map rather than throwing.
 */
function readApprovedVariantsByBrief(manifestPath: string): ReadonlyMap<string, ApprovedBriefInfo> {
  const result = new Map<string, ApprovedBriefInfo>();
  // The aggregate manifest.json is a gitignored build artifact and may be
  // absent; compose the entries from the per-asset shards instead.
  let entries: Record<string, { briefId?: unknown; variantIndex?: unknown; sourceRun?: unknown }>;
  try {
    entries = composeManifestFromShards(path.dirname(manifestPath)).entries as typeof entries;
  } catch {
    return result;
  }
  for (const entry of Object.values(entries)) {
    if (!entry || typeof entry.briefId !== 'string') continue;
    const variantIndex = typeof entry.variantIndex === 'number' ? entry.variantIndex : null;
    let runId: string | null = null;
    if (typeof entry.sourceRun === 'string') {
      const parts = entry.sourceRun
        .replace(/\\/g, '/')
        .split('/')
        .filter((segment) => segment !== '');
      runId = parts.length >= 1 ? (parts[parts.length - 1] ?? null) : null;
    }
    const current = result.get(entry.briefId) ?? {
      count: 0,
      firstRunId: null,
      firstVariantIndex: null,
    };
    current.count += 1;
    if (
      variantIndex !== null &&
      (current.firstVariantIndex === null || variantIndex < current.firstVariantIndex)
    ) {
      current.firstVariantIndex = variantIndex;
      current.firstRunId = runId;
    }
    result.set(entry.briefId, current);
  }
  return result;
}

/**
 * Read-only presence check for a run's brief: true when the YAML still exists on
 * disk OR remains mirrored in the run store under its workflow-state key. Unlike
 * materializeBriefFromStore it NEVER writes to disk — it only reports presence.
 */
async function isBriefStored(
  store: RunStore,
  repoRoot: string,
  briefPath: string,
): Promise<boolean> {
  const absPath = path.isAbsolute(briefPath) ? briefPath : path.resolve(repoRoot, briefPath);
  if (existsSync(absPath)) return true;
  const rel = toRepoRelativePath(repoRoot, absPath);
  if (!isRepoConfined(rel)) return false;
  try {
    return await store.has(workflowBriefKey(rel));
  } catch {
    return false;
  }
}

function readPromotedRunsFromManifest(manifestPath: string): ReadonlySet<string> {
  const promoted = new Set<string>();
  try {
    // The aggregate manifest.json is a gitignored build artifact and may be
    // absent; compose the entries from the per-asset shards instead.
    const entries = composeManifestFromShards(path.dirname(manifestPath)).entries as Record<
      string,
      { sourceRun?: unknown }
    >;
    for (const entry of Object.values(entries)) {
      if (!entry || typeof entry.sourceRun !== 'string') continue;
      const normalized = entry.sourceRun.replace(/\\/g, '/');
      const parts = normalized
        .split('/')
        .filter((segment) => segment !== '')
        .slice(-2);
      if (parts.length !== 2) continue;
      const [briefId, runId] = parts;
      if (!briefId || !runId) continue;
      promoted.add(`${briefId}/${runId}`);
    }
    return promoted;
  } catch {
    return new Set<string>();
  }
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
