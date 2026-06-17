/**
 * AzureBlobRunStore — Azure Blob Storage-backed RunStore.
 *
 * Stores run artifacts as blobs in an Azure Storage container. Keys map
 * directly to blob names, so `briefId/runId/sheet-00.png` becomes a blob
 * named exactly that inside the configured container.
 *
 * Authentication
 * --------------
 * Use `AzureBlobRunStore.fromOptions()` with account name + key, or
 * `AzureBlobRunStore.fromConnectionString()` for a full connection string
 * (supports Azurite via `UseDevelopmentStorage=true`).
 *
 * Container lifecycle
 * -------------------
 * The factory does NOT create the container — that is a one-time
 * infrastructure step handled by `infra/azure-storage.bicep`. If the
 * container is missing, operations throw Azure SDK errors with a clear HTTP
 * 404 status. The `infra/README.md` documents the `az` commands to provision
 * the container before first use.
 */
import { type RunStore } from './types.js';
export interface AzureBlobRunStoreOptions {
  /** Azure Storage account name. */
  readonly accountName: string;
  /** Storage account access key. */
  readonly accountKey: string;
  /** Blob container name. Defaults to `'generated-runs'`. */
  readonly containerName?: string;
}
export declare class AzureBlobRunStore implements RunStore {
  private readonly container;
  private readonly accountName;
  private readonly containerName;
  readonly backend: 'azure-blob';
  private constructor();
  /** Construct from explicit account name + key. */
  static fromOptions(options: AzureBlobRunStoreOptions): AzureBlobRunStore;
  /**
   * Construct from a full connection string. Supports Azurite
   * (`UseDevelopmentStorage=true`) and standard Azure connection strings.
   */
  static fromConnectionString(connectionString: string, containerName?: string): AzureBlobRunStore;
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  has(key: string): Promise<boolean>;
  list(prefix: string): Promise<readonly string[]>;
  remove(key: string): Promise<void>;
  resolve(key: string): string;
}
//# sourceMappingURL=azure-store.d.ts.map
