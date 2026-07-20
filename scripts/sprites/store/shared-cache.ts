/**
 * SharedResourceCache — the ONE canonical, cross-process-safe cache for
 * Azure-backed sprite-pipeline resources, shared by every worktree/session on
 * the machine and by the sidecar that fronts them.
 *
 * Why one shared cache (ADR 0065)
 * -------------------------------
 * Historically the cache surface was fragmented: a bespoke filesystem-mirror
 * `CachingRunStore` (sheets only) plus four independent, unlimited per-extension
 * image caches. That is impossible to bound or keep coherent. This module
 * replaces all of it with a single content-addressable store so the same
 * physical bytes are stored exactly once regardless of how many worktrees,
 * sessions, or extensions reference them.
 *
 * Build-vs-buy
 * ------------
 * Storage is delegated to `cacache` (the npm/pacote content-addressable cache):
 * atomic content writes, SRI integrity verification, lockless concurrent
 * reads/writes, and automatic dedupe. We do NOT reimplement any of that.
 * Node 22/24's built-in `node:sqlite` is deliberately NOT used — it is still
 * flagged experimental at this repo's Node version.
 *
 * What this module layers on top of cacache
 * -----------------------------------------
 *  - **Namespacing** by a stable, NON-SECRET hash of the remote identity
 *    (`{host, account, container}`). No storage key / connection string ever
 *    enters a namespace, a path, or a log. This isolates Azurite/dev/prod and
 *    two different accounts from ever sharing content.
 *  - **True access-based LRU** over UNIQUE physical content (deduped by SRI
 *    integrity, so a blob referenced by two keys is counted once). Recency is
 *    tracked with per-key access-marker files whose mtime is the last access;
 *    a cache hit refreshes recency, so hits change the eviction victim.
 *  - **Serialized writes and reclamation** guarded by a global lock directory
 *    with stale-owner recovery. Contenders wait asynchronously, so concurrent
 *    writers converge under one budget without blocking the Node.js event loop.
 *  - **A shared list-invalidation version** (an opaque token file) so listing
 *    snapshots captured by one process are invalidated for all processes the
 *    moment any process mutates the store. See {@link CachingRunStore}.
 *
 * Safety / reliability contract
 * -----------------------------
 *  - Keys are opaque to the filesystem: cacache hashes them for its index, so a
 *    key containing `..` or separators can NEVER traverse out of the cache.
 *  - Corrupt / missing / integrity-failing content surfaces as a cache MISS
 *    (`get` returns `null`), never an exception to the caller.
 *  - Writes are best-effort: a read-only or full cache dir never fails the
 *    caller. Operational failures are surfaced through the injected `log`.
 *  - No credentials are ever persisted or logged.
 */

import cacache from 'cacache';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Default LRU budget: exactly 5 GiB of unique physical content. */
export const DEFAULT_MAX_CACHE_BYTES = 5 * 1024 * 1024 * 1024;

/** A prune lock older than this is treated as an abandoned crash leftover. */
const STALE_LOCK_MS = 60 * 1000;

/** Delay between non-blocking cross-process lock attempts. */
const LOCK_RETRY_MS = 10;
const LOCK_HEARTBEAT_MS = 10 * 1000;

/** Non-secret remote identity used to derive the cache namespace. */
export interface RemoteCacheIdentity {
  /** Blob endpoint host (e.g. `acct.blob.core.windows.net` or `127.0.0.1:10000`). */
  readonly host: string;
  /** Storage account name (NON-SECRET). */
  readonly account: string;
  /** Container name. */
  readonly container: string;
}

/** Optional structured logger for operational (non-fatal) cache failures. */
export type CacheLogger = (message: string) => void;

const defaultLog: CacheLogger = (message) => {
  // Surface operational failures on stderr with a stable prefix so they are
  // never silently swallowed, without polluting stdout data streams.
  process.stderr.write(`shared-resource-cache: ${message}\n`);
};

