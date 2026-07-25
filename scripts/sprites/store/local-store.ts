/**
 * LocalRunStore — filesystem-backed RunStore.
 *
 * Stores run artifacts under `<root>/runs/<key>` on the local filesystem.
 * This is the default when `SPRITES_RUN_STORE` is unset or `'local'`.
 *
 * Directory creation is handled transparently by `put`: callers never need
 * to pre-create directories the way the old `run-artifacts.ts` flow required
 * explicit `mkdirSync` calls.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  StoreConditionalWriteError,
  StoreNotFoundError,
  type ConditionalWriteConditions,
  type RunStore,
} from './types.js';

/** Monotonic suffix so concurrent `put`s in the same ms get distinct temp names. */
let tmpCounter = 0;

export class LocalRunStore implements RunStore {
  readonly backend = 'local' as const;

  /**
   * @param root Absolute path to the runs directory
   *             (e.g. `<repoRoot>/generated/runs`).
   */
  constructor(private readonly root: string) {}

  async put(key: string, data: Buffer): Promise<void> {
    const abs = this.abs(key);
    mkdirSync(path.dirname(abs), { recursive: true });
    // Atomic write: stage to a sibling temp file then rename into place. A
    // crash (or a concurrent re-run reading the same key) therefore never sees
    // a half-written artifact — readers observe either the old bytes or the
    // complete new bytes. `renameSync` is atomic on the same filesystem and
    // overwrites an existing destination cross-platform under Node. The temp
    // name is per-pid + monotonic so concurrent writers never collide; a
    // failure between write and rename leaves only an orphan `.tmp-*` file,
    // never a torn target.
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${(tmpCounter = (tmpCounter + 1) >>> 0)}`;
    try {
      writeFileSync(tmp, data);
      renameSync(tmp, abs);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Best-effort cleanup; surface the original write/rename error.
      }
      throw err;
    }
  }

  async get(key: string): Promise<Buffer> {
    const abs = this.abs(key);
    if (!existsSync(abs)) throw new StoreNotFoundError(key);
    return readFileSync(abs);
  }

  async getWithETag(key: string): Promise<{ data: Buffer; etag: string }> {
    const abs = this.abs(key);
    if (!existsSync(abs)) throw new StoreNotFoundError(key);
    const data = readFileSync(abs);
    const { mtimeMs, size } = statSync(abs);
    const etag = `"${mtimeMs.toString(36)}-${size.toString(36)}"`;
    return { data, etag };
  }

  async putConditional(
    key: string,
    data: Buffer,
    conditions: ConditionalWriteConditions,
  ): Promise<void> {
    const abs = this.abs(key);
    if (conditions.ifNoneMatch === '*') {
      if (existsSync(abs)) throw new StoreConditionalWriteError(key);
    } else if (conditions.ifMatch !== undefined) {
      if (!existsSync(abs)) throw new StoreConditionalWriteError(key);
      const { mtimeMs, size } = statSync(abs);
      const currentEtag = `"${mtimeMs.toString(36)}-${size.toString(36)}"`;
      if (currentEtag !== conditions.ifMatch) throw new StoreConditionalWriteError(key);
    }
    await this.put(key, data);
  }

  async has(key: string): Promise<boolean> {
    return existsSync(this.abs(key));
  }

  async list(prefix: string): Promise<readonly string[]> {
    const absPrefix = this.abs(prefix);
    if (!existsSync(absPrefix)) return [];
    const stat = statSync(absPrefix);
    if (!stat.isDirectory()) return [prefix];
    return this.walk(absPrefix).map((abs) =>
      path.relative(this.root, abs).split(path.sep).join('/'),
    );
  }

  async remove(key: string): Promise<void> {
    const abs = this.abs(key);
    if (!existsSync(abs)) return;
    rmSync(abs, { recursive: true, force: true });
  }

  resolve(key: string): string {
    return this.abs(key);
  }

  private abs(key: string): string {
    // Normalise: strip leading slash, collapse ../ sequences so keys stay
    // inside the root (defence-in-depth; the pipeline never passes user-
    // controlled keys, but belt-and-suspenders).
    const safe = path.normalize(key).replace(/^(\.\.(\/|\\|$))+/, '');
    return path.join(this.root, safe);
  }

  private walk(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.walk(full));
      } else {
        results.push(full);
      }
    }
    return results;
  }
}
