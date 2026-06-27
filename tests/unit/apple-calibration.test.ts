import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import {
  type AppleEntry,
  type Verdict,
  MISS_THRESHOLD,
  VALID_VERDICTS,
  coerceApples,
  computeCalibration,
  isMiss,
  normalizeEntry,
  normalizeVerdict,
  verdictEmoji,
  verdictFromDelta,
} from '../../scripts/agent/docs/apple-calibration-lib.js';

/**
 * Regression coverage for the apple-calibration NaN/undefined bug (issue #335).
 *
 * The nightly `docs-apple-calibration` report surfaced `Mean delta: NaN` and an
 * `undefined on-target` verdict because historical apple entries use legacy
 * shapes (field aliases, 🍎-emoji counts, the `on-target` verdict, missing
 * `delta`). These tests pin the normalization + aggregation logic so a single
 * malformed row can never again poison the aggregate.
 */

function entry(overrides: Partial<AppleEntry> = {}): AppleEntry {
  const estimated_apples = overrides.estimated_apples ?? 2;
  const actual_apples = overrides.actual_apples ?? estimated_apples;
  const delta = overrides.delta ?? actual_apples - estimated_apples;
  return {
    session: overrides.session ?? 's',
    estimated_apples,
    actual_apples,
    delta,
    verdict: overrides.verdict ?? verdictFromDelta(delta),
    hello_kitties: overrides.hello_kitties ?? actual_apples / 5,
    ...(overrides.date ? { date: overrides.date } : {}),
  };
}

