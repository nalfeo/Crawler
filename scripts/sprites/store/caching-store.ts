/**
 * CachingRunStore — persistent read-through cache for immutable RunStore blobs.
 *
 * Why
 * ---
 * Sprite sheets (`<briefId>/<runId>/sheet-NN.png`) are written **once** by
 * `generateOne` and never mutated afterwards. The devtools sidecar hits
 * `store.get(...)` for the same sheet on every reload, slice-map recompute,
 * and postprocess re-run. With `SPRITES_RUN_STORE=azure-blob` each of those
 * calls is a multi-hundred-KB Azure blob GET over the network.
 *
 * This wrapper adds a persistent local cache at a directory **outside the
 * git worktree** so a worktree checkpoint or `git clean` doesn't wipe it and
 * `.gitignore` doesn't have to know about it. Cache path defaults to
 * `%LOCALAPPDATA%\Crawler\sprite-sheets` (Windows), `$XDG_CACHE_HOME/crawler/
 * sprite-sheets`, or `~/.cache/crawler/sprite-sheets`. Override with
 * `SPRITES_AZURE_CACHE_DIR`; disable with `SPRITES_AZURE_CACHE=off`.
 *
 * Safety
 * ------
 * Only keys matching the immutable sheet pattern are cached. `put` writes to
 * the inner store first, then mirrors into the cache. `remove` invalidates
 * before forwarding, so a locally-writing pipeline never observes a stale
 * cache after a delete. `list` and `resolve` forward verbatim — the cache
 * never affects listings or SAS-URL resolution.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunStore } from './types.js';

/** Matches immutable sheet PNGs: `<briefId>/<runId>/sheet-NN.png`. */
const SHEET_KEY_RE = /^[^/]+\/[^/]+\/sheet-\d+\.png$/i;

/** Monotonic suffix so concurrent cache writes in the same ms get distinct temps. */
let tmpCounter = 0;

export interface CachingRunStoreOptions {
  /** Store to delegate to (Azure in production; LocalRunStore in tests). */
  readonly inner: RunStore;
  /** Absolute path to the cache directory. Must be outside any git worktree. */
  readonly cacheDir: string;
  /**
   * Predicate for which keys are cacheable. Defaults to sheet PNGs
   * (`isSheetKey`). Non-cacheable keys pass through untouched.
   */
  readonly shouldCache?: (key: string) => boolean;
}

export class CachingRunStore implements RunStore {
  readonly backend: RunStore['backend'];
  private readonly inner: RunStore;
  private readonly cacheDir: string;
  private readonly shouldCache: (key: string) => boolean;

  constructor(options: CachingRunStoreOptions) {
    this.inner = options.inner;
    this.backend = options.inner.backend;
    this.cacheDir = options.cacheDir;
    this.shouldCache = options.shouldCache ?? isSheetKey;
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.inner.put(key, data);
    if (this.shouldCache(key)) {
      this.writeCache(key, data);
    }
  }

  async get(key: string): Promise<Buffer> {
    if (!this.shouldCache(key)) {
      return this.inner.get(key);
    }
    const cached = this.readCache(key);
    if (cached !== null) return cached;
    const data = await this.inner.get(key);
    this.writeCache(key, data);
    return data;
  }

  async has(key: string): Promise<boolean> {
    if (this.shouldCache(key) && this.hasCache(key)) return true;
    return this.inner.has(key);
  }

  async list(prefix: string): Promise<readonly string[]> {
    return this.inner.list(prefix);
  }

  async remove(key: string): Promise<void> {
    // Invalidate first so an inner-remove failure never leaves a stale hit
    // that outlives the authoritative delete.
    this.invalidate(key);
    return this.inner.remove(key);
  }

  resolve(key: string): string {
    return this.inner.resolve(key);
  }

  // ── cache helpers ─────────────────────────────────────────────────────────

  private cachePath(key: string): string {
    // Keys use POSIX separators (`briefId/runId/sheet-00.png`). Normalise
    // against traversal (`..`) before joining under the cache root — matches
    // the belt-and-suspenders normalisation LocalRunStore already does.
    const safe = path.posix.normalize(key).replace(/^(\.\.(\/|$))+/, '');
    return path.join(this.cacheDir, ...safe.split('/'));
  }

  private readCache(key: string): Buffer | null {
    const abs = this.cachePath(key);
    try {
      if (!existsSync(abs)) return null;
      const st = statSync(abs);
      if (!st.isFile()) return null;
      return readFileSync(abs);
    } catch {
      // A partially-written or unreadable cache entry must never break the
      // caller — fall through to the inner store.
      return null;
    }
  }

  private hasCache(key: string): boolean {
    const abs = this.cachePath(key);
    try {
      return existsSync(abs) && statSync(abs).isFile();
    } catch {
      return false;
    }
  }

  private writeCache(key: string, data: Buffer): void {
    const abs = this.cachePath(key);
    try {
      mkdirSync(path.dirname(abs), { recursive: true });
      // Atomic write via sibling temp + rename (same pattern as LocalRunStore
      // so a crashed writer never leaves a torn PNG for the next reader).
      const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${(tmpCounter = (tmpCounter + 1) >>> 0)}`;
      try {
        writeFileSync(tmp, data);
        renameSync(tmp, abs);
      } catch (err) {
        try {
          rmSync(tmp, { force: true });
        } catch {
          // best-effort cleanup
        }
        throw err;
      }
    } catch {
      // Cache is a best-effort optimisation; never fail the caller because
      // the cache directory is read-only or full.
    }
  }

  private invalidate(key: string): void {
    const abs = this.cachePath(key);
    try {
      rmSync(abs, { force: true });
    } catch {
      // best-effort
    }
  }
}

/** True iff `key` matches the immutable sheet PNG layout. */
export function isSheetKey(key: string): boolean {
  return SHEET_KEY_RE.test(key);
}

/**
 * Resolve the default local cache directory (outside any git worktree).
 *
 * Precedence:
 *   1. `SPRITES_AZURE_CACHE_DIR` (explicit override)
 *   2. `%LOCALAPPDATA%\Crawler\sprite-sheets` on Windows
 *   3. `$XDG_CACHE_HOME/crawler/sprite-sheets`
 *   4. `<homedir>/.cache/crawler/sprite-sheets`
 */
export function defaultAzureSheetCacheDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homedir: () => string = os.homedir,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env['SPRITES_AZURE_CACHE_DIR'];
  if (override && override.length > 0) return override;
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'];
    if (local && local.length > 0) return path.join(local, 'Crawler', 'sprite-sheets');
  }
  const xdg = env['XDG_CACHE_HOME'];
  if (xdg && xdg.length > 0) return path.join(xdg, 'crawler', 'sprite-sheets');
  return path.join(homedir(), '.cache', 'crawler', 'sprite-sheets');
}

/**
 * True iff local caching should be enabled for the Azure store based on env.
 * Default is on. Set `SPRITES_AZURE_CACHE=off` (or `0`/`false`) to disable.
 */
export function isAzureCacheEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = (env['SPRITES_AZURE_CACHE'] ?? 'on').toLowerCase();
  return raw !== 'off' && raw !== '0' && raw !== 'false';
}
