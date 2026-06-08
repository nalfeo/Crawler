#!/usr/bin/env node
/**
 * health/balance-regression.ts — Diff fresh balance metrics from
 * `coverage/balance-metrics.json` against the committed baseline at
 * `docs/knowledge/metrics/balance-baseline.json`.
 *
 * Fails on >REGRESSION_PCT drift in any metric. SKIPs cleanly when fresh
 * metrics aren't produced yet (Governor harness still TODO).
 */

import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

const FRESH_PATH = 'coverage/balance-metrics.json';
const BASELINE_PATH = 'docs/knowledge/metrics/balance-baseline.json';
const REGRESSION_PCT = 10.0;

interface BalanceFile {
  readonly version: number;
  readonly recordedAt: string | null;
  readonly metrics: Readonly<Record<string, number>>;
}

async function main(): Promise<void> {
  const report = new Report('health-balance-regression');
  if (!existsSync(fromRepo(FRESH_PATH))) {
    report.skip(`No fresh balance metrics at ${FRESH_PATH} (governor harness pending).`);
    report.finish();
  }
  const baseline = JSON.parse(readFileSync(fromRepo(BASELINE_PATH), 'utf8')) as BalanceFile;
  const fresh = JSON.parse(readFileSync(fromRepo(FRESH_PATH), 'utf8')) as BalanceFile;

  if (Object.keys(baseline.metrics).length === 0) {
    report.info('Empty baseline — recording fresh metrics as the new baseline (advisory).');
    process.stdout.write(JSON.stringify(fresh, null, 2) + '\n');
    report.finish();
  }

  for (const [metric, freshValue] of Object.entries(fresh.metrics)) {
    const baseValue = baseline.metrics[metric];
    if (baseValue === undefined) {
      report.warn(`New metric ${metric}=${freshValue} — add to baseline once stable.`);
      continue;
    }
    if (baseValue === 0) continue;
    const driftPct = ((freshValue - baseValue) / baseValue) * 100;
    if (Math.abs(driftPct) > REGRESSION_PCT) {
      report.error(
        `Metric ${metric} drifted ${driftPct.toFixed(2)}% (baseline ${baseValue} → ${freshValue}).`,
        {
          remediation:
            'Investigate cause; either revert the change, accept the new value by updating docs/knowledge/metrics/balance-baseline.json, or document the rationale in a handoff.',
        },
      );
    }
  }
  report.finish();
}

main().catch((err) => {
  process.stderr.write(`balance-regression crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
