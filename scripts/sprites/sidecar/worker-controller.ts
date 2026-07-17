/**
 * In-process queue-worker controller for the sprite sidecar.
 *
 * Why this exists
 * ---------------
 * On the `azure-queue` path the sidecar's `/api/workflow/generate` route only
 * *enqueues* a request (HTTP 202) — a separate worker must dequeue it and run
 * {@link generateOne}. Historically that worker was a standalone process
 * (`sprites:worker`) that an operator had to remember to start. When it wasn't
 * running, the devtools workflow page polled forever on "Generating…" with no
 * consumer on the other end (the exact bug this change fixes).
 *
 * This controller lets the sidecar **own** an in-process worker so a consumer
 * always exists wherever the sidecar runs:
 *   - `cli.ts` auto-starts it when the queue backend is `azure-queue`.
 *   - The devtools "Launch worker" button starts it on demand via
 *     `POST /api/workflow/worker/start`.
 *
 * Design notes
 * ------------
 *   - `buildServer` constructs a controller but NEVER calls `start()`. Starting
 *     is the CLI's / operator's job. This keeps existing sidecar tests (whose
 *     fake queues only implement `enqueue`) unaffected — the loop only runs
 *     when something explicitly starts it.
 *   - Providers are constructed lazily inside `start()` so missing Azure
 *     credentials fail fast with a recorded `lastError` instead of throwing at
 *     sidecar-build time or spinning the loop into repeated failures.
 *   - `start()` / `stop()` are idempotent. `stop()` aborts the loop and awaits
 *     its clean exit so the Fastify `onClose` hook can rely on it.
 *
 * Infra module: `Date.now()` is acceptable here (this is not game code). The
 * clock is injectable via `deps.now` for deterministic tests.
 */

import {
  createBriefSelectorProvider,
  createImageProvider,
  createSynthProvider,
  createTextProvider,
  createVisionProvider,
} from '../provider/factory.js';
import { runWorker as defaultRunWorker } from '../worker.js';
import type { WorkerOptions, WorkerStatus } from '../worker.js';
import type { AssetQueue } from '../queue/types.js';
import type { RunStore } from '../store/types.js';
import {
  createGhAssetRequestIssueApi,
  type AssetRequestIssueApi,
} from './asset-request-issue-api.js';
import { isIssueRequestRejectedIngestState } from './issue-ingester-controller.js';

/** Signature of {@link runWorker}; injectable so tests avoid a real loop. */
export type RunWorkerFn = (options: WorkerOptions) => Promise<void>;

/** Provider-factory signatures, injectable so tests avoid network providers. */
export type CreateImageProviderFn = typeof createImageProvider;
export type CreateTextProviderFn = typeof createTextProvider;
export type CreateSynthProviderFn = typeof createSynthProvider;
export type CreateBriefSelectorProviderFn = typeof createBriefSelectorProvider;
export type CreateVisionProviderFn = typeof createVisionProvider;

export interface WorkerControllerDeps {
  /** Queue the worker polls. Its `backend` is surfaced in status. */
  readonly queue: AssetQueue;
  /** Store the worker writes artifacts into. */
  readonly store: RunStore;
  /** Absolute repo root forwarded to `generateOne`. */
  readonly repoRoot: string;
  /** Env snapshot used to construct providers. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Poll interval (ms) when the queue is empty. Defaults to worker's own default. */
  readonly pollIntervalMs?: number;
  /** Worker loop. Defaults to the real {@link runWorker}. */
  readonly runWorker?: RunWorkerFn;
  /** Image-provider factory. Defaults to the real one. */
  readonly createImageProvider?: CreateImageProviderFn;
  /** Text-provider factory. Defaults to the real one. */
  readonly createTextProvider?: CreateTextProviderFn;
  /** Synth-provider factory. Defaults to the real one. */
  readonly createSynthProvider?: CreateSynthProviderFn;
  /** Brief-selector provider factory. Defaults to the real one. */
  readonly createBriefSelectorProvider?: CreateBriefSelectorProviderFn;
  /** Vision-provider factory. Defaults to the real one. */
  readonly createVisionProvider?: CreateVisionProviderFn;
  /** GitHub issue API for issue-originated jobs. */
  readonly issueApi?: AssetRequestIssueApi;
  /** Clock for timestamps. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Optional extra status sink (the controller always records internally). */
  readonly onStatus?: (status: WorkerStatus) => void;
}

/** Immutable snapshot of the worker's state, safe to serialize into JSON. */
export interface WorkerControllerStatus {
  /** True while the worker loop is running. */
  readonly running: boolean;
  /** Queue backend the worker consumes. */
  readonly backend: 'noop' | 'azure-queue' | 'local-file';
  /** ISO timestamp of the most recent successful `start()`, or null. */
  readonly startedAt: string | null;
  /** ISO timestamp of the most recent loop exit, or null. */
  readonly stoppedAt: string | null;
  /** Count of briefs processed successfully since this controller was created. */
  readonly processed: number;
  /** Count of brief failures since this controller was created. */
  readonly failed: number;
  /** Brief id of the most recent processing/done/error event, or null. */
  readonly lastBriefId: string | null;
  /** Type of the most recent worker status event, or null. */
  readonly lastEvent: WorkerStatus['type'] | null;
  /** ISO timestamp of the most recent worker status event, or null. */
  readonly lastEventAt: string | null;
  /** Message of the most recent error (provider init or brief failure), or null. */
  readonly lastError: string | null;
}

