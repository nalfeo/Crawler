#!/usr/bin/env node
/**
 * Release-baseline index derivation.
 *
 * `index.json` on the `baselines` branch is a pure function of the `by-sha/*.json`
 * baseline files, which is what lets concurrent baseline publishers never
 * textually merge a shared array. That derivation used to live as an inline
 * `node -e` script inside deploy.yml, where it was untestable — and it silently
 * dropped the per-leg metrics, so `evaluateBaselineRegression` never saw a
 * previous entry's `legs` and every per-leg diagnostic was dead on real
 * releases. It lives here so the mapping is covered by unit tests.
 *
 * CLI usage (from the workflow):
 *   BASELINES_DIR=<worktree> npx tsx scripts/agent/perf/baseline-index.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { BaselineFile, BaselineIndexEntry } from './baseline-regression-check.js';

interface FunReportFile {
  report: {
    overall_fun_score: number;
    gate: { pass: boolean };
  };
}

function parseFunReport(value: unknown): FunReportFile | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as FunReportFile).report?.overall_fun_score !== 'number' ||
    typeof (value as FunReportFile).report?.gate?.pass !== 'boolean'
  ) {
    return null;
  }
  return value as FunReportFile;
}

/**
 * Map one stored baseline onto its index entry, preserving EVERY field the
 * regression check reads from a previous entry — including `legs` and the sweep
 * matrix revision, both of which gate real comparison behavior.
 */
export function toBaselineIndexEntry(
  baseline: BaselineFile,
  funReport: FunReportFile | null = null,
): BaselineIndexEntry {
  const legs = baseline.legs
    ? Object.fromEntries(
        Object.entries(baseline.legs).map(([legId, leg]) => [
          legId,
          {
            winRate: leg.winRate,
            totalWins: leg.totalWins,
            totalRuns: leg.totalRuns,
          },
        ]),
      )
    : undefined;
  return {
    commit: baseline.meta.commit,
    commitDate: baseline.meta.commitDate,
    commitSubject: baseline.meta.commitSubject,
    capturedAt: baseline.meta.capturedAt,
    runUrl: baseline.meta.runUrl,
    winRate: baseline.winRate,
    totalWins: baseline.totalWins,
    totalRuns: baseline.totalRuns,
    path: `by-sha/${baseline.meta.commit}.json`,
    ...(legs ? { legs } : {}),
    ...(typeof baseline.meta.sweep?.revision === 'number'
      ? { sweepRevision: baseline.meta.sweep.revision }
      : {}),
    fun: funReport
      ? {
          overallFunScore: funReport.report.overall_fun_score,
          gatePass: funReport.report.gate.pass,
          path: `by-sha/${baseline.meta.commit}.fun-report.json`,
        }
      : null,
  };
}

function hasCommit(baseline: unknown): baseline is BaselineFile {
  return (
    typeof baseline === 'object' &&
    baseline !== null &&
    typeof (baseline as BaselineFile).meta?.commit === 'string'
  );
}

/** Build the whole index, newest commit date first. */
export function buildBaselineIndex(
  baselines: readonly unknown[],
  funReports: ReadonlyMap<string, unknown> = new Map(),
): BaselineIndexEntry[] {
  return baselines
    .filter(hasCommit)
    .map((baseline) =>
      toBaselineIndexEntry(baseline, parseFunReport(funReports.get(baseline.meta.commit))),
    )
    .sort((a, b) => (b.commitDate || '').localeCompare(a.commitDate || ''));
}

/** Read every `by-sha/*.json` under `dir` and write `index.json` beside it. */
export function writeBaselineIndex(dir: string): BaselineIndexEntry[] {
  const bySha = path.join(dir, 'by-sha');
  const baselines = fs
    .readdirSync(bySha)
    .filter((file) => file.endsWith('.json') && !file.endsWith('.fun-report.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(bySha, file), 'utf8')) as unknown);
  const funReports = new Map<string, unknown>();
  for (const file of fs.readdirSync(bySha).filter((name) => name.endsWith('.fun-report.json'))) {
    const commit = file.slice(0, -'.fun-report.json'.length);
    try {
      funReports.set(
        commit,
        JSON.parse(fs.readFileSync(path.join(bySha, file), 'utf8')) as unknown,
      );
    } catch {
      // Historical diagnostic reports must not prevent baseline discovery.
      funReports.set(commit, null);
    }
  }
  const entries = buildBaselineIndex(baselines, funReports);
  fs.writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify(entries, null, 2)}\n`);
  return entries;
}

function main(): void {
  const dir = process.env.BASELINES_DIR;
  if (!dir) throw new Error('BASELINES_DIR is required');
  const entries = writeBaselineIndex(dir);
  console.log(
    `baseline index rebuilt with ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}.`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
