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
export {};
//# sourceMappingURL=types.js.map
