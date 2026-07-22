/**
 * Unit tests for the sprite-generation worker loop.
 *
 * Uses vi.mock to stub generateOne so the worker logic (polling, acking,
 * error handling, abort) can be tested without touching the filesystem or
 * real providers.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AssetQueue,
  AssetRequest,
  BriefPathAssetRequest,
  DequeuedMessage,
  IssueAssetRequest,
} from '../../../scripts/sprites/queue/types.js';
import type { RunStore } from '../../../scripts/sprites/store/types.js';
import type { ImageProvider } from '../../../scripts/sprites/provider/types.js';
import { ProviderError } from '../../../scripts/sprites/provider/types.js';
import { runWorker, sleep, type WorkerStatus } from '../../../scripts/sprites/worker.js';
import { workflowBriefKey } from '../../../scripts/sprites/sidecar/workflow-state.js';

// ---------------------------------------------------------------------------
// Stub generateOne so the worker tests run without real IO.
// ---------------------------------------------------------------------------
vi.mock('../../../scripts/sprites/generate-one.js', () => ({
  generateOne: vi.fn(),
}));
vi.mock('../../../scripts/sprites/issue-pipeline.js', () => ({
  runIssuePipeline: vi.fn(),
}));

import { generateOne } from '../../../scripts/sprites/generate-one.js';
import { runIssuePipeline } from '../../../scripts/sprites/issue-pipeline.js';
const mockGenerate = vi.mocked(generateOne);
const mockIssuePipeline = vi.mocked(runIssuePipeline);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(briefId = 'iron-sword'): BriefPathAssetRequest {
  return {
    kind: 'brief-path',
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
  dequeueCount = 1,
): DequeuedMessage {
  return { request, dequeueCount, ack: ackFn };
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
    // Model a store that DOES hold a durably-mirrored brief: brief-path jobs
    // materialise it back onto disk (into the per-test temp repoRoot) before
    // generation, exercising the real recovery path. generateOne is mocked, so
    // the exact YAML bytes are irrelevant to these loop tests.
    async get() {
      return Buffer.from('name: stub\ntype: item\nreferences:\n  - a.png\n  - b.png\n');
    },
    async has() {
      return true;
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

// Per-test temp repo root so brief materialisation/mirroring writes land in an
// isolated, auto-cleaned directory instead of polluting the real worktree. A
// root-level hook applies to every describe block in this file.
let repoRoot: string;
beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'crawler-worker-'));
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

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
      repoRoot,
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
      repoRoot,
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
      repoRoot,
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
      repoRoot,
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
    const request: BriefPathAssetRequest = {
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
      repoRoot,
      provider: stubProvider,
      signal: controller.signal,
      pollIntervalMs: 0,
      onStatus: patchedOnStatus,
    });

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        briefPath: path.resolve(repoRoot, 'briefs/weapons/iron-sword.yaml'),
        repoRoot,
      }),
    );
  });

  it('drops a brief-path job as a permanent failure when the brief is absent from disk and store', async () => {
    // The referenced brief exists in neither the worktree nor the store, so no
    // retry can conjure the missing bytes. The job must be dropped (acked) on the
    // first delivery and never reach generateOne, rather than retried to the cap.
    const ack = vi.fn().mockResolvedValue(undefined);
    const request = makeRequest('ghost-brief');
    const statuses: WorkerStatus[] = [];
    const controller = new AbortController();
    const emptyStore: RunStore = {
      ...makeStore(),
      async has() {
        return false;
      },
    };

    const queue = makeQueue([makeMessage(request, ack), null]);
    await runWorker({
      queue,
      store: emptyStore,
      repoRoot,
      provider: stubProvider,
      signal: controller.signal,
      pollIntervalMs: 0,
      onStatus: (s) => {
        statuses.push(s);
        if (s.type === 'error') controller.abort();
      },
    });

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    const err = statuses.find((s) => s.type === 'error') as Extract<
      WorkerStatus,
      { type: 'error' }
    >;
    expect(err).toBeDefined();
    expect(err.dropped).toBe(true);
    expect(err.error.message).toMatch(/brief/i);
  });

  it('mirrors the brief into the store on a successful brief-path run', async () => {
    // Path-level durability: a worker-produced run mirrors its (recovered) brief
    // back under the stable workflow-briefs key, so a later checkpoint wipe of the
    // gitignored draft is recoverable even for CLI-enqueued jobs.
    mockGenerate.mockResolvedValueOnce(fakeSummaryResult as never);
    const put = vi.fn().mockResolvedValue(undefined);
    const store: RunStore = { ...makeStore(), put };
    const request = makeRequest('iron-sword');
    const controller = new AbortController();

    const queue = makeQueue([makeMessage(request, vi.fn().mockResolvedValue(undefined)), null]);
    await runWorker({
      queue,
      store,
      repoRoot,
      provider: stubProvider,
      signal: controller.signal,
      pollIntervalMs: 0,
      onStatus: (s) => {
        if (s.type === 'done') controller.abort();
      },
    });

    expect(put).toHaveBeenCalledWith(
      workflowBriefKey('briefs/weapons/iron-sword.yaml'),
      expect.any(Buffer),
    );
  });

  it('runs issue-originated jobs through the automated issue pipeline', async () => {
    mockIssuePipeline.mockResolvedValueOnce({
      briefId: 'bone-dagger',
      runId: 'run-1',
      summaryPath: '/tmp/run-1/summary.json',
    });
    const ack = vi.fn().mockResolvedValue(undefined);
    const request: AssetRequest = {
      kind: 'issue-request',
      issueNumber: 99,
      name: 'bone-dagger',
      briefSentence: 'A chipped bone dagger with twine-wrapped handle.',
      fingerprint: 'abc',
      claimedAt: new Date().toISOString(),
      requestedBy: 'test',
      requestedAt: new Date().toISOString(),
      priority: 'normal',
    };
    const controller = new AbortController();
    const queue = makeQueue([makeMessage(request, ack), null]);
    await runWorker({
      queue,
      store: makeStore(),
      repoRoot,
      provider: stubProvider,
      textProvider: null,
      synthProvider: {} as never,
      briefSelectorProvider: {} as never,
      issueApi: { comment: async () => {} },
      signal: controller.signal,
      pollIntervalMs: 0,
      onStatus: (s) => {
        if (s.type === 'done') controller.abort();
      },
    });
    expect(mockIssuePipeline).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledOnce();
  });

  it('acks and skips a rejected issue-originated job before pipeline execution', async () => {
    const ack = vi.fn().mockResolvedValue(undefined);
    const request: AssetRequest = {
      kind: 'issue-request',
      issueNumber: 100,
      name: 'bone-dagger',
      briefSentence: 'A chipped bone dagger with twine-wrapped handle.',
      fingerprint: 'reject-me',
      claimedAt: new Date().toISOString(),
      requestedBy: 'test',
      requestedAt: new Date().toISOString(),
      priority: 'normal',
    };
    const controller = new AbortController();
    const queue = makeQueue([makeMessage(request, ack), null]);
    await runWorker({
      queue,
      store: makeStore(),
      repoRoot,
      provider: stubProvider,
      textProvider: null,
      synthProvider: {} as never,
      briefSelectorProvider: {} as never,
      issueApi: { comment: async () => {} },
      shouldSkipIssueRequest: async (r) =>
        r.kind === 'issue-request' && r.fingerprint === 'reject-me',
      signal: controller.signal,
      pollIntervalMs: 0,
      onStatus: (s) => {
        if (s.type === 'skipped') controller.abort();
      },
    });
    expect(ack).toHaveBeenCalledOnce();
    expect(mockIssuePipeline).not.toHaveBeenCalled();
  });

  it('processes at most two messages concurrently without dequeuing a third', async () => {
    let dequeueCalls = 0;
    const messages = [
      makeMessage(makeRequest('first')),
      makeMessage(makeRequest('second')),
      makeMessage(makeRequest('third')),
    ];
    const queue: AssetQueue = {
      backend: 'noop',
      async enqueue() {},
      async dequeue() {
        dequeueCalls += 1;
        return messages.shift() ?? null;
      },
      async peek() {
        return [];
      },
    };
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    mockGenerate.mockImplementation(
      () =>
        new Promise<never>((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          releases.push(() => {
            active -= 1;
            resolve(fakeSummaryResult as never);
          });
        }),
    );
    const controller = new AbortController();
    const statuses: WorkerStatus[] = [];
    const worker = runWorker({
      queue,
      store: makeStore(),
      repoRoot,
      provider: stubProvider,
      concurrency: 2,
      pollIntervalMs: 0,
      signal: controller.signal,
      onStatus: (status) => {
        statuses.push(status);
        if (statuses.filter((entry) => entry.type === 'done').length === 3) {
          controller.abort();
        }
      },
    });

    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(dequeueCalls).toBe(2);
    expect(maxActive).toBe(2);

    releases[0]!();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    expect(dequeueCalls).toBe(3);
    expect(maxActive).toBe(2);

    releases[1]!();
    releases[2]!();
    await worker;
    expect(statuses.filter((status) => status.type === 'stopping')).toHaveLength(1);
  });

  it('emits one idle event only after every slot observes an empty queue', async () => {
    const controller = new AbortController();
    const statuses: WorkerStatus[] = [];
    await runWorker({
      queue: makeQueue([]),
      store: makeStore(),
      repoRoot,
      provider: stubProvider,
      concurrency: 2,
      pollIntervalMs: 0,
      signal: controller.signal,
      onStatus: (status) => {
        statuses.push(status);
        if (statuses.filter((entry) => entry.type === 'idle').length === 2) {
          controller.abort();
        }
      },
    });

    expect(statuses.filter((status) => status.type === 'idle')).toHaveLength(2);
    expect(statuses.filter((status) => status.type === 'stopping')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Bug A: bounded-failure / poison-message policy
// ---------------------------------------------------------------------------

function makeIssueRequest(overrides: Partial<IssueAssetRequest> = {}): IssueAssetRequest {
  return {
    kind: 'issue-request',
    issueNumber: 555,
    name: 'classified-dossier',
    briefSentence: 'A classified dossier character in a trench coat.',
    fingerprint: 'fp-555',
    claimedAt: new Date().toISOString(),
    requestedBy: 'test',
    requestedAt: new Date().toISOString(),
    priority: 'normal',
    ...overrides,
  };
}

/**
 * A queue that redelivers a single un-acked message, incrementing
 * `dequeueCount` on each delivery (mirroring Azure's visibility-timeout
 * re-surfacing) and returning null once the message is acked. This is the
 * anti-loop harness: if the worker never acked, `dequeue()` would keep
 * handing back the same poison message forever.
 */
