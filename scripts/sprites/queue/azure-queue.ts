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
 * Defaults to 900 seconds (15 minutes). Generating one 16-cell sprite sheet via
 * gpt-image-1 was measured live at ~4 minutes typically and up to ~6 minutes for
 * slower briefs, so 900s leaves robust margin for a run to finish and `ack()`
 * before the message resurfaces. (The prior 300s / 5-minute default was
 * marginal: a slow brief ran past it, the pop receipt went stale mid-run, the
 * delete-on-ack failed with "The specified message does not exist", and the
 * brief was needlessly regenerated.) Override via the `visibilityTimeout`
 * constructor option or `AZURE_STORAGE_QUEUE_VISIBILITY_TIMEOUT` env var.
 */

import { QueueServiceClient, StorageSharedKeyCredential } from '@azure/storage-queue';
import type { QueueClient } from '@azure/storage-queue';
import {
  InvalidAssetRequestMessageError,
  normalizeAssetRequest,
  type AssetQueue,
  type AssetRequest,
  type DequeuedMessage,
} from './types.js';

export interface AzureStorageQueueOptions {
  readonly accountName: string;
  readonly accountKey: string;
  /** Queue name. Defaults to `'asset-requests'`. */
  readonly queueName?: string;
  /**
   * Seconds a dequeued message stays invisible while processing.
   * Defaults to 900 (15 minutes) — see the class-level "Visibility timeout"
   * note for the empirical generation timing behind this value.
   */
  readonly visibilityTimeout?: number;
}

const DEFAULT_QUEUE_NAME = 'asset-requests';
// 15 minutes. A 16-cell gpt-image-1 sheet runs ~4 min typically and up to ~6 min
// for slow briefs; see the "Visibility timeout" note in the class JSDoc for why
// the prior 300s default was too marginal.
const DEFAULT_VISIBILITY_TIMEOUT = 900;

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
   *
   * `visibilityTimeout` is honored here exactly as on {@link fromOptions} so the
   * `AZURE_STORAGE_QUEUE_VISIBILITY_TIMEOUT` override applies to the
   * connection-string path too; it falls back to the shared default when unset.
   */
  static fromConnectionString(
    connectionString: string,
    queueName?: string,
    visibilityTimeout?: number,
  ): AzureStorageQueue {
    const service = QueueServiceClient.fromConnectionString(connectionString);
    const name = queueName ?? DEFAULT_QUEUE_NAME;
    return new AzureStorageQueue(
      service.getQueueClient(name),
      visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT,
    );
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

    let request: AssetRequest | null;
    try {
      request = normalizeAssetRequest(JSON.parse(msg.messageText));
    } catch (error) {
      if (error instanceof InvalidAssetRequestMessageError) {
        process.stderr.write(
          `azure-queue: dropping invalid-size queue message: ${error.message}\n`,
        );
        try {
          await this.client.deleteMessage(msg.messageId, msg.popReceipt);
        } catch (deleteError) {
          throw new Error(
            `azure-queue: failed to delete invalid-size message (${error.message}); ` +
              `delete also failed: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`,
            { cause: deleteError },
          );
        }
        return null;
      }
      // Malformed JSON or other non-validation errors: ack to avoid poison-pill loop.
      await this.client.deleteMessage(msg.messageId, msg.popReceipt);
      return null;
    }
    if (!request) {
      await this.client.deleteMessage(msg.messageId, msg.popReceipt);
      return null;
    }

    return {
      request,
      dequeueCount: msg.dequeueCount ?? 1,
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
        const parsed = normalizeAssetRequest(JSON.parse(msg.messageText));
        if (parsed) results.push(parsed);
      } catch {
        // Skip malformed messages in peek output
      }
    }
    return results;
  }
}
