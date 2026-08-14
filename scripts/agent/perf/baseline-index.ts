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

/**
 * Map one stored baseline onto its index entry, preserving EVERY field the
 * regression check reads from a previous entry — including `legs` and the sweep
 * matrix revision, both of which gate real comparison behavior.
 */
export function toBaselineIndexEntry(baseline: BaselineFile): BaselineIndexEntry {
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
    ...(baseline.legs ? { legs: baseline.legs } : {}),
    ...(typeof baseline.meta.sweep?.revision === 'number'
      ? { sweepRevision: baseline.meta.sweep.revision }
      : {}),
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
export function buildBaselineIndex(baselines: readonly unknown[]): BaselineIndexEntry[] {
  return baselines
    .filter(hasCommit)
    .map(toBaselineIndexEntry)
    .sort((a, b) => (b.commitDate || '').localeCompare(a.commitDate || ''));
}

/** Read every `by-sha/*.json` under `dir` and write `index.json` beside it. */
export function writeBaselineIndex(dir: string): BaselineIndexEntry[] {
  const bySha = path.join(dir, 'by-sha');
  const baselines = fs
    .readdirSync(bySha)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(bySha, file), 'utf8')) as unknown);
  const entries = buildBaselineIndex(baselines);
  fs.writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify(entries, null, 2)}\n`);
  return entries;
}

function main(): void {
  const dir = process.env.BASELINES_DIR;
  if (!dir) throw new Error('BASELINES_DIR is required');
  const entries = writeBaselineIndex(dir);
  console.log(`baseline index rebuilt with ${entries.length} entrie(s).`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
