/**
 * RunStore factory.
 *
 * Reads `SPRITES_RUN_STORE` from the environment and returns the appropriate
 * RunStore implementation. Defaults to `'local'` so all existing workflows
 * continue unchanged.
 *
 * Environment variables
 * ---------------------
 * | Variable                        | Required for Azure | Description                                                       |
 * |---------------------------------|--------------------|-------------------------------------------------------------------|
 * | SPRITES_RUN_STORE               | —                  | `'local'` (default) or `'azure-blob'`                             |
 * | AZURE_STORAGE_ACCOUNT           | yes                | Storage account name                                              |
 * | AZURE_STORAGE_KEY               | yes                | Storage account access key                                        |
 * | AZURE_STORAGE_RUNS_CONTAINER    | no                 | Blob container name (default: `generated-runs`)                   |
 * | CRAWLER_AZURE_CACHE             | no                 | `on` (default) / `off` — shared persistent resource cache         |
 * | CRAWLER_AZURE_CACHE_DIR         | no                 | Override for the shared cache base dir (outside any worktree)     |
 * | CRAWLER_AZURE_CACHE_MAX_BYTES   | no                 | Unique-content LRU cap in bytes (default: 5 GiB; `0` = unbounded) |
 * | CRAWLER_AZURE_OFFLINE           | no                 | `on`/`1` — serve reads from cache only, never contact Azure       |
 *
 * Legacy aliases `SPRITES_AZURE_CACHE`, `SPRITES_AZURE_CACHE_DIR`,
 * `SPRITES_AZURE_CACHE_MAX_BYTES`, and `SPRITES_AZURE_OFFLINE` remain honoured.
 *
 * Alternatively, set `AZURE_STORAGE_CONNECTION_STRING` to use a full
 * connection string instead of the separate account/key variables.
 */

import path from 'node:path';
import { AzureBlobRunStore } from './azure-store.js';
import { CachingRunStore } from './caching-store.js';
import { LocalRunStore } from './local-store.js';
import {
  createSharedResourceCache,
  isAzureCacheEnabled,
  isAzureOffline,
  resolveCacheBaseDir,
  resolveMaxCacheBytes,
} from './shared-cache.js';
import type { RunStore } from './types.js';

export type { RunStore, StoreNotFoundError } from './types.js';

export interface CreateRunStoreOptions {
  /**
   * Process env source. Defaults to `process.env`.
   * Inject an explicit map in tests to avoid polluting the real environment.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Absolute path to the repository root. Used by the local impl to
   * resolve `<repoRoot>/generated/runs`. Ignored for Azure.
   */
  readonly repoRoot: string;
}

/**
 * Construct a RunStore from environment configuration.
 *
 * Returns a `LocalRunStore` by default. Pass `SPRITES_RUN_STORE=azure-blob`
 * (with the required Azure credentials) to use Azure Blob Storage instead.
 */
export function createRunStore(options: CreateRunStoreOptions): RunStore {
  const env = options.env ?? process.env;
  const which = (env['SPRITES_RUN_STORE'] ?? 'local').toLowerCase();

  if (which === 'local') {
    const runsDir = path.join(options.repoRoot, 'generated', 'runs');
    return new LocalRunStore(runsDir);
  }

  if (which === 'azure-blob') {
    // Connection string takes priority over separate account/key vars.
    const connStr = env['AZURE_STORAGE_CONNECTION_STRING'];
    const containerName = env['AZURE_STORAGE_RUNS_CONTAINER'];
    const inner = connStr
      ? AzureBlobRunStore.fromConnectionString(connStr, containerName)
      : AzureBlobRunStore.fromOptions({
          accountName: required(env, 'AZURE_STORAGE_ACCOUNT'),
          accountKey: required(env, 'AZURE_STORAGE_KEY'),
          containerName,
        });
    if (!isAzureCacheEnabled(env)) {
      // CRAWLER_AZURE_OFFLINE=1 requires the cache wrapper — the cache is the
      // only read source when Azure is forced unavailable. Returning the raw
      // Azure store with offline mode set would silently allow (and then fail)
      // real Azure reads, contradicting the documented "never contact Azure"
      // guarantee. Reject the contradictory combination loudly.
      if (isAzureOffline(env)) {
        throw new Error(
          'CRAWLER_AZURE_OFFLINE=1 (or SPRITES_AZURE_OFFLINE) requires the shared cache to be ' +
            'enabled. Unset CRAWLER_AZURE_CACHE=off (or SPRITES_AZURE_CACHE=off) or disable ' +
            'offline mode.',
        );
      }
      return inner;
    }
    // Wrap Azure in the shared, cross-session content-addressable cache so a
    // devtools reload (in ANY worktree) paints without re-downloading blobs and
    // a warmed worktree can serve exact bytes/listings while offline. The cache
    // is namespaced by the store's NON-SECRET identity so Azurite/dev/prod and
    // distinct accounts never share content.
    const cache = createSharedResourceCache({
      identity: inner.identity,
      baseDir: resolveCacheBaseDir(env),
      maxBytes: resolveMaxCacheBytes(env),
    });
    return new CachingRunStore({ inner, cache, offline: isAzureOffline(env) });
  }

  throw new Error(
    `Unknown SPRITES_RUN_STORE '${which}'. Supported values: local, azure-blob. ` +
      `See infra/README.md for Azure setup instructions.`,
  );
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const v = env[name];
  if (!v) {
    throw new Error(
      `Missing required env var '${name}' for SPRITES_RUN_STORE=azure-blob. ` +
        `See infra/README.md for the expected variables.`,
    );
  }
  return v;
}
