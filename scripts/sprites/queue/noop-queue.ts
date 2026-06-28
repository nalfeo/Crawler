/**
 * NoopAssetQueue — in-process stub for local development.
 *
 * Enqueued requests are printed to stdout and discarded. Useful when no
 * Azure credentials are available and the developer just wants to verify the
 * enqueue code path without needing a real queue.
 */

import type { AssetQueue, AssetRequest, DequeuedMessage } from './types.js';

export class NoopAssetQueue implements AssetQueue {
  readonly backend = 'noop' as const;

  async enqueue(request: AssetRequest): Promise<void> {
    const label =
      request.kind === 'issue-request'
        ? `issue #${request.issueNumber} (${request.name})`
        : request.briefId;
    process.stdout.write(
      `[noop-queue] enqueue: ${label} (priority=${request.priority}, by=${request.requestedBy})\n`,
    );
  }

  async dequeue(): Promise<DequeuedMessage | null> {
    return null;
  }

  async peek(_maxCount?: number): Promise<readonly AssetRequest[]> {
    return [];
  }
}
