/**
 * Unit tests for the sidecar-owned worker controller.
 *
 * The controller wraps `runWorker` with start/stop/status lifecycle so the
 * sidecar (and the devtools "Launch worker" button) can manage an in-process
 * queue consumer. All collaborators are injected, so these tests never touch
 * the network, the filesystem, or a real provider — and never run a real loop.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createWorkerController,
  type RunWorkerFn,
  type WorkerControllerDeps,
} from '../../../scripts/sprites/sidecar/worker-controller.js';
import type { WorkerOptions, WorkerStatus } from '../../../scripts/sprites/worker.js';
import type { AssetQueue } from '../../../scripts/sprites/queue/types.js';
import type { RunStore } from '../../../scripts/sprites/store/types.js';
import type { ImageProvider } from '../../../scripts/sprites/provider/types.js';

const FIXED_NOW = 1_700_000_000_000;

function fakeQueue(backend: 'noop' | 'azure-queue' = 'azure-queue'): AssetQueue {
  return {
    backend,
    async enqueue() {},
    async dequeue() {
      return null;
    },
    async peek() {
      return [];
    },
  };
}

function fakeStore(): RunStore {
  return {
    backend: 'local',
    async put() {},
    async get() {
      return Buffer.alloc(0);
    },
    async has() {
      return false;
    },
    async list() {
      return [];
    },
    async remove() {},
    resolve(key) {
      return `/tmp/runs/${key}`;
    },
  };
}

const stubImageProvider: ImageProvider = {
  async generateSheet() {
    return Buffer.alloc(0);
  },
};

/** A fake worker loop that captures its options and resolves only on abort. */
function abortableRunWorker(): { run: RunWorkerFn; options: WorkerOptions[] } {
  const options: WorkerOptions[] = [];
  const run: RunWorkerFn = (opts) => {
    options.push(opts);
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        opts.onStatus?.({ type: 'stopping' });
        resolve();
      };
      if (opts.signal?.aborted) {
        finish();
        return;
      }
      opts.signal?.addEventListener('abort', finish, { once: true });
    });
  };
  return { run, options };
}

/** A fake worker loop that synchronously emits statuses, then waits for abort. */
function emittingRunWorker(emit: readonly WorkerStatus[]): RunWorkerFn {
  return (opts) => {
    for (const status of emit) opts.onStatus?.(status);
    return new Promise<void>((resolve) => {
      if (opts.signal?.aborted) {
        resolve();
        return;
      }
      opts.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  };
}

function baseDeps(over: Partial<WorkerControllerDeps> = {}): WorkerControllerDeps {
  return {
    queue: fakeQueue(),
    store: fakeStore(),
    repoRoot: '/repo',
    env: {},
    createImageProvider: () => stubImageProvider,
    createTextProvider: () => null,
    now: () => FIXED_NOW,
    ...over,
  };
}

describe('createWorkerController', () => {
  it('starts the loop and reports running status with injected timestamps', () => {
    const { run, options } = abortableRunWorker();
    const controller = createWorkerController(baseDeps({ runWorker: run, pollIntervalMs: 0 }));

    expect(controller.status().running).toBe(false);
    const result = controller.start();

    expect(result).toMatchObject({ started: true, reason: 'started' });
    expect(controller.status()).toMatchObject({
      running: true,
      backend: 'azure-queue',
      startedAt: new Date(FIXED_NOW).toISOString(),
      stoppedAt: null,
    });
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ repoRoot: '/repo', provider: stubImageProvider });
    // pollIntervalMs is forwarded only when provided.
    expect(options[0]?.pollIntervalMs).toBe(0);
  });

  it('is idempotent: a second start() does not launch a second loop', () => {
    const { run, options } = abortableRunWorker();
    const controller = createWorkerController(baseDeps({ runWorker: run }));

    controller.start();
    const second = controller.start();

    expect(second).toMatchObject({ started: false, reason: 'already-running' });
    expect(options).toHaveLength(1);
  });

  it('records processed/failed counters and last event from worker status', () => {
    const err = new Error('boom');
    const run = emittingRunWorker([
      { type: 'processing', briefId: 'iron-sword' },
      { type: 'done', briefId: 'iron-sword', runId: 'run-1', summaryPath: 's.json' },
      { type: 'error', briefId: 'gold-ring', error: err },
    ]);
    const controller = createWorkerController(baseDeps({ runWorker: run }));

    controller.start();
    const status = controller.status();

    expect(status.processed).toBe(1);
    expect(status.failed).toBe(1);
    expect(status.lastBriefId).toBe('gold-ring');
    expect(status.lastError).toBe('boom');
    expect(status.lastEvent).toBe('error');
  });

  it('forwards worker status to an injected onStatus sink', () => {
    const onStatus = vi.fn();
    const run = emittingRunWorker([{ type: 'processing', briefId: 'iron-sword' }]);
    const controller = createWorkerController(baseDeps({ runWorker: run, onStatus }));

    controller.start();

    expect(onStatus).toHaveBeenCalledWith({ type: 'processing', briefId: 'iron-sword' });
  });

  it('does not start when provider construction fails, recording lastError', () => {
    const { run, options } = abortableRunWorker();
    const controller = createWorkerController(
      baseDeps({
        runWorker: run,
        createImageProvider: () => {
          throw new Error('Missing AZURE_OPENAI_API_KEY');
        },
      }),
    );

    const result = controller.start();

    expect(result).toMatchObject({ started: false, reason: 'provider-init-failed' });
    expect(result.status.running).toBe(false);
    expect(result.status.lastError).toContain('Missing AZURE_OPENAI_API_KEY');
    expect(options).toHaveLength(0);
  });

  it('stop() aborts the loop and resolves with a stopped status', async () => {
    const { run } = abortableRunWorker();
    const controller = createWorkerController(baseDeps({ runWorker: run }));

    controller.start();
    expect(controller.status().running).toBe(true);

    const stopped = await controller.stop();

    expect(stopped.running).toBe(false);
    expect(stopped.stoppedAt).toBe(new Date(FIXED_NOW).toISOString());
    expect(controller.status().running).toBe(false);
  });

  it('stop() is a no-op when the worker was never started', async () => {
    const { run, options } = abortableRunWorker();
    const controller = createWorkerController(baseDeps({ runWorker: run }));

    const status = await controller.stop();

    expect(status.running).toBe(false);
    expect(options).toHaveLength(0);
  });

  it('reports the queue backend in status', () => {
    const { run } = abortableRunWorker();
    const controller = createWorkerController(
      baseDeps({ runWorker: run, queue: fakeQueue('noop') }),
    );

    expect(controller.status().backend).toBe('noop');
  });
});
