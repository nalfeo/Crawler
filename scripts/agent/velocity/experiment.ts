/**
 * Experiment orchestrator — the one command behind the velocity lab.
 *
 *   npm run velocity:experiment -- --spec <experiment.json>
 *
 * Runs every (task × arm × repetition) trial, then emits a verdict report with
 * per-arm verifier pass-rate, median agent turns, and median tokens to first
 * green. It refuses two-factor experiments, excludes leaked trials, and reports
 * "INCONCLUSIVE" loudly rather than inventing significance from a tiny sample.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadPack, repoRoot } from './task-pack.js';
import { DEFAULT_DENY_TOOLS, defaultWorkRoot, runTrial } from './trial-runner.js';
import { MIN_SAMPLES_FOR_VERDICT, assertOneFactor, compareArms, summarize } from './stats.js';
import {
  REPORT_SCHEMA,
  type ArmSummary,
  type ComparableMetric,
  type Comparison,
  type ExperimentReport,
  type ExperimentSpec,
  type TrialResult,
} from './types.js';

const COMPARED_METRICS: readonly ComparableMetric[] = [
  'modelCalls',
  'outputTokens',
  'nanoAiu',
  'sessionDurationMs',
  'toolResultBytes',
  'compactions',
];

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * A trial only contributes to the verdict if it is green AND uncontaminated
 * AND actually ran.
 *
 * The `error` check is load-bearing: a trial whose agent failed to launch still
 * runs the verifier, and if that verifier happens to pass anyway it would
 * otherwise enter the medians as a spectacular zero-turn, zero-token success.
 * A harness that reports a crash as the fastest arm is worse than useless.
 */
export function isUsable(trial: TrialResult): boolean {
  return trial.verifierPassed && !trial.error && trial.leakSignals.length === 0;
}

export function summarizeArm(
  armId: string,
  description: string,
  trials: readonly TrialResult[],
): ArmSummary {
  const mine = trials.filter((t) => t.armId === armId);
  const usable = mine.filter(isUsable);
  return {
    armId,
    description,
    trials: mine.length,
    // Deliberately `usable`, not `verifierPassed`: a crashed launch whose
    // verifier passed anyway, or a contaminated trial, is not a success. The
    // denominator stays `mine.length` so those trials still cost the arm — and
    // the warnings enumerate exactly which trials were excluded and why.
    passed: usable.length,
    passRate: mine.length === 0 ? 0 : usable.length / mine.length,
    modelCalls: summarize(usable.map((t) => t.metrics.modelCalls)),
    outputTokens: summarize(usable.map((t) => t.metrics.outputTokens)),
    nanoAiu: summarize(usable.map((t) => t.metrics.nanoAiu)),
    sessionDurationMs: summarize(usable.map((t) => t.metrics.sessionDurationMs)),
    toolResultBytes: summarize(
      usable.filter((t) => t.context.available).map((t) => t.context.toolResultBytes),
    ),
    compactions: summarize(
      usable.filter((t) => t.context.available).map((t) => t.context.compactions),
    ),
  };
}

/** Context metrics are only meaningful when the session event log was found. */
const CONTEXT_METRICS: ReadonlySet<ComparableMetric> = new Set(['toolResultBytes', 'compactions']);

function hasMetric(trial: TrialResult, metric: ComparableMetric): boolean {
  return !CONTEXT_METRICS.has(metric) || trial.context.available;
}

/**
 * Read one comparable metric off a trial, whichever record it lives in.
 * Context metrics come from the session event log, production metrics from the
 * transcript — but a comparison should not have to care.
 */
export function metricValue(trial: TrialResult, metric: ComparableMetric): number {
  switch (metric) {
    case 'toolResultBytes':
      return trial.context.toolResultBytes;
    case 'compactions':
      return trial.context.compactions;
    default:
      return trial.metrics[metric];
  }
}

export function buildComparisons(
  spec: ExperimentSpec,
  trials: readonly TrialResult[],
): Comparison[] {
  const baselineArm = spec.arms[0]?.id;
  if (!baselineArm) return [];
  const usable = trials.filter(isUsable);
  const comparisons: Comparison[] = [];

  for (const arm of spec.arms.slice(1)) {
    for (const metric of COMPARED_METRICS) {
      comparisons.push(
        compareArms(
          metric,
          baselineArm,
          usable
            .filter((t) => t.armId === baselineArm && hasMetric(t, metric))
            .map((t) => metricValue(t, metric)),
          arm.id,
          usable
            .filter((t) => t.armId === arm.id && hasMetric(t, metric))
            .map((t) => metricValue(t, metric)),
        ),
      );
    }
  }
  return comparisons;
}

