/**
 * Sprite-generation queue worker.
 *
 * Polls an {@link AssetQueue} in a loop, calls {@link generateOne} for each
 * dequeued request, and acks the message on success.
 *
 * Failure handling (see {@link isPermanentFailure} / MAX_DEQUEUE_ATTEMPTS):
 *  - TRANSIENT failure below the retry cap → the message is left un-acked so
 *    the queue's visibility timeout re-surfaces it for a natural retry.
 *  - PERMANENT failure (a deterministic provider error — `auth`,
 *    `request-error`, `bad-grid`, `non-png`) OR once `dequeueCount` reaches
 *    MAX_DEQUEUE_ATTEMPTS → the
 *    message is acked (dropped) so a deterministically-failing "poison"
 *    message cannot loop forever. For issue-requests a single failure comment
 *    is posted on the give-up path (at most once per message under normal
 *    operation), instead of once per redelivery.
 *
 * Usage:
 *   import { runWorker } from './worker.js';
 *   await runWorker({ queue, store, repoRoot, provider, signal });
 *
 * The worker exits cleanly when `signal` is aborted (SIGINT / SIGTERM from
 * the CLI). Otherwise it idle-polls indefinitely, sleeping `pollIntervalMs`
 * between empty polls — it does NOT exit on an empty queue.
 */

import path from 'node:path';
import { generateOne } from './generate-one.js';
import type { AssetQueue, AssetRequest, IssueAssetRequest } from './queue/types.js';
import type { RunStore } from './store/types.js';
import type { ImageProvider } from './provider/types.js';
import type { TextProvider } from './provider/text-types.js';
import type { SynthProvider } from './provider/synth-types.js';
import type { BriefSelectorProvider } from './provider/brief-selector-types.js';
import type { VisionProvider } from './provider/vision-types.js';
import type { IssuePipelineIssueApi } from './issue-pipeline.js';
import { runIssuePipeline } from './issue-pipeline.js';
import { materializeBriefFromStore, mirrorBriefToStore } from './brief-durability.js';

/**
 * Maximum number of times a single message may be dequeued before the worker
 * gives up and drops it. Azure Storage Queue increments `dequeueCount` on each
 * redelivery, so this caps the natural-retry loop for TRANSIENT failures (a
 * deterministic failure is dropped immediately via {@link isPermanentFailure}).
 * Three attempts gives transient infrastructure blips two natural retries
 * without letting a poison message loop forever.
 */
const MAX_DEQUEUE_ATTEMPTS = 3;

/**
 * Kinds that are DETERMINISTIC and therefore never worth retrying at the worker
 * level: authentication and rejected provider requests, grid/format failures
 * which {@link generateSheetCore} has already retried in-run, and a brief
 * absent from BOTH disk and the store. Transient kinds (`rate-limit`,
 * `server-error`, `network`), malformed model output, and plain errors are left
 * to the bounded natural-redelivery cap.
 */
const PERMANENT_FAILURE_KINDS: ReadonlySet<string> = new Set([
  'auth',
  'request-error',
  'bad-grid',
  'non-png',
  'brief-not-found',
]);

/** True when `err` is a deterministic, non-retryable provider failure. */
function isPermanentFailure(err: unknown): boolean {
  const kind = (err as { readonly kind?: unknown } | null | undefined)?.kind;
  return typeof kind === 'string' && PERMANENT_FAILURE_KINDS.has(kind);
}

/**
 * Thrown when a `brief-path` job's YAML is absent from BOTH the working tree and
 * the run store (e.g. a gitignored draft wiped by a checkpoint that was never
 * mirrored). Carries `kind: 'brief-not-found'` so {@link isPermanentFailure}
 * classifies it as permanent: the worker drops the message immediately instead
 * of retrying to the {@link MAX_DEQUEUE_ATTEMPTS} cap.
 */
class BriefNotFoundError extends Error {
  readonly kind = 'brief-not-found';
  constructor(briefPath: string) {
    super(`brief not found on disk or in store: ${briefPath}`);
    this.name = 'BriefNotFoundError';
  }
}

