import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  evaluateBaselineRegression,
  type BaselineFile,
  type BaselineIndexEntry,
} from '../../scripts/agent/perf/baseline-regression-check';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/baseline-regression',
);

function fixture(name: string): BaselineFile {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as BaselineFile;
}

function indexEntry(baseline: BaselineFile): BaselineIndexEntry {
  return {
    ...baseline.meta,
    winRate: baseline.winRate,
    totalWins: baseline.totalWins,
    totalRuns: baseline.totalRuns,
    path: `by-sha/${baseline.meta.commit}.json`,
  };
}

describe('release baseline regression check', () => {
  const previous = fixture('previous');
  const regression = fixture('regression');
  const noise = fixture('noise');

  it('detects the real 596/600 to 584/600 regression and renders investigation evidence', () => {
    const decision = evaluateBaselineRegression(
      regression,
      [indexEntry(regression), indexEntry(previous)],
      [previous.meta.commit],
    );

    expect(decision.regression).toBe(true);
    expect(decision.winRateDrop).toBeCloseTo(0.02);
    expect(decision.additionalLosses).toBe(12);
    expect(decision.issue?.body).toContain('99.33%');
    expect(decision.issue?.body).toContain('97.33%');
    expect(decision.issue?.body).toContain('596/600');
    expect(decision.issue?.body).toContain('584/600');
    expect(decision.issue?.body).toContain(regression.meta.commitSubject);
    expect(decision.issue?.body).toContain(regression.meta.runUrl);
  });

  it('files an issue for any Floor 1 loss even when the trend change is within tolerance', () => {
    const decision = evaluateBaselineRegression(
      noise,
      [indexEntry(noise), indexEntry(previous)],
      [previous.meta.commit],
    );
    expect(decision.regression).toBe(true);
    expect(decision.winRateDrop).toBeCloseTo(2 / 600, 10);
    expect(decision.additionalLosses).toBe(2);
    expect(decision.issue?.title).toContain('Floor 1 release sweep loss');
    expect(decision.issue?.body).toContain('100% success requirement');
  });

  it('files an issue at and above the prior trend threshold when Floor 1 has losses', () => {
    const atBoundary = {
      ...regression,
      winRate: 593 / 600,
      totalWins: 593,
    };
    const aboveBoundary = {
      ...regression,
      winRate: 592 / 600,
      totalWins: 592,
    };
    const history = [indexEntry(previous)];

    const boundaryDecision = evaluateBaselineRegression(atBoundary, history, [
      previous.meta.commit,
    ]);
    expect(boundaryDecision.winRateDrop).toBeCloseTo(0.005, 10);
    expect(boundaryDecision.additionalLosses).toBe(3);
    expect(boundaryDecision.regression).toBe(true);

    const aboveDecision = evaluateBaselineRegression(aboveBoundary, history, [
      previous.meta.commit,
    ]);
    expect(aboveDecision.winRateDrop).toBeCloseTo(4 / 600, 10);
    expect(aboveDecision.additionalLosses).toBe(4);
    expect(aboveDecision.regression).toBe(true);
  });

  it('selects the prior first-parent baseline even when a newer release published first', () => {
    const future = {
      ...indexEntry(noise),
      commit: 'a'.repeat(40),
      capturedAt: '2026-08-12T00:00:00Z',
    };
    const decision = evaluateBaselineRegression(
      regression,
      [future, indexEntry(previous), indexEntry(regression)],
      [previous.meta.commit],
    );
    expect(decision.previous?.commit).toBe(previous.meta.commit);
  });

  it('files a Floor 1 loss issue even when no prior release exists on the lineage', () => {
    const decision = evaluateBaselineRegression(regression, [indexEntry(regression)], []);
    expect(decision.regression).toBe(true);
    expect(decision.issue?.body).toContain('| Previous | N/A | N/A | N/A |');
  });

  it('CLI reports a no-history Floor 1 loss instead of crashing on the missing previous baseline', () => {
    // Regression coverage for a real bug: main() formatted every regression
    // with `decision.previous!.winRate`, but the no-history branch of
    // evaluateBaselineRegression intentionally omits `previous`. That crashed
    // the CLI AFTER the GITHUB_OUTPUT `regression=true` line was already
    // written, so the step still failed and the workflow skipped the
    // following issue-filing step entirely.
    const dir = mkdtempSync(path.join(tmpdir(), 'baseline-regression-cli-'));
    try {
      // `firstParentHistory` resolves the commit via `git rev-list`, so the
      // fixture's synthetic SHA (absent from this checkout) must be swapped
      // for the real HEAD commit. The index is left empty so no entry can
      // match any commit in that lineage regardless of its depth.
      const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim();
      const baselineWithRealCommit: BaselineFile = {
        ...regression,
        meta: { ...regression.meta, commit: headCommit },
      };
      const baselinePath = path.join(dir, 'baseline.json');
      const indexPath = path.join(dir, 'index.json');
      const resultPath = path.join(dir, 'result.json');
      const githubOutputPath = path.join(dir, 'github-output.txt');
      writeFileSync(baselinePath, JSON.stringify(baselineWithRealCommit));
      writeFileSync(indexPath, JSON.stringify([]));
      writeFileSync(githubOutputPath, '');

      const result = spawnSync('npx', ['tsx', 'scripts/agent/perf/baseline-regression-check.ts'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          BASELINE_JSON: baselinePath,
          BASELINE_INDEX_JSON: indexPath,
          BASELINE_REGRESSION_RESULT: resultPath,
          GITHUB_OUTPUT: githubOutputPath,
        },
      });

      // Asserting the exit code (rather than letting execFileSync throw) keeps
      // this a clean assertion failure instead of an uncaught-error path if the
      // crash regresses.
      expect(result.status).toBe(0);
      const output = result.stdout;
      expect(output).toContain('release sweep regressed');
      expect(output).not.toContain('[ERROR]');
      expect(readFileSync(githubOutputPath, 'utf8')).toContain('regression=true');
      const decision = JSON.parse(readFileSync(resultPath, 'utf8')) as { regression: boolean };
      expect(decision.regression).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('files a Floor 1 loss issue when the sweep matrix is resized', () => {
    // The multi-floor rollout resizes the Floor-1 leg (600 → 300 runs). Rates
    // across different sample sizes are not comparable, and the
    // additional-losses half of the tolerance rule is meaningless across them.
    // A Floor 1 loss is still actionable regardless: it never depends on the
    // resize/revision comparison being reachable at all.
    const mismatched = { ...indexEntry(previous), totalRuns: 300, totalWins: 298 };
    mismatched.winRate = mismatched.totalWins / mismatched.totalRuns;
    const decision = evaluateBaselineRegression(regression, [mismatched], [previous.meta.commit]);
    expect(decision.regression).toBe(true);
    expect(decision.reason).toContain('100% success');
    // Floor 1 losses remain actionable even when trend comparison is skipped.
    expect(decision.issue?.title).toContain('Floor 1 release sweep loss');
  });

  function resized(entry: BaselineIndexEntry): BaselineIndexEntry {
    const mismatched = { ...entry, totalRuns: 300, totalWins: 298 };
    mismatched.winRate = mismatched.totalWins / mismatched.totalRuns;
    return mismatched;
  }

  function withRevision(baseline: BaselineFile, revision: number | undefined): BaselineFile {
    return {
      ...baseline,
      meta: {
        ...baseline.meta,
        ...(revision === undefined ? {} : { sweep: { seeds: '1-50', kind: 'winrate', revision } }),
      },
    };
  }

  // A Floor 1 loss now always short-circuits to an actionable issue (see above),
  // so the resize/revision migration path below is only reachable for a
  // CURRENT baseline with zero losses. These tests use a perfect-win current
  // baseline to exercise that migration logic in isolation.
  function perfectCurrent(baseline: BaselineFile): BaselineFile {
    return { ...baseline, totalWins: baseline.totalRuns, winRate: 1 };
  }

  it('skips exactly one comparison when the sweep matrix revision is intentionally bumped', () => {
    // The multi-floor rollout resizes the Floor-1 leg (600 → 300 runs) under a
    // NEW RELEASE_SWEEP_REVISION. Rates across different sample sizes are not
    // comparable, and the additional-losses half of the tolerance rule is
    // meaningless across them, so exactly one comparison is skipped.
    const decision = evaluateBaselineRegression(
      withRevision(perfectCurrent(regression), 2),
      [resized(indexEntry(previous))],
      [previous.meta.commit],
    );
    expect(decision.regression).toBe(false);
    expect(decision.seriesMigrated).toBe(true);
    expect(decision.reason).toContain('sweep matrix resized under a new revision');
    // Crucially it does NOT file an issue for a comparison it never made.
    expect(decision.issue).toBeUndefined();
  });

  it('fails closed on a run-count change that is not an explicit revision bump', () => {
    // A truncated producer or an accidental matrix edit must never be laundered
    // into a "series migration" that silently suppresses regression detection.
    expect(() =>
      evaluateBaselineRegression(
        withRevision(perfectCurrent(regression), 2),
        [{ ...resized(indexEntry(previous)), sweepRevision: 2 }],
        [previous.meta.commit],
      ),
    ).toThrow(/cannot compare baseline run counts/);

    expect(() =>
      evaluateBaselineRegression(
        withRevision(perfectCurrent(regression), undefined),
        [resized(indexEntry(previous))],
        [previous.meta.commit],
      ),
    ).toThrow(/cannot compare baseline run counts/);
  });

  it('resumes detecting regressions on the release after a resize', () => {
    // The migration must be a one-release skip, not a permanent hole: once both
    // baselines share the new size, the same drop is caught normally.
    const resizedPrev = { ...previous, totalRuns: 600, totalWins: 596 };
    resizedPrev.winRate = resizedPrev.totalWins / resizedPrev.totalRuns;
    const decision = evaluateBaselineRegression(
      regression,
      [indexEntry(resizedPrev)],
      [previous.meta.commit],
    );
    expect(decision.regression).toBe(true);
  });

  it('rejects inconsistent metrics instead of silently accepting malformed history', () => {
    const malformed = { ...indexEntry(previous), winRate: 0.5 };
    expect(() =>
      evaluateBaselineRegression(regression, [malformed], [previous.meta.commit]),
    ).toThrow('does not match totalWins/totalRuns');
  });
});
