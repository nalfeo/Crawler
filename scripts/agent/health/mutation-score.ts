#!/usr/bin/env node
/**
 * health/mutation-score.ts — Parse the Stryker mutation report from
 * `reports/mutation/mutation.json` and compare the mutation score against
 * the committed baseline at `docs/knowledge/metrics/mutation-baseline.json`.
 *
 * Fails if the mutation score regresses more than REGRESSION_PCT.
 * SKIPs cleanly when no fresh report exists (Stryker hasn't run yet).
 *
 * Run via the nightly-mutation workflow or locally:
 *   npx stryker run && npx tsx scripts/agent/health/mutation-score.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

const FRESH_PATH = 'reports/mutation/mutation.json';
const BASELINE_PATH = 'docs/knowledge/metrics/mutation-baseline.json';
const REGRESSION_PCT = 5.0;

interface StrykerMutant {
  readonly status: string;
}

interface StrykerFileEntry {
  readonly mutants: ReadonlyArray<StrykerMutant>;
}

interface StrykerReport {
  readonly files: Readonly<Record<string, StrykerFileEntry>>;
}

interface MutationBaseline {
  readonly version: number;
  readonly recordedAt: string | null;
  readonly mutationScore: number;
}

/**
 * Compute the mutation score from a Stryker JSON report.
 * Score = (killed + timeout) / total × 100
 */
function computeScore(report: StrykerReport): { score: number; total: number } {
  let killed = 0;
  let timeout = 0;
  let total = 0;

  for (const file of Object.values(report.files)) {
    for (const mutant of file.mutants) {
      total++;
      if (mutant.status === 'Killed') killed++;
      else if (mutant.status === 'Timeout') timeout++;
    }
  }

  const score = total === 0 ? 100 : ((killed + timeout) / total) * 100;
  return { score, total };
}

async function main(): Promise<void> {
  const report = new Report('health-mutation-score');

  if (!existsSync(fromRepo(FRESH_PATH))) {
    report.skip(`No mutation report at ${FRESH_PATH}. Run \`npx stryker run\` first.`);
    report.finish();
    return; // unreachable; makes control flow explicit
  }

  let strykerReport: StrykerReport | undefined;
  try {
    strykerReport = JSON.parse(readFileSync(fromRepo(FRESH_PATH), 'utf8')) as StrykerReport;
  } catch {
    report.error(`Could not parse ${FRESH_PATH} as JSON.`);
    report.finish();
    return; // unreachable; makes control flow explicit
  }

  const { score, total } = computeScore(strykerReport);
  process.stdout.write(`Mutation score: ${score.toFixed(2)}% (${total} mutants tested)\n`);

  // Load or bootstrap baseline
  let baseline: MutationBaseline;
  if (!existsSync(fromRepo(BASELINE_PATH))) {
    baseline = { version: 1, recordedAt: null, mutationScore: 0 };
  } else {
    try {
      baseline = JSON.parse(readFileSync(fromRepo(BASELINE_PATH), 'utf8')) as MutationBaseline;
    } catch {
      report.warn(`${BASELINE_PATH} was not valid JSON; treating as empty baseline.`);
      baseline = { version: 1, recordedAt: null, mutationScore: 0 };
    }
  }

  if (baseline.mutationScore === 0) {
    const newBaseline: MutationBaseline = {
      version: 1,
      recordedAt: new Date().toISOString(),
      mutationScore: score,
    };
    writeFileSync(fromRepo(BASELINE_PATH), `${JSON.stringify(newBaseline, null, 2)}\n`);
    report.info(
      `Empty baseline — recorded mutation score ${score.toFixed(2)}% as the new baseline.`,
    );
    report.finish();
    return; // unreachable; makes control flow explicit
  }

  const delta = score - baseline.mutationScore;
  process.stdout.write(
    `Delta vs baseline (${baseline.mutationScore.toFixed(2)}%): ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%\n`,
  );

  if (delta < -REGRESSION_PCT) {
    report.error(
      `Mutation score regressed by ${(-delta).toFixed(2)}% (baseline ${baseline.mutationScore.toFixed(2)}% → ${score.toFixed(2)}%).`,
      {
        remediation:
          'Add tests covering the newly mutated code, or document the regression in docs/knowledge/metrics/mutation-baseline.json.',
      },
    );
  } else {
    report.info(
      `Mutation score ${score.toFixed(2)}% is within ${REGRESSION_PCT}% of baseline ${baseline.mutationScore.toFixed(2)}%.`,
    );
  }

  report.finish();
}

main().catch((err) => {
  process.stderr.write(`mutation-score crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