function makeResurfacingQueue(
  request: AssetRequest,
  opts: { ackFailsTimes?: number } = {},
): {
  queue: AssetQueue;
  ack: ReturnType<typeof vi.fn>;
  deliveries: () => number;
} {
  let acked = false;
  let dequeueCount = 0;
  let deliveries = 0;
  let ackCalls = 0;
  const ackFailsTimes = opts.ackFailsTimes ?? 0;
  const ack = vi.fn(async () => {
    ackCalls += 1;
    if (ackCalls <= ackFailsTimes) {
      // Model a stale pop receipt: the visibility timeout expired mid-run so
      // the delete/ack is rejected and the message resurfaces.
      throw new Error(`stale pop receipt (ack failure #${ackCalls})`);
    }
    acked = true;
  });
  const queue: AssetQueue = {
    backend: 'noop',
    async enqueue() {},
    async dequeue() {
      if (acked) return null;
      dequeueCount += 1;
      deliveries += 1;
      return { request, dequeueCount, ack };
    },
    async peek() {
      return [];
    },
  };
  return { queue, ack, deliveries: () => deliveries };
}

/**
 * Drive the worker until `abortOn` matches a status, then return the observed
 * statuses. Keeps the individual failure-policy tests focused on assertions.
 */
async function drive(opts: {
  queue: AssetQueue;
  store?: RunStore;
  comment?: (issueNumber: number, body: string) => Promise<void>;
  issueJob?: boolean;
  abortOn: WorkerStatus['type'] | ((s: WorkerStatus) => boolean);
}): Promise<WorkerStatus[]> {
  const statuses: WorkerStatus[] = [];
  const controller = new AbortController();
  const predicate =
    typeof opts.abortOn === 'function'
      ? opts.abortOn
      : (s: WorkerStatus) => s.type === opts.abortOn;
  await runWorker({
    queue: opts.queue,
    store: opts.store ?? makeStore(),
    repoRoot,
    provider: stubProvider,
    textProvider: null,
    ...(opts.issueJob ? { synthProvider: {} as never, briefSelectorProvider: {} as never } : {}),
    ...(opts.comment ? { issueApi: { comment: opts.comment } } : {}),
    signal: controller.signal,
    pollIntervalMs: 0,
    onStatus: (s) => {
      statuses.push(s);
      if (predicate(s)) controller.abort();
    },
  });
  return statuses;
}

