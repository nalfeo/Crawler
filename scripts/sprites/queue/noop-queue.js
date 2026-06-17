/**
 * NoopAssetQueue — in-process stub for local development.
 *
 * Enqueued requests are printed to stdout and discarded. Useful when no
 * Azure credentials are available and the developer just wants to verify the
 * enqueue code path without needing a real queue.
 */
export class NoopAssetQueue {
  backend = 'noop';
  async enqueue(request) {
    process.stdout.write(
      `[noop-queue] enqueue: ${request.briefId} (priority=${request.priority}, by=${request.requestedBy})\n`,
    );
  }
  async dequeue() {
    return null;
  }
  async peek(_maxCount) {
    return [];
  }
}
//# sourceMappingURL=noop-queue.js.map
