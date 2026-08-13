#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { RunStats } from '../../../src/game/ai/types.js';
import { normalizeFunSessions } from '../health/fun-score-lib.js';

type UnknownRecord = Record<string, unknown>;

export interface ReleaseBaselineMeta {
  commit: string;
  commitDate: string;
  commitSubject: string;
  capturedAt: string;
  runId: string;
  runNumber: number;
  runUrl: string;
  sweep: {
    seeds: string;
    kind: 'winrate';
  };
}

export type ReleaseBaselineWithRuns<T extends UnknownRecord> = T & {
  totalRuns: number;
  runs: RunStats[];
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the persisted release-baseline contract through the real fun-score
 * normalizer. Count equality prevents a partial producer or publisher from
 * silently storing fewer runs than the aggregate claims.
 */
export function assertReleaseBaselineRuns(
  payload: unknown,
): asserts payload is ReleaseBaselineWithRuns<UnknownRecord> {
  if (!isRecord(payload)) {
    throw new Error('Release baseline must be a JSON object.');
  }
  if (!Number.isInteger(payload.totalRuns) || (payload.totalRuns as number) < 0) {
    throw new Error('Release baseline totalRuns must be a non-negative integer.');
  }
  if (!Array.isArray(payload.runs)) {
    throw new Error('Release baseline must include runs: RunStats[].');
  }

  const sessions = normalizeFunSessions(payload);
  if (sessions.length !== payload.totalRuns) {
    throw new Error(
      `Release baseline run count mismatch: totalRuns=${payload.totalRuns}, runs=${sessions.length}.`,
    );
  }
}

export function attachReleaseBaselineRuns<T extends UnknownRecord & { totalRuns: number }>(
  summary: T,
  runs: readonly RunStats[],
): ReleaseBaselineWithRuns<T> {
  if ('runs' in summary) {
    throw new Error('Release baseline summary already contains a runs field.');
  }
  const payload = { ...summary, runs: [...runs] };
  assertReleaseBaselineRuns(payload);
  return payload;
}

export function enrichReleaseBaseline<T extends ReleaseBaselineWithRuns<UnknownRecord>>(
  baseline: T,
  meta: ReleaseBaselineMeta,
): T & { meta: ReleaseBaselineMeta } {
  if ('meta' in baseline) {
    throw new Error('Release baseline already contains meta; refusing to overwrite provenance.');
  }
  assertReleaseBaselineRuns(baseline);
  const enriched = { meta, ...baseline };
  assertReleaseBaselineRuns(enriched);
  return enriched;
}

/**
 * Validate the JSON round trip, not only the in-memory object, so undefined or
 * non-serializable required fields cannot produce a corrupt stored artifact.
 */
export function serializeReleaseBaseline(payload: unknown): string {
  assertReleaseBaselineRuns(payload);
  const json = JSON.stringify(payload, null, 2);
  assertReleaseBaselineRuns(JSON.parse(json) as unknown);
  return json;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function main(): void {
  const baselinePath = requiredEnv('BASELINE_JSON');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as unknown;
  assertReleaseBaselineRuns(baseline);

  const runNumber = Number(requiredEnv('RUN_NUMBER'));
  if (!Number.isInteger(runNumber) || runNumber <= 0) {
    throw new Error('RUN_NUMBER must be a positive integer.');
  }

  const enriched = enrichReleaseBaseline(baseline, {
    commit: requiredEnv('SHA'),
    commitDate: requiredEnv('COMMIT_DATE'),
    commitSubject: requiredEnv('COMMIT_SUBJECT'),
    capturedAt: new Date().toISOString(),
    runId: requiredEnv('RUN_ID'),
    runNumber,
    runUrl: requiredEnv('RUN_URL'),
    sweep: { seeds: '1-100', kind: 'winrate' },
  });
  writeFileSync(baselinePath, serializeReleaseBaseline(enriched));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
