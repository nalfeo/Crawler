/**
 * Regression tests for the two defects that let a local machine pin a stale
 * copy of a mutable coordination document while CI advanced the authoritative
 * one:
 *
 *  1. `theme-sets/<id>/state.json` was cached read-through like an immutable
 *     artifact, so every local read returned permanently stale bytes (observed
 *     in production: local revision 40 vs. authoritative revision 59).
 *  2. `CachingRunStore` implemented neither `getWithETag` nor `putConditional`,
 *     so wrapping a compare-and-swap-capable store silently downgraded every
 *     conditional write to an unconditional overwrite — the caller's
 *     `expectedRevision` check ran against the same stale cache and passed.
 *
 * These use a `FakeAtomicStore` with genuine server-side ETag semantics as the
 * shared authoritative backend, and TWO `CachingRunStore` wrappers over
 * SEPARATE cache directories to simulate two machines (a laptop and a CI
 * runner) that cannot see each other's local cache coherence metadata.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CachingRunStore, isCacheableKey } from '../../../scripts/sprites/store/caching-store.js';
import { SharedResourceCache } from '../../../scripts/sprites/store/shared-cache.js';
import {
  StoreConditionalWriteError,
  StoreNotFoundError,
  type ConditionalWriteConditions,
  type ListOptions,
  type RunStore,
} from '../../../scripts/sprites/store/types.js';
import { WORKFLOW_STATE_KEY } from '../../../scripts/sprites/sidecar/workflow-state.js';
import { INGEST_STATE_KEY } from '../../../scripts/sprites/sidecar/ingest-state-key.js';
import { ISSUE_STATUS_KEY_PREFIX } from '../../../scripts/sprites/sidecar/issue-status-key.js';
import { themeEquipmentSetStateKey } from '../../../scripts/sprites/theme-equipment-set.js';

const noop = (): void => {};

const STATE_KEY = themeEquipmentSetStateKey('classic-fantasy-basic-leather');
const ARTIFACT_KEY = 'theme-sets/classic-fantasy-basic-leather/artifacts/iron-dagger/brief.yaml';

/**
 * Authoritative store with real compare-and-swap semantics: the precondition
 * is evaluated against the CURRENT stored ETag at write time, exactly as Azure
 * evaluates `If-Match`/`If-None-Match` server-side. Counts every inner call so
 * "zero remote operations" claims can be asserted.
 */
class FakeAtomicStore implements RunStore {
  readonly backend = 'azure-blob' as const;
  readonly conditionalWrites = 'atomic' as const;
  gets = 0;
  etagGets = 0;
  puts = 0;
  conditionalPuts = 0;
  private readonly values = new Map<string, { data: Buffer; etag: string }>();
  private nextEtag = 1;

  /** Commits a value with no precondition — stands in for "the other machine wrote". */
  commit(key: string, data: Buffer): void {
    this.values.set(key, { data: Buffer.from(data), etag: `etag-${this.nextEtag++}` });
  }

  peek(key: string): string | undefined {
    return this.values.get(key)?.data.toString('utf8');
  }

  async put(key: string, data: Buffer): Promise<void> {
    this.puts++;
    this.commit(key, data);
  }

  async get(key: string): Promise<Buffer> {
    this.gets++;
    const entry = this.values.get(key);
    if (!entry) throw new StoreNotFoundError(key);
    return Buffer.from(entry.data);
  }

  async getWithETag(key: string): Promise<{ data: Buffer; etag: string }> {
    this.etagGets++;
    const entry = this.values.get(key);
    if (!entry) throw new StoreNotFoundError(key);
    return { data: Buffer.from(entry.data), etag: entry.etag };
  }

  async putConditional(
    key: string,
    data: Buffer,
    conditions: ConditionalWriteConditions,
  ): Promise<void> {
    this.conditionalPuts++;
    const entry = this.values.get(key);
    if (conditions.ifNoneMatch === '*' && entry !== undefined) {
      throw new StoreConditionalWriteError(`${key} already exists`);
    }
    if (conditions.ifMatch !== undefined && entry?.etag !== conditions.ifMatch) {
      throw new StoreConditionalWriteError(`${key} etag mismatch`);
    }
    this.commit(key, data);
  }

  async has(key: string): Promise<boolean> {
    return this.values.has(key);
  }

