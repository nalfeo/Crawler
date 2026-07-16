/**
 * Unit tests for AssetQueue implementations and factory.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoopAssetQueue } from '../../../scripts/sprites/queue/noop-queue.js';
import { createAssetQueue } from '../../../scripts/sprites/queue/index.js';
import { AzureStorageQueue } from '../../../scripts/sprites/queue/azure-queue.js';
import {
  InvalidAssetRequestMessageError,
  normalizeAssetRequest,
  type BriefPathAssetRequest,
} from '../../../scripts/sprites/queue/types.js';

// ---------------------------------------------------------------------------
// Mock the Azure Storage Queue SDK so the visibility-timeout tests can assert
// the value the queue passes to receiveMessages() with no network access. The
// fake QueueClient.receiveMessages records its args and returns an empty batch,
// so dequeue() resolves to null while the spy captures { visibilityTimeout }.
// ---------------------------------------------------------------------------
const azureSdkMock = vi.hoisted(() => {
  const receiveMessages = vi.fn(async () => ({ receivedMessageItems: [] as unknown[] }));
  const deleteMessage = vi.fn(async () => undefined);
  const getQueueClient = vi.fn(() => ({ receiveMessages, deleteMessage }));
  const fromConnectionString = vi.fn(() => ({ getQueueClient }));
  return { receiveMessages, deleteMessage, getQueueClient, fromConnectionString };
});

vi.mock('@azure/storage-queue', () => {
  class QueueServiceClient {
    getQueueClient = azureSdkMock.getQueueClient;
    static fromConnectionString = azureSdkMock.fromConnectionString;
  }
  return { QueueServiceClient, StorageSharedKeyCredential: vi.fn() };
});

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

  it('accepts valid floors and rejects invalid floor payloads', () => {
    const request = {
      kind: 'issue-request',
      issueNumber: 42,
      name: 'bone-dagger',
      briefSentence: 'A chipped bone dagger with twine-wrapped handle.',
      fingerprint: 'abc',
      claimedAt: '2026-06-10T00:00:00.000Z',
      requestedBy: 'test',
      requestedAt: '2026-06-10T00:00:00.000Z',
      priority: 'normal',
    };

    expect(normalizeAssetRequest({ ...request, floor: 12 })).toMatchObject({ floor: 12 });
    expect(normalizeAssetRequest({ ...request, floor: 0 })).toBeNull();
    expect(normalizeAssetRequest({ ...request, floor: '12' })).toBeNull();
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
    // Only IssueAssetRequest carries `type`; narrow before asserting it was dropped.
    if (result?.kind === 'issue-request') {
      expect(result.type).toBeUndefined();
    }
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

  it('round-trips an explicit size variant through queue JSON persistence', () => {
    const persisted = JSON.stringify({
      kind: 'issue-request',
      issueNumber: 42,
      name: 'beetlefolk-boss',
      briefSentence: 'A broad low beetlefolk crime boss.',
      sizeVariant: 'wide',
      fingerprint: 'abc',
      claimedAt: '2026-06-10T00:00:00.000Z',
      requestedBy: 'test',
      requestedAt: '2026-06-10T00:00:00.000Z',
      priority: 'normal',
    });
    expect(normalizeAssetRequest(JSON.parse(persisted))).toMatchObject({
      kind: 'issue-request',
      sizeVariant: 'wide',
    });
  });

  it('keeps legacy issue queue entries without size readable', () => {
    const result = normalizeAssetRequest({
      kind: 'issue-request',
      issueNumber: 42,
      name: 'batfolk-boss',
      briefSentence: 'An aristocratic batfolk crime boss.',
      fingerprint: 'legacy',
      claimedAt: '2026-06-10T00:00:00.000Z',
      requestedBy: 'test',
      requestedAt: '2026-06-10T00:00:00.000Z',
      priority: 'normal',
    });
    expect(result).toMatchObject({ kind: 'issue-request', fingerprint: 'legacy' });
    if (result?.kind === 'issue-request') expect(result.sizeVariant).toBeUndefined();
  });

  it('throws a clear validation error for an invalid persisted size', () => {
    expect(() =>
      normalizeAssetRequest({
        kind: 'issue-request',
        issueNumber: 42,
        name: 'batfolk-boss',
        briefSentence: 'An aristocratic batfolk crime boss.',
        sizeVariant: 'huge',
        fingerprint: 'abc',
        claimedAt: '2026-06-10T00:00:00.000Z',
        requestedBy: 'test',
        requestedAt: '2026-06-10T00:00:00.000Z',
        priority: 'normal',
      }),
    ).toThrowError(InvalidAssetRequestMessageError);
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

describe('AzureStorageQueue visibility timeout', () => {
  const azureEnv = {
    SPRITES_ASSET_QUEUE: 'azure-queue',
    AZURE_STORAGE_ACCOUNT: 'myaccount',
    AZURE_STORAGE_KEY: 'dGVzdA==',
  } as const;

  beforeEach(() => {
    azureSdkMock.receiveMessages.mockClear();
  });

  it('defaults to a 900s visibility timeout when none is configured', async () => {
    const q = createAssetQueue({ env: { ...azureEnv } });
    await q.dequeue();
    expect(azureSdkMock.receiveMessages).toHaveBeenCalledWith(
      expect.objectContaining({ visibilityTimeout: 900 }),
    );
  });

  it('honors an explicit visibilityTimeout option over the default', async () => {
    const q = AzureStorageQueue.fromOptions({
      accountName: 'myaccount',
      accountKey: 'dGVzdA==',
      visibilityTimeout: 120,
    });
    await q.dequeue();
    expect(azureSdkMock.receiveMessages).toHaveBeenCalledWith(
      expect.objectContaining({ visibilityTimeout: 120 }),
    );
  });

  it('lets AZURE_STORAGE_QUEUE_VISIBILITY_TIMEOUT override the default (account/key path)', async () => {
    const q = createAssetQueue({
      env: { ...azureEnv, AZURE_STORAGE_QUEUE_VISIBILITY_TIMEOUT: '600' },
    });
    await q.dequeue();
    expect(azureSdkMock.receiveMessages).toHaveBeenCalledWith(
      expect.objectContaining({ visibilityTimeout: 600 }),
    );
  });

  it('applies the 900s default on the connection-string path', async () => {
    const q = createAssetQueue({
      env: {
        SPRITES_ASSET_QUEUE: 'azure-queue',
        AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
      },
    });
    await q.dequeue();
    expect(azureSdkMock.receiveMessages).toHaveBeenCalledWith(
      expect.objectContaining({ visibilityTimeout: 900 }),
    );
  });

  it('lets AZURE_STORAGE_QUEUE_VISIBILITY_TIMEOUT override the default (connection-string path)', async () => {
    const q = createAssetQueue({
      env: {
        SPRITES_ASSET_QUEUE: 'azure-queue',
        AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
        AZURE_STORAGE_QUEUE_VISIBILITY_TIMEOUT: '450',
      },
    });
    await q.dequeue();
    expect(azureSdkMock.receiveMessages).toHaveBeenCalledWith(
      expect.objectContaining({ visibilityTimeout: 450 }),
    );
  });
});

describe('AzureStorageQueue dequeue — invalid-size message handling', () => {
  const invalidSizeMessage = JSON.stringify({
    kind: 'issue-request',
    issueNumber: 42,
    name: 'batfolk-boss',
    briefSentence: 'An aristocratic batfolk crime boss.',
    sizeVariant: 'huge',
    fingerprint: 'abc',
    claimedAt: '2026-06-10T00:00:00.000Z',
    requestedBy: 'test',
    requestedAt: '2026-06-10T00:00:00.000Z',
    priority: 'normal',
  });

  beforeEach(() => {
    azureSdkMock.receiveMessages.mockClear();
    azureSdkMock.deleteMessage.mockClear();
  });

  it('writes a diagnostic to stderr, deletes the message, and returns null for InvalidAssetRequestMessageError', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    azureSdkMock.receiveMessages.mockResolvedValueOnce({
      receivedMessageItems: [
        {
          messageId: 'msg-1',
          popReceipt: 'pop-1',
          messageText: invalidSizeMessage,
          dequeueCount: 1,
        },
      ],
    });

    const q = AzureStorageQueue.fromOptions({
      accountName: 'myaccount',
      accountKey: 'dGVzdA==',
    });
    const result = await q.dequeue();

    expect(result).toBeNull();
    expect(azureSdkMock.deleteMessage).toHaveBeenCalledWith('msg-1', 'pop-1');
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('invalid-size'));
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('huge'));
    stderrWrite.mockRestore();
  });

  it('throws a combined error when deleteMessage also fails after InvalidAssetRequestMessageError', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    azureSdkMock.receiveMessages.mockResolvedValueOnce({
      receivedMessageItems: [
        {
          messageId: 'msg-2',
          popReceipt: 'pop-2',
          messageText: invalidSizeMessage,
          dequeueCount: 1,
        },
      ],
    });
    azureSdkMock.deleteMessage.mockRejectedValueOnce(new Error('queue unavailable'));

    const q = AzureStorageQueue.fromOptions({
      accountName: 'myaccount',
      accountKey: 'dGVzdA==',
    });

    await expect(q.dequeue()).rejects.toThrow(/queue unavailable/);
    stderrWrite.mockRestore();
  });

  it('returns null and deletes the message for malformed JSON (preserves existing behavior)', async () => {
    azureSdkMock.receiveMessages.mockResolvedValueOnce({
      receivedMessageItems: [
        {
          messageId: 'msg-3',
          popReceipt: 'pop-3',
          messageText: '{not valid json',
          dequeueCount: 1,
        },
      ],
    });

    const q = AzureStorageQueue.fromOptions({
      accountName: 'myaccount',
      accountKey: 'dGVzdA==',
    });
    const result = await q.dequeue();

    expect(result).toBeNull();
    expect(azureSdkMock.deleteMessage).toHaveBeenCalledWith('msg-3', 'pop-3');
  });

  it('skips consecutive invalid-size messages and returns the following valid request', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const validMessageText = JSON.stringify(makeRequest({ briefId: 'iron-sword' }));
    azureSdkMock.receiveMessages
      .mockResolvedValueOnce({
        receivedMessageItems: [
          {
            messageId: 'p-1',
            popReceipt: 'pr-1',
            messageText: invalidSizeMessage,
            dequeueCount: 1,
          },
        ],
      })
      .mockResolvedValueOnce({
        receivedMessageItems: [
          {
            messageId: 'p-2',
            popReceipt: 'pr-2',
            messageText: invalidSizeMessage,
            dequeueCount: 1,
          },
        ],
      })
      .mockResolvedValueOnce({
        receivedMessageItems: [
          {
            messageId: 'p-3',
            popReceipt: 'pr-3',
            messageText: invalidSizeMessage,
            dequeueCount: 1,
          },
        ],
      })
      .mockResolvedValueOnce({
        receivedMessageItems: [
          {
            messageId: 'valid-1',
            popReceipt: 'vpr-1',
            messageText: validMessageText,
            dequeueCount: 1,
          },
        ],
      });

    const q = AzureStorageQueue.fromOptions({ accountName: 'myaccount', accountKey: 'dGVzdA==' });
    const result = await q.dequeue();

    expect(result).not.toBeNull();
    expect(result?.request).toMatchObject({ briefId: 'iron-sword' });
    expect(azureSdkMock.deleteMessage).toHaveBeenCalledTimes(3);
    expect(azureSdkMock.deleteMessage).toHaveBeenCalledWith('p-1', 'pr-1');
    expect(azureSdkMock.deleteMessage).toHaveBeenCalledWith('p-2', 'pr-2');
    expect(azureSdkMock.deleteMessage).toHaveBeenCalledWith('p-3', 'pr-3');
    expect(azureSdkMock.receiveMessages).toHaveBeenCalledTimes(4);
    stderrWrite.mockRestore();
  });

  it('returns null (empty queue) after draining all consecutive invalid-size messages', async () => {
    azureSdkMock.receiveMessages
      .mockResolvedValueOnce({
        receivedMessageItems: [
          {
            messageId: 'p-a',
            popReceipt: 'pr-a',
            messageText: invalidSizeMessage,
            dequeueCount: 1,
          },
        ],
      })
      .mockResolvedValueOnce({
        receivedMessageItems: [
          {
            messageId: 'p-b',
            popReceipt: 'pr-b',
            messageText: invalidSizeMessage,
            dequeueCount: 1,
          },
        ],
      });
    const q = AzureStorageQueue.fromOptions({ accountName: 'myaccount', accountKey: 'dGVzdA==' });
    const result = await q.dequeue();

    expect(result).toBeNull();
    expect(azureSdkMock.deleteMessage).toHaveBeenCalledTimes(2);
    expect(azureSdkMock.receiveMessages).toHaveBeenCalledTimes(3);
  });
});
