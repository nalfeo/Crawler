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
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { StoreNotFoundError } from './types.js';
export class AzureBlobRunStore {
  container;
  accountName;
  containerName;
  backend = 'azure-blob';
  constructor(container, accountName, containerName) {
    this.container = container;
    this.accountName = accountName;
    this.containerName = containerName;
  }
  /** Construct from explicit account name + key. */
  static fromOptions(options) {
    const containerName = options.containerName ?? 'generated-runs';
    const cred = new StorageSharedKeyCredential(options.accountName, options.accountKey);
    const service = new BlobServiceClient(
      `https://${options.accountName}.blob.core.windows.net`,
      cred,
    );
    return new AzureBlobRunStore(
      service.getContainerClient(containerName),
      options.accountName,
      containerName,
    );
  }
  /**
   * Construct from a full connection string. Supports Azurite
   * (`UseDevelopmentStorage=true`) and standard Azure connection strings.
   */
  static fromConnectionString(connectionString, containerName) {
    const service = BlobServiceClient.fromConnectionString(connectionString);
    const name = containerName ?? 'generated-runs';
    // 'devstoreaccount1' is the well-known Azurite account name used when
    // AccountName is absent from the connection string (UseDevelopmentStorage=true).
    const accountName = extractFromConnStr(connectionString, 'AccountName') ?? 'devstoreaccount1';
    return new AzureBlobRunStore(service.getContainerClient(name), accountName, name);
  }
  async put(key, data) {
    const blobClient = this.container.getBlockBlobClient(key);
    await blobClient.uploadData(data, {
      blobHTTPHeaders: { blobContentType: contentTypeFor(key) },
    });
  }
  async get(key) {
    const blobClient = this.container.getBlobClient(key);
    try {
      const download = await blobClient.download();
      const chunks = [];
      for await (const chunk of download.readableStreamBody ?? []) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (err) {
      if (isNotFound(err)) throw new StoreNotFoundError(key);
      throw err;
    }
  }
  async has(key) {
    const blobClient = this.container.getBlobClient(key);
    return blobClient.exists();
  }
  async list(prefix) {
    const keys = [];
    for await (const item of this.container.listBlobsFlat({ prefix })) {
      keys.push(item.name);
    }
    return keys;
  }
  async remove(key) {
    const blobClient = this.container.getBlobClient(key);
    await blobClient.deleteIfExists();
  }
  resolve(key) {
    return `https://${this.accountName}.blob.core.windows.net/${this.containerName}/${key}`;
  }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function contentTypeFor(key) {
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}
function isNotFound(err) {
  if (err == null || typeof err !== 'object') return false;
  const status = err.statusCode;
  return status === 404;
}
function extractFromConnStr(connStr, field) {
  const match = new RegExp(`(?:^|;)${field}=([^;]+)`).exec(connStr);
  return match?.[1];
}
//# sourceMappingURL=azure-store.js.map
