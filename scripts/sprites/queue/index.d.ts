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
 * | SPRITES_ASSET_QUEUE               | —                 | `'noop'` (default) or `'azure-queue'`                    |
 * | AZURE_STORAGE_ACCOUNT             | yes               | Storage account name                                     |
 * | AZURE_STORAGE_KEY                 | yes               | Storage account access key                               |
 * | AZURE_STORAGE_QUEUE_NAME          | no                | Queue name (default: `asset-requests`)                   |
 * | AZURE_STORAGE_QUEUE_VISIBILITY_TIMEOUT | no           | Visibility timeout in seconds (default: 300)             |
 *
 * Alternatively, set `AZURE_STORAGE_CONNECTION_STRING` to use a full
 * connection string instead of the separate account/key variables.
 */
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
export declare function createAssetQueue(options?: CreateAssetQueueOptions): AssetQueue;
//# sourceMappingURL=index.d.ts.map
