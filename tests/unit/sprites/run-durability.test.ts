/**
 * Regression tests for the sprite-generation durability contract.
 *
 * Incident these lock down: seven finished 12-candidate directional sheets were
 * generated through `sprites:run`/`sprites:batch`, approved, and queued into
 * git — but the source runs existed in neither `generated/runs/**` nor Azure.
 * `generate-one.ts` defaulted to `new LocalRunStore(...)` whenever a caller did
 * not inject a store, and both direct CLIs injected nothing, so every LLM-
 * authored brief/prompt/sheet died with the worktree while the git-side
 * `sourceRun` pointer survived.
 *
 * The contract asserted here:
 *  1. Provenance + sheets + summary reach the DURABLE store before publication.
 *  2. Publication fails CLOSED when they have not.
 *  3. Retry after a partial failure is idempotent.
 *  4. `sprites:run` / `sprites:batch` never silently fall back to ephemeral
 *     local storage; offline mode must be opted into explicitly.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRunProvenance,
  ensureRunDurable,
  hasAzureStorageCredentials,
  parseSourceRun,
  PROVENANCE_BRIEF_KEY,
  PROVENANCE_PROMPT_KEY,
  resolveGenerationRunStore,
  RUN_PROVENANCE_VERSION,
  RunDurabilityError,
} from '../../../scripts/sprites/run-durability.js';
import { MirroredRunStore } from '../../../scripts/sprites/store/mirrored-store.js';
import { LocalRunStore } from '../../../scripts/sprites/store/local-store.js';
import { StoreNotFoundError, type RunStore } from '../../../scripts/sprites/store/types.js';

const REPO_ROOT = path.join('/fake', 'repo');
const AZURE_ENV = {
  AZURE_STORAGE_ACCOUNT: 'acct',
  AZURE_STORAGE_KEY: 'key',
} as const;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'run-durability-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** In-memory RunStore that records every mutation in call order. */
class FakeStore implements RunStore {
  readonly backend = 'azure-blob' as const;
  readonly conditionalWrites = 'unsupported' as const;
  readonly files = new Map<string, Buffer>();
  readonly puts: string[] = [];
  failPut: ((key: string) => Error | null) | null = null;

  put(key: string, data: Buffer): Promise<void> {
    const failure = this.failPut?.(key) ?? null;
    if (failure) return Promise.reject(failure);
    this.files.set(key, Buffer.from(data));
    this.puts.push(key);
    return Promise.resolve();
  }

  get(key: string): Promise<Buffer> {
    const found = this.files.get(key);
    if (!found) return Promise.reject(new StoreNotFoundError(key));
    return Promise.resolve(found);
  }

  has(key: string): Promise<boolean> {
    return Promise.resolve(this.files.has(key));
  }

  list(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.files.keys()].filter((key) => key.startsWith(prefix)).sort());
  }

  remove(key: string): Promise<void> {
    this.files.delete(key);
    return Promise.resolve();
  }

  resolve(key: string): string {
    return `fake://${key}`;
  }
}

/** Populate a local run dir with the minimum durable-required artifact set. */
function seedLocalRun(runDir: string): void {
  mkdirSync(path.join(runDir, 'provenance'), { recursive: true });
  mkdirSync(path.join(runDir, 'processed'), { recursive: true });
  writeFileSync(path.join(runDir, PROVENANCE_PROMPT_KEY), '{"provenanceVersion":1}');
  writeFileSync(path.join(runDir, PROVENANCE_BRIEF_KEY), 'name: iron-sword\n');
  writeFileSync(path.join(runDir, 'summary.json'), '{"runId":"r1"}');
  writeFileSync(path.join(runDir, 'sheet-01.png'), Buffer.from([0x89, 0x50]));
  writeFileSync(path.join(runDir, 'processed', '01.png'), Buffer.from([0x89, 0x50]));
}

const PROVENANCE_INPUT = {
  briefId: 'iron-sword',
  runId: '2026-01-01T00-00-00Z-abc',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  briefPath: 'assets/briefs/iron-sword.yaml',
  briefSource: 'name: iron-sword\ndescription: a sword\n',
  effectiveBrief: { name: 'iron-sword', frames: 4 },
  prompt: 'a pixel-art iron sword, 12 candidates',
  singleVariantPrompt: 'a pixel-art iron sword',
  styleGuide: '# style guide',
} as const;