/** Outcome of a `start()` call. */
export interface WorkerStartResult {
  readonly started: boolean;
  readonly reason: 'started' | 'already-running' | 'provider-init-failed';
  readonly status: WorkerControllerStatus;
}

export interface WorkerController {
  /** Start the loop if not already running. Idempotent. */
  start(): WorkerStartResult;
  /** Abort the loop and await its clean exit. Idempotent. */
  stop(): Promise<WorkerControllerStatus>;
  /** Read the current status snapshot. */
  status(): WorkerControllerStatus;
}

/**
 * Construct a worker controller. Does NOT start the loop — call `start()`
 * (the CLI does this automatically for the `azure-queue` backend; the devtools
 * "Launch worker" button does it on demand).
 */
export function createWorkerController(deps: WorkerControllerDeps): WorkerController {
  const runWorker = deps.runWorker ?? defaultRunWorker;
  const makeImageProvider = deps.createImageProvider ?? createImageProvider;
  const makeTextProvider = deps.createTextProvider ?? createTextProvider;
  const makeSynthProvider = deps.createSynthProvider ?? createSynthProvider;
  const makeBriefSelectorProvider = deps.createBriefSelectorProvider ?? createBriefSelectorProvider;
  const makeVisionProvider = deps.createVisionProvider ?? createVisionProvider;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const issueApi = deps.issueApi ?? createGhAssetRequestIssueApi(deps.repoRoot);

  let running = false;
  let startedAt: string | null = null;
  let stoppedAt: string | null = null;
  let processed = 0;
  let failed = 0;
  let lastBriefId: string | null = null;
  let lastEvent: WorkerStatus['type'] | null = null;
  let lastEventAt: string | null = null;
  let lastError: string | null = null;

  let abortController: AbortController | null = null;
  let loopPromise: Promise<void> | null = null;

  const iso = (): string => new Date(now()).toISOString();

  function snapshot(): WorkerControllerStatus {
    return {
      running,
      backend: deps.queue.backend,
      startedAt,
      stoppedAt,
      processed,
      failed,
      lastBriefId,
      lastEvent,
      lastEventAt,
      lastError,
    };
  }

  function recordStatus(status: WorkerStatus): void {
    lastEvent = status.type;
    lastEventAt = iso();
    switch (status.type) {
      case 'processing':
        lastBriefId = status.briefId;
        break;
      case 'done':
        processed += 1;
        lastBriefId = status.briefId;
        break;
      case 'error':
        failed += 1;
        lastBriefId = status.briefId;
        lastError = status.error.message;
        break;
      default:
        break;
    }
    deps.onStatus?.(status);
  }

  function start(): WorkerStartResult {
    if (running) {
      return { started: false, reason: 'already-running', status: snapshot() };
    }

    let options: WorkerOptions;
    try {
      const provider = makeImageProvider({ env });
      const textProvider = makeTextProvider({ env });
      let synthProvider = null;
      try {
        synthProvider = makeSynthProvider({ env });
      } catch {
        // Optional unless an issue-request job is dequeued.
      }
      const briefSelectorProvider = makeBriefSelectorProvider({ env });
      const visionProvider = makeVisionProvider({ env });
      abortController = new AbortController();
      options = {
        queue: deps.queue,
        store: deps.store,
        repoRoot: deps.repoRoot,
        provider,
        textProvider,
        synthProvider,
        briefSelectorProvider,
        visionProvider,
        issueApi,
        shouldSkipIssueRequest: async (request) =>
          isIssueRequestRejectedIngestState(deps.store, request.issueNumber, request.fingerprint),
        signal: abortController.signal,
        onStatus: recordStatus,
        ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
      };
    } catch (err) {
      abortController = null;
      lastError = err instanceof Error ? err.message : String(err);
      lastEvent = 'error';
      lastEventAt = iso();
      return { started: false, reason: 'provider-init-failed', status: snapshot() };
    }

    running = true;
    startedAt = iso();
    stoppedAt = null;
    lastError = null;

    loopPromise = runWorker(options)
      .catch((err: unknown) => {
        lastError = err instanceof Error ? err.message : String(err);
        lastEvent = 'error';
        lastEventAt = iso();
      })
      .finally(() => {
        running = false;
        stoppedAt = iso();
      });

    return { started: true, reason: 'started', status: snapshot() };
  }

  async function stop(): Promise<WorkerControllerStatus> {
    const pending = loopPromise;
    abortController?.abort();
    if (pending) {
      await pending;
    }
    loopPromise = null;
    abortController = null;
    return snapshot();
  }

  return { start, stop, status: snapshot };
}
