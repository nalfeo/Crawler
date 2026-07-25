import { describe, expect, it } from 'vitest';
import {
  buildFingerprint,
  canonicalize,
  compareFingerprints,
  FINGERPRINT_VERSION,
  formatComparison,
  NON_DETERMINISTIC_TOP_LEVEL_KEYS,
  runLabel,
  type Fingerprint,
  type FingerprintRun,
  type FingerprintSample,
} from '../../scripts/agent/perf/sim-fingerprint-lib.js';

const SAMPLE: FingerprintSample = { seeds: [1, 2], weapons: ['bow', 'sword'], maxFrames: 100 };

function statsFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    totalFrames: 1200,
    wallTimeMs: 4321,
    gameTimeMs: 20_000,
    outcome: 'victory',
    finalLevel: 5,
    combat: { totalKills: 12, damageTaken: 34 },
    levelUps: [{ level: 2, atMs: 500 }],
    ...overrides,
  };
}

function fp(runs: FingerprintRun[], sample: FingerprintSample = SAMPLE): Fingerprint {
  return buildFingerprint(runs, sample);
}

describe('canonicalize', () => {
  it('sorts object keys so property order cannot affect the hash', () => {
    const a = canonicalize({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = canonicalize({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not drop keys on its own — stripping is the caller\u2019s top-level concern', () => {
    // A name-pattern strip would silently discard a future gameplay field whose
    // name happened to match, so canonicalize itself keeps everything.
    expect(canonicalize({ wallTimeMs: 10, wallHits: 4 })).toEqual({ wallTimeMs: 10, wallHits: 4 });
  });

  it('preserves array order and normalizes sparse holes to null', () => {
    // Array order is simulation-meaningful (event sequences), so it must NOT be
    // sorted away — only object key order is normalized.
    expect(canonicalize([3, 1, 2])).toEqual([3, 1, 2]);
    // eslint-disable-next-line no-sparse-arrays
    expect(canonicalize([1, , 3])).toEqual([1, null, 3]);
  });

  it('normalizes negative zero so a sign flip is not reported as drift', () => {
    expect(Object.is(canonicalize(-0), 0)).toBe(true);
  });

  it('omits undefined object properties', () => {
    expect(canonicalize({ a: undefined, b: 1 })).toEqual({ b: 1 });
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('throws on %s rather than letting JSON collapse it to null', (_label, value) => {
    // JSON.stringify turns all three — and a literal null — into `null`, so
    // genuinely different simulations would otherwise share a hash.
    expect(() => canonicalize({ combat: { dps: value } })).toThrow(/Non-finite number/);
  });

  it('names the dotted path of the offending non-finite value', () => {
    expect(() => canonicalize({ combat: { dps: Number.NaN } })).toThrow(/"combat\.dps"/);
  });

  it.each([
    ['Map', new Map([['a', 1]])],
    ['Set', new Set([1, 2])],
  ])('throws on a %s rather than canonicalizing it to an empty object', (_label, value) => {
    expect(() => canonicalize({ tally: value })).toThrow(/Unsupported (Map|Set)/);
  });

  it.each([
    ['Date', new Date(0)],
    ['RegExp', /a/],
    ['Error', new Error('boom')],
    [
      'class instance',
      new (class Point {
        x = 1;
      })(),
    ],
  ])('throws on a %s whose own keys do not capture its value', (_label, value) => {
    // Same collision class as Map/Set: distinct Dates/RegExps have no enumerable
    // own keys, so they would all canonicalize to {} and share a hash.
    expect(() => canonicalize({ field: value })).toThrow(/Unsupported/);
  });

  it('accepts null-prototype objects, which do capture their value in own keys', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });
    expect(canonicalize({ field: bare })).toEqual({ field: { a: 1 } });
  });
});

describe('buildFingerprint', () => {
  it('is stable regardless of run ordering', () => {
    const runs = [
      { weapon: 'sword', seed: 1, stats: statsFixture() },
      { weapon: 'bow', seed: 2, stats: statsFixture({ finalLevel: 6 }) },
    ];
    const forward = fp(runs);
    const reversed = fp([...runs].reverse());
    expect(forward.hash).toBe(reversed.hash);
    expect(forward.runs).toEqual(reversed.runs);
  });

  it('ignores wall-clock differences between identical simulations', () => {
    const a = fp([{ weapon: 'sword', seed: 1, stats: statsFixture() }]);
    const b = fp([{ weapon: 'sword', seed: 1, stats: statsFixture({ wallTimeMs: 99_999 }) }]);
    expect(a.hash).toBe(b.hash);
  });

  it('only strips wall-clock keys at the top level', () => {
    // A nested field that happens to share the name is gameplay data until
    // someone deliberately adds it to the allowlist.
    const a = fp([
      { weapon: 'sword', seed: 1, stats: statsFixture({ combat: { wallTimeMs: 1 } }) },
    ]);
    const b = fp([
      { weapon: 'sword', seed: 1, stats: statsFixture({ combat: { wallTimeMs: 2 } }) },
    ]);
    expect(a.hash).not.toBe(b.hash);
  });

  it('exposes the excluded keys as an explicit allowlist', () => {
    expect([...NON_DETERMINISTIC_TOP_LEVEL_KEYS]).toEqual(['wallTimeMs']);
  });

  it('changes when any gameplay field changes', () => {
    const a = fp([{ weapon: 'sword', seed: 1, stats: statsFixture() }]);
    const b = fp([
      { weapon: 'sword', seed: 1, stats: statsFixture({ combat: { totalKills: 13 } }) },
    ]);
    expect(a.hash).not.toBe(b.hash);
  });

  it('rejects duplicate runs rather than silently collapsing them', () => {
    expect(() =>
      fp([
        { weapon: 'sword', seed: 1, stats: statsFixture() },
        { weapon: 'sword', seed: 1, stats: statsFixture() },
      ]),
    ).toThrow(/Duplicate fingerprint runs: sword:1/);
  });

  it('stamps the current schema version', () => {
    expect(fp([]).version).toBe(FINGERPRINT_VERSION);
  });

  it('records a normalized sample so mismatched workloads are detectable', () => {
    const built = fp([], { seeds: [3, 1, 2], weapons: ['sword', 'bow'], maxFrames: 42 });
    expect(built.sample).toEqual({ seeds: [1, 2, 3], weapons: ['bow', 'sword'], maxFrames: 42 });
  });
});

describe('compareFingerprints', () => {
  it('reports identical fingerprints as clean', () => {
    const runs = [{ weapon: 'sword', seed: 1, stats: statsFixture() }];
    const comparison = compareFingerprints(fp(runs), fp(runs));
    expect(comparison.identical).toBe(true);
    expect(comparison.drifts).toEqual([]);
    expect(comparison.sampleMismatch).toBeNull();
  });

  it('names the exact divergent field path', () => {
    const baseline = fp([{ weapon: 'sword', seed: 1, stats: statsFixture() }]);
    const current = fp([
      {
        weapon: 'sword',
        seed: 1,
        stats: statsFixture({ combat: { totalKills: 12, damageTaken: 99 } }),
      },
    ]);
    const comparison = compareFingerprints(baseline, current);
    expect(comparison.identical).toBe(false);
    expect(comparison.drifts).toHaveLength(1);
    expect(comparison.drifts[0]?.kind).toBe('changed');
    expect(comparison.drifts[0]?.fields).toEqual([
      { path: 'combat.damageTaken', baseline: 34, current: 99 },
    ]);
  });

  it('flags runs present in only one fingerprint', () => {
    const baseline = fp([{ weapon: 'sword', seed: 1, stats: statsFixture() }]);
    const current = fp([{ weapon: 'bow', seed: 1, stats: statsFixture() }]);
    const comparison = compareFingerprints(baseline, current);
    expect(comparison.drifts.map((d) => [d.label, d.kind])).toEqual([
      ['bow:1', 'added'],
      ['sword:1', 'missing'],
    ]);
  });

  it('treats a schema version mismatch as drift so stale baselines are never trusted', () => {
    const runs = [{ weapon: 'sword', seed: 1, stats: statsFixture() }];
    const stale: Fingerprint = { ...fp(runs), version: FINGERPRINT_VERSION - 1 };
    const comparison = compareFingerprints(stale, fp(runs));
    expect(comparison.identical).toBe(false);
    expect(comparison.versionMismatch).toBe(true);
    expect(formatComparison(comparison)).toMatch(/version mismatch/i);
  });

  it('reports a differing sample as a mismatch instead of as gameplay drift', () => {
    // Without this, narrowing --check against a full-gate baseline reports every
    // uncovered run as "drift" and sends the reader hunting a nonexistent bug.
    const runs = [{ weapon: 'sword', seed: 1, stats: statsFixture() }];
    const baseline = fp(runs, { seeds: [1, 2], weapons: ['bow', 'sword'], maxFrames: 100 });
    const current = fp(runs, { seeds: [1], weapons: ['sword'], maxFrames: 100 });
    const comparison = compareFingerprints(baseline, current);
    expect(comparison.identical).toBe(false);
    expect(comparison.sampleMismatch).toMatch(/baseline covers/);
    expect(comparison.drifts).toEqual([]);
    const report = formatComparison(comparison);
    expect(report).toMatch(/Sample mismatch/);
    expect(report).toMatch(/NOT a gameplay finding/);
  });

  it('reports a baseline with no sample metadata as a mismatch', () => {
    const runs = [{ weapon: 'sword', seed: 1, stats: statsFixture() }];
    const legacy = { ...fp(runs), sample: undefined } as unknown as Fingerprint;
    const comparison = compareFingerprints(legacy, fp(runs));
    expect(comparison.sampleMismatch).toMatch(/no recorded sample metadata/);
  });
});

describe('formatComparison', () => {
  it('truncates long field lists with a remainder count', () => {
    const baseline = fp([{ weapon: 'sword', seed: 1, stats: { a: 1, b: 1, c: 1 } }]);
    const current = fp([{ weapon: 'sword', seed: 1, stats: { a: 2, b: 2, c: 2 } }]);
    const report = formatComparison(compareFingerprints(baseline, current), 2);
    expect(report).toMatch(/and 1 more field/);
  });

  it('scopes the clean message to RunStats rather than claiming full neutrality', () => {
    const runs = [{ weapon: 'sword', seed: 1, stats: statsFixture() }];
    expect(formatComparison(compareFingerprints(fp(runs), fp(runs)))).toMatch(/RunStats identical/);
  });
});

describe('runLabel', () => {
  it('formats a weapon/seed pair', () => {
    expect(runLabel({ weapon: 'baseball-bat', seed: 7 })).toBe('baseball-bat:7');
  });
});
