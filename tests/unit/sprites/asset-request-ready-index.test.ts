import { describe, expect, it } from 'vitest';
import {
  addAssetRequestReadyKey,
  AssetRequestReadyIndexError,
  completeAssetRequestReadyIndexBackfill,
  readAssetRequestReadyIndex,
} from '../../../scripts/sprites/asset-request-ready-index.js';
import { ASSET_REQUEST_READY_INDEX_KEY } from '../../../scripts/sprites/sidecar/issue-status-key.js';
import {
  StoreConditionalWriteError,
  StoreNotFoundError,
  type ConditionalWriteConditions,
  type RunStore,
} from '../../../scripts/sprites/store/types.js';

class AtomicStore implements RunStore {
  readonly backend = 'azure-blob' as const;
  readonly conditionalWrites = 'atomic' as const;
  conditionalPuts = 0;
  private readonly values = new Map<string, { data: Buffer; etag: string }>();
  private nextEtag = 1;

  seed(key: string, data: Buffer): void {
    this.values.set(key, { data: Buffer.from(data), etag: `etag-${this.nextEtag++}` });
  }

  async put(key: string, data: Buffer): Promise<void> {
    this.seed(key, data);
  }

  async get(key: string): Promise<Buffer> {
    const value = this.values.get(key);
    if (!value) throw new StoreNotFoundError(key);
    return Buffer.from(value.data);
  }

  async getWithETag(key: string): Promise<{ data: Buffer; etag: string }> {
    const value = this.values.get(key);
    if (!value) throw new StoreNotFoundError(key);
    return { data: Buffer.from(value.data), etag: value.etag };
  }

  async putConditional(
    key: string,
    data: Buffer,
    conditions: ConditionalWriteConditions,
  ): Promise<void> {
    this.conditionalPuts++;
    const current = this.values.get(key);
    if (conditions.ifNoneMatch === '*' && current !== undefined) {
      throw new StoreConditionalWriteError(key);
    }
    if (conditions.ifMatch !== undefined && current?.etag !== conditions.ifMatch) {
      throw new StoreConditionalWriteError(key);
    }
    this.seed(key, data);
  }

  async has(key: string): Promise<boolean> {
    return this.values.has(key);
  }

  async list(prefix: string): Promise<readonly string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }

  resolve(key: string): string {
    return key;
  }
}

describe('asset-request ready index', () => {
  it('CAS-merges concurrent ready additions without losing either checkpoint', async () => {
    const store = new AtomicStore();

    await Promise.all([
      addAssetRequestReadyKey(store, 'workflow-state/asset-request-jobs/2-b.json'),
      addAssetRequestReadyKey(store, 'workflow-state/asset-request-jobs/1-a.json'),
    ]);

    await expect(readAssetRequestReadyIndex(store)).resolves.toEqual({
      status: 'valid',
      index: {
        version: 1,
        legacyBackfillComplete: false,
        keys: [
          'workflow-state/asset-request-jobs/1-a.json',
          'workflow-state/asset-request-jobs/2-b.json',
        ],
      },
    });
    expect(store.conditionalPuts).toBeGreaterThanOrEqual(3);
  });

  it('repairs malformed or unknown-version index bytes from authoritative backfill', async () => {
    const store = new AtomicStore();
    store.seed(ASSET_REQUEST_READY_INDEX_KEY, Buffer.from('{"version":999,"keys":[]}'));

    await completeAssetRequestReadyIndexBackfill(store, [
      'workflow-state/asset-request-jobs/42-ready.json',
    ]);

    await expect(readAssetRequestReadyIndex(store)).resolves.toEqual({
      status: 'valid',
      index: {
        version: 1,
        legacyBackfillComplete: true,
        keys: ['workflow-state/asset-request-jobs/42-ready.json'],
      },
    });
  });

  it('refuses to maintain an Azure index without server-enforced atomic CAS', async () => {
    const store: RunStore = {
      backend: 'azure-blob',
      conditionalWrites: 'unsupported',
      async put() {},
      async get(key) {
        throw new StoreNotFoundError(key);
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

    await expect(addAssetRequestReadyKey(store, 'checkpoint.json')).rejects.toBeInstanceOf(
      AssetRequestReadyIndexError,
    );
  });
});