  async list(prefix: string, _options?: ListOptions): Promise<readonly string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }

  resolve(key: string): string {
    return key;
  }
}

/** A store with no conditional-write support at all. */
class PlainStore implements RunStore {
  readonly backend = 'azure-blob' as const;
  private readonly values = new Map<string, Buffer>();
  async put(key: string, data: Buffer): Promise<void> {
    this.values.set(key, Buffer.from(data));
  }
  async get(key: string): Promise<Buffer> {
    const value = this.values.get(key);
    if (!value) throw new StoreNotFoundError(key);
    return Buffer.from(value);
  }
  async has(key: string): Promise<boolean> {
    return this.values.has(key);
  }
  async list(prefix: string, _options?: ListOptions): Promise<readonly string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
  resolve(key: string): string {
    return key;
  }
}

describe('run-store cache policy', () => {
  it('never caches the mutable coordination documents', () => {
    expect(isCacheableKey(WORKFLOW_STATE_KEY)).toBe(false);
    expect(isCacheableKey(STATE_KEY)).toBe(false);
    expect(isCacheableKey(INGEST_STATE_KEY)).toBe(false);
    expect(isCacheableKey(`${ISSUE_STATUS_KEY_PREFIX}/1234-abcdef.json`)).toBe(false);
  });

  it('excludes theme-set state for any set id, without excluding its artifacts', () => {
    expect(isCacheableKey(themeEquipmentSetStateKey('edo-samurai'))).toBe(false);
    expect(isCacheableKey(themeEquipmentSetStateKey('a'))).toBe(false);
    // Artifacts under the same set are immutable content and stay cacheable —
    // excluding them would make the set unreadable in offline mode.
    expect(isCacheableKey(ARTIFACT_KEY)).toBe(true);
    expect(isCacheableKey('theme-sets/edo-samurai/artifacts/katana/sheet.png')).toBe(true);
  });

  it('keeps the audited mutable-but-cacheable families cacheable', () => {
    // Rewritten by reruns, but never read to make a locking decision, and
    // required to be warm for offline reads. See cache-policy.ts.
    expect(isCacheableKey('iron-sword/run-abc/summary.json')).toBe(true);
    expect(isCacheableKey('workflow-state/briefs/iron-sword.yaml')).toBe(true);
  });

  it('does not exclude keys that merely resemble a coordination document', () => {
    expect(isCacheableKey('theme-sets/edo-samurai/state.json.bak')).toBe(true);
    expect(isCacheableKey('theme-sets/state.json')).toBe(true);
    expect(isCacheableKey('mirror/workflow-state/queue.json')).toBe(true);
  });
});

