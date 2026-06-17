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
export declare function createRunStore(options: CreateRunStoreOptions): RunStore;
//# sourceMappingURL=index.d.ts.map
