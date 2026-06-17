/**
 * AssetQueue — abstraction for the sprite-generation request queue.
 *
 * Producers (sidecar, CLI) call `enqueue` to request a new generation run.
 * A worker process calls `dequeue` in a loop, processes the request, and
 * calls `ack` to remove the message from the queue.
 *
 * The no-op implementation (`NoopAssetQueue`) is the default for local dev:
 * requests are logged but not persisted. Use `SPRITES_ASSET_QUEUE=azure-queue`
 * to route through Azure Storage Queue.
 */
/** A request to generate sprites for a specific brief. */
export interface AssetRequest {
  /** `brief.name` slug (e.g. `'iron-sword'`). */
  readonly briefId: string;
  /** Repo-relative path to the brief YAML (e.g. `'briefs/weapons/iron-sword.yaml'`). */
  readonly briefPath: string;
  /**
   * Free-form identifier for the requestor — agent session ID, username, or
   * process name. Used for audit logging only; not validated.
   */
  readonly requestedBy: string;
  /** ISO-8601 timestamp at which the request was submitted. */
  readonly requestedAt: string;
  /** Generation priority. Workers MAY honour this; there is no SLA. */
  readonly priority: 'normal' | 'high';
}
/**
 * A dequeued message. Call `ack()` after successfully processing the request
 * to remove it from the queue. If `ack()` is never called (e.g. the worker
 * crashes) the message becomes visible again after the queue's visibility
 * timeout, which Azure Storage Queue handles automatically.
 */
export interface DequeuedMessage {
  readonly request: AssetRequest;
  ack(): Promise<void>;
}
export interface AssetQueue {
  /** Add a generation request to the tail of the queue. */
  enqueue(request: AssetRequest): Promise<void>;
  /**
   * Fetch the next available message.
   * Returns `null` when the queue is empty.
   * The message is invisible to other consumers until `ack()` is called or
   * the visibility timeout expires.
   */
  dequeue(): Promise<DequeuedMessage | null>;
  /**
   * Peek at up to `maxCount` messages (default 1) without making them
   * invisible. Useful for dashboards; not safe for processing (no ack).
   */
  peek(maxCount?: number): Promise<readonly AssetRequest[]>;
  /** Human-readable backend tag surfaced in /api/health. */
  readonly backend: 'noop' | 'azure-queue';
}
//# sourceMappingURL=types.d.ts.map
