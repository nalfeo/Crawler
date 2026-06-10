/**
 * RunStore factory.
 *
 * Reads `SPRITES_RUN_STORE` from the environment and returns the appropriate
 * RunStore implementation. Defaults to `'local'` so all existing workflows
 * continue unchanged.
 *
 * Environment variables
 * ---------------------
 * | Variable                 | Required for Azure | Description                                      |
 * |--------------------------|-------------------|--------------------------------------------------|
 * | SPRITES_RUN_STORE        | —                 | `'local'` (default) or `'azure-blob'`            |
 * | AZURE_STORAGE_ACCOUNT    | yes               | Storage account name                             |
 * | AZURE_STORAGE_KEY        | yes               | Storage account access key                       |
 * | AZURE_STORAGE_RUNS_CONTAINER | no            | Blob container name (default: `generated-runs`)  |
 *
 * Alternatively, set `AZURE_STORAGE_CONNECTION_STRING` to use a full
 * connection string instead of the separate account/key variables.
 */

import path from 'node:path';
import { AzureBlobRunStore } from './azure-store.js';
import { LocalRunStore } from './local-store.js';
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
    if (connStr) {
      return AzureBlobRunStore.fromConnectionString(connStr, containerName);
    }
    const accountName = required(env, 'AZURE_STORAGE_ACCOUNT');
    const accountKey = required(env, 'AZURE_STORAGE_KEY');
    return AzureBlobRunStore.fromOptions({ accountName, accountKey, containerName });
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