describe('runWorker failure handling (poison-message policy)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops an issue-request on a permanent bad-grid error at first delivery and comments once', async () => {
    mockIssuePipeline.mockRejectedValueOnce(
      new ProviderError('bad-grid', 'expected 16 cells, slicer produced 8'),
    );
    const ack = vi.fn().mockResolvedValue(undefined);
    const comment = vi.fn().mockResolvedValue(undefined);
    const queue = makeQueue([makeMessage(makeIssueRequest(), ack, 1), null]);

    const statuses = await drive({ queue, comment, issueJob: true, abortOn: 'error' });

    expect(ack).toHaveBeenCalledOnce();
    expect(comment).toHaveBeenCalledOnce();
    expect(comment).toHaveBeenCalledWith(555, expect.stringContaining('permanent'));
    const err = statuses.find((s) => s.type === 'error') as Extract<
      WorkerStatus,
      { type: 'error' }
    >;
    expect(err.dropped).toBe(true);
  });

  it('drops a deterministic request-error on the first delivery', async () => {
    mockIssuePipeline.mockRejectedValue(
      new ProviderError('request-error', 'content filter rejected this request'),
    );
    const comment = vi.fn().mockResolvedValue(undefined);
    const { queue, ack, deliveries } = makeResurfacingQueue(makeIssueRequest());

    await drive({
      queue,
      comment,
      issueJob: true,
      abortOn: (status) => status.type === 'error' && status.dropped === true,
    });

    expect(deliveries()).toBe(1);
    expect(ack).toHaveBeenCalledOnce();
    expect(comment).toHaveBeenCalledOnce();
  });

  it('leaves a transient issue-request un-acked and does not comment below the retry cap', async () => {
    mockIssuePipeline.mockRejectedValueOnce(new ProviderError('rate-limit', 'slow down'));
    const ack = vi.fn().mockResolvedValue(undefined);
    const comment = vi.fn().mockResolvedValue(undefined);
    const queue = makeQueue([makeMessage(makeIssueRequest(), ack, 1), null]);

    const statuses = await drive({ queue, comment, issueJob: true, abortOn: 'error' });

    expect(ack).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
    const err = statuses.find((s) => s.type === 'error') as Extract<
      WorkerStatus,
      { type: 'error' }
    >;
    expect(err.dropped).toBeUndefined();
  });

  it('keeps an unexpected provider-error transient below the retry cap', async () => {
    mockIssuePipeline.mockRejectedValueOnce(
      new ProviderError('provider-error', 'temporary storage write failed'),
    );
    const ack = vi.fn().mockResolvedValue(undefined);
    const comment = vi.fn().mockResolvedValue(undefined);
    const queue = makeQueue([makeMessage(makeIssueRequest(), ack, 1), null]);

    const statuses = await drive({ queue, comment, issueJob: true, abortOn: 'error' });

    expect(ack).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
    const err = statuses.find((status) => status.type === 'error') as Extract<
      WorkerStatus,
      { type: 'error' }
    >;
    expect(err.dropped).toBeUndefined();
  });

  it('keeps a server-error transient below the retry cap', async () => {
    mockIssuePipeline.mockRejectedValueOnce(
      new ProviderError('server-error', 'Foundry is temporarily unavailable'),
    );
    const ack = vi.fn().mockResolvedValue(undefined);
    const comment = vi.fn().mockResolvedValue(undefined);
    const queue = makeQueue([makeMessage(makeIssueRequest(), ack, 1), null]);

    const statuses = await drive({ queue, comment, issueJob: true, abortOn: 'error' });

    expect(ack).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
    const err = statuses.find((status) => status.type === 'error') as Extract<
      WorkerStatus,
      { type: 'error' }
    >;
    expect(err.dropped).toBeUndefined();
  });

  it('drops a transient issue-request once dequeueCount reaches the cap and comments once', async () => {
    mockIssuePipeline.mockRejectedValueOnce(new ProviderError('network', 'boom'));
    const ack = vi.fn().mockResolvedValue(undefined);
    const comment = vi.fn().mockResolvedValue(undefined);
    // dequeueCount already at the cap (3) — the next failure must give up.
    const queue = makeQueue([makeMessage(makeIssueRequest(), ack, 3), null]);

    const statuses = await drive({ queue, comment, issueJob: true, abortOn: 'error' });

    expect(ack).toHaveBeenCalledOnce();
    expect(comment).toHaveBeenCalledOnce();
    expect(comment).toHaveBeenCalledWith(555, expect.stringContaining('delivery attempts'));
    const err = statuses.find((s) => s.type === 'error') as Extract<
      WorkerStatus,
      { type: 'error' }
    >;
    expect(err.dropped).toBe(true);
  });

  it('drops a permanent brief-path failure without posting any comment', async () => {
    mockGenerate.mockRejectedValueOnce(new ProviderError('auth', 'bad api key'));
    const ack = vi.fn().mockResolvedValue(undefined);
    const comment = vi.fn().mockResolvedValue(undefined);
    const queue = makeQueue([makeMessage(makeRequest('iron-sword'), ack, 1), null]);

    const statuses = await drive({ queue, comment, abortOn: 'error' });

    expect(ack).toHaveBeenCalledOnce();
    expect(comment).not.toHaveBeenCalled();
    const err = statuses.find((s) => s.type === 'error') as Extract<
      WorkerStatus,
      { type: 'error' }
    >;
    expect(err.dropped).toBe(true);
  });

  it('terminates a transient poison loop at the cap: redelivered until acked, comments exactly once', async () => {
    // Fails on EVERY delivery with a transient error. Without the dequeueCount
    // cap this would loop forever; the resurfacing queue would never return null.
    mockIssuePipeline.mockRejectedValue(new ProviderError('network', 'flaky provider'));
    const comment = vi.fn().mockResolvedValue(undefined);
    const { queue, ack, deliveries } = makeResurfacingQueue(makeIssueRequest());

    const statuses = await drive({
      queue,
      comment,
      issueJob: true,
      abortOn: (s) => s.type === 'error' && s.dropped === true,
    });

    expect(deliveries()).toBe(3); // MAX_DEQUEUE_ATTEMPTS
    expect(ack).toHaveBeenCalledOnce();
    expect(comment).toHaveBeenCalledOnce();
    const dropped = statuses.filter((s) => s.type === 'error' && s.dropped);
    const transient = statuses.filter((s) => s.type === 'error' && !s.dropped);
    expect(dropped).toHaveLength(1);
    expect(transient).toHaveLength(2);
  });

  it('drops a deterministic poison message on the first delivery (no redelivery loop)', async () => {
    // A permanent error must not even reach a second delivery.
    mockIssuePipeline.mockRejectedValue(
      new ProviderError('bad-grid', 'expected 16 cells, slicer produced 8'),
    );
    const comment = vi.fn().mockResolvedValue(undefined);
    const { queue, ack, deliveries } = makeResurfacingQueue(makeIssueRequest());

    await drive({
      queue,
      comment,
      issueJob: true,
      abortOn: (s) => s.type === 'error' && s.dropped === true,
    });

    expect(deliveries()).toBe(1);
    expect(ack).toHaveBeenCalledOnce();
    expect(comment).toHaveBeenCalledOnce();
  });

  it('does not crash and comments exactly once when the give-up ack fails then succeeds on redelivery', async () => {
    // A permanent failure whose FIRST give-up ack throws (stale pop receipt).
    // The worker must not crash: it leaves the message for redelivery WITHOUT
    // commenting, then on the next delivery the ack succeeds and the single
    // failure comment is posted — proving at-most-once holds even across an ack
    // failure.
    mockIssuePipeline.mockRejectedValue(
      new ProviderError('bad-grid', 'expected 16 cells, slicer produced 8'),
    );
    const comment = vi.fn().mockResolvedValue(undefined);
    const { queue, ack, deliveries } = makeResurfacingQueue(makeIssueRequest(), {
      ackFailsTimes: 1,
    });

    const statuses = await drive({
      queue,
      comment,
      issueJob: true,
      abortOn: (s) => s.type === 'error' && s.dropped === true,
    });

    expect(deliveries()).toBe(2); // give-up@1 ack throws (resurfaces), give-up@2 ack succeeds
    expect(ack).toHaveBeenCalledTimes(2);
    expect(comment).toHaveBeenCalledOnce();
    const dropped = statuses.filter((s) => s.type === 'error' && s.dropped === true);
    const notDropped = statuses.filter((s) => s.type === 'error' && s.dropped === false);
    expect(dropped).toHaveLength(1); // only the delivery whose ack succeeded
    expect(notDropped).toHaveLength(1); // the delivery whose ack failed — no comment
  });

  it('retries a transient brief-path failure then acks on success without commenting', async () => {
    mockGenerate
      .mockRejectedValueOnce(new ProviderError('network', 'blip'))
      .mockResolvedValueOnce(fakeSummaryResult as never);
    const comment = vi.fn().mockResolvedValue(undefined);
    const { queue, ack, deliveries } = makeResurfacingQueue(makeRequest('iron-sword'));

    await drive({ queue, comment, abortOn: 'done' });

    expect(deliveries()).toBe(2); // fail@1 (no ack), succeed@2 (ack)
    expect(ack).toHaveBeenCalledOnce();
    expect(comment).not.toHaveBeenCalled();
  });

  it('retries a TRANSIENT store outage during brief recovery instead of dropping it as not-found', async () => {
    // Regression: the brief is NOT on disk but IS in the store, and the download
    // errors on the first delivery (network blip). materializeBriefFromStore must
    // THROW (not return false), so the worker treats it as transient and retries —
    // never mistaking a store outage for a permanently-missing brief and dropping
    // a recoverable job. On redelivery the read succeeds and the run completes.
    let getCalls = 0;
    const flakyStore: RunStore = {
      ...makeStore(),
      async get() {
        getCalls += 1;
        if (getCalls === 1) throw new Error('transient store read failure');
        return Buffer.from('name: stub\ntype: item\nreferences:\n  - a.png\n  - b.png\n');
      },
    };
    mockGenerate.mockResolvedValueOnce(fakeSummaryResult as never);
    const comment = vi.fn().mockResolvedValue(undefined);
    const { queue, ack, deliveries } = makeResurfacingQueue(makeRequest('iron-sword'));

    const statuses = await drive({ queue, store: flakyStore, comment, abortOn: 'done' });

    expect(deliveries()).toBe(2); // transient store read@1 (no ack), recover+succeed@2 (ack)
    expect(ack).toHaveBeenCalledOnce();
    expect(comment).not.toHaveBeenCalled();
    expect(mockGenerate).toHaveBeenCalledOnce(); // only the successful 2nd delivery
    // The first-delivery error must be a transient (non-dropped) failure, proving
    // it was retried rather than permanently dropped like a BriefNotFoundError.
    // The transient path emits an `error` status without a `dropped` flag.
    const transient = statuses.filter((s) => s.type === 'error' && !s.dropped);
    expect(transient).toHaveLength(1);
  });
});

