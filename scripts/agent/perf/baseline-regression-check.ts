import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Report } from '../shared/report';

export const MIN_WIN_RATE_DROP = 0.005;
export const MIN_ADDITIONAL_LOSSES = 2;
export const BASELINE_REGRESSION_MARKER_PREFIX = 'release-baseline-regression';

interface BaselineMetadata {
  commit: string;
  commitDate: string;
  commitSubject: string;
  capturedAt: string;
  runUrl: string;
}

export interface BaselineFile {
  meta: BaselineMetadata;
  winRate: number;
  totalWins: number;
  totalRuns: number;
}

export interface BaselineIndexEntry {
  commit: string;
  commitDate: string;
  commitSubject: string;
  capturedAt: string;
  runUrl: string;
  winRate: number;
  totalWins: number;
  totalRuns: number;
  path: string;
}

interface ComparedBaseline {
  commit: string;
  commitDate: string;
  commitSubject: string;
  runUrl: string;
  winRate: number;
  totalWins: number;
  totalRuns: number;
  totalLosses: number;
}

export interface BaselineRegressionDecision {
  regression: boolean;
  reason: string;
  current: ComparedBaseline;
  previous?: ComparedBaseline;
  winRateDrop?: number;
  additionalLosses?: number;
  issue?: {
    marker: string;
    title: string;
    body: string;
  };
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function validateMetrics(
  baseline: Pick<BaselineFile, 'winRate' | 'totalWins' | 'totalRuns'>,
  context: string,
): void {
  if (!Number.isInteger(baseline.totalRuns) || baseline.totalRuns <= 0) {
    throw new Error(`${context}.totalRuns must be a positive integer`);
  }
  if (
    !Number.isInteger(baseline.totalWins) ||
    baseline.totalWins < 0 ||
    baseline.totalWins > baseline.totalRuns
  ) {
    throw new Error(`${context}.totalWins must be an integer between 0 and totalRuns`);
  }
  if (!Number.isFinite(baseline.winRate) || baseline.winRate < 0 || baseline.winRate > 1) {
    throw new Error(`${context}.winRate must be between 0 and 1`);
  }
  const calculatedWinRate = baseline.totalWins / baseline.totalRuns;
  if (Math.abs(calculatedWinRate - baseline.winRate) > 1e-9) {
    throw new Error(
      `${context}.winRate (${baseline.winRate}) does not match totalWins/totalRuns (${calculatedWinRate})`,
    );
  }
}

function compareShape(
  baseline: BaselineFile | BaselineIndexEntry,
  context: string,
): ComparedBaseline {
  const meta = 'meta' in baseline ? baseline.meta : baseline;
  assertNonEmptyString(meta.commit, `${context}.commit`);
  assertNonEmptyString(meta.commitDate, `${context}.commitDate`);
  assertNonEmptyString(meta.commitSubject, `${context}.commitSubject`);
  assertNonEmptyString(meta.runUrl, `${context}.runUrl`);
  validateMetrics(baseline, context);
  return {
    commit: meta.commit,
    commitDate: meta.commitDate,
    commitSubject: meta.commitSubject,
    runUrl: meta.runUrl,
    winRate: baseline.winRate,
    totalWins: baseline.totalWins,
    totalRuns: baseline.totalRuns,
    totalLosses: baseline.totalRuns - baseline.totalWins,
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function buildIssue(
  previous: ComparedBaseline,
  current: ComparedBaseline,
  winRateDrop: number,
  additionalLosses: number,
): NonNullable<BaselineRegressionDecision['issue']> {
  const marker = `<!-- ${BASELINE_REGRESSION_MARKER_PREFIX}:${current.commit} -->`;
  const title = `bug: release sweep regression at ${current.commit.slice(0, 12)}`;
  const body = [
    marker,
    '## Release weapon-sweep regression',
    '',
    `The post-release baseline for \`${current.commit}\` regressed beyond the deterministic noise tolerance.`,
    '',
    '| Baseline | Commit | Win rate | Wins |',
    '| --- | --- | ---: | ---: |',
    `| Previous | \`${previous.commit}\` | ${formatPercent(previous.winRate)} | ${previous.totalWins}/${previous.totalRuns} |`,
    `| Regressing | \`${current.commit}\` | ${formatPercent(current.winRate)} | ${current.totalWins}/${current.totalRuns} |`,
    '',
    `- **Drop:** ${(winRateDrop * 100).toFixed(2)} percentage points`,
    `- **Additional losses:** ${additionalLosses}`,
    `- **Regressing commit:** ${current.commitSubject}`,
    `- **Commit date:** ${current.commitDate}`,
    `- **Sweep run:** ${current.runUrl}`,
    '',
    '### Detection tolerance',
    '',
    `This issue is filed only when the win rate drops by more than ${(MIN_WIN_RATE_DROP * 100).toFixed(1)} percentage points **and** the equal-sized sweep adds at least ${MIN_ADDITIONAL_LOSSES} losses. Requiring both conditions suppresses one-run noise while catching material regressions.`,
    '',
    '### Investigation',
    '',
    'Identify the first behavioral commit responsible for the lost runs, reproduce the affected seeds, and fix the root cause without weakening the sweep or gameplay requirements. Add deterministic regression coverage, run the required repository verification, and publish a ready-for-review PR.',
  ].join('\n');
  return { marker, title, body };
}

export function evaluateBaselineRegression(
  currentBaseline: BaselineFile,
  index: readonly BaselineIndexEntry[],
  firstParentHistory: readonly string[],
): BaselineRegressionDecision {
  const current = compareShape(currentBaseline, 'current baseline');
  if (!Array.isArray(index)) {
    throw new Error('baseline index must be an array');
  }

  const entriesByCommit = new Map(
    index
      .filter((entry) => entry && typeof entry.commit === 'string')
      .map((entry) => [entry.commit, entry]),
  );
  const previousEntry = firstParentHistory
    .map((commit) => entriesByCommit.get(commit))
    .find((entry): entry is BaselineIndexEntry => entry !== undefined);

  if (!previousEntry) {
    return {
      regression: false,
      reason: 'no earlier release baseline exists on the current first-parent lineage',
      current,
    };
  }

  const previous = compareShape(previousEntry, 'previous baseline');
  if (previous.totalRuns !== current.totalRuns) {
    throw new Error(
      `cannot compare baseline run counts: previous=${previous.totalRuns}, current=${current.totalRuns}. ` +
        'Reset or migrate the release baseline series when intentionally changing sweep size.',
    );
  }

  const additionalLosses = current.totalLosses - previous.totalLosses;
  const winRateDrop = previous.winRate - current.winRate;
  const exceedsRateTolerance =
    additionalLosses * 1000 > current.totalRuns * (MIN_WIN_RATE_DROP * 1000);
  const regression =
    winRateDrop > 0 && exceedsRateTolerance && additionalLosses >= MIN_ADDITIONAL_LOSSES;

  if (!regression) {
    return {
      regression: false,
      reason: `change stayed within tolerance (${(winRateDrop * 100).toFixed(2)} pp, ${additionalLosses} additional losses)`,
      current,
      previous,
      winRateDrop,
      additionalLosses,
    };
  }

  return {
    regression: true,
    reason: 'win rate and loss count exceeded the release regression tolerance',
    current,
    previous,
    winRateDrop,
    additionalLosses,
    issue: buildIssue(previous, current, winRateDrop, additionalLosses),
  };
}

function readJson<T>(filePath: string, label: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    throw new Error(
      `${label} unreadable at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function firstParentHistory(commit: string): string[] {
  const lineage = execFileSync(
    'git',
    ['rev-list', '--first-parent', '--parents', '-n', '1', commit],
    {
      encoding: 'utf8',
    },
  )
    .trim()
    .split(/\s+/);
  const parent = lineage[1];
  if (!parent) return [];
  return execFileSync('git', ['rev-list', '--first-parent', parent], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
}

function main(): void {
  const report = new Report('baseline-regression-check');
  const baselinePath = process.env.BASELINE_JSON;
  const indexPath = process.env.BASELINE_INDEX_JSON;
  const resultPath = process.env.BASELINE_REGRESSION_RESULT;

  try {
    if (!baselinePath || !indexPath || !resultPath) {
      throw new Error(
        'BASELINE_JSON, BASELINE_INDEX_JSON, and BASELINE_REGRESSION_RESULT are required',
      );
    }
    const baseline = readJson<BaselineFile>(baselinePath, 'current baseline');
    const index = readJson<BaselineIndexEntry[]>(indexPath, 'baseline index');
    const decision = evaluateBaselineRegression(
      baseline,
      index,
      firstParentHistory(baseline.meta.commit),
    );
    writeJsonAtomically(resultPath, decision);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `regression=${decision.regression}\n`);
    }
    if (decision.regression) {
      report.warn(
        `release sweep regressed ${formatPercent(decision.previous!.winRate)} -> ${formatPercent(decision.current.winRate)}; investigation issue required`,
        { file: baselinePath, remediation: 'Run the baseline regression issue-filing step.' },
      );
    } else {
      report.info(`No release sweep regression: ${decision.reason}`);
    }
  } catch (error) {
    report.error(error instanceof Error ? error.message : String(error), {
      file: baselinePath,
      remediation:
        'Inspect the published baseline JSON/index and run `npx tsx scripts/agent/perf/baseline-regression-check.ts` with the three required path variables.',
    });
  }
  report.finish();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
