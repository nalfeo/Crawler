#!/usr/bin/env node
/**
 * health/bench-regression.ts — Diff fresh vitest bench results from
 * `coverage/bench-results.json` against the committed baseline at
 * `docs/knowledge/metrics/bench-baseline.json`.
 *
 * Fails if any benchmark regresses more than REGRESSION_PCT in ops/sec (hz).
 * SKIPs cleanly when no fresh results exist (bench wasn't run yet).
 *
 * Run via `npm run bench` to produce fresh results, then `npm run health:check`
 * to evaluate them.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

const FRESH_PATH = 'coverage/bench-results.json';
const BASELINE_PATH = 'docs/knowledge/metrics/bench-baseline.json';
const REGRESSION_PCT = 15.0;

interface BenchResult {
  readonly name: string;
  readonly hz: number;
  readonly mean: number;
}

interface BenchGroup {
  readonly name: string;
  readonly benchmarks?: ReadonlyArray<BenchResult>;
  readonly groups?: ReadonlyArray<BenchGroup>;
}

interface BenchFile {
  readonly name: string;
  readonly groups?: ReadonlyArray<BenchGroup>;
  readonly benchmarks?: ReadonlyArray<BenchResult>;
}

interface BenchReport {
  readonly files?: ReadonlyArray<BenchFile>;
  readonly benchmarks?: ReadonlyArray<BenchResult & { readonly suiteName: string }>;
}

interface BenchBaseline {
  readonly version: number;
  readonly recordedAt: string | null;
  readonly benchmarks: Readonly<Record<string, number>>;
}

/** Recursively collect all benchmarks from the vitest bench JSON output. */
function collectResults(report: BenchReport): Map<string, number> {
  const out = new Map<string, number>();

  function visitBenchmarks(results: ReadonlyArray<BenchResult> | undefined, prefix: string): void {
    if (!results) return;
    for (const b of results) {
      const key = prefix ? `${prefix} > ${b.name}` : b.name;
      out.set(key, b.hz);
    }
  }

  function visitGroup(g: BenchGroup, prefix: string): void {
    const p = prefix ? `${prefix} > ${g.name}` : g.name;
    visitBenchmarks(g.benchmarks, p);
    for (const sub of g.groups ?? []) {
      visitGroup(sub, p);
    }
  }

  for (const file of report.files ?? []) {
    const filePrefix = file.name;
    visitBenchmarks(file.benchmarks, filePrefix);
    for (const g of file.groups ?? []) {
      visitGroup(g, filePrefix);
    }
  }

  return out;
}

async function main(): Promise<void> {
  const report = new Report('health-bench-regression');

  if (!existsSync(fromRepo(FRESH_PATH))) {
    report.skip(`No fresh bench results at ${FRESH_PATH}. Run \`npm run bench\` first.`);
    report.finish();
    return; // unreachable; makes control flow explicit
  }

  const freshRaw = readFileSync(fromRepo(FRESH_PATH), 'utf8');
  let freshReport: BenchReport | undefined;
  try {
    freshReport = JSON.parse(freshRaw) as BenchReport;
  } catch {
    report.error(`Could not parse ${FRESH_PATH} as JSON.`);
    report.finish();
    return; // unreachable; makes control flow explicit
  }

  const freshResults = collectResults(freshReport);
  if (freshResults.size === 0) {
    report.warn('No benchmark entries found in fresh results — nothing to compare.');
    report.finish();
    return; // unreachable; makes control flow explicit
  }

  // Load or bootstrap baseline
  let baseline: BenchBaseline;
  if (!existsSync(fromRepo(BASELINE_PATH))) {
    baseline = { version: 1, recordedAt: null, benchmarks: {} };
  } else {
    try {
      baseline = JSON.parse(readFileSync(fromRepo(BASELINE_PATH), 'utf8')) as BenchBaseline;
    } catch {
      report.warn(`${BASELINE_PATH} was not valid JSON; treating as empty baseline.`);
      baseline = { version: 1, recordedAt: null, benchmarks: {} };
    }
  }

  if (Object.keys(baseline.benchmarks).length === 0) {
    // Write fresh results as the new baseline
    const newBaseline: BenchBaseline = {
      version: 1,
      recordedAt: new Date().toISOString(),
      benchmarks: Object.fromEntries(freshResults),
    };
    writeFileSync(fromRepo(BASELINE_PATH), `${JSON.stringify(newBaseline, null, 2)}\n`);
    report.info(`Empty baseline — recorded ${freshResults.size} benchmark(s) as the new baseline.`);
    report.finish();
    return; // unreachable; makes control flow explicit
  }

  let regressions = 0;
  for (const [name, freshHz] of freshResults) {
    const baseHz = baseline.benchmarks[name];
    if (baseHz === undefined) {
      report.info(
        `New benchmark "${name}" (${freshHz.toFixed(0)} ops/s) — add to baseline once stable.`,
      );
      continue;
    }
    if (baseHz === 0) continue;
    const driftPct = ((freshHz - baseHz) / baseHz) * 100;
    if (driftPct < -REGRESSION_PCT) {
      report.error(
        `Benchmark "${name}" regressed ${(-driftPct).toFixed(1)}% (baseline ${baseHz.toFixed(0)} → ${freshHz.toFixed(0)} ops/s).`,
        {
          remediation:
            'Profile the change that caused the regression. If intentional, update docs/knowledge/metrics/bench-baseline.json.',
        },
      );
      regressions++;
    } else {
      process.stdout.write(
        `  ✓ ${name}: ${freshHz.toFixed(0)} ops/s (${driftPct >= 0 ? '+' : ''}${driftPct.toFixed(1)}%)\n`,
      );
    }
  }

  if (regressions === 0) {
    report.info(`All ${freshResults.size} benchmark(s) within ${REGRESSION_PCT}% threshold.`);
  }

  report.finish();
}

main().catch((err) => {
  process.stderr.write(`bench-regression crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
