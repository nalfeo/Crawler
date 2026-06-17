/**
 * AzureStorageQueue — Azure Storage Queue-backed AssetQueue.
 *
 * Sends and receives `AssetRequest` messages as JSON in a single Azure
 * Storage Queue. Azure Storage Queue guarantees at-least-once delivery:
 * a message becomes invisible to other consumers for `visibilityTimeout`
 * seconds after `dequeue`, and is re-queued automatically if `ack()` is
 * never called (e.g. the worker crashes mid-generation).
 *
 * Message encoding
 * ----------------
 * Azure Storage Queue messages are base64-encoded strings. We serialize the
 * `AssetRequest` as JSON and let the SDK handle the base64 wrapping.
 *
 * Queue name
 * ----------
 * Defaults to `asset-requests`. Override via `AZURE_STORAGE_QUEUE_NAME`
 * (or the constructor option). Queue names are lowercase alphanumeric with
 * hyphens (Azure enforces this).
 *
 * Visibility timeout
 * ------------------
 * Defaults to 300 seconds (5 minutes) — enough time for a typical single-
 * brief generation run. Override via the `visibilityTimeout` constructor
 * option or `AZURE_STORAGE_QUEUE_VISIBILITY_TIMEOUT` env var.
 */
import type { AssetQueue, AssetRequest, DequeuedMessage } from './types.js';
export interface AzureStorageQueueOptions {
  readonly accountName: string;
  readonly accountKey: string;
  /** Queue name. Defaults to `'asset-requests'`. */
  readonly queueName?: string;
  /**
   * Seconds a dequeued message stays invisible while processing.
   * Defaults to 300 (5 minutes).
   */
  readonly visibilityTimeout?: number;
}
export declare class AzureStorageQueue implements AssetQueue {
  private readonly client;
  private readonly visibilityTimeout;
  readonly backend: 'azure-queue';
  private constructor();
  /** Construct from explicit account name + key. */
  static fromOptions(options: AzureStorageQueueOptions): AzureStorageQueue;
  /**
   * Construct from a full connection string. Supports Azurite
   * (`UseDevelopmentStorage=true`) and standard Azure connection strings.
   */
  static fromConnectionString(connectionString: string, queueName?: string): AzureStorageQueue;
  enqueue(request: AssetRequest): Promise<void>;
  dequeue(): Promise<DequeuedMessage | null>;
  peek(maxCount?: number): Promise<readonly AssetRequest[]>;
}
//# sourceMappingURL=azure-queue.d.ts.map
