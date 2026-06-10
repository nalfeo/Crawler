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

import { QueueServiceClient, StorageSharedKeyCredential } from '@azure/storage-queue';
import type { QueueClient } from '@azure/storage-queue';
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

const DEFAULT_QUEUE_NAME = 'asset-requests';
const DEFAULT_VISIBILITY_TIMEOUT = 300;

export class AzureStorageQueue implements AssetQueue {
  readonly backend = 'azure-queue' as const;

  private constructor(
    private readonly client: QueueClient,
    private readonly visibilityTimeout: number,
  ) {}

  /** Construct from explicit account name + key. */
  static fromOptions(options: AzureStorageQueueOptions): AzureStorageQueue {
    const queueName = options.queueName ?? DEFAULT_QUEUE_NAME;
    const visibilityTimeout = options.visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT;
    const cred = new StorageSharedKeyCredential(options.accountName, options.accountKey);
    const service = new QueueServiceClient(
      `https://${options.accountName}.queue.core.windows.net`,
      cred,
    );
    return new AzureStorageQueue(service.getQueueClient(queueName), visibilityTimeout);
  }

  /**
   * Construct from a full connection string. Supports Azurite
   * (`UseDevelopmentStorage=true`) and standard Azure connection strings.
   */
  static fromConnectionString(connectionString: string, queueName?: string): AzureStorageQueue {
    const service = QueueServiceClient.fromConnectionString(connectionString);
    const name = queueName ?? DEFAULT_QUEUE_NAME;
    return new AzureStorageQueue(service.getQueueClient(name), DEFAULT_VISIBILITY_TIMEOUT);
  }

  async enqueue(request: AssetRequest): Promise<void> {
    const json = JSON.stringify(request);
    await this.client.sendMessage(json);
  }

  async dequeue(): Promise<DequeuedMessage | null> {
    const response = await this.client.receiveMessages({
      numberOfMessages: 1,
      visibilityTimeout: this.visibilityTimeout,
    });
    const msg = response.receivedMessageItems[0];
    if (!msg) return null;

    let request: AssetRequest;
    try {
      request = JSON.parse(msg.messageText) as AssetRequest;
    } catch {
      // Malformed message: ack it to avoid a poison-pill loop
      await this.client.deleteMessage(msg.messageId, msg.popReceipt);
      return null;
    }

    return {
      request,
      ack: async () => {
        await this.client.deleteMessage(msg.messageId, msg.popReceipt);
      },
    };
  }

  async peek(maxCount = 1): Promise<readonly AssetRequest[]> {
    const clamped = Math.min(Math.max(1, maxCount), 32); // Azure max is 32
    const response = await this.client.peekMessages({ numberOfMessages: clamped });
    const results: AssetRequest[] = [];
    for (const msg of response.peekedMessageItems) {
      try {
        results.push(JSON.parse(msg.messageText) as AssetRequest);
      } catch {
        // Skip malformed messages in peek output
      }
    }
    return results;
  }
}
