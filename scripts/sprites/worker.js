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
import path from 'node:path';
import { generateOne } from './generate-one.js';
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
export async function runWorker(options) {
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
    onStatus?.({ type: 'processing', briefId: request.briefId });
    try {
      const result = await generateOne({
        briefPath: path.resolve(repoRoot, request.briefPath),
        provider,
        textProvider: options.textProvider ?? null,
        visionProvider: options.visionProvider ?? null,
        repoRoot,
        store,
      });
      await msg.ack();
      onStatus?.({
        type: 'done',
        briefId: request.briefId,
        runId: result.summary.runId,
        summaryPath: result.summaryPath,
      });
    } catch (err) {
      // Do NOT ack — the message will become visible again after the
      // visibility timeout so a fixed worker can retry it.
      const error = err instanceof Error ? err : new Error(String(err));
      onStatus?.({ type: 'error', briefId: request.briefId, error });
    }
  }
  onStatus?.({ type: 'stopping' });
}
/** Abortable sleep — resolves immediately when the signal fires or is already aborted. */
function sleep(ms, signal) {
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
//# sourceMappingURL=worker.js.map
