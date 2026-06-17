/**
 * NoopAssetQueue — in-process stub for local development.
 *
 * Enqueued requests are printed to stdout and discarded. Useful when no
 * Azure credentials are available and the developer just wants to verify the
 * enqueue code path without needing a real queue.
 */
import type { AssetQueue, AssetRequest, DequeuedMessage } from './types.js';
export declare class NoopAssetQueue implements AssetQueue {
  readonly backend: 'noop';
  enqueue(request: AssetRequest): Promise<void>;
  dequeue(): Promise<DequeuedMessage | null>;
  peek(_maxCount?: number): Promise<readonly AssetRequest[]>;
}
//# sourceMappingURL=noop-queue.d.ts.map