export interface SharedResourceCacheOptions {
  /** Absolute path to the global cache root (see {@link createSharedResourceCache}). */
  readonly cacheDir: string;
  /** Non-secret remote namespace. Keys and metadata remain isolated within the global cache. */
  readonly namespace?: string;
  /** Unique-content byte budget. `0` (or `<=0`) disables eviction (unbounded). */
  readonly maxBytes: number;
  /** @deprecated Retained for source compatibility. Every successful write now prunes. */
  readonly pruneThresholdBytes?: number;
  /** Operational-failure logger. Defaults to a stderr writer. */
  readonly log?: CacheLogger;
}

/** A single cached value: raw bytes plus caller-supplied metadata. */
export interface CachedEntry {
  readonly data: Buffer;
  readonly metadata: Record<string, unknown> | undefined;
}

/**
 * Derive the 16-hex cache namespace from a remote identity. Pure and
 * deterministic; contains no secret material.
 */
export function computeCacheNamespace(identity: RemoteCacheIdentity): string {
  const canonical = `${identity.host}\n${identity.account}\n${identity.container}`;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Resolve the shared cache base directory (parent of all namespaces).
 *
 * Precedence:
 *   1. `CRAWLER_AZURE_CACHE_DIR` (canonical override)
 *   2. `SPRITES_AZURE_CACHE_DIR` (legacy alias, preserved for back-compat)
 *   3. `$COPILOT_HOME/crawler/azure-resource-cache` (user-level Copilot data dir)
 *   4. `<homedir>/.copilot/crawler/azure-resource-cache`
 *
 * The directory is deliberately OUTSIDE any git worktree so a checkpoint or
 * `git clean` never wipes it and `.gitignore` need not know about it.
 */
export function resolveCacheBaseDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homedir: () => string = os.homedir,
): string {
  const canonical = env['CRAWLER_AZURE_CACHE_DIR'];
  if (canonical && canonical.length > 0) return canonical;
  const legacy = env['SPRITES_AZURE_CACHE_DIR'];
  if (legacy && legacy.length > 0) return legacy;
  const copilotHome = env['COPILOT_HOME'];
  const base =
    copilotHome && copilotHome.length > 0 ? copilotHome : path.join(homedir(), '.copilot');
  return path.join(base, 'crawler', 'azure-resource-cache');
}

/**
 * Resolve the LRU byte budget.
 *
 * `CRAWLER_AZURE_CACHE_MAX_BYTES` (canonical) or `SPRITES_AZURE_CACHE_MAX_BYTES`
 * (legacy alias) — a non-negative integer count of bytes. `0` disables eviction
 * (unbounded). Unset / empty / malformed values fall back to the 5 GiB default.
 */
export function resolveMaxCacheBytes(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env['CRAWLER_AZURE_CACHE_MAX_BYTES'] ?? env['SPRITES_AZURE_CACHE_MAX_BYTES'];
  if (raw === undefined) return DEFAULT_MAX_CACHE_BYTES;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_MAX_CACHE_BYTES;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) return DEFAULT_MAX_CACHE_BYTES;
  return n;
}

/**
 * Construct a namespaced SharedResourceCache over one global physical cache.
 * Keys are prefixed by namespace, so distinct remotes stay logically isolated
 * while one lock and one byte budget govern the entire user-level cache.
 */
export function createSharedResourceCache(params: {
  readonly identity: RemoteCacheIdentity;
  readonly baseDir: string;
  readonly maxBytes: number;
  readonly pruneThresholdBytes?: number;
  readonly log?: CacheLogger;
}): SharedResourceCache {
  const namespace = computeCacheNamespace(params.identity);
  return new SharedResourceCache({
    cacheDir: params.baseDir,
    namespace,
    maxBytes: params.maxBytes,
    ...(params.pruneThresholdBytes !== undefined
      ? { pruneThresholdBytes: params.pruneThresholdBytes }
      : {}),
    ...(params.log !== undefined ? { log: params.log } : {}),
  });
}

