/**
 * Unit tests for AssetQueue implementations and factory.
 */

import { describe, expect, it, vi } from 'vitest';
import { NoopAssetQueue } from '../../../scripts/sprites/queue/noop-queue.js';
import { createAssetQueue } from '../../../scripts/sprites/queue/index.js';
import {
  normalizeAssetRequest,
  type BriefPathAssetRequest,
} from '../../../scripts/sprites/queue/types.js';

function makeRequest(overrides: Partial<BriefPathAssetRequest> = {}): BriefPathAssetRequest {
  return {
    kind: 'brief-path',
    briefId: 'iron-sword',
    briefPath: 'briefs/weapons/iron-sword.yaml',
    requestedBy: 'test',
    requestedAt: '2026-06-10T00:00:00.000Z',
    priority: 'normal',
    ...overrides,
  };
}

describe('NoopAssetQueue', () => {
  it('reports noop backend', () => {
    const q = new NoopAssetQueue();
    expect(q.backend).toBe('noop');
  });

  it('enqueue resolves without throwing', async () => {
    const q = new NoopAssetQueue();
    await expect(q.enqueue(makeRequest())).resolves.toBeUndefined();
  });

  it('dequeue always returns null (empty)', async () => {
    const q = new NoopAssetQueue();
    const msg = await q.dequeue();
    expect(msg).toBeNull();
  });

  it('peek always returns empty array', async () => {
    const q = new NoopAssetQueue();
    const items = await q.peek(5);
    expect(items).toEqual([]);
  });

  it('enqueue writes to stdout', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const q = new NoopAssetQueue();
    await q.enqueue(makeRequest({ briefId: 'skull-mace' }));
    expect(write).toHaveBeenCalledWith(expect.stringContaining('skull-mace'));
    write.mockRestore();
  });
});

describe('normalizeAssetRequest', () => {
  it('accepts legacy brief-path payloads without explicit kind', () => {
    expect(
      normalizeAssetRequest({
        briefId: 'iron-sword',
        briefPath: 'briefs/weapons/iron-sword.yaml',
        requestedBy: 'test',
        requestedAt: '2026-06-10T00:00:00.000Z',
        priority: 'normal',
      }),
    ).toMatchObject({ kind: 'brief-path', briefId: 'iron-sword' });
  });

  it('accepts issue-request payloads with idempotency fields', () => {
    expect(
      normalizeAssetRequest({
        kind: 'issue-request',
        issueNumber: 42,
        name: 'bone-dagger',
        briefSentence: 'A chipped bone dagger with twine-wrapped handle.',
        fingerprint: 'abc',
        claimedAt: '2026-06-10T00:00:00.000Z',
        requestedBy: 'test',
        requestedAt: '2026-06-10T00:00:00.000Z',
        priority: 'normal',
      }),
    ).toMatchObject({ kind: 'issue-request', issueNumber: 42 });
  });

  it('accepts issue-request with valid type field', () => {
    const result = normalizeAssetRequest({
      kind: 'issue-request',
      issueNumber: 42,
      name: 'bone-dagger',
      briefSentence: 'A chipped bone dagger with twine-wrapped handle.',
      fingerprint: 'abc',
      claimedAt: '2026-06-10T00:00:00.000Z',
      requestedBy: 'test',
      requestedAt: '2026-06-10T00:00:00.000Z',
      priority: 'normal',
      type: 'weapon',
    });
    expect(result).toMatchObject({ kind: 'issue-request', type: 'weapon' });
  });

  it('silently omits invalid type field', () => {
    const result = normalizeAssetRequest({
      kind: 'issue-request',
      issueNumber: 42,
      name: 'bone-dagger',
      briefSentence: 'A chipped bone dagger with twine-wrapped handle.',
      fingerprint: 'abc',
      claimedAt: '2026-06-10T00:00:00.000Z',
      requestedBy: 'test',
      requestedAt: '2026-06-10T00:00:00.000Z',
      priority: 'normal',
      type: 'invalid-type',
    });
    // Invalid type is silently omitted; request still proceeds without type field
    expect(result).toMatchObject({ kind: 'issue-request', issueNumber: 42 });
    expect(result?.type).toBeUndefined();
  });

  it('normalizes type to lowercase when valid', () => {
    const result = normalizeAssetRequest({
      kind: 'issue-request',
      issueNumber: 42,
      name: 'bone-dagger',
      briefSentence: 'A chipped bone dagger with twine-wrapped handle.',
      fingerprint: 'abc',
      claimedAt: '2026-06-10T00:00:00.000Z',
      requestedBy: 'test',
      requestedAt: '2026-06-10T00:00:00.000Z',
      priority: 'normal',
      type: 'WEAPON',
    });
    expect(result).toMatchObject({ type: 'weapon' });
  });
});

describe('createAssetQueue factory', () => {
  it('returns NoopAssetQueue by default', () => {
    const q = createAssetQueue({ env: {} });
    expect(q.backend).toBe('noop');
  });

  it('returns NoopAssetQueue when SPRITES_ASSET_QUEUE=noop', () => {
    const q = createAssetQueue({ env: { SPRITES_ASSET_QUEUE: 'noop' } });
    expect(q.backend).toBe('noop');
  });

  it('throws on unknown backend value', () => {
    expect(() => createAssetQueue({ env: { SPRITES_ASSET_QUEUE: 'kafka' } })).toThrow(
      "Unknown SPRITES_ASSET_QUEUE 'kafka'",
    );
  });

  it('throws on missing AZURE_STORAGE_ACCOUNT when azure-queue requested', () => {
    expect(() =>
      createAssetQueue({
        env: { SPRITES_ASSET_QUEUE: 'azure-queue' },
      }),
    ).toThrow("Missing required env var 'AZURE_STORAGE_ACCOUNT'");
  });

  it('throws on missing AZURE_STORAGE_KEY when azure-queue requested', () => {
    expect(() =>
      createAssetQueue({
        env: {
          SPRITES_ASSET_QUEUE: 'azure-queue',
          AZURE_STORAGE_ACCOUNT: 'myaccount',
        },
      }),
    ).toThrow("Missing required env var 'AZURE_STORAGE_KEY'");
  });

  it('constructs AzureStorageQueue when all required vars present', () => {
    const q = createAssetQueue({
      env: {
        SPRITES_ASSET_QUEUE: 'azure-queue',
        AZURE_STORAGE_ACCOUNT: 'myaccount',
        AZURE_STORAGE_KEY: 'dGVzdA==',
      },
    });
    expect(q.backend).toBe('azure-queue');
  });
});