describe('coerceApples', () => {
  it('passes through finite numbers, including zero', () => {
    expect(coerceApples(3)).toBe(3);
    expect(coerceApples(0)).toBe(0);
  });

  it('parses numeric strings, trimming whitespace', () => {
    expect(coerceApples('4')).toBe(4);
    expect(coerceApples('  5  ')).toBe(5);
  });

  it('counts 🍎 emoji strings (legacy handoff format)', () => {
    expect(coerceApples('🍎')).toBe(1);
    expect(coerceApples('🍎🍎🍎')).toBe(3);
  });

  it('returns undefined for empty, blank, or non-numeric strings', () => {
    expect(coerceApples('')).toBeUndefined();
    expect(coerceApples('   ')).toBeUndefined();
    expect(coerceApples('abc')).toBeUndefined();
  });

  it('returns undefined for non-finite numbers and non-string/number values', () => {
    expect(coerceApples(Number.NaN)).toBeUndefined();
    expect(coerceApples(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(coerceApples(null)).toBeUndefined();
    expect(coerceApples(undefined)).toBeUndefined();
    expect(coerceApples({})).toBeUndefined();
  });
});

describe('verdictFromDelta', () => {
  it('maps delta sign to verdict (positive = underestimate)', () => {
    expect(verdictFromDelta(0)).toBe('exact');
    expect(verdictFromDelta(1)).toBe('under');
    expect(verdictFromDelta(-1)).toBe('over');
  });

  it('treats |delta| >= MISS_THRESHOLD as a miss', () => {
    expect(verdictFromDelta(MISS_THRESHOLD)).toBe('miss');
    expect(verdictFromDelta(-MISS_THRESHOLD)).toBe('miss');
    expect(verdictFromDelta(3)).toBe('miss');
  });
});

describe('normalizeVerdict', () => {
  it('accepts canonical verdicts case-insensitively', () => {
    for (const v of VALID_VERDICTS) {
      expect(normalizeVerdict(v)).toBe(v);
      expect(normalizeVerdict(v.toUpperCase())).toBe(v);
    }
  });

  it('maps the legacy on-target label to exact', () => {
    expect(normalizeVerdict('on-target')).toBe('exact');
    expect(normalizeVerdict('on target')).toBe('exact');
    expect(normalizeVerdict('  On-Target ')).toBe('exact');
  });

  it('returns undefined for unknown strings and non-strings', () => {
    expect(normalizeVerdict('bogus')).toBeUndefined();
    expect(normalizeVerdict(42)).toBeUndefined();
    expect(normalizeVerdict(null)).toBeUndefined();
  });
});

describe('verdictEmoji', () => {
  it('returns a distinct emoji per canonical verdict', () => {
    expect(verdictEmoji('exact')).toBe('🎯');
    expect(verdictEmoji('under')).toBe('📉');
    expect(verdictEmoji('over')).toBe('📈');
    expect(verdictEmoji('miss')).toBe('💥');
  });

  it('falls back to ❓ instead of printing undefined for an unexpected verdict', () => {
    expect(verdictEmoji('on-target' as unknown as Verdict)).toBe('❓');
  });
});

describe('isMiss', () => {
  it('is true only when |delta| >= MISS_THRESHOLD', () => {
    expect(isMiss(0)).toBe(false);
    expect(isMiss(1)).toBe(false);
    expect(isMiss(-1)).toBe(false);
    expect(isMiss(2)).toBe(true);
    expect(isMiss(-2)).toBe(true);
    expect(isMiss(5)).toBe(true);
  });
});

describe('normalizeEntry', () => {
  it('passes a canonical entry through unchanged', () => {
    const result = normalizeEntry({
      date: '2026-06-26',
      session: '2026-06-26-foo',
      estimated_apples: 3,
      actual_apples: 4,
      delta: 1,
      verdict: 'under',
      hello_kitties: 0.8,
    });
    expect(result).toEqual({
      date: '2026-06-26',
      session: '2026-06-26-foo',
      estimated_apples: 3,
      actual_apples: 4,
      delta: 1,
      verdict: 'under',
      hello_kitties: 0.8,
    });
  });

  it('resolves legacy field aliases (estimate/estimated, actual, slug)', () => {
    const fromEstimate = normalizeEntry({ slug: 'legacy-a', estimate: 2, actual: 2 });
    expect(fromEstimate).toMatchObject({
      session: 'legacy-a',
      estimated_apples: 2,
      actual_apples: 2,
    });

    const fromEstimated = normalizeEntry({ slug: 'legacy-b', estimated: 3, actual: 1 });
    expect(fromEstimated).toMatchObject({
      session: 'legacy-b',
      estimated_apples: 3,
      actual_apples: 1,
    });
  });

  it('counts emoji apple values', () => {
    const result = normalizeEntry({
      session: 's',
      estimated_apples: '🍎🍎',
      actual_apples: '🍎🍎🍎',
    });
    expect(result).toMatchObject({ estimated_apples: 2, actual_apples: 3, delta: 1 });
  });

  it('maps the on-target verdict to exact', () => {
    const result = normalizeEntry({
      session: 's',
      estimated_apples: 2,
      actual_apples: 2,
      verdict: 'on-target',
    });
    expect(result?.verdict).toBe('exact');
  });

  it('derives delta from actual - estimated when delta is missing', () => {
    const result = normalizeEntry({ session: 's', estimated_apples: 2, actual_apples: 5 });
    expect(result?.delta).toBe(3);
    expect(result?.verdict).toBe('miss');
  });

  it('derives hello_kitties from actual / 5 when missing, rounded to 2dp', () => {
    const result = normalizeEntry({ session: 's', estimated_apples: 3, actual_apples: 3 });
    expect(result?.hello_kitties).toBe(0.6);
  });

  it('derives session from slug, falling back to (unknown)', () => {
    expect(
      normalizeEntry({ slug: 'only-slug', estimated_apples: 1, actual_apples: 1 })?.session,
    ).toBe('only-slug');
    expect(normalizeEntry({ estimated_apples: 1, actual_apples: 1 })?.session).toBe('(unknown)');
  });

  it('omits the date key entirely when absent', () => {
    const result = normalizeEntry({ session: 's', estimated_apples: 1, actual_apples: 1 });
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('date');
  });

  it('rejects entries that lack a usable estimate or actual (returns null)', () => {
    expect(normalizeEntry({ session: 's', actual_apples: 2 })).toBeNull();
    expect(normalizeEntry({ session: 's', estimated_apples: 2 })).toBeNull();
    expect(
      normalizeEntry({ session: 's', estimated_apples: 'abc', actual_apples: 'xyz' }),
    ).toBeNull();
    expect(normalizeEntry({})).toBeNull();
  });
});

describe('computeCalibration', () => {
  it('returns finite zeros for an empty input (never NaN)', () => {
    const stats = computeCalibration([]);
    expect(stats.totalSessions).toBe(0);
    expect(stats.meanDelta).toBe(0);
    expect(stats.missCount).toBe(0);
    expect(stats.missRate).toBe(0);
    expect(stats.byLevel.size).toBe(0);
    expect(stats.byVerdict.size).toBe(0);
  });

  it('aggregates mean delta, miss rate, by-level, and by-verdict', () => {
    const entries: AppleEntry[] = [
      entry({ estimated_apples: 1, actual_apples: 1, verdict: 'exact' }),
      entry({ estimated_apples: 2, actual_apples: 3, verdict: 'under' }),
      entry({ estimated_apples: 2, actual_apples: 0, verdict: 'miss' }),
      entry({ estimated_apples: 3, actual_apples: 2, verdict: 'over' }),
    ];
    const stats = computeCalibration(entries);

    expect(stats.totalSessions).toBe(4);
    expect(stats.meanDelta).toBeCloseTo(-0.5, 10);
    expect(stats.missCount).toBe(1);
    expect(stats.missRate).toBeCloseTo(0.25, 10);

    expect(stats.byLevel.get(1)).toEqual({ count: 1, meanDelta: 0, missRate: 0 });
    expect(stats.byLevel.get(2)).toEqual({ count: 2, meanDelta: -0.5, missRate: 0.5 });
    expect(stats.byLevel.get(3)).toEqual({ count: 1, meanDelta: -1, missRate: 0 });

    expect(stats.byVerdict.get('exact')).toBe(1);
    expect(stats.byVerdict.get('under')).toBe(1);
    expect(stats.byVerdict.get('miss')).toBe(1);
    expect(stats.byVerdict.get('over')).toBe(1);
  });

  it('never produces NaN for any set of finite-delta entries (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            estimated_apples: fc.integer({ min: 1, max: 5 }),
            actual_apples: fc.integer({ min: 0, max: 10 }),
          }),
          { minLength: 1, maxLength: 50 },
        ),
        (rows) => {
          const entries = rows.map((r) =>
            entry({ estimated_apples: r.estimated_apples, actual_apples: r.actual_apples }),
          );
          const stats = computeCalibration(entries);
          expect(Number.isFinite(stats.meanDelta)).toBe(true);
          expect(Number.isFinite(stats.missRate)).toBe(true);
          for (const level of stats.byLevel.values()) {
            expect(Number.isFinite(level.meanDelta)).toBe(true);
            expect(Number.isFinite(level.missRate)).toBe(true);
          }
        },
      ),
    );
  });
});

