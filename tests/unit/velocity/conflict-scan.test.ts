import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildReport,
  classify,
  computeOverlaps,
  collectCommits,
  deriveFindings,
  isDirectExecution,
  isKnownAggregatePath,
  parseGitLog,
  render,
  resolveMainlineRef,
  type ConflictReport,
} from '../../../scripts/agent/velocity/conflict-scan';

const NOW = '2026-08-01T00:00:00.000Z';
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(TEST_DIR, '../../../scripts/agent/velocity/conflict-scan.ts');
const TSX_PATH = resolve(TEST_DIR, '../../../node_modules/tsx/dist/cli.mjs');

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

  describe('isKnownAggregatePath', () => {
    it('recognizes generated aggregate paths only', () => {
      expect(isKnownAggregatePath('docs/knowledge/handoffs/INDEX.md')).toBe(true);
      expect(isKnownAggregatePath('package.json')).toBe(false);
    });
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

  it('calls out non-source hotspots without assuming all are aggregates', () => {
    const findings = deriveFindings(base({}));
    expect(findings.some((f) => f.includes('generated aggregates'))).toBe(true);
    expect(findings.some((f) => f.includes('hand-authored config'))).toBe(true);
  });

  it('does not call out artifact shape when code collides more', () => {
    const findings = deriveFindings(
      base({
        source: { touches: 5, overlapEvents: 3, overlapRatePct: 60 },
        nonSource: { touches: 5, overlapEvents: 0, overlapRatePct: 0 },
      }),
    );
    expect(findings.some((f) => f.includes('generated aggregates'))).toBe(false);
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

  it('uses aggregate-specific advice only for known aggregate paths', () => {
    const findings = deriveFindings(
      base({
        top: [
          {
            path: 'package.json',
            category: 'non-source',
            touches: 5,
            overlapEvents: 4,
            contendedDays: 2,
          },
        ],
      }),
    );
    expect(findings.some((f) => f.includes('Worst non-source file: package.json'))).toBe(true);
    expect(findings.some((f) => f.includes('Inspect whether it is generated shared output'))).toBe(
      true,
    );
    expect(findings.some((f) => f.includes('prefer deriving, sharding'))).toBe(false);
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Test User');
  git(root, 'config', 'user.email', 'test@example.com');
  return root;
}

describe('mainline history collection', () => {
  it('resolves the local main branch when origin/main is absent', () => {
    const root = makeRepo('conflict-scan-mainline-');
    try {
      writeFileSync(join(root, 'shared.md'), 'main\n');
      git(root, 'add', 'shared.md');
      git(root, 'commit', '-m', 'main touch');
      expect(resolveMainlineRef(root)).toBe('refs/heads/main');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('collects first-parent mainline history instead of feature-branch commits', () => {
    const root = makeRepo('conflict-scan-history-');
    try {
      writeFileSync(join(root, 'shared.md'), 'main\n');
      git(root, 'add', 'shared.md');
      git(root, 'commit', '-m', 'main touch');

      git(root, 'checkout', '-b', 'feature');
      writeFileSync(join(root, 'feature-only.md'), 'feature\n');
      git(root, 'add', 'feature-only.md');
      git(root, 'commit', '-m', 'feature touch');

      const commits = collectCommits(root, 365);
      expect(commits.map((commit) => commit.files)).toEqual([['shared.md']]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('CLI entrypoint and validation', () => {
  it('matches direct execution even when the script path contains spaces', () => {
    expect(
      isDirectExecution(
        '/tmp/conflict scan/scripts/agent/velocity/conflict-scan.ts',
        'file:///tmp/conflict%20scan/scripts/agent/velocity/conflict-scan.ts',
      ),
    ).toBe(true);
  });

  it('runs successfully from a spaced path and writes the report', () => {
    const root = makeRepo('conflict scan repo ');
    try {
      writeFileSync(join(root, 'shared.md'), 'main\n');
      git(root, 'add', 'shared.md');
      git(root, 'commit', '-m', 'main touch');

      const scriptDir = join(root, 'scripts', 'agent', 'velocity');
      mkdirSync(scriptDir, { recursive: true });
      const copiedScript = join(scriptDir, 'conflict-scan.ts');
      copyFileSync(SCRIPT_PATH, copiedScript);

      const outPath = join(root, 'files', 'report.json');
      const result = spawnSync(process.execPath, [TSX_PATH, copiedScript, '--out', outPath], {
        cwd: root,
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Report →');
      expect(readFileSync(outPath, 'utf8')).toContain('"schema": "crawler-velocity-conflicts/v1"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a non-numeric max-nonsource-rate threshold', () => {
    const root = makeRepo('conflict-scan-threshold-');
    try {
      writeFileSync(join(root, 'shared.md'), 'main\n');
      git(root, 'add', 'shared.md');
      git(root, 'commit', '-m', 'main touch');

      const result = spawnSync(
        process.execPath,
        [TSX_PATH, SCRIPT_PATH, '--max-nonsource-rate', 'bad', '--out', join(root, 'files/report.json')],
        {
          cwd: root,
          encoding: 'utf8',
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('--max-nonsource-rate must be a finite number');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