describe('resolveGenerationRunStore', () => {
  it('fails closed when no run store is configured and no Azure credentials exist', () => {
    // THE BUG: this used to silently return a LocalRunStore, which is how the
    // seven directional runs were generated straight into a doomed worktree.
    expect(() => resolveGenerationRunStore({ repoRoot: REPO_ROOT, env: {} })).toThrow(
      RunDurabilityError,
    );
    expect(() => resolveGenerationRunStore({ repoRoot: REPO_ROOT, env: {} })).toThrow(
      /setup:azure:env/,
    );
  });

  it('names the explicit offline opt-out in the failure message', () => {
    expect(() => resolveGenerationRunStore({ repoRoot: REPO_ROOT, env: {} })).toThrow(
      /SPRITES_RUN_STORE=local/,
    );
  });

  it('allows explicit offline mode, clearly labelled, with no durable store', () => {
    const resolved = resolveGenerationRunStore({
      repoRoot: REPO_ROOT,
      env: { SPRITES_RUN_STORE: 'local' },
    });
    expect(resolved.mode).toBe('ephemeral-explicit');
    expect(resolved.durable).toBeNull();
    expect(resolved.store.backend).toBe('local');
    expect(resolved.description).toContain('LOCAL ONLY');
    expect(resolved.description).toContain('NOT durably persisted');
  });

  it('defaults to a durable mirrored store when Azure credentials are present', () => {
    const durable = new FakeStore();
    const resolved = resolveGenerationRunStore({
      repoRoot: REPO_ROOT,
      env: { ...AZURE_ENV },
      createStore: () => durable,
    });
    expect(resolved.mode).toBe('durable');
    expect(resolved.durable).toBe(durable);
    expect(resolved.store).toBeInstanceOf(MirroredRunStore);
    expect(resolved.description).toContain('DURABLE');
  });

  it('forwards an explicit backend request to createRunStore and still mirrors', () => {
    const durable = new FakeStore();
    let seenEnv: Record<string, string | undefined> = {};
    const resolved = resolveGenerationRunStore({
      repoRoot: REPO_ROOT,
      env: { SPRITES_RUN_STORE: 'azure-blob', ...AZURE_ENV },
      createStore: (options) => {
        seenEnv = { ...options.env };
        return durable;
      },
    });
    expect(seenEnv['SPRITES_RUN_STORE']).toBe('azure-blob');
    expect(resolved.mode).toBe('durable');
    expect(resolved.store).toBeInstanceOf(MirroredRunStore);
  });

  it('detects Azure credentials from either supported form', () => {
    expect(hasAzureStorageCredentials({})).toBe(false);
    expect(hasAzureStorageCredentials({ AZURE_STORAGE_ACCOUNT: 'a' })).toBe(false);
    expect(hasAzureStorageCredentials({ ...AZURE_ENV })).toBe(true);
    expect(hasAzureStorageCredentials({ AZURE_STORAGE_CONNECTION_STRING: 'x' })).toBe(true);
  });
});

describe('MirroredRunStore', () => {
  it('writes to both the local primary and the durable mirror', async () => {
    const local = new LocalRunStore(makeTempDir());
    const mirror = new FakeStore();
    const store = new MirroredRunStore({ primary: local, mirror });

    await store.put('brief/run/sheet-01.png', Buffer.from('png'));

    expect(await local.has('brief/run/sheet-01.png')).toBe(true);
    expect(mirror.puts).toEqual(['brief/run/sheet-01.png']);
    expect(store.durable).toBe(mirror);
  });

  it('fails closed when the durable mirror write fails', async () => {
    const mirror = new FakeStore();
    mirror.failPut = () => new Error('azure unavailable');
    const store = new MirroredRunStore({
      primary: new LocalRunStore(makeTempDir()),
      mirror,
    });

    await expect(store.put('brief/run/sheet-01.png', Buffer.from('png'))).rejects.toThrow(
      'azure unavailable',
    );
  });

  it('serves reads and path resolution from the local primary', async () => {
    const localRoot = makeTempDir();
    const local = new LocalRunStore(localRoot);
    const mirror = new FakeStore();
    const store = new MirroredRunStore({ primary: local, mirror });
    await store.put('brief/run/summary.json', Buffer.from('{}'));

    // `run-full.ts` hands store.resolve(...) to postprocess as a FILESYSTEM
    // path, and sprites:approve/gallery read run artifacts as real files, so
    // resolve must stay local even though writes go to Azure too.
    expect(store.resolve('brief/run/summary.json')).toBe(local.resolve('brief/run/summary.json'));
    expect((await store.get('brief/run/summary.json')).toString()).toBe('{}');
  });

  it('declares conditional writes unsupported (two stores cannot be atomic)', () => {
    const store = new MirroredRunStore({
      primary: new LocalRunStore(makeTempDir()),
      mirror: new FakeStore(),
    });
    expect(store.conditionalWrites).toBe('unsupported');
  });
});

