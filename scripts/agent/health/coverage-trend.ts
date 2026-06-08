#!/usr/bin/env node
/**
 * health/coverage-trend.ts — Append the latest coverage snapshot to
 * `docs/knowledge/metrics/coverage-trend.json` and fail if line coverage
 * regressed more than `MAX_REGRESSION_PCT` against the previous snapshot.
 *
 * Reads `coverage/coverage-summary.json` (produced by `vitest run --coverage`
 * with the v8 provider + json-summary reporter). The workflow is responsible
 * for producing that file before invoking this script.
 *
 * Snapshot schema:
 *   { recordedAt, sha, total: { lines: <pct>, statements: <pct>,
 *     functions: <pct>, branches: <pct> } }
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

const SUMMARY_PATH = 'coverage/coverage-summary.json';
const TREND_PATH = 'docs/knowledge/metrics/coverage-trend.json';
const MAX_REGRESSION_PCT = 1.0;

interface CovTotals {
  readonly lines: { readonly pct: number };
  readonly statements: { readonly pct: number };
  readonly functions: { readonly pct: number };
  readonly branches: { readonly pct: number };
}

interface CovSummary {
  readonly total: CovTotals;
}

interface TrendEntry {
  readonly recordedAt: string;
  readonly sha: string;
  readonly total: {
    readonly lines: number;
    readonly statements: number;
    readonly functions: number;
    readonly branches: number;
  };
}

function currentSha(): string {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: fromRepo(),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const report = new Report('health-coverage-trend');
  if (!existsSync(fromRepo(SUMMARY_PATH))) {
    report.error(`Missing ${SUMMARY_PATH}. Run \`npm run test:coverage\` first.`);
    report.finish();
  }
  const summary = JSON.parse(readFileSync(fromRepo(SUMMARY_PATH), 'utf8')) as CovSummary;
  const entry: TrendEntry = {
    recordedAt: new Date().toISOString(),
    sha: currentSha(),
    total: {
      lines: summary.total.lines.pct,
      statements: summary.total.statements.pct,
      functions: summary.total.functions.pct,
      branches: summary.total.branches.pct,
    },
  };

  let trend: TrendEntry[] = [];
  if (existsSync(fromRepo(TREND_PATH))) {
    const raw = readFileSync(fromRepo(TREND_PATH), 'utf8').trim();
    if (raw) {
      try {
        trend = JSON.parse(raw) as TrendEntry[];
      } catch {
        report.warn(`${TREND_PATH} was not valid JSON; rewriting.`);
        trend = [];
      }
    }
  }

  const previous = trend.length > 0 ? trend[trend.length - 1] : null;
  trend.push(entry);
  writeFileSync(fromRepo(TREND_PATH), `${JSON.stringify(trend, null, 2)}\n`);

  process.stdout.write(
    `Coverage snapshot: lines=${entry.total.lines}% functions=${entry.total.functions}% branches=${entry.total.branches}%\n`,
  );

  if (previous) {
    const delta = entry.total.lines - previous.total.lines;
    process.stdout.write(
      `Delta vs previous (${previous.recordedAt}): ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%\n`,
    );
    if (delta < -MAX_REGRESSION_PCT) {
      report.error(
        `Line coverage regressed by ${(-delta).toFixed(2)}% (> ${MAX_REGRESSION_PCT}% threshold).`,
        {
          remediation:
            'Add tests for new code, or justify the regression in the PR body and reset the baseline.',
        },
      );
    }
  } else {
    report.info('No previous trend entry — recorded as baseline.');
  }
  report.finish();
}

main().catch((err) => {
  process.stderr.write(`coverage-trend crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