describe('sleep (abortable)', () => {
  it('resolves immediately when the signal is already aborted before the call', async () => {
    const controller = new AbortController();
    controller.abort();
    // Would hang for 60s (and time the test out) if the early guard regressed.
    await expect(sleep(60_000, controller.signal)).resolves.toBeUndefined();
  });

  it('resolves via the post-registration re-check when abort lands right after listener registration', async () => {
    // Deterministically reproduce the reviewer's race and pin the fix: `.aborted`
    // is false at the initial guard and only flips to true AFTER the abort
    // listener has been registered (tracked via `registered`). The `{ once: true }`
    // listener is registered *after* the (fake) abort, so it can never fire — the
    // ONLY thing that can resolve this sleep early is the post-registration
    // re-check, and `reCheckObserved` proves that re-check actually ran.
    vi.useFakeTimers();
    try {
      let registered = false;
      let reCheckObserved = false;
      const racingSignal = {
        get aborted() {
          if (registered) reCheckObserved = true;
          return registered;
        },
        addEventListener: () => {
          registered = true;
        },
        removeEventListener: () => {},
      } as unknown as AbortSignal;

      const slept = sleep(60_000, racingSignal);
      // Prove it settles on the next microtask via the synchronous re-check
      // rather than by waiting out the 60s timer: race against a microtask
      // sentinel. Without the re-check `slept` stays pending and the sentinel
      // wins, failing this assertion immediately (no 60s/timeout dependence).
      const outcome = await Promise.race([
        slept.then(() => 'resolved' as const),
        Promise.resolve().then(() => 'pending' as const),
      ]);

      expect(outcome).toBe('resolved');
      expect(registered).toBe(true);
      expect(reCheckObserved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Renewal timer: visibility-lease extension while processing
// ---------------------------------------------------------------------------

describe('runWorker renewal timer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('calls renew() at configured interval while generating and not after done', async () => {
    const renewIntervalMs = 1_000;
    let renewCalls = 0;
    let generationRelease!: () => void;

    const renew = vi.fn(async () => {
      renewCalls += 1;
    });
    const ack = vi.fn().mockResolvedValue(undefined);
    const request = makeRequest('iron-sword');

    const msg: DequeuedMessage = {
      request,
      dequeueCount: 1,
      renewIntervalMs,
      renew,
      ack,
    };

    mockGenerate.mockImplementation(
      () =>
        new Promise((resolve) => {
          generationRelease = () => resolve(fakeSummaryResult as never);
        }),
    );

    const controller = new AbortController();
    const workerDone = runWorker({
      queue: {
        backend: 'noop',
        async enqueue() {},
        async dequeue() {
          return msg;
        },
        async peek() {
          return [];
        },
      },
      store: makeStore(),
      repoRoot,
      provider: stubProvider,
      pollIntervalMs: 0,
      signal: controller.signal,
      onStatus: (s) => {
        if (s.type === 'done') controller.abort();
      },
    });

    // Wait for generation to start
    await vi.waitFor(() => expect(mockGenerate).toHaveBeenCalledOnce());

    // Advance past two renewal intervals while generation is in-flight
    await vi.advanceTimersByTimeAsync(renewIntervalMs * 2 + 50);
    expect(renewCalls).toBeGreaterThanOrEqual(2);

    // Release generation and let the worker finish
    const renewBeforeDone = renewCalls;
    generationRelease();
    await workerDone;

    // Renewal must stop after the work is done — no new calls after release
    await vi.advanceTimersByTimeAsync(renewIntervalMs * 3);
    expect(renewCalls).toBe(renewBeforeDone);
    expect(ack).toHaveBeenCalledOnce();
  });

  it('does not start a renewal timer when msg.renew is absent', async () => {
    mockGenerate.mockResolvedValueOnce(fakeSummaryResult as never);
    const ack = vi.fn().mockResolvedValue(undefined);
    // Message without renew (e.g. noop queue)
    const msg: DequeuedMessage = {
      request: makeRequest(),
      dequeueCount: 1,
      ack,
    };
    const controller = new AbortController();
    await runWorker({
      queue: {
        backend: 'noop',
        async enqueue() {},
        async dequeue() {
          return msg;
        },
        async peek() {
          return [];
        },
      },
      store: makeStore(),
      repoRoot,
      provider: stubProvider,
      pollIntervalMs: 0,
      signal: controller.signal,
      onStatus: (s) => {
        if (s.type === 'done') controller.abort();
      },
    });
    expect(ack).toHaveBeenCalledOnce();
    // No renewal means no extra async work — worker should complete cleanly
  });
});

// ---------------------------------------------------------------------------
// Brief-name lock: same-name concurrency serialization
// ---------------------------------------------------------------------------

describe('runWorker brief-name lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serializes two concurrent slots with the same canonical brief name', async () => {
    // Two messages with the same briefId must not run at the same time.
    const releases: Array<() => void> = [];
    let maxConcurrent = 0;
    let active = 0;
    mockGenerate.mockImplementation(
      () =>
        new Promise<never>((resolve) => {
          active += 1;
          maxConcurrent = Math.max(maxConcurrent, active);
          releases.push(() => {
            active -= 1;
            resolve(fakeSummaryResult as never);
          });
        }),
    );

    const sameNameRequest = makeRequest('collision-name');
    const messages = [
      makeMessage(sameNameRequest),
      makeMessage(sameNameRequest),
    ];
    const queue: AssetQueue = {
      backend: 'noop',
      async enqueue() {},
      async dequeue() {
        return messages.shift() ?? null;
      },
      async peek() {
        return [];
      },
    };

    const controller = new AbortController();
    const statuses: WorkerStatus[] = [];
    const worker = runWorker({
      queue,
      store: makeStore(),
      repoRoot,
      provider: stubProvider,
      concurrency: 2,
      pollIntervalMs: 0,
      signal: controller.signal,
      onStatus: (s) => {
        statuses.push(s);
        if (statuses.filter((e) => e.type === 'done').length === 2) controller.abort();
      },
    });

    // Wait for the first generation to start; the second slot must be blocked
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    // Only one may run at a time for the same name
    expect(maxConcurrent).toBe(1);

    releases[0]!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(maxConcurrent).toBe(1);

    releases[1]!();
    await worker;
    expect(maxConcurrent).toBe(1);
  });

  it('allows two concurrent slots with different canonical brief names', async () => {
    const releases: Array<() => void> = [];
    let maxConcurrent = 0;
    let active = 0;
    mockGenerate.mockImplementation(
      () =>
        new Promise<never>((resolve) => {
          active += 1;
          maxConcurrent = Math.max(maxConcurrent, active);
          releases.push(() => {
            active -= 1;
            resolve(fakeSummaryResult as never);
          });
        }),
    );

    const messages = [
      makeMessage(makeRequest('first-name')),
      makeMessage(makeRequest('second-name')),
    ];
    const queue: AssetQueue = {
      backend: 'noop',
      async enqueue() {},
      async dequeue() {
        return messages.shift() ?? null;
      },
      async peek() {
        return [];
      },
    };

    const controller = new AbortController();
    const statuses: WorkerStatus[] = [];
    const worker = runWorker({
      queue,
      store: makeStore(),
      repoRoot,
      provider: stubProvider,
      concurrency: 2,
      pollIntervalMs: 0,
      signal: controller.signal,
      onStatus: (s) => {
        statuses.push(s);
        if (statuses.filter((e) => e.type === 'done').length === 2) controller.abort();
      },
    });

    // Both slots should start concurrently since names differ
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(maxConcurrent).toBe(2);

    releases[0]!();
    releases[1]!();
    await worker;
  });
});
