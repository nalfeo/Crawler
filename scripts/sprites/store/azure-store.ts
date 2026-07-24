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

import {
  BlobSASPermissions,
  BlobServiceClient,
  SASProtocol,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';
import type { ContainerClient } from '@azure/storage-blob';
import { StoreNotFoundError, type RunStore } from './types.js';

export interface AzureBlobRunStoreOptions {
  /** Azure Storage account name. */
  readonly accountName: string;
  /** Storage account access key. */
  readonly accountKey: string;
  /** Blob container name. Defaults to `'generated-runs'`. */
  readonly containerName?: string;
}

export class AzureBlobRunStore implements RunStore {
  readonly backend = 'azure-blob' as const;

  /**
   * Non-secret identity used to namespace the shared resource cache. Contains
   * ONLY the blob endpoint host, account name, and container — never the storage
   * key or connection string. Isolates Azurite/dev/prod and distinct accounts.
   */
  readonly identity: {
    readonly host: string;
    readonly account: string;
    readonly container: string;
  };

  private constructor(
    private readonly container: ContainerClient,
    private readonly accountName: string,
    private readonly containerName: string,
    host: string,
    private readonly sharedKeyCredential: StorageSharedKeyCredential | null,
  ) {
    this.identity = { host, account: accountName, container: containerName };
  }

  /** Construct from explicit account name + key. */
  static fromOptions(options: AzureBlobRunStoreOptions): AzureBlobRunStore {
    const containerName = options.containerName ?? 'generated-runs';
    const cred = new StorageSharedKeyCredential(options.accountName, options.accountKey);
    const endpoint = `https://${options.accountName}.blob.core.windows.net`;
    const service = new BlobServiceClient(endpoint, cred);
    return new AzureBlobRunStore(
      service.getContainerClient(containerName),
      options.accountName,
      containerName,
      hostOf(endpoint),
      cred,
    );
  }

  /**
   * Construct from a full connection string. Supports Azurite
   * (`UseDevelopmentStorage=true`) and standard Azure connection strings.
   */
  static fromConnectionString(connectionString: string, containerName?: string): AzureBlobRunStore {
    const service = BlobServiceClient.fromConnectionString(connectionString);
    const name = containerName ?? 'generated-runs';
    // 'devstoreaccount1' is the well-known Azurite account name used when
    // AccountName is absent from the connection string (UseDevelopmentStorage=true).
    const accountName = extractFromConnStr(connectionString, 'AccountName') ?? 'devstoreaccount1';
    const accountKey = extractFromConnStr(connectionString, 'AccountKey');
    const sharedKeyCredential =
      typeof accountKey === 'string' && accountKey.length > 0
        ? new StorageSharedKeyCredential(accountName, accountKey)
        : null;
    return new AzureBlobRunStore(
      service.getContainerClient(name),
      accountName,
      name,
      hostOf(service.url),
      sharedKeyCredential,
    );
  }

  async put(key: string, data: Buffer): Promise<void> {
    const blobClient = this.container.getBlockBlobClient(key);
    await blobClient.uploadData(data, {
      blobHTTPHeaders: { blobContentType: contentTypeFor(key) },
    });
  }

  async get(key: string): Promise<Buffer> {
    const blobClient = this.container.getBlobClient(key);
    try {
      const download = await blobClient.download();
      const chunks: Buffer[] = [];
      for await (const chunk of download.readableStreamBody ?? []) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }
      return Buffer.concat(chunks);
    } catch (err: unknown) {
      if (isNotFound(err)) throw new StoreNotFoundError(key);
      throw err;
    }
  }

  async has(key: string): Promise<boolean> {
    const blobClient = this.container.getBlobClient(key);
    return blobClient.exists();
  }

  async list(prefix: string): Promise<readonly string[]> {
    const keys: string[] = [];
    for await (const item of this.container.listBlobsFlat({ prefix })) {
      keys.push(item.name);
    }
    return keys;
  }

  async remove(key: string): Promise<void> {
    const blobClient = this.container.getBlobClient(key);
    await blobClient.deleteIfExists();
  }

  resolve(key: string): string {
    return `https://${this.accountName}.blob.core.windows.net/${this.containerName}/${key}`;
  }

  resolveForExternalRead(key: string): string {
    if (this.sharedKeyCredential === null) return this.resolve(key);
    const startsOn = new Date(Date.now() - 5 * 60 * 1000);
    const expiresOn = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const sas = generateBlobSASQueryParameters(
      {
        containerName: this.containerName,
        blobName: key,
        permissions: BlobSASPermissions.parse('r'),
        startsOn,
        expiresOn,
        protocol: SASProtocol.HttpsAndHttp,
      },
      this.sharedKeyCredential,
    ).toString();
    return `${this.resolve(key)}?${sas}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contentTypeFor(key: string): string {
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

/** Extract the `host[:port]` from a blob endpoint URL for cache namespacing. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isNotFound(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const status = (err as { statusCode?: unknown }).statusCode;
  return status === 404;
}

function extractFromConnStr(connStr: string, field: string): string | undefined {
  const match = new RegExp(`(?:^|;)${field}=([^;]+)`).exec(connStr);
  return match?.[1];
}
