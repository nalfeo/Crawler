#!/usr/bin/env node
/**
 * Scores the deterministic fun evaluation for a published release baseline.
 *
 * This runs immediately after `release-baseline.ts` enriches the post-release
 * 100-seed win-rate sweep with commit metadata, once the full 600-run cohort
 * (`baseline.json`'s `runs: RunStats[]`) exists. It reuses the same evaluator
 * the `fun-score` CLI and `playtest-fun-rater` skill use elsewhere
 * (`scoreFunSessions`/`normalizeFunSessions` in `fun-score-lib.ts`) so the
 * release report and any ad hoc playtest report are scored identically.
 *
 * Output is diagnostic/trendable, not a release gate: a low fun score must
 * never fail a deploy that has already shipped. The workflow step invoking
 * this script tolerates a non-zero exit so a scoring failure is visible in
 * the job log without blocking the baseline publish.
 *
 * Deterministic output contract: `.cache/baseline/fun-report.json`
 * `{ meta: ReleaseBaselineMeta, report: FunScoreReport }` — see
 * `docs/knowledge/game-design/playtest-fun-eval-framework.md`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  normalizeFunSessions,
  scoreFunSessions,
  type FunScoreReport,
} from '../health/fun-score-lib.js';
import type { ReleaseBaselineMeta } from './release-baseline.js';

export interface ReleaseFunReport {
  readonly meta: ReleaseBaselineMeta;
  readonly report: FunScoreReport;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Scores a fun-evaluation report for an already-enriched release baseline
 * (i.e. one that has passed through `enrichReleaseBaseline`/`meta`
 * attachment). The baseline's own `runs: RunStats[]` cohort is the input —
 * no separate run set is captured for this step.
 */
export function buildReleaseFunReport(baseline: unknown): ReleaseFunReport {
  if (!isRecord(baseline)) {
    throw new Error('Release baseline must be a JSON object.');
  }
  if (!isRecord(baseline.meta)) {
    throw new Error(
      'Release baseline must include meta (run release-baseline.ts before scoring fun evaluation).',
    );
  }
  const sessions = normalizeFunSessions(baseline);
  const report = scoreFunSessions(sessions);
  return { meta: baseline.meta as unknown as ReleaseBaselineMeta, report };
}

export function serializeReleaseFunReport(value: ReleaseFunReport): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function main(): void {
  const baselinePath = requiredEnv('BASELINE_JSON');
  const outPath = requiredEnv('FUN_REPORT_JSON');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as unknown;
  const funReport = buildReleaseFunReport(baseline);
  writeFileSync(outPath, serializeReleaseFunReport(funReport));
  process.stdout.write(
    `fun-eval: overall=${funReport.report.overall_fun_score} ` +
      `gate.pass=${funReport.report.gate.pass} runs=${funReport.report.runs}\n`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
