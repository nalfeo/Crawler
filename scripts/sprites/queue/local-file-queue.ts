/**
 * LocalFileQueue — filesystem-backed queue for isolated CI runs.
 *
 * Persists messages as a JSON array in a single file on the local filesystem.
 * Intended for `targetIssueOnly` CI runs where the ingest and drain steps
 * share a CI runner's filesystem but MUST NOT touch the shared Azure queue.
 *
 * Behaviour contract:
 *   - `enqueue`:  appends `{ request, dequeueCount: 0 }` to the array.
 *                 Creates the parent directory if it does not exist.
 *   - `dequeue`:  reads the head entry, increments its `dequeueCount`,
 *                 writes the updated array back (head STAYS in file), then
 *                 returns the message. `ack()` removes the head entry from
 *                 the file, matching the standard `AssetQueue` contract.
 *   - `peek`:     reads without modifying; skips entries whose request
 *                 payload cannot be parsed (does not throw per-entry).
 *   - `backend`:  `'local-file'`; the sidecar CLI treats any non-azure-queue
 *                 value as local and skips auto-starting the Azure worker.
 *
 * Error handling:
 *   - Throws on malformed JSON or a non-array root value (do NOT broad-catch).
 *   - Throws when the head entry is missing the `{ request, dequeueCount }`
 *     wrapper (corrupt file) or when its `request` payload fails validation.
 *
 * NOT suitable for concurrent access: two simultaneous callers can race on
 * the file write. The CI workflow is sequential so this is fine.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeAssetRequest } from './types.js';
import type { AssetQueue, AssetRequest, DequeuedMessage } from './types.js';

/**
 * Serialized form of each queue entry.
 *
 * `dequeueCount` starts at 0 on enqueue and is incremented on each
 * `dequeue()` call so the returned `DequeuedMessage.dequeueCount` reflects
 * the actual delivery count (1 on first delivery, 2 on first retry, etc.),
 * matching Azure Storage Queue semantics. The entry remains in the file
 * until `ack()` removes it.
 */
interface QueueEntry {
  readonly request: unknown;
  readonly dequeueCount: number;
}

export class LocalFileQueue implements AssetQueue {
  readonly backend = 'local-file' as const;

  constructor(private readonly filePath: string) {}

  async enqueue(request: AssetRequest): Promise<void> {
    const entries = this.readEntries();
    this.writeEntries([...entries, { request, dequeueCount: 0 }]);
  }

  async dequeue(): Promise<DequeuedMessage | null> {
    const entries = this.readEntries();
    if (entries.length === 0) return null;

    const rawHead = entries[0]!;
    this.assertWellFormedEntry(rawHead);

    const parsed = normalizeAssetRequest(rawHead.request);
    if (!parsed) {
      throw new Error(`LocalFileQueue: invalid asset-request payload at head of ${this.filePath}`);
    }

    const newCount = rawHead.dequeueCount + 1;
    this.writeEntries([{ request: rawHead.request, dequeueCount: newCount }, ...entries.slice(1)]);

    return {
      request: parsed,
      dequeueCount: newCount,
      ack: async () => {
        const current = existsSync(this.filePath) ? this.readEntries() : [];
        this.writeEntries(current.slice(1));
      },
    };
  }

  async peek(maxCount = 1): Promise<readonly AssetRequest[]> {
    const entries = this.readEntries();
    const out: AssetRequest[] = [];
    for (const entry of entries.slice(0, maxCount)) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as QueueEntry).dequeueCount !== 'number'
      )
        continue;
      const r = normalizeAssetRequest((entry as QueueEntry).request);
      if (r) out.push(r);
    }
    return out;
  }

  /**
   * Read all queue entries from disk. Returns an empty array when the file
   * does not yet exist. Throws `SyntaxError` on malformed JSON and a
   * descriptive `Error` when the root value is not an array.
   */
  private readEntries(): QueueEntry[] {
    if (!existsSync(this.filePath)) return [];
    // JSON.parse throws SyntaxError on malformed input — let it propagate.
    const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
    if (!Array.isArray(raw)) {
      throw new Error(
        `LocalFileQueue: expected a JSON array in ${this.filePath}, got ${typeof raw}`,
      );
    }
    return raw as QueueEntry[];
  }

  private writeEntries(entries: readonly QueueEntry[]): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  }

  /** Throws when an entry is missing the required `{ request, dequeueCount }` wrapper. */
  private assertWellFormedEntry(entry: unknown): asserts entry is QueueEntry {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('request' in entry) ||
      !('dequeueCount' in entry) ||
      typeof (entry as Record<string, unknown>).dequeueCount !== 'number'
    ) {
      throw new Error(
        `LocalFileQueue: corrupt entry in ${this.filePath} — expected { request, dequeueCount }`,
      );
    }
  }
}