export function buildWarnings(
  spec: ExperimentSpec,
  trials: readonly TrialResult[],
  arms: readonly ArmSummary[],
): string[] {
  const warnings: string[] = [];

  const leaked = trials.filter((t) => t.leakSignals.length > 0);
  if (leaked.length > 0) {
    warnings.push(
      `${leaked.length} trial(s) tripped the leak audit and were excluded from the verdict: ` +
        leaked
          .map((t) => `${t.taskId}/${t.armId}#${t.repetition} [${t.leakSignals.join(',')}]`)
          .join('; '),
    );
  }

  const errored = trials.filter((t) => t.error);
  if (errored.length > 0) {
    warnings.push(
      `${errored.length} trial(s) failed to run and were excluded from the verdict: ` +
        errored.map((t) => `${t.taskId}/${t.armId}#${t.repetition} (${t.error})`).join('; '),
    );
  }

  const unmeasured = trials.filter((t) => isUsable(t) && !t.context.available);
  if (unmeasured.length > 0) {
    warnings.push(
      `${unmeasured.length} usable trial(s) had no readable session event log, so context metrics ` +
        `(toolResultBytes, compactions) are UNMEASURED for them and were excluded from those ` +
        `comparisons. Do not read this as "used no context".`,
    );
  }

  const censored = trials.filter((t) => t.budgetExhausted);
  if (censored.length > 0) {
    warnings.push(
      `${censored.length} trial(s) stopped at the AI-credit ceiling (maxAiCredits=${spec.maxAiCredits ?? 'unset'}). ` +
        'These are censored, not failed: they show the arm did not finish within budget, ' +
        'NOT that it could not finish. Raise maxAiCredits and rerun before drawing any conclusion.',
    );
  }

  for (const arm of arms) {
    // Censoring flatters fragile arms: excluding budget-capped trials from the
    // medians silently drops the arm's worst runs. Report the rate explicitly so
    // "faster median" cannot hide "and fails more often".
    const mine = trials.filter((t) => t.armId === arm.armId);
    const armCensored = mine.filter((t) => t.budgetExhausted).length;
    if (armCensored > 0) {
      warnings.push(
        `Arm "${arm.armId}" success-rate-under-budget = ` +
          `${mine.length === 0 ? 0 : Math.round((arm.passed / mine.length) * 100)}% ` +
          `(${armCensored}/${mine.length} censored). Compare arms on this rate, not on medians alone.`,
      );
    }
    if (arm.modelCalls.n < MIN_SAMPLES_FOR_VERDICT) {
      warnings.push(
        `Arm "${arm.armId}" has only ${arm.modelCalls.n} usable trial(s) ` +
          `(minimum ${MIN_SAMPLES_FOR_VERDICT} for any conclusive comparison).`,
      );
    }
    if (arm.trials > 0 && arm.passRate === 0) {
      warnings.push(
        `Arm "${arm.armId}" never reached a passing verifier — it has no "time to green".`,
      );
    }
  }

  if (spec.trials < MIN_SAMPLES_FOR_VERDICT) {
    warnings.push(
      `Configured trials=${spec.trials} is below ${MIN_SAMPLES_FOR_VERDICT}; treat this run as a smoke ` +
        `test of the harness, not as evidence about the hypothesis.`,
    );
  }
  return warnings;
}

export function buildVerdict(comparisons: readonly Comparison[]): string {
  const conclusive = comparisons.filter((c) => c.conclusive);
  if (conclusive.length === 0) {
    return (
      'INCONCLUSIVE — no metric produced a bootstrap interval that excludes zero at the ' +
      'available sample size. This is not evidence of "no effect"; it is an absence of evidence. ' +
      'Increase trials per arm or pick a task where the hypothesised effect is larger.'
    );
  }
  const lines = conclusive.map((c) => {
    const direction = c.medianDelta < 0 ? 'reduced' : 'increased';
    return (
      `${c.treatmentArm} ${direction} median ${c.metric} vs ${c.baselineArm} by ` +
      `${Math.abs(c.medianDelta).toFixed(1)} (95% CI [${c.ci95[0].toFixed(1)}, ${c.ci95[1].toFixed(1)}], ` +
      `Cliff's δ=${c.cliffsDelta.toFixed(2)}, ${c.effectSizeLabel})`
    );
  });
  return `CONCLUSIVE on ${conclusive.length}/${comparisons.length} comparison(s):\n  - ${lines.join('\n  - ')}`;
}

/**
 * Rank the tools that consumed the most context across an experiment.
 *
 * This is the actionable half of context telemetry: "context filled up" is not
 * a fix, but "grep returned 180KB in 3 trials" is a specific optimisation.
 */
