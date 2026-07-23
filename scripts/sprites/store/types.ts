/**
 * RunStore — storage abstraction for ephemeral sprite-generation artifacts.
 *
 * Generated run artifacts (sheets, processed variants, scorecards, summaries)
 * are produced by `generateOne` and consumed by the sidecar for review. They
 * are intentionally NOT checked into the repository; they live in a transient
 * store that can be local (`generated/runs/`) or remote (Azure Blob Storage).
 *
 * Keys follow the layout from `run-artifacts.ts`:
 *
 *   <briefId>/<runId>/sheet-00.png
 *   <briefId>/<runId>/raw/00.png
 *   <briefId>/<runId>/processed/00.png
 *   <briefId>/<runId>/processed/00.scorecard.json
 *   <briefId>/<runId>/summary.json
 *
 * All methods are async so both the local (sync fs) and Azure (network) impls
 * satisfy the same contract. The local impl wraps the existing synchronous
 * node:fs calls but returns Promises so callers are backend-agnostic.
 *
 * Error model
 * -----------
 * `get` and `has` throw `StoreNotFoundError` when the key doesn't exist.
 * All other errors surface as plain Error instances from the underlying
 * backend (fs errno, Azure SDK error).
 */

export class StoreNotFoundError extends Error {
  override readonly name = 'StoreNotFoundError';
  constructor(readonly key: string) {
    super(`Run-store key not found: ${key}`);
  }
}

export interface ListOptions {
  /**
   * When true, the caller requires a listing that reflects the authoritative
   * remote store at the time of the call. Caching implementations (see
   * `CachingRunStore`) normally serve `list()` from a warmed on-disk snapshot
   * for instant cross-process/worktree reads (stale-while-revalidate); this
   * flag bypasses that fast path and blocks on a fresh remote listing
   * instead. REQUIRED for any destructive/mutation workflow that enumerates
   * keys via `list()` and then acts on exactly that set (archive, delete,
   * clear-store) — a stale listing there could leave newly-added files
   * un-archived/un-deleted. Non-caching implementations (local/Azure
   * directly) are always authoritative and ignore this option.
   */
  readonly authoritative?: boolean;
}

export interface RunStore {
  /** Write bytes to a run-relative key. Creates any intermediate "directories". */
  put(key: string, data: Buffer): Promise<void>;
  /**
   * Read bytes from a key.
   * @throws {StoreNotFoundError} if the key does not exist.
   */
  get(key: string): Promise<Buffer>;
  /** Return true iff the key exists. Never throws. */
  has(key: string): Promise<boolean>;
  /**
   * List all keys whose names start with `prefix`. Pass
   * `{ authoritative: true }` for any enumerate-then-act workflow — see
   * {@link ListOptions}.
   */
  list(prefix: string, options?: ListOptions): Promise<readonly string[]>;
  /** Delete a single key. No-ops silently if the key doesn't exist. */
  remove(key: string): Promise<void>;
  /**
   * Resolve a key to a URL or absolute path for the sidecar to serve.
   * Local impl returns the absolute filesystem path.
   * Azure impl returns the blob URL (without SAS — caller adds it as needed).
   */
  resolve(key: string): string;
  /** Human-readable backend tag surfaced in /api/health. */
  readonly backend: 'local' | 'azure-blob';
}