export class SharedResourceCache {
  private readonly cacheDir: string;
  private readonly namespace: string;
  private readonly maxBytes: number;
  private readonly log: CacheLogger;
  private readonly metaDir: string;
  private readonly accessDir: string;
  private readonly lockDir: string;
  private readonly epochFile: string;
  private lockHeartbeat: NodeJS.Timeout | null = null;

  constructor(options: SharedResourceCacheOptions) {
    this.cacheDir = options.cacheDir;
    this.namespace = options.namespace ?? '';
    this.maxBytes = options.maxBytes;
    this.log = options.log ?? defaultLog;
    this.metaDir = path.join(this.cacheDir, '.crawler');
    this.accessDir = path.join(this.metaDir, 'access');
    this.lockDir = path.join(this.metaDir, 'prune.lock');
    this.epochFile = path.join(this.metaDir, 'epochs', this.namespace || 'default');
  }

  /** Absolute cache root (namespaced). Exposed for diagnostics/tests. */
  get directory(): string {
    return this.cacheDir;
  }

  // ── value API ──────────────────────────────────────────────────────────

  /**
   * Read a cached value, or `null` on a miss / corruption / integrity failure.
   * A hit refreshes the key's access recency.
   */
  async get(key: string): Promise<CachedEntry | null> {
    try {
      const physicalKey = this.physicalKey(key);
      const result = await cacache.get(this.cacheDir, physicalKey);
      this.touch(physicalKey);
      return {
        data: result.data,
        metadata: (result.metadata as Record<string, unknown> | undefined) ?? undefined,
      };
    } catch {
      // ENOENT (miss) or EINTEGRITY (corruption) → treat as a miss. Never throw.
      return null;
    }
  }

