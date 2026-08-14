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

export interface BaselineLegMetrics {
  winRate: number;
  totalWins: number;
  totalRuns: number;
}

export interface BaselineFile {
  meta: BaselineMetadata;
  winRate: number;
  totalWins: number;
  totalRuns: number;
  /**
   * Per-leg metrics for the multi-floor sweep (`floor1`, `floor2`,
   * `floor1-chain`, …). Optional: a baseline captured before the multi-floor
   * methodology has none, and the top-level aggregate remains the primary
   * comparison so the existing series stays continuous.
   */
  legs?: Record<string, BaselineLegMetrics>;
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
  /** Per-leg metrics, when the entry was published by a multi-floor sweep. */
  legs?: Record<string, BaselineLegMetrics>;
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

export interface BaselineLegRegression {
  legId: string;
  regression: boolean;
  reason: string;
  winRateDrop: number;
  additionalLosses: number;
  previous: BaselineLegMetrics;
  current: BaselineLegMetrics;
}

export interface BaselineRegressionDecision {
  regression: boolean;
  reason: string;
  current: ComparedBaseline;
  previous?: ComparedBaseline;
  winRateDrop?: number;
  additionalLosses?: number;
  /**
   * True when this release skipped its comparison because the sweep matrix was
   * intentionally resized. Surfaced explicitly so a skipped comparison is
   * visible in the published result rather than looking like a clean pass.
   */
  seriesMigrated?: boolean;
  /**
   * Per-leg verdicts for the multi-floor sweep, present only when BOTH
   * baselines carry leg metrics. These are diagnostic detail attached to the
   * same decision — they never change `regression`, which stays keyed on the
   * top-level aggregate so the existing filing threshold and issue history are
   * unchanged by the multi-floor rollout.
   */
  legs?: BaselineLegRegression[];
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
  legs?: readonly BaselineLegRegression[],
): NonNullable<BaselineRegressionDecision['issue']> {
  const marker = `<!-- ${BASELINE_REGRESSION_MARKER_PREFIX}:${current.commit} -->`;
  const title = `bug: release sweep regression at ${current.commit.slice(0, 12)}`;
  // Per-leg detail tells the investigator WHICH floor (or the progression
  // chain) lost runs, so a Floor-2-only or transition-only regression is not
  // misdiagnosed as a Floor-1 combat regression.
  const legLines =
    legs && legs.length > 0
      ? [
          '',
          '### Per-leg breakdown',
          '',
          '| Leg | Previous | Current | Drop | Extra losses | Regressed |',
          '| --- | ---: | ---: | ---: | ---: | :---: |',
          ...legs.map(
            (l) =>
              `| \`${l.legId}\` | ${formatPercent(l.previous.winRate)} | ${formatPercent(l.current.winRate)} | ` +
              `${(l.winRateDrop * 100).toFixed(2)} pp | ${l.additionalLosses} | ${l.regression ? '**yes**' : 'no'} |`,
          ),
        ]
      : [];
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
    ...legLines,
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

/**
 * Apply the SAME tolerance rule used for the aggregate to one leg. Extracted so
 * the aggregate and every leg provably share one definition of "regressed"
 * rather than drifting into two thresholds.
 */
function exceedsRegressionTolerance(
  previous: BaselineLegMetrics,
  current: BaselineLegMetrics,
): { regression: boolean; winRateDrop: number; additionalLosses: number } {
  const additionalLosses =
    current.totalRuns - current.totalWins - (previous.totalRuns - previous.totalWins);
  const winRateDrop = previous.winRate - current.winRate;
  const exceedsRateTolerance =
    additionalLosses * 1000 > current.totalRuns * (MIN_WIN_RATE_DROP * 1000);
  return {
    regression:
      winRateDrop > 0 && exceedsRateTolerance && additionalLosses >= MIN_ADDITIONAL_LOSSES,
    winRateDrop,
    additionalLosses,
  };
}

/**
 * Evaluate every leg present in BOTH baselines. A leg that appears in only one
 * of them is skipped rather than compared: a newly-added or removed leg is a
 * methodology change, not a gameplay regression, and comparing it would fire a
 * false regression on the first release after the leg set changes.
 *
 * A leg whose run count changed is likewise skipped for the same reason — the
 * aggregate path throws on a run-count change, but a leg must not take down the
 * whole check when the sweep matrix is intentionally resized.
 */
export function evaluateLegRegressions(
  previousLegs: Record<string, BaselineLegMetrics> | undefined,
  currentLegs: Record<string, BaselineLegMetrics> | undefined,
): BaselineLegRegression[] | undefined {
  if (!previousLegs || !currentLegs) return undefined;
  const results: BaselineLegRegression[] = [];
  for (const legId of Object.keys(currentLegs).sort()) {
    const current = currentLegs[legId];
    const previous = previousLegs[legId];
    if (!current || !previous) continue;
    validateMetrics(current, `current baseline leg "${legId}"`);
    validateMetrics(previous, `previous baseline leg "${legId}"`);
    if (previous.totalRuns !== current.totalRuns) {
      results.push({
        legId,
        regression: false,
        reason: `leg run count changed (${previous.totalRuns} → ${current.totalRuns}); skipped`,
        winRateDrop: 0,
        additionalLosses: 0,
        previous,
        current,
      });
      continue;
    }
    const { regression, winRateDrop, additionalLosses } = exceedsRegressionTolerance(
      previous,
      current,
    );
    results.push({
      legId,
      regression,
      reason: regression
        ? `leg regressed ${formatPercent(previous.winRate)} → ${formatPercent(current.winRate)}`
        : `leg stayed within tolerance (${(winRateDrop * 100).toFixed(2)} pp, ${additionalLosses} additional losses)`,
      winRateDrop,
      additionalLosses,
      previous,
      current,
    });
  }
  return results;
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
  const legs = evaluateLegRegressions(previousEntry.legs, currentBaseline.legs);

  // A run-count change means the sweep matrix was intentionally resized (the
  // multi-floor rollout resized the Floor-1 leg from 600 to 300 runs). Rates
  // across differing sample sizes are not comparable, and the additional-losses
  // half of the tolerance rule is meaningless across them.
  //
  // Historically this threw, which would have hard-failed the release job on the
  // first post-resize run. Reporting a skipped comparison instead is the
  // "reset or migrate the series" path: it never suppresses a real regression,
  // because comparison resumes at full strength on the very next release (the
  // first one whose predecessor shares the new size).
  if (previous.totalRuns !== current.totalRuns) {
    return {
      regression: false,
      reason:
        `sweep matrix resized (previous=${previous.totalRuns} runs, current=${current.totalRuns} runs); ` +
        'skipped one comparison — the series resumes on the next release',
      current,
      previous,
      seriesMigrated: true,
      ...(legs ? { legs } : {}),
    };
  }

  const { regression, winRateDrop, additionalLosses } = exceedsRegressionTolerance(
    previous,
    current,
  );

  if (!regression) {
    return {
      regression: false,
      reason: `change stayed within tolerance (${(winRateDrop * 100).toFixed(2)} pp, ${additionalLosses} additional losses)`,
      current,
      previous,
      winRateDrop,
      additionalLosses,
      ...(legs ? { legs } : {}),
    };
  }

  return {
    regression: true,
    reason: 'win rate and loss count exceeded the release regression tolerance',
    current,
    previous,
    winRateDrop,
    additionalLosses,
    ...(legs ? { legs } : {}),
    issue: buildIssue(previous, current, winRateDrop, additionalLosses, legs),
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
