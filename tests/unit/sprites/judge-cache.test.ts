/**
 * Unit tests for the filesystem-backed VLM judge cache.
 *
 * Coverage:
 *   - Key determinism: identical inputs → identical key.
 *   - Variant PNG byte change → different key.
 *   - Reference PNG byte change → different key.
 *   - Reference ORDER matters (a permutation of refs is a different scene).
 *   - Reference COUNT matters (length-prefixed hashing prevents [A,B] vs [AB]
 *     collisions).
 *   - Different model deployments produce different keys.
 *   - Prompt-template-version bump invalidates prior keys.
 *   - Hit path: `get` returns a stored scorecard and bumps `stats.hits`.
 *   - Miss path: `get` returns null on empty cache; `put` then `get` round-trips.
 *   - LRU eviction: when entry count exceeds the cap, the OLDEST scorecard
 *     and its sibling meta file are removed.
 *   - `enabled: false` bypasses both `get` and `put` and bumps `stats.bypassed`.
 *   - `prune(maxAgeHours)` removes entries older than the cutoff and
 *     returns the count.
 *   - `meta.json` sibling written alongside the scorecard.
 */

import {
  mkdtempSync,
  existsSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { JudgeCache } from '../../../scripts/sprites/judge-cache.js';
import type { JudgeScorecard } from '../../../scripts/sprites/judge.js';

function tmpCacheDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'judge-cache-'));
}

function makeScorecard(variantIndex = 0): JudgeScorecard {
  return {
    variantIndex,
    modelDeployment: 'gpt-4o-vision',
    judgedAt: '2026-06-05T14:30:00.000Z',
    styleMatch: { score: 5, rationale: 'great' },
    briefMatch: { score: 4, rationale: 'good' },
    readability: { score: 5, rationale: 'crisp' },
    passed: true,
    minScore: 4,
    rejectedBy: [],
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  };
}

function baseInputs() {
  return {
    modelDeployment: 'gpt-4o-vision',
    promptTemplateVersion: 'v1',
    systemInstructions: 'System rubric for enemy normal.',
    userPrompt: 'Judge this enemy normal candidate.',
    variantPng: Buffer.from([1, 2, 3, 4, 5]),
    referencePngs: [Buffer.from([10, 11, 12]), Buffer.from([20, 21, 22])],
    briefMatchInstructions: 'A vertical iron sword.',
    floor: 1,
    designLanguageAddenda: '',
  };
}

describe('JudgeCache.computeKey', () => {
  const cache = new JudgeCache({ cacheDir: tmpCacheDir() });

  it('is deterministic for identical inputs', () => {
    const a = cache.computeKey(baseInputs());
    const b = cache.computeKey(baseInputs());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the variant PNG bytes change', () => {
    const a = cache.computeKey(baseInputs());
    const b = cache.computeKey({ ...baseInputs(), variantPng: Buffer.from([1, 2, 3, 4, 99]) });
    expect(a).not.toBe(b);
  });

  it('changes when a reference PNG byte changes', () => {
    const a = cache.computeKey(baseInputs());
    const b = cache.computeKey({
      ...baseInputs(),
      referencePngs: [Buffer.from([10, 11, 99]), Buffer.from([20, 21, 22])],
    });
    expect(a).not.toBe(b);
  });

  it('changes when reference order changes', () => {
    const a = cache.computeKey(baseInputs());
    const b = cache.computeKey({
      ...baseInputs(),
      referencePngs: [baseInputs().referencePngs[1]!, baseInputs().referencePngs[0]!],
    });
    expect(a).not.toBe(b);
  });

  it('distinguishes [A, B] from [AB] via length prefix', () => {
    const a = cache.computeKey({
      ...baseInputs(),
      referencePngs: [Buffer.from([1, 2]), Buffer.from([3, 4])],
    });
    const b = cache.computeKey({
      ...baseInputs(),
      referencePngs: [Buffer.from([1, 2, 3, 4])],
    });
    expect(a).not.toBe(b);
  });

  it('distinguishes different model deployments', () => {
    const a = cache.computeKey(baseInputs());
    const b = cache.computeKey({ ...baseInputs(), modelDeployment: 'gpt-4-turbo' });
    expect(a).not.toBe(b);
  });

  it('distinguishes different prompt template versions', () => {
    const a = cache.computeKey(baseInputs());
    const b = cache.computeKey({ ...baseInputs(), promptTemplateVersion: 'v2' });
    expect(a).not.toBe(b);
  });

  it('distinguishes different brief match instructions', () => {
    const a = cache.computeKey(baseInputs());
    const b = cache.computeKey({
      ...baseInputs(),
      briefMatchInstructions: 'A red sword instead.',
    });
    expect(a).not.toBe(b);
  });

  it('distinguishes identical inputs judged at different floors', () => {
    const a = cache.computeKey({ ...baseInputs(), floor: 1 });
    const b = cache.computeKey({ ...baseInputs(), floor: 20 });
    expect(a).not.toBe(b);
  });

  it('distinguishes different floor or theme addenda', () => {
    const a = cache.computeKey(baseInputs());
    const b = cache.computeKey({
      ...baseInputs(),
      designLanguageAddenda: 'A family-specific visual direction.',
    });
    expect(a).not.toBe(b);
  });

  it('distinguishes different rendered prompt contracts', () => {
    const a = cache.computeKey(baseInputs());
    const b = cache.computeKey({
      ...baseInputs(),
      systemInstructions: 'System rubric for enemy boss (requires boss_presence).',
      userPrompt: 'Judge this boss enemy candidate.',
    });
    expect(a).not.toBe(b);
  });
});

