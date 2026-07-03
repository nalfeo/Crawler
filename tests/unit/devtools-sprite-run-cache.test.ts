import { describe, expect, it } from 'vitest';
import {
  RUN_CACHE_STORAGE_KEY,
  isPromotedFilter,
  normalizePromotedFilter,
  readRunCache,
  resolveRunPickerSelection,
  sanitizeRunEntry,
  writeRunCache,
  type PromotedFilter,
} from '../../src/devtools/sprite-run-cache.js';
import type { SidecarRunListEntry } from '../../src/devtools/sprite-approval-api.js';

function makeRun(overrides: Partial<SidecarRunListEntry> = {}): SidecarRunListEntry {
  return {
    briefId: 'iron-sword',
    runId: '2026-07-03T12-00-00-deadbeef',
    timestamp: '2026-07-03T12:00:00.000Z',
    briefHash: 'abc123',
    chosenIndex: 1,
    candidateCount: 4,
    hasJudge: true,
    promotionState: 'not-promoted',
    ...overrides,
  };
}

describe('sprite-run-cache', () => {
  it('exposes a versioned storage key', () => {
    expect(RUN_CACHE_STORAGE_KEY).toBe('crawler.devtools.sprite-run-cache.v1');
  });

  describe('isPromotedFilter / normalizePromotedFilter', () => {
    it('accepts the three known filters and rejects anything else', () => {
      expect(isPromotedFilter('all')).toBe(true);
      expect(isPromotedFilter('promoted')).toBe(true);
      expect(isPromotedFilter('not-promoted')).toBe(true);
      expect(isPromotedFilter('nonsense')).toBe(false);
      expect(isPromotedFilter(null)).toBe(false);
      expect(isPromotedFilter(undefined)).toBe(false);
    });

    it('defaults unknown values to all', () => {
      expect(normalizePromotedFilter('promoted')).toBe('promoted');
      expect(normalizePromotedFilter('bogus')).toBe('all');
      expect(normalizePromotedFilter(42)).toBe('all');
    });
  });

  describe('sanitizeRunEntry', () => {
    it('accepts a fully-formed entry and returns a fresh object', () => {
      const input = makeRun();
      const sanitized = sanitizeRunEntry(input);
      expect(sanitized).toEqual(input);
      expect(sanitized).not.toBe(input);
    });

    it('accepts the nullable fields as null', () => {
      const sanitized = sanitizeRunEntry(
        makeRun({ timestamp: null, briefHash: null, chosenIndex: null, candidateCount: null }),
      );
      expect(sanitized).not.toBeNull();
      expect(sanitized?.timestamp).toBeNull();
      expect(sanitized?.chosenIndex).toBeNull();
    });

    it.each([
      ['non-object', 42],
      ['null', null],
      ['missing briefId', { ...makeRun(), briefId: undefined }],
      ['empty briefId', makeRun({ briefId: '' })],
      ['missing runId', { ...makeRun(), runId: undefined }],
      ['non-boolean hasJudge', { ...makeRun(), hasJudge: 'yes' }],
      ['bad promotionState', { ...makeRun(), promotionState: 'maybe' }],
      ['non-integer chosenIndex', { ...makeRun(), chosenIndex: 1.5 }],
      ['string timestamp wrong type', { ...makeRun(), timestamp: 123 }],
    ])('rejects %s', (_label, value) => {
      expect(sanitizeRunEntry(value)).toBeNull();
    });
  });

  describe('write + read round-trip', () => {
    it('round-trips a run list for a filter', () => {
      const runs = [makeRun(), makeRun({ briefId: 'oak-shield', runId: 'run-2' })];
      const raw = writeRunCache(null, 'all', runs);
      expect(readRunCache(raw, 'all')).toEqual(runs);
    });

    it('returns null for a filter that was never cached (distinct from cached empty)', () => {
      const raw = writeRunCache(null, 'all', [makeRun()]);
      expect(readRunCache(raw, 'promoted')).toBeNull();
    });

    it('preserves the null-vs-empty distinction: a cached empty list reads back as []', () => {
      const raw = writeRunCache(null, 'promoted', []);
      expect(readRunCache(raw, 'promoted')).toEqual([]);
      // ...while an untouched filter is still null.
      expect(readRunCache(raw, 'all')).toBeNull();
    });

    it('merges a new filter slot without clobbering the others', () => {
      const allRuns = [makeRun()];
      const promotedRuns = [makeRun({ briefId: 'oak-shield', promotionState: 'promoted' })];
      let raw = writeRunCache(null, 'all', allRuns);
      raw = writeRunCache(raw, 'promoted', promotedRuns);
      expect(readRunCache(raw, 'all')).toEqual(allRuns);
      expect(readRunCache(raw, 'promoted')).toEqual(promotedRuns);
    });

    it('overwrites an existing slot on re-write', () => {
      let raw = writeRunCache(null, 'all', [makeRun()]);
      raw = writeRunCache(raw, 'all', []);
      expect(readRunCache(raw, 'all')).toEqual([]);
    });

    it('decouples the stored copy from the caller-supplied array', () => {
      const runs = [makeRun()];
      const raw = writeRunCache(null, 'all', runs);
      runs[0] = makeRun({ briefId: 'mutated' });
      expect(readRunCache(raw, 'all')?.[0]?.briefId).toBe('iron-sword');
    });
  });

  describe('malformed / hostile input tolerance', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
      ['not JSON', '{not json'],
      ['JSON array', '[]'],
      ['JSON primitive', '42'],
      ['missing byFilter', JSON.stringify({ version: 1 })],
      ['version mismatch', JSON.stringify({ version: 99, byFilter: { all: [] } })],
    ])('reads null for %s', (_label, raw) => {
      expect(readRunCache(raw as string | null | undefined, 'all')).toBeNull();
    });

    it('drops malformed entries but keeps the valid ones in a slot', () => {
      const raw = JSON.stringify({
        version: 1,
        byFilter: { all: [makeRun(), { briefId: '' }, 'garbage', makeRun({ runId: 'ok-2' })] },
      });
      const runs = readRunCache(raw, 'all');
      expect(runs).toHaveLength(2);
      expect(runs?.map((run) => run.runId)).toEqual(['2026-07-03T12-00-00-deadbeef', 'ok-2']);
    });

    it('replaces a version-mismatched envelope on the next write, keeping only the new slot', () => {
      const stale = JSON.stringify({ version: 0, byFilter: { all: [makeRun()] } });
      const raw = writeRunCache(stale, 'promoted', [makeRun({ promotionState: 'promoted' })]);
      expect(readRunCache(raw, 'all')).toBeNull();
      expect(readRunCache(raw, 'promoted')).toHaveLength(1);
    });

    it('starts a fresh envelope when the existing value is unparseable', () => {
      const raw = writeRunCache('{corrupt', 'all', [makeRun()]);
      expect(readRunCache(raw, 'all')).toHaveLength(1);
    });
  });

  describe('resolveRunPickerSelection', () => {
    const keys = ['iron-sword::run-1', 'oak-shield::run-2'];

    it('keeps the operator selection when it still exists (survives a background refresh)', () => {
      expect(resolveRunPickerSelection('oak-shield::run-2', keys, 'iron-sword::run-1')).toBe(
        'oak-shield::run-2',
      );
    });

    it('falls back to the fallback key when the previous selection is gone', () => {
      expect(resolveRunPickerSelection('deleted::run-9', keys, 'iron-sword::run-1')).toBe(
        'iron-sword::run-1',
      );
    });

    it('returns empty when neither the selection nor the fallback exist', () => {
      expect(resolveRunPickerSelection('deleted::run-9', keys, 'also-gone::run-8')).toBe('');
    });

    it('returns empty when there was no selection and no fallback', () => {
      expect(resolveRunPickerSelection('', keys)).toBe('');
    });

    it('ignores an empty previousKey and uses the fallback', () => {
      expect(resolveRunPickerSelection('', keys, 'oak-shield::run-2')).toBe('oak-shield::run-2');
    });
  });

  it('keys and reads all three promoted filters independently', () => {
    const filters: PromotedFilter[] = ['all', 'promoted', 'not-promoted'];
    let raw: string | null = null;
    for (const filter of filters) {
      raw = writeRunCache(raw, filter, [makeRun({ briefId: filter })]);
    }
    for (const filter of filters) {
      expect(readRunCache(raw, filter)?.[0]?.briefId).toBe(filter);
    }
  });
});
