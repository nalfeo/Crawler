/**
 * Unit tests for the sprite-generation worker loop.
 *
 * Uses vi.mock to stub generateOne so the worker logic (polling, acking,
 * error handling, abort) can be tested without touching the filesystem or
 * real providers.
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AssetQueue,
  AssetRequest,
  DequeuedMessage,
} from '../../../scripts/sprites/queue/types.js';
import type { RunStore } from '../../../scripts/sprites/store/types.js';
import type { ImageProvider } from '../../../scripts/sprites/provider/types.js';
import { runWorker, type WorkerStatus } from '../../../scripts/sprites/worker.js';

// ---------------------------------------------------------------------------
// Stub generateOne so the worker tests run without real IO.
// ---------------------------------------------------------------------------
vi.mock('../../../scripts/sprites/generate-one.js', () => ({
  generateOne: vi.fn(),
}));

import { generateOne } from '../../../scripts/sprites/generate-one.js';
const mockGenerate = vi.mocked(generateOne);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(briefId = 'iron-sword'): AssetRequest {
  return {
    briefId,
    briefPath: `briefs/weapons/${briefId}.yaml`,
    requestedBy: 'test',
    requestedAt: new Date().toISOString(),
    priority: 'normal',
  };
}

function makeMessage(
  request: AssetRequest,
  ackFn = vi.fn().mockResolvedValue(undefined),
): DequeuedMessage {
  return { request, ack: ackFn };
}

function makeQueue(messages: Array<DequeuedMessage | null>): AssetQueue {
  let index = 0;
  return {
    backend: 'noop',
    async enqueue() {},
    async dequeue() {
      return messages[index++] ?? null;
    },
    async peek() {
      return [];
    },
  };
}

function makeStore(): RunStore {
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

const stubProvider: ImageProvider = {
  async generateSheet() {
    return Buffer.alloc(0);
  },
};

const fakeSummaryResult = {
  summary: {
    runId: '2026-06-10T00-00-00-abcdef01',
    brief: 'iron-sword',
    briefPath: 'briefs/weapons/iron-sword.yaml',
    runId2: '',
    createdAt: new Date().toISOString(),
    promptHash: 'abcdef01',
    attempts: 1,
    variantCount: 4,
    candidates: [],
    diversity: null,
    variations: { seed: [], proposed: [], final: [], minVariations: 1, skippedReason: null },
    chosen: null,
    judgeBudget: null,
    judgeCache: null,
  },
  summaryPath: '/tmp/runs/iron-sword/2026-06-10T00-00-00-abcdef01/summary.json',
  runDir: '/tmp/runs/iron-sword/2026-06-10T00-00-00-abcdef01',
  attempts: 1,
  brief: {} as never,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits immediately when signal is already aborted', async () => {
    const statuses: WorkerStatus[] = [];
    const controller = new AbortController();
    controller.abort();

    await runWorker({
      queue: makeQueue([]),
      store: makeStore(),
      repoRoot: '/tmp',
      provider: stubProvider,
      signal: controller.signal,
      onStatus: (s) => statuses.push(s),
    });

    // Only 'stopping' should be emitted — no dequeue calls.
    expect(statuses).toEqual([{ type: 'stopping' }]);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('emits idle and stops after empty queue with aborted signal', async () => {
    const statuses: WorkerStatus[] = [];
    const controller = new AbortController();

    // Queue returns null once, then we abort via a side-effect in onStatus.
    const queue = makeQueue([null]);
    // Abort after first idle so the loop exits quickly.
    const patchedOnStatus = (s: WorkerStatus) => {
      statuses.push(s);
      if (s.type === 'idle') controller.abort();
    };

    await runWorker({
      queue,
      store: makeStore(),
      repoRoot: '/tmp',
      provider: stubProvider,
      signal: controller.signal,
      pollIntervalMs: 0, // don't actually wait
      onStatus: patchedOnStatus,
    });

    expect(statuses.some((s) => s.type === 'idle')).toBe(true);
    expect(statuses.at(-1)).toEqual({ type: 'stopping' });
  });

  it('processes a message: calls generateOne and acks on success', async () => {
    mockGenerate.mockResolvedValueOnce(fakeSummaryResult as never);

    const ack = vi.fn().mockResolvedValue(undefined);
    const request = makeRequest();
    const statuses: WorkerStatus[] = [];
    const controller = new AbortController();

    const queue = makeQueue([makeMessage(request, ack), null]);
    const patchedOnStatus = (s: WorkerStatus) => {
      statuses.push(s);
      if (s.type === 'done') controller.abort();
    };

    await runWorker({
      queue,
      store: makeStore(),
      repoRoot: '/tmp',
      provider: stubProvider,
      signal: controller.signal,
      pollIntervalMs: 0,
      onStatus: patchedOnStatus,
    });

    expect(mockGenerate).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledOnce();
    expect(statuses).toContainEqual({ type: 'processing', briefId: 'iron-sword' });
    expect(statuses).toContainEqual(
      expect.objectContaining({ type: 'done', briefId: 'iron-sword' }),
    );
  });

  it('does NOT ack when generateOne throws, emits error status', async () => {
    mockGenerate.mockRejectedValueOnce(new Error('provider-error'));

    const ack = vi.fn();
    const request = makeRequest('fire-staff');
    const statuses: WorkerStatus[] = [];
    const controller = new AbortController();

    const queue = makeQueue([makeMessage(request, ack), null]);
    const patchedOnStatus = (s: WorkerStatus) => {
      statuses.push(s);
      // Abort after error so the loop exits.
      if (s.type === 'error') controller.abort();
    };

    await runWorker({
      queue,
      store: makeStore(),
      repoRoot: '/tmp',
      provider: stubProvider,
      signal: controller.signal,
      pollIntervalMs: 0,
      onStatus: patchedOnStatus,
    });

    expect(ack).not.toHaveBeenCalled();
    const errorStatus = statuses.find((s) => s.type === 'error') as Extract<
      WorkerStatus,
      { type: 'error' }
    >;
    expect(errorStatus).toBeDefined();
    expect(errorStatus.briefId).toBe('fire-staff');
    expect(errorStatus.error.message).toBe('provider-error');
  });

  it('passes briefPath resolved against repoRoot to generateOne', async () => {
    mockGenerate.mockResolvedValueOnce(fakeSummaryResult as never);

    const ack = vi.fn().mockResolvedValue(undefined);
    const request: AssetRequest = {
      ...makeRequest(),
      briefPath: 'briefs/weapons/iron-sword.yaml',
    };
    const controller = new AbortController();
    const statuses: WorkerStatus[] = [];

    const queue = makeQueue([makeMessage(request, ack), null]);
    const patchedOnStatus = (s: WorkerStatus) => {
      statuses.push(s);
      if (s.type === 'done') controller.abort();
    };

    await runWorker({
      queue,
      store: makeStore(),
      repoRoot: '/repo',
      provider: stubProvider,
      signal: controller.signal,
      pollIntervalMs: 0,
      onStatus: patchedOnStatus,
    });

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        briefPath: path.resolve('/repo', 'briefs/weapons/iron-sword.yaml'),
        repoRoot: '/repo',
      }),
    );
  });
});