describe('CachingRunStore conditional writes', () => {
  let cacheDirA: string;
  let cacheDirB: string;
  let authoritative: FakeAtomicStore;
  let machineA: CachingRunStore;
  let machineB: CachingRunStore;

  const newCache = (dir: string): SharedResourceCache =>
    new SharedResourceCache({ cacheDir: dir, maxBytes: 0, log: noop });

  beforeEach(() => {
    cacheDirA = mkdtempSync(path.join(tmpdir(), 'crawler-cas-a-'));
    cacheDirB = mkdtempSync(path.join(tmpdir(), 'crawler-cas-b-'));
    authoritative = new FakeAtomicStore();
    machineA = new CachingRunStore({ inner: authoritative, cache: newCache(cacheDirA) });
    machineB = new CachingRunStore({ inner: authoritative, cache: newCache(cacheDirB) });
  });

  afterEach(async () => {
    await rm(cacheDirA, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(cacheDirB, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('exposes conditional-write methods only when the inner store implements them', () => {
    expect(typeof machineA.getWithETag).toBe('function');
    expect(typeof machineA.putConditional).toBe('function');
    expect(machineA.conditionalWrites).toBe('atomic');

    const plain = new CachingRunStore({ inner: new PlainStore(), cache: newCache(cacheDirA) });
    // Feature detection MUST fail for a non-CAS inner store — a prototype
    // method would make these truthy and silently downgrade callers to an
    // unconditional overwrite.
    expect(typeof plain.getWithETag).toBe('undefined');
    expect(typeof plain.putConditional).toBe('undefined');
    expect(plain.conditionalWrites).toBe('unsupported');
  });

  it('reads a coordination document written by another machine (no cache pinning)', async () => {
    authoritative.commit(STATE_KEY, Buffer.from('revision-40'));
    expect((await machineA.get(STATE_KEY)).toString('utf8')).toBe('revision-40');

    // The other machine advances the authoritative document. It cannot touch
    // machine A's local cache metadata.
    await machineB.put(STATE_KEY, Buffer.from('revision-59'));

    // Regression: this returned 'revision-40' forever before the fix.
    expect((await machineA.get(STATE_KEY)).toString('utf8')).toBe('revision-59');
    expect(await machineA.has(STATE_KEY)).toBe(true);
  });

  it('still serves cacheable artifacts from the cache', async () => {
    await machineA.put(ARTIFACT_KEY, Buffer.from('brief'));
    const before = authoritative.gets;
    expect((await machineA.get(ARTIFACT_KEY)).toString('utf8')).toBe('brief');
    expect(authoritative.gets).toBe(before);
  });

  it('rejects a conflicting conditional write instead of overwriting the winner', async () => {
    authoritative.commit(STATE_KEY, Buffer.from('revision-40'));
    const staleRead = await machineA.getWithETag!(STATE_KEY);

    // Machine B commits first using its own fresh ETag.
    const freshRead = await machineB.getWithETag!(STATE_KEY);
    await machineB.putConditional!(STATE_KEY, Buffer.from('revision-59'), {
      ifMatch: freshRead.etag,
    });

    await expect(
      machineA.putConditional!(STATE_KEY, Buffer.from('revision-41'), {
        ifMatch: staleRead.etag,
      }),
    ).rejects.toBeInstanceOf(StoreConditionalWriteError);

    // The winner's value survives, and the loser's bytes were never published.
    expect(authoritative.peek(STATE_KEY)).toBe('revision-59');
    expect((await machineA.get(STATE_KEY)).toString('utf8')).toBe('revision-59');
  });

  it('does not publish attempted bytes to the cache when a conditional write fails', async () => {
    await machineA.put(ARTIFACT_KEY, Buffer.from('committed'));
    await expect(
      machineA.putConditional!(ARTIFACT_KEY, Buffer.from('rejected'), {
        ifMatch: 'etag-does-not-exist',
      }),
    ).rejects.toBeInstanceOf(StoreConditionalWriteError);

    expect(authoritative.peek(ARTIFACT_KEY)).toBe('committed');
    expect((await machineA.get(ARTIFACT_KEY)).toString('utf8')).toBe('committed');
  });

  it('publishes to the cache after a successful conditional write', async () => {
    await machineA.put(ARTIFACT_KEY, Buffer.from('v1'));
    const read = await machineA.getWithETag!(ARTIFACT_KEY);
    await machineA.putConditional!(ARTIFACT_KEY, Buffer.from('v2'), { ifMatch: read.etag });

    const before = authoritative.gets;
    expect((await machineA.get(ARTIFACT_KEY)).toString('utf8')).toBe('v2');
    expect(authoritative.gets).toBe(before);
  });

  it('does not populate the blob cache from an ETag read', async () => {
    authoritative.commit(ARTIFACT_KEY, Buffer.from('etag-only'));
    await machineA.getWithETag!(ARTIFACT_KEY);

    // An ETag read cannot keep a cache entry coherent, so it must not seed one.
    const offline = new CachingRunStore({
      inner: authoritative,
      cache: newCache(cacheDirA),
      offline: true,
    });
    await expect(offline.get(ARTIFACT_KEY)).rejects.toBeInstanceOf(StoreNotFoundError);
  });

  it('rejects conditional operations in offline mode with zero inner calls', async () => {
    const offline = new CachingRunStore({
      inner: authoritative,
      cache: newCache(cacheDirA),
      offline: true,
    });
    const etagGetsBefore = authoritative.etagGets;
    const conditionalPutsBefore = authoritative.conditionalPuts;

    await expect(offline.getWithETag!(STATE_KEY)).rejects.toBeInstanceOf(StoreNotFoundError);
    await expect(
      offline.putConditional!(STATE_KEY, Buffer.from('x'), { ifNoneMatch: '*' }),
    ).rejects.toBeInstanceOf(StoreConditionalWriteError);

    expect(authoritative.etagGets).toBe(etagGetsBefore);
    expect(authoritative.conditionalPuts).toBe(conditionalPutsBefore);
  });
});
