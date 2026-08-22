import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Report } from '../shared/report';
import { RELEASE_SWEEP_LEGS, RELEASE_SWEEP_REVISION } from './sweep-legs';

export const MIN_WIN_RATE_DROP = 0.005;
export const MIN_ADDITIONAL_LOSSES = 2;
export const BASELINE_REGRESSION_MARKER_PREFIX = 'release-baseline-regression';

/**
 * Win-rate target the report-only release legs (`floor2`, `floor1-chain`) are
 * held to. Below it, the release workflow files an investigation issue — the
 * same release-time treatment Floor 1 already gets for its 100% invariant,
 * rather than a clause buried in the scheduled nightly balance issue
 * (nalfeo/Crawler#3293, follow-up to #3240).
 *
 * Hardcoded on purpose: moving this target is a gameplay-policy decision, not
 * an operator knob.
 */
export const REPORT_ONLY_LEG_WIN_RATE_FLOOR = 0.9;

/**
 * The legs held to {@link REPORT_ONLY_LEG_WIN_RATE_FLOOR}: every non-blocking
 * leg of the release matrix. Derived from the matrix itself so adding a
 * report-only leg automatically monitors it instead of silently leaving it
 * unwatched, and so the leg ids can never drift from the sweep that produces
 * them.
 */
export const REPORT_ONLY_LEG_IDS: readonly string[] = Object.freeze(
  RELEASE_SWEEP_LEGS.filter((leg) => !leg.blocking).map((leg) => leg.id),
);

export const LEG_WIN_RATE_FLOOR_MARKER = `<!-- ${BASELINE_REGRESSION_MARKER_PREFIX}:report-only-leg-win-rate -->`;

interface BaselineMetadata {
  commit: string;
  commitDate: string;
  commitSubject: string;
  capturedAt: string;
  runUrl: string;
  /**
   * Sweep provenance written by release-baseline.ts. `sweep.revision` is the
   * identity of the leg matrix that produced the baseline; a change in it is
   * the ONLY sanctioned reason for a run-count change.
   */
  sweep?: { seeds?: string; kind?: string; revision?: number };
}

export interface BaselineLegMetrics {
  winRate: number;
  totalWins: number;
  totalRuns: number;
}

