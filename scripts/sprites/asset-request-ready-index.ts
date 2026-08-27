import { z } from 'zod';
import {
  ASSET_REQUEST_READY_INDEX_KEY,
  ISSUE_STATUS_KEY_PREFIX,
} from './sidecar/issue-status-key.js';
import { StoreConditionalWriteError, StoreNotFoundError, type RunStore } from './store/types.js';

const READY_INDEX_VERSION = 1;
const MAX_CAS_ATTEMPTS = 8;

export const assetRequestReadyIndexSchema = z
  .object({
    version: z.literal(READY_INDEX_VERSION),
    legacyBackfillComplete: z.boolean(),
    keys: z.array(
      z
        .string()
        .refine(
          (key) => key.startsWith(`${ISSUE_STATUS_KEY_PREFIX}/`) && key.endsWith('.json'),
          `Ready index keys must be JSON checkpoints under ${ISSUE_STATUS_KEY_PREFIX}/`,
        ),
    ),
  })
  .strict();

export type AssetRequestReadyIndex = z.infer<typeof assetRequestReadyIndexSchema>;

export type AssetRequestReadyIndexRead =
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly error: string }
  | { readonly status: 'valid'; readonly index: AssetRequestReadyIndex };

interface IndexSnapshot {
  readonly status: 'missing' | 'invalid' | 'valid';
  readonly index: AssetRequestReadyIndex;
  readonly etag?: string;
}

const EMPTY_INDEX: AssetRequestReadyIndex = {
  version: READY_INDEX_VERSION,
  legacyBackfillComplete: false,
  keys: [],
};

export class AssetRequestReadyIndexError extends Error {
  override readonly name = 'AssetRequestReadyIndexError';
}

export async function readAssetRequestReadyIndex(
  store: RunStore,
): Promise<AssetRequestReadyIndexRead> {
  try {
    return parseIndexBuffer(await store.get(ASSET_REQUEST_READY_INDEX_KEY));
  } catch (error) {
    if (error instanceof StoreNotFoundError) return { status: 'missing' };
    throw error;
  }
}

export async function addAssetRequestReadyKey(
  store: RunStore,
  checkpointKey: string,
): Promise<AssetRequestReadyIndex> {
  return mutateReadyIndex(
    store,
    (current) => ({ ...current, keys: [...current.keys, checkpointKey] }),
    { repairInvalid: true },
  );
}

export async function removeAssetRequestReadyKey(
  store: RunStore,
  checkpointKey: string,
): Promise<AssetRequestReadyIndex> {
  return mutateReadyIndex(
    store,
    (current) => ({
      ...current,
      keys: current.keys.filter((key) => key !== checkpointKey),
    }),
    { repairInvalid: false, skipCreateWhenMissing: true },
  );
}

export async function completeAssetRequestReadyIndexBackfill(
  store: RunStore,
  readyKeys: readonly string[],
): Promise<AssetRequestReadyIndex> {
  return mutateReadyIndex(
    store,
    (current) => ({
      ...current,
      legacyBackfillComplete: true,
      keys: [...current.keys, ...readyKeys],
    }),
    { repairInvalid: true },
  );
}