describe('JudgeCache.get / put round trip', () => {
  it('returns null on a fresh cache', () => {
    const cache = new JudgeCache({ cacheDir: tmpCacheDir() });
    const key = cache.computeKey(baseInputs());
    expect(cache.get(key)).toBeNull();
  });

  it('persists and replays a scorecard', () => {
    const cache = new JudgeCache({ cacheDir: tmpCacheDir() });
    const key = cache.computeKey(baseInputs());
    const card = makeScorecard(3);
    cache.put(key, card, { variantPath: '/tmp/variant.png', briefId: 'iron-sword' });
    const hit = cache.get(key);
    expect(hit).toEqual(card);
    expect(cache.stats.hits).toBe(1);
    expect(cache.stats.misses).toBe(1);
  });

  it('writes a sibling meta.json describing the cached call', () => {
    const dir = tmpCacheDir();
    const cache = new JudgeCache({ cacheDir: dir });
    const key = cache.computeKey(baseInputs());
    cache.put(key, makeScorecard(), { variantPath: '/tmp/v.png', briefId: 'brief-1' });
    const metaFile = path.join(dir, `${key}.meta.json`);
    expect(existsSync(metaFile)).toBe(true);
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    expect(meta.variantPath).toBe('/tmp/v.png');
    expect(meta.briefId).toBe('brief-1');
    expect(typeof meta.cachedAt).toBe('string');
  });

  it('treats a corrupt scorecard file as a miss', () => {
    const dir = tmpCacheDir();
    const cache = new JudgeCache({ cacheDir: dir });
    const key = cache.computeKey(baseInputs());
    cache.put(key, makeScorecard(), { variantPath: '/tmp/v.png', briefId: 'brief' });
    // Corrupt it.
    writeFileSync(path.join(dir, `${key}.json`), 'garbage{');
    expect(cache.get(key)).toBeNull();
  });
});

describe('JudgeCache hit short-circuits the provider call', () => {
  it('a mock provider is NOT called on the second `get`', () => {
    // Simulate the orchestrator pattern: compute key, get; if null, call
    // provider then put. Second time around: get returns, provider stays cold.
    let providerCalls = 0;
    const mockProviderCall = () => {
      providerCalls += 1;
      return makeScorecard();
    };

    const cache = new JudgeCache({ cacheDir: tmpCacheDir() });
    const key = cache.computeKey(baseInputs());

    // First run: miss -> call provider -> put.
    let card = cache.get(key);
    if (card == null) {
      card = mockProviderCall();
      cache.put(key, card, { variantPath: '/tmp/v.png', briefId: 'brief' });
    }
    expect(providerCalls).toBe(1);

    // Second run: hit -> provider stays cold.
    card = cache.get(key);
    expect(card).not.toBeNull();
    expect(providerCalls).toBe(1);
  });
});

