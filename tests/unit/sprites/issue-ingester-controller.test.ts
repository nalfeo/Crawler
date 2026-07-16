import { describe, expect, it, vi } from 'vitest';
import { normalizeAssetRequest, type AssetRequest } from '../../../scripts/sprites/queue/types.js';
import type { RunStore } from '../../../scripts/sprites/store/types.js';
import {
  ISSUE_STATUS_KEY_PREFIX,
  createIssueIngesterController,
} from '../../../scripts/sprites/sidecar/issue-ingester-controller.js';
import {
  ASSET_REQUEST_MARKER,
  fingerprintAssetRequest,
} from '../../../scripts/sprites/asset-request.js';
import type { OpenAssetRequestIssue } from '../../../scripts/sprites/sidecar/asset-request-issue-api.js';

function memStore(): RunStore {
  const mem = new Map<string, Buffer>();
  return {
    backend: 'local',
    put: async (key, data) => void mem.set(key, data),
    get: async (key) => mem.get(key) ?? Buffer.alloc(0),
    has: async (key) => mem.has(key),
    list: async (prefix) => [...mem.keys()].filter((k) => k.startsWith(prefix)),
    remove: async (key) => void mem.delete(key),
    resolve: (key) => key,
  };
}

/**
 * Build a minimal `AssetRequestIssueApi`-shaped mock with sensible defaults so
 * each test only spells out the fields it actually cares about. `getIssue`
 * defaults to `null` (i.e. "target issue not found / nothing to prepend"),
 * `comment` is a no-op unless overridden.
 */
function issuesMock(
  overrides: {
    list?: () => Promise<readonly OpenAssetRequestIssue[]>;
    get?: (n: number) => Promise<OpenAssetRequestIssue | null>;
    comment?: (n: number, body: string) => Promise<void>;
  } = {},
) {
  return {
    listOpenAssetRequestIssues: overrides.list ?? (async () => []),
    getIssue: overrides.get ?? (async () => null),
    comment: overrides.comment ?? (async () => {}),
  };
}

async function seedIngestState(
  store: RunStore,
  state: {
    readonly claims?: Record<
      string,
      {
        readonly issueNumber: number;
        readonly fingerprint: string;
        readonly claimedAt: string;
        readonly name: string;
        readonly briefSentence: string;
        readonly sizeVariant?: 'default' | 'wide' | 'tall' | 'large';
      }
    >;
    readonly rejected?: Record<
      string,
      {
        readonly issueNumber: number;
        readonly fingerprint: string;
        readonly rejectedAt: string;
        readonly reason: string | null;
        readonly name: string;
        readonly briefSentence: string;
        readonly sizeVariant?: 'default' | 'wide' | 'tall' | 'large';
      }
    >;
  },
): Promise<void> {
  await store.put(
    'workflow-state/asset-request-ingest.json',
    Buffer.from(`${JSON.stringify({ version: 2, claims: {}, rejected: {}, ...state }, null, 2)}\n`),
  );
}