  /**
   * True iff `key` is present **and** its content is readable and
   * integrity-valid. A hit refreshes the key's access recency.
   *
   * `cacache.get.info()` only validates the index entry; the referenced content
   * blob could be missing or corrupt while info returns non-null. We therefore
   * call `cacache.get.hasContent()` to confirm the content file exists and
   * passes SRI verification. A dangling index entry (content missing/invalid)
   * is pruned so future callers don't retry a doomed lookup.
   */
  async has(key: string): Promise<boolean> {
    try {
      const physicalKey = this.physicalKey(key);
      const info = await cacache.get.info(this.cacheDir, physicalKey);
      if (info === null) return false;
      const contentCheck = await cacache.get.hasContent(this.cacheDir, info.integrity);
      if (!contentCheck) {
        // Content is missing or integrity-invalid. Guard the cleanup against a
        // concurrent set() that may have just repaired this key: re-read the
        // index and only remove if the integrity is still the same stale one.
        // If it changed, the new valid entry must not be deleted.
        try {
          const current = await cacache.get.info(this.cacheDir, physicalKey);
          if (current !== null && current.integrity === info.integrity) {
            await cacache.rm.entry(this.cacheDir, physicalKey);
          }
        } catch {
          // best-effort; a stale entry is harmless if removal fails
        }
        return false;
      }
      this.touch(physicalKey);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write a value (best-effort). A single value larger than the whole budget is
   * skipped rather than written then immediately evicted. After a successful
   * write the global LRU budget is enforced before the call completes.
   *
   * Replacing an existing key would leave the previous content blob orphaned
   * (cacache appends a new index entry but does not remove the old content).
   * We capture the previous integrity before the write and compact orphaned
   * content afterwards to keep the physical store within budget.
   */
  async set(key: string, data: Buffer, metadata?: Record<string, unknown>): Promise<void> {
    // Acquire the lock before the size check so that an oversized replacement
    // can evict the existing stale entry. Without the lock, the old (smaller)
    // value would remain indefinitely and be served as "current" after the
    // authoritative Azure write completes.
    const lockToken = await this.acquireLock();
    if (lockToken === null) return;
    // physicalKey must be declared outside the try block so the catch handler
    // can force a cache miss (rm.entry) when the write fails.
    const physicalKey = this.physicalKey(key);
    try {
      if (this.maxBytes > 0 && data.length > this.maxBytes) {
        // Cannot store this blob; evict any stale existing entry so subsequent
        // reads fall through to the authoritative Azure store rather than
        // serving outdated content forever.
        try {
          const existing = await cacache.get.info(this.cacheDir, physicalKey);
          if (existing !== null) {
            await cacache.rm.entry(this.cacheDir, physicalKey);
            this.removeMarker(physicalKey);
            await this.removeContentIfUnreferenced(existing.integrity);
          }
        } catch {
          // best-effort
        }
        return;
      }
      // Capture the previous integrity so we can compact the orphaned blob
      // after the put (cacache does not remove it automatically).
      let prevIntegrity: string | null = null;
      try {
        const prev = await cacache.get.info(this.cacheDir, physicalKey);
        if (prev !== null) prevIntegrity = prev.integrity;
      } catch {
        // best-effort; failing to read old info is not fatal
      }
      await cacache.put(this.cacheDir, physicalKey, data, metadata ? { metadata } : undefined);
      this.touch(physicalKey);
      // Compact the previous blob if it was replaced with different content.
      if (prevIntegrity !== null) {
        const newInfo = await cacache.get.info(this.cacheDir, physicalKey);
        if (newInfo !== null && newInfo.integrity !== prevIntegrity) {
          await this.removeContentIfUnreferenced(prevIntegrity);
        }
      }
      if (this.maxBytes > 0) await this.pruneLocked(lockToken);
    } catch (err) {
      this.log(`put failed for ${redactKey(key)}: ${errMsg(err)}`);
      // Force a cache miss so subsequent reads do not serve stale data after
      // a successful authoritative Azure write (CachingRunStore.put commits to
      // inner before caching). Best-effort: if removal also fails the stale
      // entry remains, which is less harmful than an exception to the caller.
      try {
        await cacache.rm.entry(this.cacheDir, physicalKey);
        this.removeMarker(physicalKey);
      } catch {
        // best-effort
      }
    } finally {
      this.releaseLock(lockToken);
    }
  }

  /** Invalidate a key (best-effort). Removes both the index entry and its marker. */
  async remove(key: string): Promise<void> {
    const physicalKey = this.physicalKey(key);
    const lockToken = await this.acquireLock();
    if (lockToken === null) return;
    try {
      const info = await cacache.get.info(this.cacheDir, physicalKey);
      if (info === null) return;
      await cacache.rm.entry(this.cacheDir, physicalKey);
      this.removeMarker(physicalKey);
      await this.removeContentIfUnreferenced(info.integrity);
    } catch (err) {
      this.log(`remove failed for ${redactKey(key)}: ${errMsg(err)}`);
      // Force a cache miss even when the full removal failed so that the key
      // is not served from a stale cache entry after the authoritative delete.
      try {
        await cacache.rm.entry(this.cacheDir, physicalKey);
        this.removeMarker(physicalKey);
      } catch {
        // best-effort
      }
    } finally {
      this.releaseLock(lockToken);
    }
  }

  /**
   * Write a value only if no entry currently exists for this key. The check and
   * write are serialized under the global mutation lock, preventing a concurrent
   * set() from being overwritten by a stale read-through fill that started
   * before the put completed.
   *
   * Used for read-through cache fills (CachingRunStore.get) and for per-run
   * immutable snapshots that must not be overwritten once set.
   */
  async setIfAbsent(key: string, data: Buffer, metadata?: Record<string, unknown>): Promise<void> {
    const lockToken = await this.acquireLock();
    if (lockToken === null) return;
    const physicalKey = this.physicalKey(key);
    try {
      const existing = await cacache.get.info(this.cacheDir, physicalKey);
      if (existing !== null) return; // already present; skip write
      await cacache.put(this.cacheDir, physicalKey, data, metadata ? { metadata } : undefined);
      this.touch(physicalKey);
      if (this.maxBytes > 0) await this.pruneLocked(lockToken);
    } catch (err) {
      this.log(`setIfAbsent failed for ${redactKey(key)}: ${errMsg(err)}`);
    } finally {
      this.releaseLock(lockToken);
    }
  }

  /** Remove every logical key beginning with `prefix`, then compact orphaned content. */
  async removeByPrefix(prefix: string): Promise<void> {
    const physicalPrefix = this.physicalKey(prefix);
    const lockToken = await this.acquireLock();
    if (lockToken === null) return;
    try {
      const entries = await cacache.ls(this.cacheDir);
      const keys = Object.keys(entries).filter((key) => key.startsWith(physicalPrefix));
      if (keys.length === 0) return;
      const removedIntegrities = new Set<string>();
      for (const key of keys) {
        if (!this.ownsLock(lockToken)) return;
        const entry = entries[key];
        if (entry) removedIntegrities.add(entry.integrity);
        await cacache.rm.entry(this.cacheDir, key);
        this.removeMarker(key);
      }
      const remainingIntegrities = new Set(
        Object.values(await cacache.ls(this.cacheDir)).map((entry) => entry.integrity),
      );
      for (const integrity of removedIntegrities) {
        if (!this.ownsLock(lockToken)) return;
        if (!remainingIntegrities.has(integrity)) {
          await cacache.rm.content(this.cacheDir, integrity);
        }
      }
    } catch (err) {
      this.log(`remove prefix failed for ${redactKey(prefix)}: ${errMsg(err)}`);
    } finally {
      this.releaseLock(lockToken);
    }
  }

  // ── list-invalidation epoch ───────────────────────────────────────────────

  /**
   * Read the shared list-invalidation version. Empty when no mutation has been
   * recorded.
   */
  readEpoch(): string {
    try {
      return readFileSync(this.epochFile, 'utf8').trim();
    } catch {
      return '';
    }
  }

  /**
   * Replace the shared version with an opaque per-mutation token. Unlike a
   * read-modify-write counter, concurrent writers cannot move the version
   * backward or resurrect an older snapshot.
   */
  bumpEpoch(): void {
    try {
      mkdirSync(path.dirname(this.epochFile), { recursive: true });
      // Write to a uniquely named temp file, then rename atomically so
      // concurrent readers always observe a complete epoch token — never an
      // empty string truncated mid-write. On POSIX, rename(2) is atomic when
      // source and destination are on the same filesystem (same directory here).
      const tmp = `${this.epochFile}.tmp.${randomUUID()}`;
      writeFileSync(tmp, randomUUID());
      renameSync(tmp, this.epochFile);
    } catch (err) {
      this.log(`epoch bump failed: ${errMsg(err)}`);
    }
  }

  // ── access-recency markers ────────────────────────────────────────────────

  private markerPath(key: string): string {
    return path.join(this.accessDir, createHash('sha256').update(key).digest('hex'));
  }

  private touch(key: string): void {
    try {
      this.ensureAccessDir();
      // Writing (creating or truncating) sets mtime=now — the last-access time.
      writeFileSync(this.markerPath(key), '');
    } catch {
      // Recency tracking is advisory; a failure just falls back to insert-time.
    }
  }

  private removeMarker(key: string): void {
    try {
      rmSync(this.markerPath(key), { force: true });
    } catch {
      // best-effort
    }
  }

  private accessTimeMs(key: string, fallbackMs: number): number {
    try {
      return statSync(this.markerPath(key)).mtimeMs;
    } catch {
      return fallbackMs;
    }
  }

  private ensureMetaDir(): void {
    mkdirSync(this.metaDir, { recursive: true });
  }

  private ensureAccessDir(): void {
    mkdirSync(this.accessDir, { recursive: true });
  }

  // ── LRU prune ─────────────────────────────────────────────────────────────

  /**
   * Evict least-recently-accessed keys until UNIQUE physical content is back
   * under the budget. Serialized across processes via {@link lockDir};
   * contenders wait asynchronously. Content shared by multiple keys (dedup) is
   * only reclaimed once its last referencing key is evicted.
   */
  async prune(): Promise<void> {
    if (this.maxBytes <= 0) return;
    const lockToken = await this.acquireLock();
    if (lockToken === null) return;
    try {
      await this.pruneLocked(lockToken);
    } catch (err) {
      this.log(`prune failed: ${errMsg(err)}`);
    } finally {
      this.releaseLock(lockToken);
    }
  }

  private async pruneLocked(lockToken: string): Promise<void> {
    const entries = await cacache.ls(this.cacheDir);
    if (!this.ownsLock(lockToken)) return;
    const keys = Object.keys(entries);
    if (keys.length === 0) return;

    // integrity → { size, refs }: refs is the set of keys pointing at it.
    const byIntegrity = new Map<string, { size: number; refs: Set<string> }>();
    const keyIntegrity = new Map<string, string>();
    const accessAt = new Map<string, number>();
    for (const key of keys) {
      const entry = entries[key];
      if (!entry) continue;
      const integrity = entry.integrity;
      const size = typeof entry.size === 'number' ? entry.size : 0;
      keyIntegrity.set(key, integrity);
      accessAt.set(key, this.accessTimeMs(key, entry.time));
      const bucket = byIntegrity.get(integrity);
      if (bucket) {
        bucket.refs.add(key);
      } else {
        byIntegrity.set(integrity, { size, refs: new Set([key]) });
      }
    }

    let total = 0;
    for (const bucket of byIntegrity.values()) total += bucket.size;
    if (total <= this.maxBytes) return;

    // Least-recently-accessed first; ties broken deterministically by key.
    const ordered = keys.sort((a, b) => {
      const pinnedA = isPinned(entries[a]);
      const pinnedB = isPinned(entries[b]);
      if (pinnedA !== pinnedB) return pinnedA ? 1 : -1;
      const ta = accessAt.get(a) ?? 0;
      const tb = accessAt.get(b) ?? 0;
      return ta - tb || (a < b ? -1 : a > b ? 1 : 0);
    });

    for (const key of ordered) {
      if (total <= this.maxBytes) break;
      if (!this.ownsLock(lockToken)) return;
      const integrity = keyIntegrity.get(key);
      try {
        await cacache.rm.entry(this.cacheDir, key);
      } catch (err) {
        this.log(`prune rm.entry failed for ${redactKey(key)}: ${errMsg(err)}`);
        continue;
      }
      this.removeMarker(key);
      if (!integrity) continue;
      const bucket = byIntegrity.get(integrity);
      if (!bucket) continue;
      bucket.refs.delete(key);
      if (bucket.refs.size === 0) {
        total -= bucket.size;
        try {
          await cacache.rm.content(this.cacheDir, integrity);
        } catch (err) {
          this.log(`prune rm.content failed: ${errMsg(err)}`);
        }
      }
    }
  }

  private async removeContentIfUnreferenced(integrity: string): Promise<void> {
    const entries = await cacache.ls(this.cacheDir);
    if (Object.values(entries).some((entry) => entry.integrity === integrity)) return;
    await cacache.rm.content(this.cacheDir, integrity);
  }

  private async acquireLock(): Promise<string | null> {
    for (;;) {
      try {
        this.ensureMetaDir();
        mkdirSync(this.lockDir); // atomic exclusive create (EEXIST if held)
        const token = randomUUID();
        try {
          writeFileSync(this.lockOwnerFile(), token);
        } catch (err) {
          rmSync(this.lockDir, { recursive: true, force: true });
          throw err;
        }
        this.startLockHeartbeat(token);
        return token;
      } catch (err) {
        if (errorCode(err) !== 'EEXIST') {
          this.log(`prune lock failed: ${errMsg(err)}`);
          return null;
        }
        // Lock held. Reclaim it if it is an abandoned crash leftover.
        // Use an atomic rename to "steal" the stale lock dir — only ONE
        // process can rename it; the winner exclusively owns recovery and
        // the loser retries normally. This eliminates the TOCTOU where two
        // processes both observe a stale lock and both delete it, the second
        // deleting the newly acquired lock of the first.
        try {
          const age = Date.now() - statSync(this.lockOwnerFile()).mtimeMs;
          if (age > STALE_LOCK_MS) {
            const recoveryDir = `${this.lockDir}.recovering.${randomUUID()}`;
            try {
              renameSync(this.lockDir, recoveryDir); // atomic steal
              rmSync(recoveryDir, { recursive: true, force: true });
              continue; // back to mkdirSync
            } catch {
              // Another process won the rename race — retry normally.
            }
          }
        } catch (statErr) {
          // If the owner file is missing (crash between mkdirSync and
          // writeFileSync), use the lock directory's own mtime to age it.
          // An ownerless directory that is old enough is reclaimed; a fresh
          // one is retried so a concurrent legitimate writer can finish.
          if (errorCode(statErr) === 'ENOENT') {
            try {
              const dirAge = Date.now() - statSync(this.lockDir).mtimeMs;
              if (dirAge > STALE_LOCK_MS) {
                const recoveryDir = `${this.lockDir}.recovering.${randomUUID()}`;
                try {
                  renameSync(this.lockDir, recoveryDir); // atomic steal
                  rmSync(recoveryDir, { recursive: true, force: true });
                  continue;
                } catch {
                  // Another process won the rename race — retry normally.
                }
              }
            } catch {
              // Lock directory vanished between our create and stat — retry.
            }
          }
          // Owner file accessible but some other error, or lock directory
          // just vanished — retry on the next iteration.
        }
        await delay(LOCK_RETRY_MS);
      }
    }
  }

  private releaseLock(token: string): void {
    if (this.lockHeartbeat !== null) {
      clearInterval(this.lockHeartbeat);
      this.lockHeartbeat = null;
    }
    try {
      if (this.ownsLock(token)) rmSync(this.lockDir, { recursive: true, force: true });
    } catch {
      // best-effort; a stale lock is reclaimed by the next acquirer.
    }
  }

  private lockOwnerFile(): string {
    return path.join(this.lockDir, 'owner');
  }

  private ownsLock(token: string): boolean {
    try {
      return readFileSync(this.lockOwnerFile(), 'utf8') === token;
    } catch {
      return false;
    }
  }

  private startLockHeartbeat(token: string): void {
    this.lockHeartbeat = setInterval(() => {
      if (!this.ownsLock(token)) {
        if (this.lockHeartbeat !== null) clearInterval(this.lockHeartbeat);
        this.lockHeartbeat = null;
        return;
      }
      try {
        writeFileSync(this.lockOwnerFile(), token);
      } catch {
        // Ownership checks before destructive operations remain authoritative.
      }
    }, LOCK_HEARTBEAT_MS);
    this.lockHeartbeat.unref();
  }

  private physicalKey(key: string): string {
    return this.namespace === '' ? key : `ns:${this.namespace}:${key}`;
  }
}

function isPinned(entry: { metadata?: unknown } | undefined): boolean {
  if (!entry || typeof entry.metadata !== 'object' || entry.metadata === null) return false;
  return (entry.metadata as Record<string, unknown>)['crawlerPinned'] === true;
}

/** Redact a cache key to its shape for logs (keys are non-secret, but keep logs terse). */
function redactKey(key: string): string {
  return key.length > 96 ? `${key.slice(0, 93)}…` : key;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

/** True iff the persistent shared cache is enabled (default on). */
export function isAzureCacheEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = (env['CRAWLER_AZURE_CACHE'] ?? env['SPRITES_AZURE_CACHE'] ?? 'on').toLowerCase();
  return raw !== 'off' && raw !== '0' && raw !== 'false';
}

/**
 * True iff the cache should serve reads WITHOUT ever contacting the remote
 * (offline / Azure-forced-unavailable mode). Enables the hard-gate scenario
 * where a warmed worktree serves exact bytes and listings with zero Azure
 * read operations. Off by default.
 */
export function isAzureOffline(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = (env['CRAWLER_AZURE_OFFLINE'] ?? env['SPRITES_AZURE_OFFLINE'] ?? 'off').toLowerCase();
  return raw === 'on' || raw === '1' || raw === 'true';
}
