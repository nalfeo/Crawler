import { describe, expect, it } from 'vitest';
import {
  buildFingerprint,
  canonicalize,
  compareFingerprints,
  FINGERPRINT_VERSION,
  formatComparison,
  runLabel,
  type Fingerprint,
} from '../../scripts/agent/perf/sim-fingerprint-lib.js';

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

describe('canonicalize', () => {
  it('sorts object keys so property order cannot affect the hash', () => {
    const a = canonicalize({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = canonicalize({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('drops wall-clock keys at any depth', () => {
    const result = canonicalize({
      wallTimeMs: 10,
      nested: { wallClockTimeMs: 3, wallTimeSec: 1, gameTimeMs: 7 },
    }) as Record<string, Record<string, unknown>>;
    expect(result).not.toHaveProperty('wallTimeMs');
    expect(result.nested).toEqual({ gameTimeMs: 7 });
  });

  it('keeps deterministic keys whose names merely contain "wall"', () => {
    const result = canonicalize({ wallHits: 4, wallTimeMs: 9 }) as Record<string, unknown>;
    expect(result).toEqual({ wallHits: 4 });
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
});

describe('buildFingerprint', () => {
  it('is stable regardless of run ordering', () => {
    const runs = [
      { weapon: 'sword', seed: 1, stats: statsFixture() },
      { weapon: 'bow', seed: 2, stats: statsFixture({ finalLevel: 6 }) },
    ];
    const forward = buildFingerprint(runs);
    const reversed = buildFingerprint([...runs].reverse());
    expect(forward.hash).toBe(reversed.hash);
    expect(forward.runs).toEqual(reversed.runs);
  });

  it('ignores wall-clock differences between identical simulations', () => {
    const a = buildFingerprint([{ weapon: 'sword', seed: 1, stats: statsFixture() }]);
    const b = buildFingerprint([
      { weapon: 'sword', seed: 1, stats: statsFixture({ wallTimeMs: 99_999 }) },
    ]);
    expect(a.hash).toBe(b.hash);
  });

  it('changes when any gameplay field changes', () => {
    const a = buildFingerprint([{ weapon: 'sword', seed: 1, stats: statsFixture() }]);
    const b = buildFingerprint([
      { weapon: 'sword', seed: 1, stats: statsFixture({ combat: { totalKills: 13 } }) },
    ]);
    expect(a.hash).not.toBe(b.hash);
  });

  it('rejects duplicate runs rather than silently collapsing them', () => {
    expect(() =>
      buildFingerprint([
        { weapon: 'sword', seed: 1, stats: statsFixture() },
        { weapon: 'sword', seed: 1, stats: statsFixture() },
      ]),
    ).toThrow(/Duplicate fingerprint runs: sword:1/);
  });

  it('stamps the current schema version', () => {
    expect(buildFingerprint([]).version).toBe(FINGERPRINT_VERSION);
  });
});

describe('compareFingerprints', () => {
  it('reports identical fingerprints as clean', () => {
    const runs = [{ weapon: 'sword', seed: 1, stats: statsFixture() }];
    const comparison = compareFingerprints(buildFingerprint(runs), buildFingerprint(runs));
    expect(comparison.identical).toBe(true);
    expect(comparison.drifts).toEqual([]);
  });

  it('names the exact divergent field path', () => {
    const baseline = buildFingerprint([{ weapon: 'sword', seed: 1, stats: statsFixture() }]);
    const current = buildFingerprint([
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
    const baseline = buildFingerprint([{ weapon: 'sword', seed: 1, stats: statsFixture() }]);
    const current = buildFingerprint([{ weapon: 'bow', seed: 1, stats: statsFixture() }]);
    const comparison = compareFingerprints(baseline, current);
    expect(comparison.drifts.map((d) => [d.label, d.kind])).toEqual([
      ['bow:1', 'added'],
      ['sword:1', 'missing'],
    ]);
  });

  it('treats a schema version mismatch as drift so stale baselines are never trusted', () => {
    const runs = [{ weapon: 'sword', seed: 1, stats: statsFixture() }];
    const stale: Fingerprint = { ...buildFingerprint(runs), version: FINGERPRINT_VERSION - 1 };
    const comparison = compareFingerprints(stale, buildFingerprint(runs));
    expect(comparison.identical).toBe(false);
    expect(comparison.versionMismatch).toBe(true);
    expect(formatComparison(comparison)).toMatch(/version mismatch/i);
  });
});

describe('formatComparison', () => {
  it('truncates long field lists with a remainder count', () => {
    const baseline = buildFingerprint([{ weapon: 'sword', seed: 1, stats: { a: 1, b: 1, c: 1 } }]);
    const current = buildFingerprint([{ weapon: 'sword', seed: 1, stats: { a: 2, b: 2, c: 2 } }]);
    const report = formatComparison(compareFingerprints(baseline, current), 2);
    expect(report).toMatch(/and 1 more field/);
  });
});

describe('runLabel', () => {
  it('formats a weapon/seed pair', () => {
    expect(runLabel({ weapon: 'baseball-bat', seed: 7 })).toBe('baseball-bat:7');
  });
});