describe('end-to-end normalization invariants (issue #335 regression)', () => {
  it('a feed of mixed legacy + canonical + malformed rows yields a finite report', () => {
    const raw = [
      {
        date: '2026-06-26',
        session: 'canonical',
        estimated_apples: 2,
        actual_apples: 2,
        delta: 0,
        verdict: 'exact',
        hello_kitties: 0.4,
      },
      { slug: 'legacy-aliases', estimate: 3, actual: 4 },
      { session: 'emoji', estimated_apples: '🍎🍎', actual_apples: '🍎🍎🍎🍎' },
      { slug: 'on-target-verdict', estimate: 1, actual: 1, verdict: 'on-target' },
      { session: 'broken', notes: 'no estimate or actual at all' },
    ];
    const normalized = raw.map((r) => normalizeEntry(r)).filter((e): e is AppleEntry => e !== null);

    // The single broken row is rejected; the rest survive.
    expect(normalized).toHaveLength(4);

    const stats = computeCalibration(normalized);
    expect(Number.isFinite(stats.meanDelta)).toBe(true);
    expect(stats.byVerdict.has('exact')).toBe(true);
    // No `undefined` verdict bucket can exist — every verdict is canonical.
    for (const v of stats.byVerdict.keys()) {
      expect(VALID_VERDICTS).toContain(v);
    }
  });
});