async function mutateReadyIndex(
  store: RunStore,
  update: (current: AssetRequestReadyIndex) => AssetRequestReadyIndex,
  options: {
    readonly repairInvalid: boolean;
    readonly skipCreateWhenMissing?: boolean;
  },
): Promise<AssetRequestReadyIndex> {
  assertSharedStoreCas(store);

  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
    const snapshot = await readIndexSnapshot(store);
    if (snapshot.status === 'invalid' && !options.repairInvalid) {
      throw new AssetRequestReadyIndexError(
        `Ready index ${ASSET_REQUEST_READY_INDEX_KEY} is invalid; authoritative backfill must repair it`,
      );
    }
    if (snapshot.status === 'missing' && options.skipCreateWhenMissing) {
      return EMPTY_INDEX;
    }

    const next = normalizeIndex(update(snapshot.index));
    if (snapshot.status === 'valid' && indexesEqual(snapshot.index, next)) {
      return snapshot.index;
    }

    try {
      await writeIndexSnapshot(store, next, snapshot.etag);
      return next;
    } catch (error) {
      if (error instanceof StoreConditionalWriteError) {
        if (attempt < MAX_CAS_ATTEMPTS) continue;
        throw new AssetRequestReadyIndexError(
          `Ready index ${ASSET_REQUEST_READY_INDEX_KEY} CAS retries exhausted after ${MAX_CAS_ATTEMPTS} attempts`,
        );
      }
      throw error;
    }
  }

  throw new AssetRequestReadyIndexError(
    `Ready index ${ASSET_REQUEST_READY_INDEX_KEY} CAS retries exhausted`,
  );
}

function assertSharedStoreCas(store: RunStore): void {
  if (
    store.backend === 'azure-blob' &&
    (store.conditionalWrites !== 'atomic' ||
      typeof store.getWithETag !== 'function' ||
      typeof store.putConditional !== 'function')
  ) {
    throw new AssetRequestReadyIndexError(
      `Azure ready index ${ASSET_REQUEST_READY_INDEX_KEY} requires atomic conditional writes`,
    );
  }
}

async function readIndexSnapshot(store: RunStore): Promise<IndexSnapshot> {
  if (typeof store.getWithETag === 'function' && typeof store.putConditional === 'function') {
    try {
      const current = await store.getWithETag(ASSET_REQUEST_READY_INDEX_KEY);
      const parsed = parseIndexBuffer(current.data);
      return {
        status: parsed.status,
        index: parsed.status === 'valid' ? parsed.index : EMPTY_INDEX,
        etag: current.etag,
      };
    } catch (error) {
      if (error instanceof StoreNotFoundError) {
        return { status: 'missing', index: EMPTY_INDEX };
      }
      throw error;
    }
  }

  if (!(await store.has(ASSET_REQUEST_READY_INDEX_KEY))) {
    return { status: 'missing', index: EMPTY_INDEX };
  }
  const parsed = parseIndexBuffer(await store.get(ASSET_REQUEST_READY_INDEX_KEY));
  return {
    status: parsed.status,
    index: parsed.status === 'valid' ? parsed.index : EMPTY_INDEX,
  };
}

async function writeIndexSnapshot(
  store: RunStore,
  index: AssetRequestReadyIndex,
  etag: string | undefined,
): Promise<void> {
  const data = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
  if (typeof store.getWithETag === 'function' && typeof store.putConditional === 'function') {
    await store.putConditional(
      ASSET_REQUEST_READY_INDEX_KEY,
      data,
      etag === undefined ? { ifNoneMatch: '*' } : { ifMatch: etag },
    );
    return;
  }
  await store.put(ASSET_REQUEST_READY_INDEX_KEY, data);
}

function parseIndexBuffer(data: Buffer): AssetRequestReadyIndexRead {
  let raw: unknown;
  try {
    raw = JSON.parse(data.toString('utf8'));
  } catch (error) {
    return {
      status: 'invalid',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const parsed = assetRequestReadyIndexSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'invalid', error: parsed.error.message };
  }
  return { status: 'valid', index: normalizeIndex(parsed.data) };
}

function normalizeIndex(index: AssetRequestReadyIndex): AssetRequestReadyIndex {
  return assetRequestReadyIndexSchema.parse({
    ...index,
    keys: [...new Set(index.keys)].sort(),
  });
}

function indexesEqual(left: AssetRequestReadyIndex, right: AssetRequestReadyIndex): boolean {
  return (
    left.legacyBackfillComplete === right.legacyBackfillComplete &&
    left.keys.length === right.keys.length &&
    left.keys.every((key, index) => key === right.keys[index])
  );
}
