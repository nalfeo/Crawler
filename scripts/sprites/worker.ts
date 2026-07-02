/**
 * Sprite-generation queue worker.
 *
 * Polls an {@link AssetQueue} in a loop, calls {@link generateOne} for each
 * dequeued request, and acks the message on success. On failure the message
 * is NOT acked so it becomes visible again after the queue's visibility
 * timeout — this gives a natural retry without a local retry loop that could
 * burn through the same broken brief repeatedly.
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
  | { readonly type: 'error'; readonly briefId: string; readonly error: Error }
  | { readonly type: 'stopping' };

/**
 * Run the worker loop until the abort signal fires.
 *
 * The loop:
 *   1. Dequeue one message.
 *   2. On null (empty queue) → emit `idle`, sleep `pollIntervalMs`, repeat.
 *   3. On message → emit `processing`, call `generateOne`, ack, emit `done`.
 *   4. On `generateOne` error → emit `error`, do NOT ack (retry later), continue.
 *   5. On abort signal → finish the current message (if any) then exit.
 */
export async function runWorker(options: WorkerOptions): Promise<void> {
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

    try {
      const result =
        request.kind === 'issue-request'
          ? await runIssueRequest({
              request,
              options,
            })
          : await generateOne({
              briefPath: path.resolve(repoRoot, request.briefPath),
              provider,
              textProvider: options.textProvider ?? null,
              repoRoot,
              store,
            });
      await msg.ack();
      onStatus?.({
        type: 'done',
        briefId: describeRequest(request),
        runId: result.summary.runId,
        summaryPath: result.summaryPath,
      });
    } catch (err) {
      // Do NOT ack — the message will become visible again after the
      // visibility timeout so a fixed worker can retry it.
      const error = err instanceof Error ? err : new Error(String(err));
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
    }) {
      const { request, options } = args;
      if (!options.synthProvider || !options.briefSelectorProvider || !options.issueApi) {
        throw new Error(
          'issue-request job requires synthProvider, briefSelectorProvider, and issueApi to be configured',
        );
      }
      try {
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
        });
        return {
          summary: {
            runId: result.runId,
          },
          summaryPath: result.summaryPath,
        };
      } catch (err) {
        // On pipeline error, post diagnostic comment. User can fix and restart sidecar.
        const error = err instanceof Error ? err : new Error(String(err));
        try {
          await options.issueApi.comment(
            request.issueNumber,
            `⚠️ Asset-request pipeline failed.\n\nError: ${error.message}\n\nIf this is a parsing or validation error, please edit the issue and try again. If it's a transient service error, the sidecar will retry on next restart.`,
          );
        } catch {
          // Ignore comment errors; rethrow pipeline error
        }
        throw error;
      }
    }
  }

  onStatus?.({ type: 'stopping' });
}

/** Abortable sleep — resolves immediately when the signal fires or is already aborted. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // Resolve immediately if the signal is already aborted so the caller
    // doesn't wait the full poll interval before checking the abort flag again.
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
