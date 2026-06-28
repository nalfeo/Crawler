import { describe, expect, it } from 'vitest';
import type { AssetRequest } from '../../../scripts/sprites/queue/types.js';
import type { RunStore } from '../../../scripts/sprites/store/types.js';
import { createIssueIngesterController } from '../../../scripts/sprites/sidecar/issue-ingester-controller.js';
import { ASSET_REQUEST_MARKER } from '../../../scripts/sprites/asset-request.js';

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
    const issues = {
      listOpenAssetRequestIssues: async () => [{ number: 42, body }],
      comment: async () => {},
    };
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
});