export function contextSinks(
  trials: readonly TrialResult[],
  limit = 3,
): { tool: string; bytes: number }[] {
  const totals = new Map<string, number>();
  for (const trial of trials) {
    const name = trial.context.largestToolResultName;
    if (!name) continue;
    totals.set(name, (totals.get(name) ?? 0) + trial.context.largestToolResultBytes);
  }
  return [...totals.entries()]
    .map(([tool, bytes]) => ({ tool, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit);
}

export function renderReport(report: ExperimentReport): string {
  const lines: string[] = [];
  lines.push(`\n═══ Velocity experiment: ${report.experimentId} ═══`);
  lines.push(`Hypothesis: ${report.hypothesis}`);
  lines.push(`Factor varied: ${report.factor}  |  Pack: ${report.packId}\n`);

  lines.push(
    'Arm                  Trials  Pass%   MedTurns  MedOutTok   MedNanoAIU  MedWall(s)  MedToolKB  Compact',
  );
  lines.push('─'.repeat(105));
  for (const arm of report.arms) {
    const fmt = (v: number, digits = 0) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
    lines.push(
      [
        arm.armId.padEnd(20).slice(0, 20),
        String(arm.trials).padStart(6),
        `${(arm.passRate * 100).toFixed(0)}%`.padStart(6),
        fmt(arm.modelCalls.median, 1).padStart(10),
        fmt(arm.outputTokens.median).padStart(11),
        fmt(arm.nanoAiu.median).padStart(12),
        fmt(arm.sessionDurationMs.median / 1000, 1).padStart(11),
        fmt(arm.toolResultBytes.median / 1024, 1).padStart(11),
        fmt(arm.compactions.median, 1).padStart(9),
      ].join(''),
    );
  }

  lines.push('\nComparisons (treatment vs baseline; negative delta = cheaper):');
  for (const c of report.comparisons) {
    const flag = c.conclusive ? '✅' : '·';
    lines.push(
      `  ${flag} ${c.treatmentArm} vs ${c.baselineArm} — ${c.metric}: ` +
        `Δmedian=${Number.isFinite(c.medianDelta) ? c.medianDelta.toFixed(1) : '—'} ` +
        `CI95=[${c.ci95.map((v) => (Number.isFinite(v) ? v.toFixed(1) : '—')).join(', ')}] ` +
        `δ=${Number.isFinite(c.cliffsDelta) ? c.cliffsDelta.toFixed(2) : '—'} (${c.effectSizeLabel})`,
    );
  }

  const sinks = contextSinks(report.trials);
  if (sinks.length > 0) {
    lines.push('\nBiggest context sinks (largest single tool result per trial, summed):');
    for (const sink of sinks) {
      lines.push(`  - ${sink.tool}: ${(sink.bytes / 1024).toFixed(1)} KB`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push('\n⚠️  Warnings:');
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }
  lines.push(`\nVerdict: ${report.verdict}\n`);
  return lines.join('\n');
}

function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith('--')) continue;
    const next = argv[i + 1];
    flags.set(token.slice(2), next && !next.startsWith('--') ? next : 'true');
  }
  return flags;
}

export function runExperiment(
  spec: ExperimentSpec,
  root: string,
  options: { trialsRoot: string; dryRun: boolean; install: boolean },
): ExperimentReport {
  assertOneFactor(spec);
  const pack = loadPack(resolve(root, spec.pack));
  const startedAt = new Date().toISOString();
  const trials: TrialResult[] = [];

  for (const task of pack.tasks) {
    for (const arm of spec.arms) {
      for (let repetition = 1; repetition <= spec.trials; repetition++) {
        process.stdout.write(`▶ ${task.id} | ${arm.id} | trial ${repetition}/${spec.trials}\n`);
        const result = runTrial(task, arm, {
          repoRoot: root,
          trialsRoot: options.trialsRoot,
          experimentId: spec.id,
          repetition,
          defaultModel: spec.defaultModel,
          maxAiCredits: spec.maxAiCredits,
          timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          install: options.install,
          denyTools: DEFAULT_DENY_TOOLS,
          dryRun: options.dryRun,
        });
        trials.push(result);
        process.stdout.write(
          `   ${result.verifierPassed ? '✅ green' : '❌ red'} — ` +
            `${result.metrics.modelCalls} turns, ${result.metrics.outputTokens} out-tokens` +
            `${result.leakSignals.length > 0 ? ` ⚠️ leak:${result.leakSignals.join(',')}` : ''}\n`,
        );
      }
    }
  }

  const arms = spec.arms.map((arm) => summarizeArm(arm.id, arm.description, trials));
  const comparisons = buildComparisons(spec, trials);
  return {
    schema: REPORT_SCHEMA,
    experimentId: spec.id,
    hypothesis: spec.hypothesis,
    factor: spec.factor,
    packId: pack.id,
    startedAt,
    finishedAt: new Date().toISOString(),
    arms,
    comparisons,
    trials,
    verdict: buildVerdict(comparisons),
    warnings: buildWarnings(spec, trials, arms),
  };
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  const specPath = flags.get('spec');
  if (!specPath) {
    process.stdout.write(
      'Usage: npm run velocity:experiment -- --spec <experiment.json> [--out <path>] [--dry-run] [--install]\n',
    );
    return;
  }
  const root = repoRoot();
  const spec = JSON.parse(readFileSync(resolve(root, specPath), 'utf8')) as ExperimentSpec;
  const trialsRootFlag = flags.get('trials-root');
  const report = runExperiment(spec, root, {
    trialsRoot: trialsRootFlag ? resolve(root, trialsRootFlag) : defaultWorkRoot('trials', spec.id),
    dryRun: flags.get('dry-run') === 'true',
    install: flags.get('install') === 'true',
  });

  const out = resolve(root, flags.get('out') ?? `files/velocity-reports/${spec.id}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(renderReport(report));
  process.stdout.write(`Report → ${out}\n`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
