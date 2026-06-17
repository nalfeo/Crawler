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
 * the CLI) or when the queue returns null on every poll for the configured
 * `idleTimeoutMs` (useful for one-shot batch processing).
 */
import type { AssetQueue } from './queue/types.js';
import type { RunStore } from './store/types.js';
import type { ImageProvider } from './provider/types.js';
import type { TextProvider } from './provider/text-types.js';
import type { VisionProvider } from './provider/vision-types.js';
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
  /** Optional vision provider for the VLM judge. Defaults to none. */
  readonly visionProvider?: VisionProvider | null;
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
}
/** Possible worker state transitions reported via `onStatus`. */
export type WorkerStatus =
  | {
      readonly type: 'idle';
    }
  | {
      readonly type: 'processing';
      readonly briefId: string;
    }
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
    }
  | {
      readonly type: 'stopping';
    };
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
export declare function runWorker(options: WorkerOptions): Promise<void>;
//# sourceMappingURL=worker.d.ts.map