describe('JudgeCache LRU eviction', () => {
  it('removes the oldest entry when cap is exceeded', async () => {
    const dir = tmpCacheDir();
    const cache = new JudgeCache({ cacheDir: dir, maxEntries: 3 });

    const keys: string[] = [];
    for (let i = 0; i < 3; i++) {
      const k = cache.computeKey({
        ...baseInputs(),
        variantPng: Buffer.from([i, i, i, i]),
      });
      keys.push(k);
      cache.put(k, makeScorecard(i), { variantPath: `/v/${i}.png`, briefId: `b${i}` });
      // Backdate mtimes so the oldest is unambiguously oldest.
      const past = new Date(2026, 0, 1, 0, 0, i);
      utimesSync(path.join(dir, `${k}.json`), past, past);
    }
    expect(cache.size()).toBe(3);

    // Insert a fourth, which exceeds maxEntries=3 -> evicts oldest (keys[0]).
    const k4 = cache.computeKey({ ...baseInputs(), variantPng: Buffer.from([9, 9, 9, 9]) });
    cache.put(k4, makeScorecard(99), { variantPath: '/v/9.png', briefId: 'b9' });
    expect(cache.size()).toBe(3);
    expect(existsSync(path.join(dir, `${keys[0]!}.json`))).toBe(false);
    expect(existsSync(path.join(dir, `${keys[0]!}.meta.json`))).toBe(false);
    expect(existsSync(path.join(dir, `${k4}.json`))).toBe(true);
  });

  it('refuses a non-positive maxEntries', () => {
    expect(() => new JudgeCache({ cacheDir: tmpCacheDir(), maxEntries: 0 })).toThrow();
  });
});

describe('JudgeCache enabled: false bypasses I/O', () => {
  it('get returns null and bumps stats.bypassed without reading', () => {
    const dir = tmpCacheDir();
    // Seed the dir with a scorecard via an enabled cache.
    const seed = new JudgeCache({ cacheDir: dir });
    const key = seed.computeKey(baseInputs());
    seed.put(key, makeScorecard(), { variantPath: '/v.png', briefId: 'b' });

    const disabled = new JudgeCache({ cacheDir: dir, enabled: false });
    expect(disabled.get(key)).toBeNull();
    expect(disabled.stats.bypassed).toBe(1);
    expect(disabled.stats.hits).toBe(0);
  });

  it('put is a no-op and bumps stats.bypassed', () => {
    const dir = tmpCacheDir();
    const cache = new JudgeCache({ cacheDir: dir, enabled: false });
    const key = cache.computeKey(baseInputs());
    cache.put(key, makeScorecard(), { variantPath: '/v.png', briefId: 'b' });
    expect(existsSync(path.join(dir, `${key}.json`))).toBe(false);
    expect(cache.stats.bypassed).toBe(1);
    expect(cache.stats.misses).toBe(0);
  });
});

describe('JudgeCache.prune', () => {
  it('removes entries older than the cutoff and returns the count', () => {
    const dir = tmpCacheDir();
    // Inject a fixed "now" so the cutoff math is deterministic.
    const now = new Date('2026-06-05T12:00:00Z');
    const cache = new JudgeCache({ cacheDir: dir, now: () => now });

    const oldKey = cache.computeKey({ ...baseInputs(), variantPng: Buffer.from([1]) });
    const newKey = cache.computeKey({ ...baseInputs(), variantPng: Buffer.from([2]) });
    cache.put(oldKey, makeScorecard(0), { variantPath: '/old.png', briefId: 'old' });
    cache.put(newKey, makeScorecard(1), { variantPath: '/new.png', briefId: 'new' });

    // Backdate oldKey to 48 hours ago.
    const fortyEightHoursAgo = new Date(now.getTime() - 48 * 3600 * 1000);
    utimesSync(path.join(dir, `${oldKey}.json`), fortyEightHoursAgo, fortyEightHoursAgo);

    const removed = cache.prune(24);
    expect(removed).toBe(1);
    expect(existsSync(path.join(dir, `${oldKey}.json`))).toBe(false);
    expect(existsSync(path.join(dir, `${newKey}.json`))).toBe(true);
  });

  it('returns 0 when the cache dir does not exist', () => {
    const cache = new JudgeCache({ cacheDir: path.join(tmpdir(), 'never-created-cache') });
    expect(cache.prune(1)).toBe(0);
  });
});

describe('JudgeCache.get touches mtime on hit (LRU freshness)', () => {
  it('frequently-hit entries do not age out under LRU', () => {
    const dir = tmpCacheDir();
    const cache = new JudgeCache({ cacheDir: dir });
    const key = cache.computeKey(baseInputs());
    cache.put(key, makeScorecard(), { variantPath: '/v.png', briefId: 'b' });

    const file = path.join(dir, `${key}.json`);
    // Backdate to 1 hour ago.
    const past = new Date(Date.now() - 3600 * 1000);
    utimesSync(file, past, past);
    const beforeMtime = statSync(file).mtimeMs;

    cache.get(key);
    const afterMtime = statSync(file).mtimeMs;
    expect(afterMtime).toBeGreaterThan(beforeMtime);
  });
});
