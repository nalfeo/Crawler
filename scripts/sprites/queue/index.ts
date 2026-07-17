/**
 * AssetQueue factory.
 *
 * Reads `SPRITES_ASSET_QUEUE` from the environment and returns the appropriate
 * AssetQueue implementation. Defaults to `'noop'` so local workflows that
 * don't need a queue continue unchanged.
 *
 * Environment variables
 * ---------------------
 * | Variable                          | Required for Azure | Description                                              |
 * |-----------------------------------|-------------------|----------------------------------------------------------|
 * | SPRITES_ASSET_QUEUE               | —                 | `'noop'` (default), `'azure-queue'`, or `'local-file'`   |
 * | AZURE_STORAGE_ACCOUNT             | azure-queue only  | Storage account name                                     |
 * | AZURE_STORAGE_KEY                 | azure-queue only  | Storage account access key                               |
 * | AZURE_STORAGE_QUEUE_NAME          | no                | Queue name (default: `asset-requests`)                   |
 * | AZURE_STORAGE_QUEUE_VISIBILITY_TIMEOUT | no           | Visibility timeout in seconds (default: 900)             |
 * | SPRITES_ASSET_QUEUE_FILE          | local-file only   | Path to the JSON-array queue file                        |
 *
 * Alternatively, set `AZURE_STORAGE_CONNECTION_STRING` to use a full
 * connection string instead of the separate account/key variables.
 *
 * `local-file` is intended for isolated CI runs (`target_issue > 0`) where
 * both the ingest and drain steps share the same runner filesystem. It avoids
 * any interaction with the shared Azure Storage queue.
 */

import { AzureStorageQueue } from './azure-queue.js';
import { LocalFileQueue } from './local-file-queue.js';
import { NoopAssetQueue } from './noop-queue.js';
import type { AssetQueue } from './types.js';

export type { AssetQueue, AssetRequest, DequeuedMessage } from './types.js';

export interface CreateAssetQueueOptions {
  /**
   * Process env source. Defaults to `process.env`.
   * Inject an explicit map in tests to avoid polluting the real environment.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Construct an AssetQueue from environment configuration.
 *
 * Returns a `NoopAssetQueue` by default. Pass `SPRITES_ASSET_QUEUE=azure-queue`
 * (with the required Azure credentials) to use Azure Storage Queue instead.
 */
export function createAssetQueue(options: CreateAssetQueueOptions = {}): AssetQueue {
  const env = options.env ?? process.env;
  const which = (env['SPRITES_ASSET_QUEUE'] ?? 'noop').toLowerCase();

  if (which === 'noop') {
    return new NoopAssetQueue();
  }

  if (which === 'azure-queue') {
    const connStr = env['AZURE_STORAGE_CONNECTION_STRING'];
    const queueName = env['AZURE_STORAGE_QUEUE_NAME'];
    const rawTimeout = env['AZURE_STORAGE_QUEUE_VISIBILITY_TIMEOUT'];
    const visibilityTimeout = rawTimeout !== undefined ? Number(rawTimeout) : undefined;

    if (connStr) {
      return AzureStorageQueue.fromConnectionString(connStr, queueName, visibilityTimeout);
    }

    const accountName = required(env, 'AZURE_STORAGE_ACCOUNT');
    const accountKey = required(env, 'AZURE_STORAGE_KEY');
    return AzureStorageQueue.fromOptions({ accountName, accountKey, queueName, visibilityTimeout });
  }

  if (which === 'local-file') {
    const filePath = env['SPRITES_ASSET_QUEUE_FILE'];
    if (!filePath) {
      throw new Error(
        `SPRITES_ASSET_QUEUE_FILE must be set when SPRITES_ASSET_QUEUE=local-file. ` +
          `Provide a path to the JSON-array queue file (e.g. files/target-run-queue.json).`,
      );
    }
    return new LocalFileQueue(filePath);
  }

  throw new Error(
    `Unknown SPRITES_ASSET_QUEUE '${which}'. Supported values: noop, azure-queue, local-file. ` +
      `See infra/README.md for Azure setup instructions.`,
  );
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const v = env[name];
  if (!v) {
    throw new Error(
      `Missing required env var '${name}' for SPRITES_ASSET_QUEUE=azure-queue. ` +
        `See infra/README.md for the expected variables.`,
    );
  }
  return v;
}
