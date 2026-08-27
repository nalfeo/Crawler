#!/usr/bin/env node

import { performance } from 'node:perf_hooks';
import type { AssetQueue } from './queue/types.js';
import type { RunStore } from './store/types.js';
import type { ImageProvider } from './provider/types.js';
import { runWorker, type WorkerStatus } from './worker.js';
import { createDrainOnStatus } from './worker-cli-lib.js';

// Historical reference captured at commit b06d80611; not a live baseline.
const MEASURED_BASELINE_MS = 13_926;
const MAX_TAIL_MS = 2_000;

const queue: AssetQueue = {
  backend: 'noop',
  async enqueue() {},
  async dequeue() {
    return null;
  },
  async peek() {
    return [];
  },
};

const store: RunStore = {
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
    return key;
  },
};

const provider: ImageProvider = {
  async generateSheet() {
    throw new Error('benchmark provider must not be called');
  },
};

const abortController = new AbortController();
const startedAt = performance.now();
const onStatus = createDrainOnStatus({
  base: (_status: WorkerStatus) => {},
  maxEmptyPolls: 3,
  abort: () => abortController.abort(),
  isProducerComplete: () => true,
});

await runWorker({
  queue,
  store,
  repoRoot: process.cwd(),
  provider,
  concurrency: 2,
  pollIntervalMs: 1_000,
  signal: abortController.signal,
  onStatus,
});

const optimizedTailMs = performance.now() - startedAt;
const result = {
  measuredBaselineMs: MEASURED_BASELINE_MS,
  optimizedTailMs: Number(optimizedTailMs.toFixed(3)),
  thresholdMs: MAX_TAIL_MS,
  concurrency: 2,
};

process.stdout.write(`${JSON.stringify(result)}\n`);
if (optimizedTailMs > MAX_TAIL_MS) {
  process.stderr.write(
    `worker drain benchmark exceeded ${MAX_TAIL_MS}ms: ${optimizedTailMs.toFixed(3)}ms\n`,
  );
  process.exitCode = 1;
}