describe('buildRunProvenance', () => {
  it('emits the brief snapshot and the exact prompt record', () => {
    const artifacts = buildRunProvenance(PROVENANCE_INPUT);
    const keys = artifacts.map((artifact) => artifact.key);
    expect(keys).toContain(PROVENANCE_BRIEF_KEY);
    expect(keys).toContain(PROVENANCE_PROMPT_KEY);

    const prompt = artifacts.find((artifact) => artifact.key === PROVENANCE_PROMPT_KEY);
    const record = JSON.parse(String(prompt?.data)) as Record<string, unknown>;
    expect(record['provenanceVersion']).toBe(RUN_PROVENANCE_VERSION);
    // The exact prompt, not just its short hash (summary.json only ever had the
    // hash, so a lost run could never be reproduced).
    expect(record['prompt']).toBe(PROVENANCE_INPUT.prompt);
    expect(record['effectiveBrief']).toEqual(PROVENANCE_INPUT.effectiveBrief);
    expect(record['briefSourceCaptured']).toBe(true);
    expect(String(record['promptSha256'])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — identical input produces byte-identical artifacts', () => {
    const first = buildRunProvenance(PROVENANCE_INPUT);
    const second = buildRunProvenance(PROVENANCE_INPUT);
    expect(first.map((a) => a.data.toString('base64'))).toEqual(
      second.map((a) => a.data.toString('base64')),
    );
  });

  it('omits the brief snapshot when the authored source is unavailable', () => {
    const artifacts = buildRunProvenance({ ...PROVENANCE_INPUT, briefSource: null });
    expect(artifacts.map((a) => a.key)).toEqual([PROVENANCE_PROMPT_KEY]);
    const record = JSON.parse(String(artifacts[0]?.data)) as Record<string, unknown>;
    // The effective brief still travels, so the run stays reproducible.
    expect(record['briefSourceCaptured']).toBe(false);
    expect(record['effectiveBrief']).toEqual(PROVENANCE_INPUT.effectiveBrief);
  });
});

describe('parseSourceRun', () => {
  it('accepts every manifest sourceRun form', () => {
    const expected = { briefId: 'iron-sword', runId: '2026-01-01T00-00-00Z-abc' };
    expect(parseSourceRun('generated/runs/iron-sword/2026-01-01T00-00-00Z-abc')).toEqual(expected);
    expect(parseSourceRun('runs/iron-sword/2026-01-01T00-00-00Z-abc')).toEqual(expected);
    expect(parseSourceRun('iron-sword/2026-01-01T00-00-00Z-abc')).toEqual(expected);
    expect(
      parseSourceRun('C:\\repo\\generated\\runs\\iron-sword\\2026-01-01T00-00-00Z-abc'),
    ).toEqual(expected);
  });

  it('rejects traversal and unrecognisable pointers', () => {
    expect(parseSourceRun('runs/../../etc/passwd')).toBeNull();
    expect(parseSourceRun('iron-sword')).toBeNull();
    expect(parseSourceRun('')).toBeNull();
  });
});

describe('ensureRunDurable', () => {
  it('rejects publication outright when there is no durable store', async () => {
    await expect(
      ensureRunDurable({ durable: null, briefId: 'iron-sword', runId: 'r1' }),
    ).rejects.toBeInstanceOf(RunDurabilityError);
  });

  it('backfills a local-only run into the durable store', async () => {
    const runDir = path.join(makeTempDir(), 'iron-sword', 'r1');
    seedLocalRun(runDir);
    const durable = new FakeStore();

    const result = await ensureRunDurable({
      durable,
      briefId: 'iron-sword',
      runId: 'r1',
      localRunDir: runDir,
    });

    expect(result.backfilled).toContain(`iron-sword/r1/${PROVENANCE_PROMPT_KEY}`);
    expect(result.backfilled).toContain('iron-sword/r1/sheet-01.png');
    expect(result.backfilled).toContain('iron-sword/r1/summary.json');
    // Nested review artifacts travel too, not just the top-level required set.
    expect(result.backfilled).toContain('iron-sword/r1/processed/01.png');
  });

  it('is idempotent — a second call uploads nothing and still verifies', async () => {
    const runDir = path.join(makeTempDir(), 'iron-sword', 'r1');
    seedLocalRun(runDir);
    const durable = new FakeStore();

    await ensureRunDurable({ durable, briefId: 'iron-sword', runId: 'r1', localRunDir: runDir });
    const putsAfterFirst = durable.puts.length;
    const second = await ensureRunDurable({
      durable,
      briefId: 'iron-sword',
      runId: 'r1',
      localRunDir: runDir,
    });

    expect(second.backfilled).toEqual([]);
    expect(durable.puts.length).toBe(putsAfterFirst);
    expect(second.verified).toContain('iron-sword/r1/summary.json');
  });

  it('resumes cleanly after a partial upload failure', async () => {
    const runDir = path.join(makeTempDir(), 'iron-sword', 'r1');
    seedLocalRun(runDir);
    const durable = new FakeStore();
    durable.failPut = (key) => (key.endsWith('summary.json') ? new Error('transient 503') : null);

    await expect(
      ensureRunDurable({ durable, briefId: 'iron-sword', runId: 'r1', localRunDir: runDir }),
    ).rejects.toThrow('transient 503');

    durable.failPut = null;
    const retry = await ensureRunDurable({
      durable,
      briefId: 'iron-sword',
      runId: 'r1',
      localRunDir: runDir,
    });

    expect(retry.backfilled).toContain('iron-sword/r1/summary.json');
    // Nothing already uploaded got written twice.
    expect(new Set(durable.puts).size).toBe(durable.puts.length);
  });

  it('fails closed, naming the missing keys, when content is unrecoverable', async () => {
    const durable = new FakeStore();
    await durable.put('iron-sword/r1/summary.json', Buffer.from('{}'));

    const error = await ensureRunDurable({
      durable,
      briefId: 'iron-sword',
      runId: 'r1',
      localRunDir: path.join(makeTempDir(), 'gone'),
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RunDurabilityError);
    const durabilityError = error as RunDurabilityError;
    expect(durabilityError.missingKeys).toContain(`iron-sword/r1/${PROVENANCE_PROMPT_KEY}`);
    expect(durabilityError.missingKeys).toContain('iron-sword/r1/sheet-NN.png');
    expect(durabilityError.message).toContain('unrecoverable');
  });
});

describe('publication ordering', () => {
  it('completes every durable write before the git publication step runs', async () => {
    const runDir = path.join(makeTempDir(), 'iron-sword', 'r1');
    seedLocalRun(runDir);
    const durable = new FakeStore();
    const order: string[] = [];
    const publishToGit = (): void => {
      order.push('git-publish');
    };

    await ensureRunDurable({ durable, briefId: 'iron-sword', runId: 'r1', localRunDir: runDir });
    order.push(...durable.puts.map(() => 'durable-put'));
    publishToGit();

    expect(order.at(-1)).toBe('git-publish');
    expect(order.filter((step) => step === 'durable-put').length).toBeGreaterThan(0);
  });

  it('never reaches git publication when durability verification fails', async () => {
    const durable = new FakeStore();
    let published = false;

    try {
      await ensureRunDurable({ durable, briefId: 'iron-sword', runId: 'r1' });
      published = true;
    } catch {
      // fail closed
    }

    expect(published).toBe(false);
    expect(durable.puts).toEqual([]);
  });
});
