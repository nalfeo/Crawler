import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  scoreFunSessions,
  normalizeFunSessions,
} from '../../scripts/agent/health/fun-score-lib.js';
import {
  attachReleaseBaselineRuns,
  enrichReleaseBaseline,
  type ReleaseBaselineMeta,
} from '../../scripts/agent/perf/release-baseline.js';
import {
  buildReleaseFunReport,
  serializeReleaseFunReport,
} from '../../scripts/agent/perf/release-fun-report.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import type { RunStats } from '../../src/game/ai/types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const TEST_META: ReleaseBaselineMeta = {
  commit: 'c'.repeat(40),
  commitDate: '2026-08-13T00:00:00Z',
  commitSubject: 'test release fun report',
  capturedAt: '2026-08-13T00:02:00Z',
  runId: '999',
  runNumber: 42,
  runUrl: 'https://example.test/actions/runs/999',
  sweep: { seeds: '1-100', kind: 'winrate', revision: 2 },
};

async function capturedRun(): Promise<RunStats> {
  return runHeadless(new BehaviorTreeAI({ seed: 7 }), {
    seed: 7,
    maxFrames: 1,
    forceWeaponId: 'sword',
  });
}

function enrichedBaseline(runs: RunStats[]) {
  const produced = attachReleaseBaselineRuns(
    {
      floorId: 'floor1',
      totalRuns: runs.length,
      totalWins: 0,
      winRate: 0,
      aggregate: { all: { n: runs.length } },
    },
    runs,
  );
  return enrichReleaseBaseline(produced, TEST_META);
}

describe('release fun report', () => {
  it('scores the release baseline cohort identically to the shared fun-score evaluator', async () => {
    const actualRun = await capturedRun();
    const runs = Array.from({ length: 10 }, (_, index) => ({
      ...actualRun,
      totalFrames: index + 1,
    }));
    const baseline = enrichedBaseline(runs);

    const funReport = buildReleaseFunReport(baseline);
    const expectedReport = scoreFunSessions(normalizeFunSessions(baseline));

    expect(funReport.meta).toEqual(TEST_META);
    expect(funReport.report).toEqual(expectedReport);
    expect(funReport.report.runs).toBe(10);
  });

  it('round-trips through JSON serialization without losing meta or report fields', async () => {
    const actualRun = await capturedRun();
    const baseline = enrichedBaseline([actualRun]);
    const funReport = buildReleaseFunReport(baseline);

    const serialized = serializeReleaseFunReport(funReport);
    expect(serialized.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(serialized) as unknown;
    expect(parsed).toEqual(JSON.parse(JSON.stringify(funReport)));
  });

  it('refuses to score a baseline that has not been enriched with meta yet', () => {
    expect(() => buildReleaseFunReport({ totalRuns: 0, runs: [] })).toThrow(/must include meta/);
    expect(() => buildReleaseFunReport(null)).toThrow(/must be a JSON object/);
    expect(() => buildReleaseFunReport('not an object')).toThrow(/must be a JSON object/);
  });

  it('is wired into the baseline-sweep job after the enrichment step, non-blocking', () => {
    const workflow = parse(
      readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8'),
    ) as {
      jobs: Record<
        string,
        { steps?: Array<{ name?: string; run?: string; env?: Record<string, unknown> }> }
      >;
    };
    const steps = workflow.jobs['baseline-sweep']?.steps ?? [];
    const funScore = steps.find((step) => step.name === 'Score fun evaluation');
    expect(funScore?.env?.BASELINE_JSON).toContain('.cache/baseline/baseline.json');
    expect(funScore?.env?.FUN_REPORT_JSON).toContain('.cache/baseline/fun-report.json');
    expect(funScore?.run).toContain('scripts/agent/perf/release-fun-report.ts');
    // A failing/erroring fun-score run must not fail the job (diagnostic-only).
    expect(funScore?.run).toMatch(/\|\|/);
  });
});