export interface WorkerOptions {
  /** Queue to poll for generation requests. */
  readonly queue: AssetQueue;
  /** Store to write artifacts into. */
  readonly store: RunStore;
  /** Absolute path to the repository root (used by generateOne). */
  readonly repoRoot: string;
  /** Image provider for sheet generation. */
  readonly provider: ImageProvider;
  /** Optional text provider for variation expansion. Defaults to none. */
  readonly textProvider?: TextProvider | null;
  /** Optional synth provider for issue-originated queue jobs. */
  readonly synthProvider?: SynthProvider | null;
  /** Optional brief selector provider for issue-originated queue jobs. */
  readonly briefSelectorProvider?: BriefSelectorProvider | null;
  /** Optional vision provider for judged issue-originated queue jobs. */
  readonly visionProvider?: VisionProvider | null;
  /** Optional issue API for status comments. */
  readonly issueApi?: IssuePipelineIssueApi | null;
  /**
   * How long (ms) to wait between polls when the queue is empty.
   * Default: 5 000 ms.
   */
  readonly pollIntervalMs?: number;
  /** Number of queue messages processed concurrently. Default: 1. */
  readonly concurrency?: number;
  /**
   * AbortSignal for graceful shutdown. The worker exits after the current
   * message (if any) finishes processing. Set from a SIGINT/SIGTERM handler
   * in the CLI.
   */
  readonly signal?: AbortSignal;
  /**
   * Optional status callback. Called with a {@link WorkerStatus} value on
   * each state transition. Useful for logging and tests.
   */
  readonly onStatus?: (status: WorkerStatus) => void;
  /**
   * Optional guard for issue-originated jobs. When it resolves true, the worker
   * acks the message without generation (for example, permanently rejected
   * requests that were queued before the rejection marker was written).
   */
  readonly shouldSkipIssueRequest?: (request: IssueAssetRequest) => Promise<boolean>;
}

/** Possible worker state transitions reported via `onStatus`. */
export type WorkerStatus =
  | { readonly type: 'idle' }
  | { readonly type: 'processing'; readonly briefId: string }
  | { readonly type: 'skipped'; readonly briefId: string; readonly reason: 'rejected' }
  | {
      readonly type: 'done';
      readonly briefId: string;
      readonly runId: string;
      readonly summaryPath: string;
    }
  | {
      readonly type: 'error';
      readonly briefId: string;
      readonly error: Error;
      readonly dropped?: boolean;
    }
  | { readonly type: 'stopping' };

/**
 * Run the worker loop until the abort signal fires.
 *
 * The loop:
 *   1. Dequeue one message.
 *   2. On null (empty queue) → emit `idle`, sleep `pollIntervalMs`, repeat.
 *   3. On message → emit `processing`, call `generateOne`, ack, emit `done`.
 *   4. On error → emit `error`. If the failure is permanent, or `dequeueCount`
 *      has reached the cap, drop the message (ack) and — for issue-requests —
 *      post one failure comment; otherwise leave it un-acked for a natural retry.
 *   5. On abort signal → finish the current message (if any) then exit.
 */
export async function runWorker(options: WorkerOptions): Promise<void> {
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`worker concurrency must be a positive integer, got ${concurrency}`);
  }

  // Keyed lock: chains operations for the same canonical brief ID so two
  // concurrent slots processing different messages with the same brief name
  // are serialized. Different names run concurrently without blocking each
  // other. Each slot waits on the tail of the in-flight promise for its key
  // (if any), then replaces it with its own work; the map entry is cleared
  // when the work completes or errors.
  const briefLocks = new Map<string, Promise<void>>();
  const withBriefLock = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = briefLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    briefLocks.set(
      key,
      prev.then(() => lock),
    );
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
        // Clean up the map entry only if it still points to the slot we just
        // completed (another waiter may have chained on and replaced it).
        if (briefLocks.get(key) === prev.then(() => lock)) {
          briefLocks.delete(key);
        }
      }
    });
  };

  const idleSlots = new Set<number>();
  const poolAbort = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, poolAbort.signal])
    : poolAbort.signal;
  const reportStatus = (slotId: number, status: WorkerStatus): void => {
    if (status.type === 'idle') {
      idleSlots.add(slotId);
      if (idleSlots.size === concurrency) {
        idleSlots.clear();
        options.onStatus?.(status);
      }
      return;
    }
    idleSlots.clear();
    options.onStatus?.(status);
  };

  try {
    const results = await Promise.allSettled(
      Array.from({ length: concurrency }, (_, slotId) =>
        runWorkerSlot(
          {
            ...options,
            signal,
            onStatus: (status) => reportStatus(slotId, status),
          },
          withBriefLock,
        ).catch((error: unknown) => {
          poolAbort.abort();
          throw error;
        }),
      ),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) {
      throw failure.reason;
    }
  } finally {
    options.onStatus?.({ type: 'stopping' });
  }
}

