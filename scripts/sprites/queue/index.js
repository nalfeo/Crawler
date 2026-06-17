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
import { AzureStorageQueue } from './azure-queue.js';
import { NoopAssetQueue } from './noop-queue.js';
/**
 * Construct an AssetQueue from environment configuration.
 *
 * Returns a `NoopAssetQueue` by default. Pass `SPRITES_ASSET_QUEUE=azure-queue`
 * (with the required Azure credentials) to use Azure Storage Queue instead.
 */
export function createAssetQueue(options = {}) {
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
      return AzureStorageQueue.fromConnectionString(connStr, queueName);
    }
    const accountName = required(env, 'AZURE_STORAGE_ACCOUNT');
    const accountKey = required(env, 'AZURE_STORAGE_KEY');
    return AzureStorageQueue.fromOptions({ accountName, accountKey, queueName, visibilityTimeout });
  }
  throw new Error(
    `Unknown SPRITES_ASSET_QUEUE '${which}'. Supported values: noop, azure-queue. ` +
      `See infra/README.md for Azure setup instructions.`,
  );
}
function required(env, name) {
  const v = env[name];
  if (!v) {
    throw new Error(
      `Missing required env var '${name}' for SPRITES_ASSET_QUEUE=azure-queue. ` +
        `See infra/README.md for the expected variables.`,
    );
  }
  return v;
}
//# sourceMappingURL=index.js.map