describe('issue ingester controller', () => {
  it('enqueues issue-request jobs once per issue+fingerprint', async () => {
    const enqueued: AssetRequest[] = [];
    const queue = {
      backend: 'azure-queue' as const,
      enqueue: async (request: AssetRequest) => void enqueued.push(request),
      dequeue: async () => null,
      peek: async () => [],
    };
    const body = `<!-- ${ASSET_REQUEST_MARKER}\n{"version":1,"name":"bone-dagger","briefSentence":"A chipped bone dagger with twine-wrapped handle."}\n-->`;
    const issues = issuesMock({ list: async () => [{ number: 42, body }] });
    const controller = createIssueIngesterController({
      queue,
      store: memStore(),
      issues,
      requestedBy: 'test',
      pollIntervalMs: 5,
      now: () => new Date('2026-06-28T00:00:00.000Z'),
    });
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await controller.stop();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ kind: 'issue-request', issueNumber: 42 });
  });

  it('persists effective size in the queue message and claim state across controller reloads', async () => {
    const enqueued: AssetRequest[] = [];
    const queue = {
      backend: 'azure-queue' as const,
      enqueue: async (request: AssetRequest) => void enqueued.push(request),
      dequeue: async () => null,
      peek: async () => [],
    };
    const store = memStore();
    const body = `<!-- ${ASSET_REQUEST_MARKER}
{"version":1,"name":"cactusfolk-boss","briefSentence":"A towering saguaro crime boss.","type":"enemy","sizeVariant":"tall"}
-->`;
    const issues = issuesMock({ list: async () => [{ number: 43, body }] });
    const options = {
      queue,
      store,
      issues,
      requestedBy: 'test',
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    };

    expect((await createIssueIngesterController(options).pollOnce()).enqueued).toBe(1);
    expect(enqueued[0]).toMatchObject({ kind: 'issue-request', sizeVariant: 'tall' });
    expect(normalizeAssetRequest(JSON.parse(JSON.stringify(enqueued[0])))).toMatchObject({
      sizeVariant: 'tall',
    });

    const reloaded = createIssueIngesterController(options);
    const status = await reloaded.pollOnce();
    expect(status.enqueued).toBe(0);
    expect(status.skippedDuplicate).toBe(1);
    expect((await reloaded.listRequests('claimed'))[0]).toMatchObject({ sizeVariant: 'tall' });
  });

  it('treats a matching legacy claim as already claimed after the type-aware fingerprint upgrade', async () => {
    const queue = {
      backend: 'azure-queue' as const,
      enqueue: async () => {
        throw new Error('should not enqueue duplicate legacy claim');
      },
      dequeue: async () => null,
      peek: async () => [],
    };
    const store = memStore();
    const brief = 'An aristocratic batfolk crime boss with folded cloak-like wings.';
    const legacyFingerprint = fingerprintAssetRequest('countess-vesper', brief);
    await seedIngestState(store, {
      claims: {
        [`50:${legacyFingerprint}`]: {
          issueNumber: 50,
          fingerprint: legacyFingerprint,
          claimedAt: '2026-07-16T00:00:00.000Z',
          name: 'countess-vesper',
          briefSentence: brief,
          sizeVariant: 'large',
        },
      },
    });
    const body = `<!-- ${ASSET_REQUEST_MARKER}
{"version":1,"name":"countess-vesper","briefSentence":"${brief}","type":"enemy"}
-->`;
    const controller = createIssueIngesterController({
      queue,
      store,
      issues: issuesMock({ list: async () => [{ number: 50, body }] }),
      requestedBy: 'test',
      now: () => new Date('2026-07-16T01:00:00.000Z'),
    });

    const status = await controller.pollOnce();
    expect(status.enqueued).toBe(0);
    expect(status.skippedDuplicate).toBe(1);
    expect((await controller.listRequests('claimed'))[0]).toMatchObject({
      issueNumber: 50,
      sizeVariant: 'large',
    });
    expect((await controller.listRequests('claimed'))[0]?.fingerprint).not.toBe(legacyFingerprint);
  });

  it('re-enqueues when a legacy claim no longer matches the request semantics', async () => {
    const enqueued: AssetRequest[] = [];
    const queue = {
      backend: 'azure-queue' as const,
      enqueue: async (request: AssetRequest) => void enqueued.push(request),
      dequeue: async () => null,
      peek: async () => [],
    };
    const store = memStore();
    const brief = 'An aristocratic batfolk crime boss with folded cloak-like wings.';
    const legacyFingerprint = fingerprintAssetRequest('countess-vesper', brief);
    await seedIngestState(store, {
      claims: {
        [`51:${legacyFingerprint}`]: {
          issueNumber: 51,
          fingerprint: legacyFingerprint,
          claimedAt: '2026-07-16T00:00:00.000Z',
          name: 'countess-vesper',
          briefSentence: brief,
        },
      },
    });
    const body = `<!-- ${ASSET_REQUEST_MARKER}
{"version":1,"name":"countess-vesper","briefSentence":"${brief}","type":"enemy"}
-->`;
    const controller = createIssueIngesterController({
      queue,
      store,
      issues: issuesMock({ list: async () => [{ number: 51, body }] }),
      requestedBy: 'test',
      now: () => new Date('2026-07-16T01:00:00.000Z'),
    });

    const status = await controller.pollOnce();
    expect(status.enqueued).toBe(1);
    expect(status.skippedDuplicate).toBe(0);
    expect(enqueued[0]).toMatchObject({
      kind: 'issue-request',
      issueNumber: 51,
      sizeVariant: 'large',
    });
    expect((enqueued[0] as { fingerprint: string }).fingerprint).not.toBe(legacyFingerprint);
  });

  it('supports permanent reject markers and exposes filtered manifest views', async () => {
    const enqueued: AssetRequest[] = [];
    const queue = {
      backend: 'azure-queue' as const,
      enqueue: async (request: AssetRequest) => void enqueued.push(request),
      dequeue: async () => null,
      peek: async () => [],
    };
    const body = `<!-- ${ASSET_REQUEST_MARKER}\n{"version":1,"name":"bone-dagger","briefSentence":"A chipped bone dagger with twine-wrapped handle."}\n-->`;
    const issues = issuesMock({ list: async () => [{ number: 77, body }] });
    const controller = createIssueIngesterController({
      queue,
      store: memStore(),
      issues,
      requestedBy: 'test',
      pollIntervalMs: 5,
      now: () => new Date('2026-06-29T00:00:00.000Z'),
    });
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await controller.stop();

    const claimed = await controller.listRequests('claimed');
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.issueNumber).toBe(77);
    expect(claimed[0]?.state).toBe('claimed');

    const rejected = await controller.rejectRequest({
      issueNumber: 77,
      fingerprint: claimed[0]!.fingerprint,
      reason: 'not in current scope',
    });
    expect(rejected?.state).toBe('rejected');

    const rejectedRows = await controller.listRequests('rejected');
    expect(rejectedRows).toHaveLength(1);
    expect(rejectedRows[0]?.rejectionReason).toBe('not in current scope');
  });

  it('pollOnce awaits ingest completion (enqueue + state save) before resolving', async () => {
    const enqueued: AssetRequest[] = [];
    let resolveList: ((v: readonly { number: number; body: string }[]) => void) | null = null;
    const listPromise = new Promise<readonly { number: number; body: string }[]>((resolve) => {
      resolveList = resolve;
    });
    const queue = {
      backend: 'azure-queue' as const,
      enqueue: async (request: AssetRequest) => void enqueued.push(request),
      dequeue: async () => null,
      peek: async () => [],
    };
    const body = `<!-- ${ASSET_REQUEST_MARKER}\n{"version":1,"name":"iron-shield","briefSentence":"An iron shield with rivets and a leather grip."}\n-->`;
    const issues = issuesMock({ list: () => listPromise });
    const controller = createIssueIngesterController({
      queue,
      store: memStore(),
      issues,
      requestedBy: 'test',
      pollIntervalMs: 24 * 60 * 60 * 1000,
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    });
    const pollPromise = controller.pollOnce();
    // The list resolves AFTER we've observed pollOnce is not yet done.
    // If pollOnce returned early (before enqueue), `enqueued` would still be empty
    // and we'd race the eventual enqueue.
    expect(enqueued).toHaveLength(0);
    resolveList!([{ number: 101, body }]);
    const status = await pollPromise;
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ kind: 'issue-request', issueNumber: 101 });
    expect(status.enqueued).toBe(1);
    expect(status.lastError).toBeNull();
  });

  it('pollOnce surfaces errors via lastError without throwing', async () => {
    const queue = {
      backend: 'azure-queue' as const,
      enqueue: async () => {},
      dequeue: async () => null,
      peek: async () => [],
    };
    const issues = issuesMock({
      list: async () => {
        throw new Error('boom');
      },
    });
    const controller = createIssueIngesterController({
      queue,
      store: memStore(),
      issues,
      requestedBy: 'test',
    });
    const status = await controller.pollOnce();
    expect(status.lastError).toBe('boom');
  });

  describe('targetIssueNumber (search-index-lag bypass)', () => {
    const bodyFor = (name: string): string =>
      `<!-- ${ASSET_REQUEST_MARKER}\n{"version":1,"name":"${name}","briefSentence":"A brief for ${name}."}\n-->`;

    it('prepends a REST-fetched target issue to the sweep list', async () => {
      const enqueued: AssetRequest[] = [];
      const queue = {
        backend: 'azure-queue' as const,
        enqueue: async (r: AssetRequest) => void enqueued.push(r),
        dequeue: async () => null,
        peek: async () => [],
      };
      // Sweep returns an older issue only — the newly-labeled one hasn't
      // propagated to the search index yet. `getIssue` returns the fresh one.
      const list = vi.fn(async () => [{ number: 100, body: bodyFor('bone-dagger') }]);
      const get = vi.fn(async (n: number) =>
        n === 999 ? { number: 999, body: bodyFor('angry-roomba') } : null,
      );
      const issues = issuesMock({ list, get });

      const controller = createIssueIngesterController({
        queue,
        store: memStore(),
        issues,
        requestedBy: 'test',
        targetIssueNumber: 999,
        pollIntervalMs: 24 * 60 * 60 * 1000,
        now: () => new Date('2026-07-03T00:00:00.000Z'),
      });
      const status = await controller.pollOnce();
      expect(status.enqueued).toBe(2);
      expect(enqueued.map((r) => (r.kind === 'issue-request' ? r.issueNumber : -1)).sort()).toEqual(
        [100, 999],
      );
      expect(get).toHaveBeenCalledTimes(1);
    });

    it('does not double-fetch when the sweep already returned the target', async () => {
      const enqueued: AssetRequest[] = [];
      const queue = {
        backend: 'azure-queue' as const,
        enqueue: async (r: AssetRequest) => void enqueued.push(r),
        dequeue: async () => null,
        peek: async () => [],
      };
      const list = vi.fn(async () => [{ number: 999, body: bodyFor('angry-roomba') }]);
      const get = vi.fn(async () => null);
      const issues = issuesMock({ list, get });

      const controller = createIssueIngesterController({
        queue,
        store: memStore(),
        issues,
        requestedBy: 'test',
        targetIssueNumber: 999,
        pollIntervalMs: 24 * 60 * 60 * 1000,
        now: () => new Date('2026-07-03T00:00:00.000Z'),
      });
      const status = await controller.pollOnce();
      expect(status.enqueued).toBe(1);
      expect(enqueued).toHaveLength(1);
      expect(get).not.toHaveBeenCalled();
    });

    it('degrades to sweep-only when getIssue returns null (issue not found / not labeled)', async () => {
      const enqueued: AssetRequest[] = [];
      const queue = {
        backend: 'azure-queue' as const,
        enqueue: async (r: AssetRequest) => void enqueued.push(r),
        dequeue: async () => null,
        peek: async () => [],
      };
      const list = vi.fn(async () => [{ number: 100, body: bodyFor('bone-dagger') }]);
      const get = vi.fn(async () => null);
      const issues = issuesMock({ list, get });

      const controller = createIssueIngesterController({
        queue,
        store: memStore(),
        issues,
        requestedBy: 'test',
        targetIssueNumber: 999,
        pollIntervalMs: 24 * 60 * 60 * 1000,
        now: () => new Date('2026-07-03T00:00:00.000Z'),
      });
      const status = await controller.pollOnce();
      expect(status.enqueued).toBe(1);
      expect(enqueued).toHaveLength(1);
    });
  });

  describe('postEnqueueComment', () => {
    const body = `<!-- ${ASSET_REQUEST_MARKER}\n{"version":1,"name":"angry-roomba","briefSentence":"A grumpy roomba mob."}\n-->`;

    it('posts the comment body on newly-enqueued issues after state save', async () => {
      const enqueued: AssetRequest[] = [];
      const queue = {
        backend: 'azure-queue' as const,
        enqueue: async (r: AssetRequest) => void enqueued.push(r),
        dequeue: async () => null,
        peek: async () => [],
      };
      const commentCalls: Array<{ n: number; body: string }> = [];
      const issues = issuesMock({
        list: async () => [{ number: 42, body }],
        comment: async (n, b) => void commentCalls.push({ n, body: b }),
      });

      const controller = createIssueIngesterController({
        queue,
        store: memStore(),
        issues,
        requestedBy: 'test',
        pollIntervalMs: 24 * 60 * 60 * 1000,
        now: () => new Date('2026-07-03T00:00:00.000Z'),
        postEnqueueComment: (context) =>
          `Run: https://x/${context.issueNumber} · ${context.reclaimed ? 're-queued' : 'queued'}`,
      });
      const status = await controller.pollOnce();
      expect(status.enqueued).toBe(1);
      expect(status.enqueueCommentsPosted).toBe(1);
      expect(commentCalls).toEqual([{ n: 42, body: 'Run: https://x/42 · queued' }]);
    });

    it('skips the comment when the callback returns null or an empty string', async () => {
      const enqueued: AssetRequest[] = [];
      const queue = {
        backend: 'azure-queue' as const,
        enqueue: async (r: AssetRequest) => void enqueued.push(r),
        dequeue: async () => null,
        peek: async () => [],
      };
      const commentCalls: Array<{ n: number; body: string }> = [];
      const issues = issuesMock({
        list: async () => [{ number: 42, body }],
        comment: async (n, b) => void commentCalls.push({ n, body: b }),
      });

      const controller = createIssueIngesterController({
        queue,
        store: memStore(),
        issues,
        requestedBy: 'test',
        pollIntervalMs: 24 * 60 * 60 * 1000,
        now: () => new Date('2026-07-03T00:00:00.000Z'),
        postEnqueueComment: () => null,
      });
      const status = await controller.pollOnce();
      expect(status.enqueued).toBe(1);
      expect(status.enqueueCommentsPosted).toBe(0);
      expect(commentCalls).toHaveLength(0);
    });

    it('records a comment failure in enqueueCommentErrors WITHOUT failing the step (lastError stays null)', async () => {
      const enqueued: AssetRequest[] = [];
      const queue = {
        backend: 'azure-queue' as const,
        enqueue: async (r: AssetRequest) => void enqueued.push(r),
        dequeue: async () => null,
        peek: async () => [],
      };
      const issues = issuesMock({
        list: async () => [{ number: 42, body }],
        comment: async () => {
          throw new Error('gh 403');
        },
      });

      const controller = createIssueIngesterController({
        queue,
        store: memStore(),
        issues,
        requestedBy: 'test',
        pollIntervalMs: 24 * 60 * 60 * 1000,
        now: () => new Date('2026-07-03T00:00:00.000Z'),
        postEnqueueComment: () => 'hello',
      });
      const status = await controller.pollOnce();
      expect(status.enqueued).toBe(1);
      expect(enqueued).toHaveLength(1);
      expect(status.enqueueCommentsPosted).toBe(0);
      // A best-effort notification failure must NOT be fatal: it stays off
      // `lastError` (which drives exitCodeForStatus → the ingest step exit code
      // → whether the drain worker runs) and is surfaced on the dedicated
      // enqueueCommentErrors / lastEnqueueCommentError diagnostics instead.
      expect(status.lastError).toBeNull();
      expect(status.enqueueCommentErrors).toBe(1);
      expect(status.lastEnqueueCommentError).toContain('enqueue-comment failed');
    });
  });

  describe('staleClaimTtlMs (automatic recovery)', () => {
    const body = `<!-- ${ASSET_REQUEST_MARKER}\n{"version":1,"name":"angry-roomba","briefSentence":"A grumpy roomba mob."}\n-->`;

    it('re-enqueues an issue when the claim is older than TTL and no status doc exists', async () => {
      const enqueued: AssetRequest[] = [];
      const queue = {
        backend: 'azure-queue' as const,
        enqueue: async (r: AssetRequest) => void enqueued.push(r),
        dequeue: async () => null,
        peek: async () => [],
      };
      const store = memStore();
      const issues = issuesMock({ list: async () => [{ number: 42, body }] });

      // First poll at t0 — enqueues.
      const t0 = new Date('2026-07-03T00:00:00.000Z');
      const controllerA = createIssueIngesterController({
        queue,
        store,
        issues,
        requestedBy: 'test',
        pollIntervalMs: 24 * 60 * 60 * 1000,
        now: () => t0,
      });
      const statusA = await controllerA.pollOnce();
      expect(statusA.enqueued).toBe(1);

      // Second poll 1h later — TTL is 45min, no status doc, should reclaim.
      const tLater = new Date('2026-07-03T01:00:00.000Z');
      const controllerB = createIssueIngesterController({
        queue,
        store,
        issues,
        requestedBy: 'test',
        pollIntervalMs: 24 * 60 * 60 * 1000,
        staleClaimTtlMs: 45 * 60 * 1000,
        issueStatusPrefix: ISSUE_STATUS_KEY_PREFIX,
        now: () => tLater,
      });
      const statusB = await controllerB.pollOnce();
      expect(statusB.enqueued).toBe(1);
      expect(statusB.reclaimedStale).toBe(1);
      expect(enqueued).toHaveLength(2);
    });

    it('skips reclaim when a completed status doc exists', async () => {
      const enqueued: AssetRequest[] = [];
      const queue = {
        backend: 'azure-queue' as const,
        enqueue: async (r: AssetRequest) => void enqueued.push(r),
        dequeue: async () => null,
        peek: async () => [],
      };
      const store = memStore();
      const issues = issuesMock({ list: async () => [{ number: 42, body }] });

      // Prime the claim.
      const t0 = new Date('2026-07-03T00:00:00.000Z');
      const controllerA = createIssueIngesterController({
        queue,
        store,
        issues,
        requestedBy: 'test',
        pollIntervalMs: 24 * 60 * 60 * 1000,
        now: () => t0,
      });
      await controllerA.pollOnce();
      expect(enqueued).toHaveLength(1);
      const fingerprint = (enqueued[0] as { fingerprint: string }).fingerprint;

      // Simulate the worker having written a completed status doc.
      await store.put(
        `${ISSUE_STATUS_KEY_PREFIX}/42-${fingerprint}.json`,
        Buffer.from(JSON.stringify({ stage: 'completed', updatedAt: '2026-07-03T00:15:00.000Z' })),
      );

      // Second poll: TTL passed, but completion doc protects against reclaim.
      const tLater = new Date('2026-07-03T01:00:00.000Z');
      const controllerB = createIssueIngesterController({
        queue,
        store,
        issues,
        requestedBy: 'test',
        pollIntervalMs: 24 * 60 * 60 * 1000,
        staleClaimTtlMs: 45 * 60 * 1000,
        issueStatusPrefix: ISSUE_STATUS_KEY_PREFIX,
        now: () => tLater,
      });
      const statusB = await controllerB.pollOnce();
      expect(statusB.enqueued).toBe(0);
      expect(statusB.reclaimedStale).toBe(0);
      expect(statusB.skippedDuplicate).toBe(1);
      expect(enqueued).toHaveLength(1);
    });

    it('skips reclaim when the status doc heartbeat is fresh (worker actively running)', async () => {
      const enqueued: AssetRequest[] = [];
      const queue = {
        backend: 'azure-queue' as const,
        enqueue: async (r: AssetRequest) => void enqueued.push(r),
        dequeue: async () => null,
        peek: async () => [],
      };
      const store = memStore();
      const issues = issuesMock({ list: async () => [{ number: 42, body }] });

      const t0 = new Date('2026-07-03T00:00:00.000Z');
      const controllerA = createIssueIngesterController({
        queue,
        store,
        issues,
        requestedBy: 'test',
        pollIntervalMs: 24 * 60 * 60 * 1000,
        now: () => t0,
      });
      await controllerA.pollOnce();
      const fingerprint = (enqueued[0] as { fingerprint: string }).fingerprint;

      // Worker heartbeat was recent (5 min ago) — do not reclaim.
      const tLater = new Date('2026-07-03T01:00:00.000Z');
      await store.put(
        `${ISSUE_STATUS_KEY_PREFIX}/42-${fingerprint}.json`,
        Buffer.from(
          JSON.stringify({ stage: 'running-pipeline', updatedAt: '2026-07-03T00:55:00.000Z' }),
        ),
      );

      const controllerB = createIssueIngesterController({
        queue,
        store,
        issues,
        requestedBy: 'test',
        pollIntervalMs: 24 * 60 * 60 * 1000,
        staleClaimTtlMs: 45 * 60 * 1000,
        issueStatusPrefix: ISSUE_STATUS_KEY_PREFIX,
        now: () => tLater,
      });
      const statusB = await controllerB.pollOnce();
      expect(statusB.enqueued).toBe(0);
      expect(statusB.reclaimedStale).toBe(0);
      expect(enqueued).toHaveLength(1);
    });

    it('reclaims when the status doc heartbeat is itself stale (worker crashed mid-run)', async () => {
      const enqueued: AssetRequest[] = [];
      const queue = {
        backend: 'azure-queue' as const,
        enqueue: async (r: AssetRequest) => void enqueued.push(r),
        dequeue: async () => null,
        peek: async () => [],
      };
      const store = memStore();
      const issues = issuesMock({ list: async () => [{ number: 42, body }] });

      const t0 = new Date('2026-07-03T00:00:00.000Z');
      const controllerA = createIssueIngesterController({
        queue,
        store,
        issues,
        requestedBy: 'test',
        pollIntervalMs: 24 * 60 * 60 * 1000,
        now: () => t0,
      });
      await controllerA.pollOnce();
      const fingerprint = (enqueued[0] as { fingerprint: string }).fingerprint;

      // Status doc exists but hasn't been updated in 40 min (> TTL/2 = 22.5).
      await store.put(
        `${ISSUE_STATUS_KEY_PREFIX}/42-${fingerprint}.json`,
        Buffer.from(
          JSON.stringify({ stage: 'running-pipeline', updatedAt: '2026-07-03T00:20:00.000Z' }),
        ),
      );

      const tLater = new Date('2026-07-03T01:00:00.000Z');
      const controllerB = createIssueIngesterController({
        queue,
        store,
        issues,
        requestedBy: 'test',
        pollIntervalMs: 24 * 60 * 60 * 1000,
        staleClaimTtlMs: 45 * 60 * 1000,
        issueStatusPrefix: ISSUE_STATUS_KEY_PREFIX,
        now: () => tLater,
      });
      const statusB = await controllerB.pollOnce();
      expect(statusB.enqueued).toBe(1);
      expect(statusB.reclaimedStale).toBe(1);
      expect(enqueued).toHaveLength(2);
    });

    it('preserves strict dedup semantics when staleClaimTtlMs is unset', async () => {
      const enqueued: AssetRequest[] = [];
      const queue = {
        backend: 'azure-queue' as const,
        enqueue: async (r: AssetRequest) => void enqueued.push(r),
        dequeue: async () => null,
        peek: async () => [],
      };
      const store = memStore();
      const issues = issuesMock({ list: async () => [{ number: 42, body }] });

      const t0 = new Date('2026-07-03T00:00:00.000Z');
      const controllerA = createIssueIngesterController({
        queue,
        store,
        issues,
        requestedBy: 'test',
        pollIntervalMs: 24 * 60 * 60 * 1000,
        now: () => t0,
      });
      await controllerA.pollOnce();

      // Hours later, no TTL, no reclaim, no status doc — still dedup.
      const tMuchLater = new Date('2026-07-04T00:00:00.000Z');
      const controllerB = createIssueIngesterController({
        queue,
        store,
        issues,
        requestedBy: 'test',
        pollIntervalMs: 24 * 60 * 60 * 1000,
        now: () => tMuchLater,
      });
      const statusB = await controllerB.pollOnce();
      expect(statusB.enqueued).toBe(0);
      expect(statusB.reclaimedStale).toBe(0);
      expect(statusB.skippedDuplicate).toBe(1);
      expect(enqueued).toHaveLength(1);
    });
  });

  describe('per-issue state durability (mid-poll enqueue failure)', () => {
    const bodyFor = (name: string, brief: string) =>
      `<!-- ${ASSET_REQUEST_MARKER}\n${JSON.stringify({ version: 1, name, briefSentence: brief })}\n-->`;
    const issueNums = (rs: readonly AssetRequest[]): number[] =>
      rs.map((r) => ('issueNumber' in r ? r.issueNumber : -1));

    it('persists an earlier claim when a later enqueue fails, so it is not re-enqueued next poll', async () => {
      const enqueued: AssetRequest[] = [];
      let failIssue200 = true;
      const queue = {
        backend: 'azure-queue' as const,
        enqueue: async (r: AssetRequest) => {
          if (failIssue200 && 'issueNumber' in r && r.issueNumber === 200) {
            throw new Error('azure queue 503');
          }
          enqueued.push(r);
        },
        dequeue: async () => null,
        peek: async () => [],
      };
      const issues = issuesMock({
        list: async () => [
          { number: 100, body: bodyFor('bone-dagger', 'A chipped bone dagger.') },
          { number: 200, body: bodyFor('angry-roomba', 'A grumpy roomba mob.') },
        ],
      });
      const store = memStore();
      const controller = createIssueIngesterController({
        queue,
        store,
        issues,
        requestedBy: 'test',
        pollIntervalMs: 24 * 60 * 60 * 1000,
        now: () => new Date('2026-07-03T00:00:00.000Z'),
      });

      // First poll: 100 enqueues + claims (persisted immediately), then 200's
      // enqueue throws. The throw surfaces on lastError, but 100's claim must
      // already be committed to the store.
      const first = await controller.pollOnce();
      expect(first.lastError).toContain('azure queue 503');
      expect(issueNums(enqueued)).toEqual([100]);
      const claimedAfterFirst = await controller.listRequests('claimed');
      expect(claimedAfterFirst).toHaveLength(1);
      expect(claimedAfterFirst[0]?.issueNumber).toBe(100);

      // Second poll with the queue healthy: 100 must be recognized as already
      // claimed (skippedDuplicate) and NOT re-enqueued. A batched save would
      // have lost 100's claim when 200 threw, re-enqueuing 100 here (→ a
      // duplicate queue message and duplicate sprite generation).
      failIssue200 = false;
      const second = await controller.pollOnce();
      expect(second.skippedDuplicate).toBeGreaterThanOrEqual(1);
      expect(issueNums(enqueued).sort((a, b) => a - b)).toEqual([100, 200]);
    });
  });
});
