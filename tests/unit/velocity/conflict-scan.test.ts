import { describe, expect, it } from 'vitest';
import {
  buildReport,
  classify,
  computeOverlaps,
  deriveFindings,
  parseGitLog,
  render,
  type ConflictReport,
} from '../../../scripts/agent/velocity/conflict-scan';

const NOW = '2026-08-01T00:00:00.000Z';

function log(entries: Array<{ sha: string; day: string; files: string[] }>): string {
  return entries
    .map((e) => [`\x01${e.sha}\t${e.day}`, ...e.files].join('\n'))
    .join('\n\n')
    .concat('\n');
}

describe('classify', () => {
  it('treats code extensions as source', () => {
    expect(classify('src/core/world.ts')).toBe('source');
    expect(classify('.github/scripts/ci-recovery/router.mjs')).toBe('source');
    expect(classify('scripts/agent/preflight.sh')).toBe('source');
  });

  it('treats docs, data and config as non-source', () => {
    expect(classify('docs/knowledge/handoffs/INDEX.md')).toBe('non-source');
    expect(classify('package.json')).toBe('non-source');
    expect(classify('.github/workflows/ci.yml')).toBe('non-source');
  });
});

describe('parseGitLog', () => {
  it('groups paths under the preceding commit header', () => {
    const commits = parseGitLog(
      log([
        { sha: 'aaa', day: '2026-07-01', files: ['a.ts', 'b.md'] },
        { sha: 'bbb', day: '2026-07-02', files: ['a.ts'] },
      ]),
    );
    expect(commits).toEqual([
      { sha: 'aaa', day: '2026-07-01', files: ['a.ts', 'b.md'] },
      { sha: 'bbb', day: '2026-07-02', files: ['a.ts'] },
    ]);
  });

  it('ignores malformed headers and stray paths before the first commit', () => {
    const commits = parseGitLog('orphan.ts\n\x01broken\n\x01ccc\t2026-07-03\nc.ts\n');
    expect(commits).toEqual([{ sha: 'ccc', day: '2026-07-03', files: ['c.ts'] }]);
  });

  it('truncates a full timestamp to a calendar day', () => {
    expect(parseGitLog('\x01ddd\t2026-07-04T12:00:00Z\nd.ts\n')[0]?.day).toBe('2026-07-04');
  });
});

describe('computeOverlaps', () => {
  it('charges one overlap event per extra same-day commit', () => {
    const overlaps = computeOverlaps(
      parseGitLog(
        log([
          { sha: 'a', day: '2026-07-01', files: ['INDEX.md'] },
          { sha: 'b', day: '2026-07-01', files: ['INDEX.md'] },
          { sha: 'c', day: '2026-07-01', files: ['INDEX.md'] },
        ]),
      ),
    );
    expect(overlaps).toEqual([
      {
        path: 'INDEX.md',
        category: 'non-source',
        touches: 3,
        overlapEvents: 2,
        contendedDays: 1,
      },
    ]);
  });

  it('does not charge overlap for touches on different days', () => {
    const overlaps = computeOverlaps(
      parseGitLog(
        log([
          { sha: 'a', day: '2026-07-01', files: ['x.ts'] },
          { sha: 'b', day: '2026-07-02', files: ['x.ts'] },
        ]),
      ),
    );
    expect(overlaps[0]).toMatchObject({ touches: 2, overlapEvents: 0, contendedDays: 0 });
  });

  it('counts a duplicated path within one commit only once', () => {
    const overlaps = computeOverlaps([{ sha: 'a', day: '2026-07-01', files: ['x.ts', 'x.ts'] }]);
    expect(overlaps[0]).toMatchObject({ touches: 1, overlapEvents: 0 });
  });

  it('ranks the most contended file first', () => {
    const overlaps = computeOverlaps(
      parseGitLog(
        log([
          { sha: 'a', day: '2026-07-01', files: ['hot.md', 'cool.ts'] },
          { sha: 'b', day: '2026-07-01', files: ['hot.md', 'cool.ts'] },
          { sha: 'c', day: '2026-07-01', files: ['hot.md'] },
        ]),
      ),
    );
    expect(overlaps.map((o) => o.path)).toEqual(['hot.md', 'cool.ts']);
  });

  it('returns nothing for empty history', () => {
    expect(computeOverlaps([])).toEqual([]);
  });
});