export interface BaselineFailure {
  seed: number;
  weapon: string;
  signature?: string;
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
  /** Failure diagnostics emitted by the sweep, including their stable signatures. */
  fails?: BaselineFailure[];
  floorId?: string;
  legId?: string;
  forceWeapon?: boolean;
  chained?: boolean;
  enemyDamageMultiplier?: number;
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
  /**
   * Sweep matrix revision (`meta.sweep.revision`) the entry was captured under.
   * Absent for baselines published before the revision marker existed.
   */
  sweepRevision?: number;
  /** Diagnostic fun-evaluation summary, when the sibling report was published. */
  fun?: {
    overallFunScore: number;
    gatePass: boolean;
    path: string;
  } | null;
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
    /** Stable identifiers used to deduplicate recurring failures across releases. */
    failureSignatures?: string[];
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

export function buildFailureSignature(
  failure: Pick<BaselineFailure, 'seed' | 'weapon'>,
  baseline: Pick<
    BaselineFile,
    'floorId' | 'legId' | 'forceWeapon' | 'chained' | 'enemyDamageMultiplier'
  >,
): string {
  const prefix = [
    `floor=${baseline.floorId ?? 'floor1'}`,
    `leg=${baseline.legId ?? 'floor1'}`,
    `forceWeapon=${baseline.forceWeapon ?? true}`,
    `chained=${baseline.chained ?? false}`,
    `damage=${baseline.enemyDamageMultiplier ?? 1}`,
  ].join('|');
  return `${prefix}|seed=${failure.seed}|weapon=${failure.weapon}`;
}

function failureSignatures(baseline: BaselineFile): string[] {
  if (!Array.isArray(baseline.fails)) return [];
  return [
    ...new Set(
      baseline.fails.map((failure) => {
        const signature = buildFailureSignature(failure, baseline);
        if (failure.signature !== undefined && failure.signature !== signature) {
          throw new Error(
            `failure signature does not match seed and sweep configuration: ${signature}`,
          );
        }
        return signature;
      }),
    ),
  ].sort();
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
 * Floor 1 is the blocking release gate and has a stronger success criterion
 * than a historical trend: every sampled run must win. A loss is therefore
 * actionable even when a preceding baseline is unavailable or the delta would
 * otherwise fall inside the noise tolerance used for trend reporting.
 */
function buildFloor1LossIssue(
  current: ComparedBaseline,
  previous: ComparedBaseline | undefined,
  legs?: readonly BaselineLegRegression[],
  signatures: readonly string[] = [],
): NonNullable<BaselineRegressionDecision['issue']> {
  const marker = `<!-- ${BASELINE_REGRESSION_MARKER_PREFIX}:${current.commit} -->`;
  const previousLine = previous
    ? `| Previous | \`${previous.commit}\` | ${formatPercent(previous.winRate)} | ${previous.totalWins}/${previous.totalRuns} |`
    : '| Previous | N/A | N/A | N/A |';
  const legLines =
    legs && legs.length > 0
      ? [
          '',
          '### Per-leg breakdown',
          '',
          '| Leg | Previous | Current | Drop | Extra losses | Regressed |',
          '| --- | ---: | ---: | ---: | ---: | :---: |',
          ...legs.map(
            (leg) =>
              `| \`${leg.legId}\` | ${formatPercent(leg.previous.winRate)} | ${formatPercent(leg.current.winRate)} | ` +
              `${(leg.winRateDrop * 100).toFixed(2)} pp | ${leg.additionalLosses} | ${leg.regression ? '**yes**' : 'no'} |`,
          ),
        ]
      : [];
  return {
    marker,
    title: `bug: Floor 1 release sweep loss at ${current.commit.slice(0, 12)}`,
    ...(signatures.length > 0 ? { failureSignatures: [...signatures] } : {}),
    body: [
      marker,
      '## Floor 1 release sweep loss',
      '',
      `The release sweep for \`${current.commit}\` recorded ${current.totalLosses} Floor 1 loss${current.totalLosses === 1 ? '' : 'es'}. Floor 1 has a 100% success requirement, so every loss is actionable.`,
      '',
      '| Baseline | Commit | Win rate | Wins |',
      '| --- | --- | ---: | ---: |',
      previousLine,
      `| Current | \`${current.commit}\` | ${formatPercent(current.winRate)} | ${current.totalWins}/${current.totalRuns} |`,
      '',
      `- **Regressing commit:** ${current.commitSubject}`,
      `- **Commit date:** ${current.commitDate}`,
      `- **Sweep run:** ${current.runUrl}`,
      ...(signatures.length > 0
        ? ['', '### Failure signatures', '', ...signatures.map((signature) => `- \`${signature}\``)]
        : []),
      ...legLines,
      '',
      '### Investigation',
      '',
      'Reproduce every failed Floor 1 seed, identify the root cause, and restore a 100% success rate without weakening the sweep or gameplay requirements. Add deterministic regression coverage, run the required repository verification, and publish a ready-for-review PR.',
    ].join('\n'),
  };
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

export interface LegWinRateFloorLeg extends BaselineLegMetrics {
  legId: string;
  belowFloor: boolean;
}

export interface LegWinRateFloorDecision {
  /**
   * True when at least one monitored leg is below the floor.
   *
   * Named `regression` (rather than `belowFloor`) because
   * `.github/scripts/baseline-regression-issue.mjs` files any decision of this
   * shape, and one filer for both release-sweep checks means one dedupe,
   * labelling, and Copilot-assignment path instead of two.
   */
  regression: boolean;
  reason: string;
  legs: LegWinRateFloorLeg[];
  issue?: { marker: string; title: string; body: string };
}

function buildLegWinRateFloorIssue(
  baseline: BaselineFile,
  legs: readonly LegWinRateFloorLeg[],
): NonNullable<LegWinRateFloorDecision['issue']> {
  const below = legs.filter((leg) => leg.belowFloor);
  const target = `${(REPORT_ONLY_LEG_WIN_RATE_FLOOR * 100).toFixed(0)}%`;
  const summary = below
    .map((leg) => `\`${leg.legId}\` at ${formatPercent(leg.winRate)}`)
    .join(', ');
  return {
    // Deliberately stable rather than commit-scoped: the release workflow runs
    // on every main deploy, so a per-commit marker would open a fresh issue
    // every release while a leg sits under target. A stable marker makes the
    // filer update the one open investigation issue with the newest numbers.
    marker: LEG_WIN_RATE_FLOOR_MARKER,
    title: `bug: report-only release sweep legs below the ${target} win-rate target`,
    body: [
      LEG_WIN_RATE_FLOOR_MARKER,
      `## Report-only release sweep legs below ${target}`,
      '',
      `The release sweep for \`${baseline.meta.commit}\` reports ${summary}, below the ${target} target for the report-only legs. These legs measure whether a player who clears Floor 1 can keep going, so a slipping win rate here is a real progression problem even though the leg never blocks the release.`,
      '',
      '| Leg | Win rate | Wins | Below target |',
      '| --- | ---: | ---: | :---: |',
      ...legs.map(
        (leg) =>
          `| \`${leg.legId}\` | ${formatPercent(leg.winRate)} | ${leg.totalWins}/${leg.totalRuns} | ${leg.belowFloor ? '**yes**' : 'no'} |`,
      ),
      '',
      `- **Release commit:** ${baseline.meta.commitSubject}`,
      `- **Commit date:** ${baseline.meta.commitDate}`,
      `- **Sweep run:** ${baseline.meta.runUrl}`,
      '',
      '### Investigation',
      '',
      `- Diagnose the failing runs using the per-run \`RunStats\` already published inside this release baseline payload (\`legs["floor1-chain"].runs\` / \`legs.floor2.runs\` in \`by-sha/${baseline.meta.commit}.json\` on the \`baselines\` branch) — this is published release-sweep panel data, already in git. Do not dispatch or run a new sweep to redo this categorization; only a small number of individual single-seed local headless runs (\`npm run ai:headless\`) to observe/reproduce a specific failure and confirm a fix are appropriate, per the "observe before done" rule.`,
      "- Categorize those runs' `outcome` field and correlate with `movementQuality` (stuck/wiggle %), `aiTelemetry.decisionStateMs`, and progression/den fields to find the root cause (stuck pathfinding, target-selection deadlock, timeout/stalled budget exhaustion, a specific lethal mechanic, or a mapgen/lockout class where the player is physically unable to reach required content).",
      '- Fix the single largest bucket that is solvable in the AI runner (`src/game/ai/**`) without materially changing core gameplay in `src/game/**`/`src/core/**`.',
      '- If the largest bucket is instead a mapgen/lockout-class bug, do not patch map generation here — document the failure with a repro seed and file it as a separate follow-up issue.',
      '- Add deterministic regression coverage, run the required repository verification, and publish a ready-for-review PR. The next release sweep is the canonical re-measurement.',
    ].join('\n'),
  };
}

/**
 * Absolute win-rate floor for the report-only legs, evaluated against the
 * CURRENT baseline alone.
 *
 * Deliberately independent of {@link evaluateBaselineRegression}: that decision
 * carries exactly one issue and short-circuits on a Floor 1 loss, so folding
 * this in would let a Floor 1 loss mask a Floor 2 breach in the same release.
 * Like the Floor 1 100% invariant it needs no previous baseline — a chronically
 * low leg must keep reporting instead of quietly becoming the new normal, which
 * is exactly what a trend-only rule does.
 */
export function evaluateLegWinRateFloor(baseline: BaselineFile): LegWinRateFloorDecision {
  const legs = baseline.legs;
  // A baseline captured under a different (or absent) sweep revision predates
  // this leg matrix, so a missing leg there is history, not a broken publisher.
  const currentMatrix = baseline.meta?.sweep?.revision === RELEASE_SWEEP_REVISION;
  if (!legs) {
    if (currentMatrix) {
      throw new Error(
        `baseline for the current sweep matrix (revision ${RELEASE_SWEEP_REVISION}) has no leg metrics; ` +
          `expected ${REPORT_ONLY_LEG_IDS.join(', ')}`,
      );
    }
    return {
      regression: false,
      reason: 'baseline carries no leg metrics; report-only win-rate floor not evaluated',
      legs: [],
    };
  }

  const evaluated: LegWinRateFloorLeg[] = [];
  const missing: string[] = [];
  for (const legId of REPORT_ONLY_LEG_IDS) {
    const leg = legs[legId];
    if (!leg) {
      missing.push(legId);
      continue;
    }
    validateMetrics(leg, `current baseline leg "${legId}"`);
    evaluated.push({
      legId,
      ...leg,
      belowFloor: leg.winRate < REPORT_ONLY_LEG_WIN_RATE_FLOOR,
    });
  }

  // A leg that vanished from a baseline captured under the CURRENT matrix means
  // a truncated publisher or a rename, which would silently retire this check.
  // Fail closed rather than pass quietly.
  if (missing.length > 0 && currentMatrix) {
    throw new Error(
      `baseline for the current sweep matrix (revision ${RELEASE_SWEEP_REVISION}) is missing ` +
        `report-only leg metrics: ${missing.join(', ')}`,
    );
  }

  if (evaluated.length === 0) {
    return {
      regression: false,
      reason: `baseline reports none of the monitored legs (${REPORT_ONLY_LEG_IDS.join(', ')})`,
      legs: [],
    };
  }

  const below = evaluated.filter((leg) => leg.belowFloor);
  const target = `${(REPORT_ONLY_LEG_WIN_RATE_FLOOR * 100).toFixed(0)}%`;
  if (below.length === 0) {
    return {
      regression: false,
      reason: `every monitored leg met the ${target} target (${evaluated
        .map((leg) => `${leg.legId} ${formatPercent(leg.winRate)}`)
        .join(', ')})`,
      legs: evaluated,
    };
  }

  return {
    regression: true,
    reason: `${below.map((leg) => `${leg.legId} ${formatPercent(leg.winRate)}`).join(', ')} below the ${target} target`,
    legs: evaluated,
    issue: buildLegWinRateFloorIssue(baseline, evaluated),
  };
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

  const previousBaseline = previousEntry;
  if (!previousBaseline) {
    if (current.totalLosses > 0) {
      return {
        regression: true,
        reason: `Floor 1 recorded ${current.totalLosses} loss${current.totalLosses === 1 ? '' : 'es'}; the release target is 100% success`,
        current,
        issue: buildFloor1LossIssue(
          current,
          undefined,
          undefined,
          failureSignatures(currentBaseline),
        ),
      };
    }
    return {
      regression: false,
      reason: 'no earlier release baseline exists on the current first-parent lineage',
      current,
    };
  }

  const previous = compareShape(previousBaseline, 'previous baseline');
  const legs = evaluateLegRegressions(previousBaseline.legs, currentBaseline.legs);

  // A Floor 1 release sweep loss is never tolerated. Unlike trend regression,
  // it does not depend on a comparison baseline because the release target is
  // a direct 100% success invariant.
  if (current.totalLosses > 0) {
    return {
      regression: true,
      reason: `Floor 1 recorded ${current.totalLosses} loss${current.totalLosses === 1 ? '' : 'es'}; the release target is 100% success`,
      current,
      previous,
      winRateDrop: previous.winRate - current.winRate,
      additionalLosses: current.totalLosses - previous.totalLosses,
      ...(legs ? { legs } : {}),
      issue: buildFloor1LossIssue(current, previous, legs, failureSignatures(currentBaseline)),
    };
  }

  // A run-count change is comparable only when the sweep matrix REVISION also
  // changed: that is an intentional, declared resize (the multi-floor rollout
  // resized the Floor-1 leg from 600 to 300 runs under revision 2). Rates across
  // differing sample sizes are not comparable, and the additional-losses half of
  // the tolerance rule is meaningless across them, so that one comparison is
  // skipped and the series resumes at full strength on the next release.
  //
  // Without a revision bump, a differing run count means a truncated producer or
  // an accidental matrix edit — treating that as a migration would silently
  // suppress regression detection, so it stays fail-closed and throws.
  if (previous.totalRuns !== current.totalRuns) {
    const currentRevision = currentBaseline.meta.sweep?.revision;
    const previousRevision = previousBaseline.sweepRevision;
    if (currentRevision === undefined || currentRevision === previousRevision) {
      throw new Error(
        `cannot compare baseline run counts: previous=${previous.totalRuns}, current=${current.totalRuns} ` +
          `(sweep revision previous=${previousRevision ?? 'none'}, current=${currentRevision ?? 'none'}). ` +
          'Reset or migrate the release baseline series by bumping RELEASE_SWEEP_REVISION when intentionally changing sweep size.',
      );
    }
    return {
      regression: false,
      reason:
        `sweep matrix resized under a new revision (${previousRevision ?? 'none'} → ${currentRevision}; ` +
        `previous=${previous.totalRuns} runs, current=${current.totalRuns} runs); ` +
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
  const legFloorResultPath = process.env.LEG_WIN_RATE_FLOOR_RESULT;

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
      const previousDescription = decision.previous
        ? `${formatPercent(decision.previous.winRate)} -> `
        : '';
      report.warn(
        `release sweep regressed ${previousDescription}${formatPercent(decision.current.winRate)}; investigation issue required`,
        { file: baselinePath, remediation: 'Run the baseline regression issue-filing step.' },
      );
    } else {
      report.info(`No release sweep regression: ${decision.reason}`);
    }

    // Evaluated after (and independently of) the aggregate decision so a Floor 1
    // loss can never mask a report-only leg falling under target in the same
    // release. Opt-in via the result path so other callers keep the old shape.
    if (legFloorResultPath) {
      const legFloor = evaluateLegWinRateFloor(baseline);
      writeJsonAtomically(legFloorResultPath, legFloor);
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(
          process.env.GITHUB_OUTPUT,
          `legWinRateFloorBreach=${legFloor.regression}\n`,
        );
      }
      if (legFloor.regression) {
        report.warn(`report-only leg win-rate floor breached: ${legFloor.reason}`, {
          file: baselinePath,
          remediation: 'Run the report-only leg win-rate issue-filing step.',
        });
      } else {
        report.info(`Report-only leg win-rate floor: ${legFloor.reason}`);
      }
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

const isMain =
  process.env.CRAWLER_PREBUNDLED_ENTRY === undefined &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