async function runWorkerSlot(
  options: WorkerOptions,
  withBriefLock: <T>(key: string, fn: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const pollMs = options.pollIntervalMs ?? 5_000;
  const { queue, store, repoRoot, provider, signal, onStatus } = options;

  while (!signal?.aborted) {
    const msg = await queue.dequeue();
    if (!msg) {
      onStatus?.({ type: 'idle' });
      await sleep(pollMs, signal);
      continue;
    }

    const { request } = msg;
    if (
      request.kind === 'issue-request' &&
      options.shouldSkipIssueRequest &&
      (await options.shouldSkipIssueRequest(request))
    ) {
      await msg.ack();
      onStatus?.({
        type: 'skipped',
        briefId: describeRequest(request),
        reason: 'rejected',
      });
      continue;
    }
    onStatus?.({ type: 'processing', briefId: describeRequest(request) });

    // Canonical key for the brief-name lock: two slots processing messages with
    // the same key (e.g. two issues normalizing to the same asset name) are
    // serialized so they cannot overwrite each other's intermediate artifacts.
    const briefLockKey = request.kind === 'issue-request' ? request.name : request.briefId;

    // Self-rescheduling renewal timer: extends the Azure Queue visibility
    // timeout while this slot holds the message invisible. Cleared in the
    // finally block regardless of success, error, or lock wait time.
    let renewActive = false;
    let renewTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRenew = (): void => {
      if (!renewActive || !msg.renew || !msg.renewIntervalMs) return;
      renewTimer = setTimeout(() => {
        if (!renewActive) return;
        void msg.renew!()
          .catch(() => {
            // Best-effort: a renewal failure is not fatal. If the lease
            // expires before the run finishes the ack will fail and the
            // message resurfaces for a natural retry.
          })
          .finally(() => {
            scheduleRenew();
          });
      }, msg.renewIntervalMs);
    };
    if (msg.renew && msg.renewIntervalMs) {
      renewActive = true;
      scheduleRenew();
    }

    let result: { readonly summary: { readonly runId: string }; readonly summaryPath: string };
    try {
      result = await withBriefLock(briefLockKey, async () => {
        if (request.kind === 'issue-request') {
          return runIssueRequest({
            request,
            options,
            dequeueCount: msg.dequeueCount,
          });
        } else {
          // Brief-path job. Give the brief path-level durability around the run:
          // recover a wiped gitignored draft from the store, then mirror it back so
          // even CLI-enqueued jobs survive a later checkpoint wipe (idempotent —
          // same-key write). `materializeBriefFromStore` returns `false` ONLY when
          // the brief is absent from BOTH disk and store — a PERMANENT failure (no
          // retry can conjure missing bytes), surfaced as BriefNotFoundError so the
          // poison message is dropped immediately. A TRANSIENT store/fs outage
          // instead THROWS and propagates to the catch below, where it is retried
          // (never mistaken for a missing brief and dropped).
          const absBrief = path.resolve(repoRoot, request.briefPath);
          if (!(await materializeBriefFromStore(store, repoRoot, absBrief))) {
            throw new BriefNotFoundError(request.briefPath);
          }
          await mirrorBriefToStore(store, repoRoot, absBrief);
          return generateOne({
            briefPath: absBrief,
            provider,
            textProvider: options.textProvider ?? null,
            repoRoot,
            store,
          });
        }
      });
    } catch (err) {
      // GENERATION failed. Ack failures are handled separately on the success
      // path below and can never reach this branch, so a run that SUCCEEDS but
      // whose ack fails is not misreported here as a generation failure.
      const error = err instanceof Error ? err : new Error(String(err));
      const permanent = isPermanentFailure(err);
      const giveUp = permanent || msg.dequeueCount >= MAX_DEQUEUE_ATTEMPTS;

      if (giveUp) {
        // Deterministic failure, or the retry cap is reached: DROP the message
        // first so a poison message cannot loop forever. We ack BEFORE posting
        // the issue-request failure comment, and comment ONLY when the ack
        // actually succeeded: a successful ack deletes the message so it can
        // never be redelivered, which is what makes the comment strictly
        // at-most-once. If the ack itself fails (e.g. a stale pop receipt after
        // the visibility timeout expired mid-run) we leave the message for
        // redelivery WITHOUT commenting and WITHOUT crashing the worker — the
        // single comment is then posted later, on whichever delivery's ack
        // succeeds.
        let dropped = false;
        try {
          await msg.ack();
          dropped = true;
        } catch {
          // Swallow the ack failure: letting the message resurface for a bounded
          // retry is far better than crashing the whole poll loop.
        }
        if (dropped && request.kind === 'issue-request' && options.issueApi) {
          try {
            await options.issueApi.comment(
              request.issueNumber,
              buildFailureComment(error, { permanent, dequeueCount: msg.dequeueCount }),
            );
          } catch {
            // Best-effort: a comment failure must not turn a dropped message
            // back into a retry.
          }
        }
        onStatus?.({ type: 'error', briefId: describeRequest(request), error, dropped });
      } else {
        // Transient failure below the cap: do NOT ack. The message becomes
        // visible again after the visibility timeout so a fixed worker can
        // retry it. No comment yet — that would spam the issue on every retry.
        onStatus?.({ type: 'error', briefId: describeRequest(request), error });
      }
      continue;
    } finally {
      // Always stop the renewal timer, regardless of success, error, or
      // how long the brief-lock wait took.
      renewActive = false;
      clearTimeout(renewTimer);
    }

    // SUCCESS: ack OUTSIDE the generation try/catch so an ack failure is never
    // mistaken for a generation failure (which could post a false ⚠️ comment).
    // If the ack fails the message simply resurfaces and the run is retried; we
    // report it as an error WITHOUT a failure comment.
    try {
      await msg.ack();
      onStatus?.({
        type: 'done',
        briefId: describeRequest(request),
        runId: result.summary.runId,
        summaryPath: result.summaryPath,
      });
    } catch (ackErr) {
      const error = ackErr instanceof Error ? ackErr : new Error(String(ackErr));
      onStatus?.({ type: 'error', briefId: describeRequest(request), error });
    }

    function describeRequest(request: AssetRequest): string {
      return request.kind === 'issue-request'
        ? `issue-${request.issueNumber}:${request.name}`
        : request.briefId;
    }

    async function runIssueRequest(args: {
      readonly request: IssueAssetRequest;
      readonly options: WorkerOptions;
      readonly dequeueCount: number;
    }) {
      const { request, options, dequeueCount } = args;
      if (!options.synthProvider || !options.briefSelectorProvider || !options.issueApi) {
        throw new Error(
          'issue-request job requires synthProvider, briefSelectorProvider, and issueApi to be configured',
        );
      }
      // NOTE: the failure comment is intentionally NOT posted here. The outer
      // catch owns failure handling so the comment is gated by the give-up
      // (permanent / dequeue-cap) decision and posted at most once per message
      // rather than on every visibility-timeout redelivery.
      //
      // Intermediate progress comments (synth / select / promote) are likewise
      // suppressed on REDELIVERIES (dequeueCount > 1): the first delivery shows
      // live progress, while natural retries stay quiet so a transient failure
      // that recurs cannot re-post the same progress updates on every attempt.
      const result = await runIssuePipeline({
        request,
        repoRoot: options.repoRoot,
        store: options.store,
        imageProvider: options.provider,
        textProvider: options.textProvider ?? null,
        synthProvider: options.synthProvider,
        briefSelectorProvider: options.briefSelectorProvider,
        visionProvider: options.visionProvider ?? null,
        issueApi: options.issueApi,
        postProgressComments: dequeueCount <= 1,
      });
      return {
        summary: {
          runId: result.runId,
        },
        summaryPath: result.summaryPath,
      };
    }
  }
}

/**
 * Build the issue comment posted when a request is dropped. The text is honest
 * about the outcome: the message has been dropped (not left to auto-retry), and
 * whether that was because the error looked permanent or because the delivery
 * cap was reached. This replaces the old "the sidecar will retry on next
 * restart" wording, which was false for dropped messages.
 */
function buildFailureComment(
  error: Error,
  opts: { readonly permanent: boolean; readonly dequeueCount: number },
): string {
  const reason = opts.permanent
    ? 'This looks like a permanent error (for example an authentication failure, or a sheet the image model could not render as a valid sprite grid), so the request was dropped and will NOT be retried automatically.'
    : `The request failed ${opts.dequeueCount} delivery attempts, so it was dropped to avoid an endless retry loop.`;
  return [
    '⚠️ Asset-request pipeline failed.',
    '',
    `Error: ${error.message}`,
    '',
    reason,
    '',
    'If this was a parsing or validation problem, edit the issue to fix it and request the asset again.',
  ].join('\n');
}

/** Abortable sleep — resolves immediately when the signal fires or is already aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // Resolve immediately if the signal is already aborted so the caller
    // doesn't wait the full poll interval before checking the abort flag again.
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      // Remove the abort listener on the normal timeout path. Otherwise a
      // long-running idle-polling worker accumulates one listener per poll on
      // the process-lifetime signal — a slow leak that also trips Node's
      // MaxListenersExceededWarning.
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    // Belt-and-suspenders: re-check after registering the listener. A
    // `{ once: true }` listener added *after* the signal has already aborted
    // never fires, so if the signal became aborted between the early
    // `signal.aborted` guard above and this registration, resolve now instead
    // of waiting the full `ms`. Unreachable while this executor stays
    // synchronous (Node cannot interleave `abort()` mid-executor), but keeps
    // the abort path correct if a future refactor ever introduces an `await`
    // between the guard and the listener registration.
    if (signal?.aborted) {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      resolve();
    }
  });
}