describe('buildReport', () => {
  const commits = parseGitLog(
    log([
      { sha: 'a', day: '2026-07-01', files: ['docs/INDEX.md', 'src/a.ts'] },
      { sha: 'b', day: '2026-07-01', files: ['docs/INDEX.md', 'src/b.ts'] },
      { sha: 'c', day: '2026-07-02', files: ['docs/INDEX.md'] },
    ]),
  );

  it('splits the rate by category', () => {
    const report = buildReport(commits, 120, NOW);
    // INDEX.md: 3 touches, 1 overlap event. Source: 2 touches, 0 overlaps.
    expect(report.nonSource).toEqual({
      touches: 3,
      overlapEvents: 1,
      overlapRatePct: (1 / 3) * 100,
    });
    expect(report.source).toEqual({ touches: 2, overlapEvents: 0, overlapRatePct: 0 });
    expect(report.overall.overlapRatePct).toBeCloseTo(20, 5);
    expect(report.commitsAnalyzed).toBe(3);
    expect(report.filesTouched).toBe(3);
  });

  it('lists only contended files in the top table, capped by topCount', () => {
    const report = buildReport(commits, 120, NOW, 1);
    expect(report.top).toHaveLength(1);
    expect(report.top[0]?.path).toBe('docs/INDEX.md');
  });

  it('reports a zero rate for an empty window without dividing by zero', () => {
    const report = buildReport([], 120, NOW);
    expect(report.overall).toEqual({ touches: 0, overlapEvents: 0, overlapRatePct: 0 });
    expect(report.findings.length).toBeGreaterThan(0);
  });

  it('renders a human-readable summary', () => {
    const text = render(buildReport(commits, 120, NOW));
    expect(text).toContain('non-source');
    expect(text).toContain('docs/INDEX.md');
    expect(text).toContain('Findings:');
  });
});

describe('deriveFindings', () => {
  const base = (
    over: Partial<Omit<ConflictReport, 'findings'>>,
  ): Omit<ConflictReport, 'findings'> => ({
    schema: 'crawler-velocity-conflicts/v1',
    generatedAt: NOW,
    windowDays: 120,
    commitsAnalyzed: 10,
    filesTouched: 2,
    overall: { touches: 10, overlapEvents: 1, overlapRatePct: 10 },
    source: { touches: 5, overlapEvents: 0, overlapRatePct: 0 },
    nonSource: { touches: 5, overlapEvents: 1, overlapRatePct: 20 },
    top: [],
    ...over,
  });

  it('calls out artifact shape when non-source collides more than code', () => {
    const findings = deriveFindings(base({}));
    expect(findings.some((f) => f.includes('artifact-shape'))).toBe(true);
  });

  it('does not call out artifact shape when code collides more', () => {
    const findings = deriveFindings(
      base({
        source: { touches: 5, overlapEvents: 3, overlapRatePct: 60 },
        nonSource: { touches: 5, overlapEvents: 0, overlapRatePct: 0 },
      }),
    );
    expect(findings.some((f) => f.includes('artifact-shape'))).toBe(false);
  });

  it('names the worst file in each category', () => {
    const findings = deriveFindings(
      base({
        top: [
          {
            path: 'docs/INDEX.md',
            category: 'non-source',
            touches: 5,
            overlapEvents: 4,
            contendedDays: 2,
          },
          {
            path: 'src/MainGameScene.ts',
            category: 'source',
            touches: 3,
            overlapEvents: 2,
            contendedDays: 1,
          },
        ],
      }),
    );
    expect(findings.some((f) => f.includes('docs/INDEX.md'))).toBe(true);
    expect(findings.some((f) => f.includes('src/MainGameScene.ts'))).toBe(true);
  });
});
