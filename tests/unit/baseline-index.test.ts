import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildBaselineIndex,
  toBaselineIndexEntry,
  writeBaselineIndex,
} from '../../scripts/agent/perf/baseline-index.js';
import {
  evaluateBaselineRegression,
  type BaselineFile,
  type BaselineIndexEntry,
} from '../../scripts/agent/perf/baseline-regression-check.js';

function baseline(overrides: Partial<BaselineFile> = {}): BaselineFile {
  return {
    meta: {
      commit: 'a'.repeat(40),
      commitDate: '2026-08-01T00:00:00Z',
      commitSubject: 'feat: something',
      capturedAt: '2026-08-01T01:00:00Z',
      runUrl: 'https://example.invalid/run/1',
      sweep: { seeds: '1-50', kind: 'winrate', revision: 2 },
    },
    winRate: 0.98,
    totalWins: 294,
    totalRuns: 300,
    legs: {
      floor1: { winRate: 0.98, totalWins: 294, totalRuns: 300 },
      floor2: { winRate: 0.6, totalWins: 90, totalRuns: 150 },
    },
    ...overrides,
  };
}

describe('release baseline index derivation', () => {
  it('preserves every field the regression check reads from a previous entry', () => {
    const entry = toBaselineIndexEntry(baseline());
    // `legs` and `sweepRevision` are load-bearing: dropping them disabled all
    // per-leg diagnostics and turned every resize into a silent migration.
    expect(entry.legs).toEqual(baseline().legs);
    expect(entry.sweepRevision).toBe(2);
    expect(entry.path).toBe(`by-sha/${'a'.repeat(40)}.json`);
  });

  it('projects rich stored legs to compact index metrics', () => {
    const rich = baseline() as BaselineFile & {
      legs: Record<
        string,
        { winRate: number; totalWins: number; totalRuns: number; runs?: unknown[] }
      >;
    };
    rich.legs.floor2!.runs = [{ large: 'run payload' }];

    const entry = toBaselineIndexEntry(rich);

    expect(entry.legs?.floor2).toEqual({ winRate: 0.6, totalWins: 90, totalRuns: 150 });
    expect(entry.legs?.floor2).not.toHaveProperty('runs');
  });

  it('omits legs and revision for a pre-multi-floor baseline', () => {
    const legacy = baseline();
    delete legacy.legs;
    delete legacy.meta.sweep;
    const entry = toBaselineIndexEntry(legacy);
    expect('legs' in entry).toBe(false);
    expect('sweepRevision' in entry).toBe(false);
  });

  it('sorts newest commit date first and drops entries without a commit', () => {
    const older = baseline({
      meta: { ...baseline().meta, commit: 'b'.repeat(40), commitDate: '2026-07-01T00:00:00Z' },
    });
    const entries = buildBaselineIndex([older, baseline(), { winRate: 1 }]);
    expect(entries.map((e) => e.commitDate)).toEqual([
      '2026-08-01T00:00:00Z',
      '2026-07-01T00:00:00Z',
    ]);
  });

  it('associates valid fun reports and leaves missing or malformed reports unavailable', () => {
    const valid = baseline();
    const malformed = baseline({
      meta: { ...baseline().meta, commit: 'b'.repeat(40), commitDate: '2026-07-01T00:00:00Z' },
    });
    const missing = baseline({
      meta: { ...baseline().meta, commit: 'c'.repeat(40), commitDate: '2026-06-01T00:00:00Z' },
    });
    const reports = new Map<string, unknown>([
      [valid.meta.commit, { report: { overall_fun_score: 73.5, gate: { pass: true } } }],
      [malformed.meta.commit, { report: { overall_fun_score: 'high', gate: {} } }],
    ]);

    expect(
      buildBaselineIndex([missing, malformed, valid], reports).map((entry) => entry.fun),
    ).toEqual([
      {
        overallFunScore: 73.5,
        gatePass: true,
        path: `by-sha/${valid.meta.commit}.fun-report.json`,
      },
      null,
      null,
    ]);
  });

  it('round-trips through the published index into a per-leg comparison', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'baseline-index-'));
    try {
      mkdirSync(path.join(dir, 'by-sha'));
      const previous = baseline();
      writeFileSync(
        path.join(dir, 'by-sha', `${previous.meta.commit}.json`),
        JSON.stringify(previous),
      );
      writeFileSync(
        path.join(dir, 'by-sha', `${previous.meta.commit}.fun-report.json`),
        JSON.stringify({ report: { overall_fun_score: 81, gate: { pass: false } } }),
      );
      writeFileSync(path.join(dir, 'by-sha', 'broken.fun-report.json'), '{');
      writeBaselineIndex(dir);

      const index = JSON.parse(
        readFileSync(path.join(dir, 'index.json'), 'utf8'),
      ) as BaselineIndexEntry[];
      expect(index).toHaveLength(1);
      expect(index[0]?.fun).toEqual({
        overallFunScore: 81,
        gatePass: false,
        path: `by-sha/${previous.meta.commit}.fun-report.json`,
      });
      const current = baseline({
        meta: { ...previous.meta, commit: 'c'.repeat(40) },
        winRate: 0.98,
        totalWins: 294,
        totalRuns: 300,
        legs: {
          floor1: { winRate: 0.98, totalWins: 294, totalRuns: 300 },
          floor2: { winRate: 0.4, totalWins: 60, totalRuns: 150 },
        },
      });

      const decision = evaluateBaselineRegression(current, index, [previous.meta.commit]);
      const floor2 = decision.legs?.find((leg) => leg.legId === 'floor2');
      expect(floor2?.regression, 'per-leg diagnostics survive the published index').toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
