#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { RunStats } from '../../../src/game/ai/types.js';
import { normalizeFunSessions } from '../health/fun-score-lib.js';
import { RELEASE_SWEEP_REVISION } from './sweep-legs.js';

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
    revision: number;
  };
}

export type ReleaseBaselineWithRuns<T extends UnknownRecord> = T & {
  totalRuns: number;
  runs: RunStats[];
};

const VALID_OUTCOMES: ReadonlySet<string> = new Set([
  'victory',
  'death',
  'timeout',
  'stalled',
  'error',
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, where: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new Error(`${where} must be an object.`);
  }
  return value;
}

function requireFiniteNumbers(
  record: UnknownRecord,
  where: string,
  fields: readonly string[],
): void {
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${where}.${field} must be a finite number.`);
    }
  }
}

function requireNullableFiniteNumbers(
  record: UnknownRecord,
  where: string,
  fields: readonly string[],
): void {
  for (const field of fields) {
    const value = record[field];
    if (value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${where}.${field} must be a finite number or null.`);
    }
  }
}

function requireNumberRecords(
  record: UnknownRecord,
  where: string,
  fields: readonly string[],
): void {
  for (const field of fields) {
    const value = requireRecord(record[field], `${where}.${field}`);
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== 'number' || !Number.isFinite(entry)) {
        throw new Error(`${where}.${field}.${key} must be a finite number.`);
      }
    }
  }
}

/**
 * Dedicated runtime schema for a persisted `RunStats`. The fun-score normalizer
 * is a lenient compatibility parser for historical inputs (it tolerates missing
 * `safeRoomMs` and never inspects `totalFrames`, `wallTimeMs`, `finalFloor`,
 * `finalScore`, or `totalGold`), so it cannot prove that this module actually
 * persisted a complete run. Every required field of `RunStats`, including the
 * required nested fields, is checked here — after JSON serialization a `NaN`
 * becomes `null` and an `undefined` disappears, and both must fail.
 */
function assertRunStats(value: unknown, where: string): asserts value is RunStats {
  const run = requireRecord(value, where);

  requireFiniteNumbers(run, where, [
    'totalFrames',
    'wallTimeMs',
    'gameTimeMs',
    'safeRoomMs',
    'finalFloor',
    'finalScore',
    'finalLevel',
    'totalXp',
    'totalGold',
  ]);
  if (typeof run.outcome !== 'string' || !VALID_OUTCOMES.has(run.outcome)) {
    throw new Error(`${where}.outcome must be a valid run outcome.`);
  }
  if (typeof run.startingWeapon !== 'string') {
    throw new Error(`${where}.startingWeapon must be a string.`);
  }
  if (!Array.isArray(run.levelUps)) {
    throw new Error(`${where}.levelUps must be an array.`);
  }
  run.levelUps.forEach((entry, index) => {
    const levelUp = requireRecord(entry, `${where}.levelUps[${index}]`);
    requireFiniteNumbers(levelUp, `${where}.levelUps[${index}]`, ['level', 'gameTimeMs', 'frame']);
  });

  const combat = requireRecord(run.combat, `${where}.combat`);
  requireFiniteNumbers(combat, `${where}.combat`, [
    'totalKills',
    'combatTimeMs',
    'engagementCount',
    'damageDealt',
    'damageTaken',
  ]);
  requireNumberRecords(combat, `${where}.combat`, ['killsByType', 'damageTakenBySource']);

  const health = requireRecord(run.health, `${where}.health`);
  requireFiniteNumbers(health, `${where}.health`, [
    'minHealthPercent',
    'closeCallCount',
    'lowHealthCount',
    'finalHealthPercent',
  ]);

  const quests = requireRecord(run.quests, `${where}.quests`);
  requireFiniteNumbers(quests, `${where}.quests`, ['questsAccepted', 'questsCompleted']);
  requireNullableFiniteNumbers(quests, `${where}.quests`, [
    'mainQuestAcceptedMs',
    'mainQuestCompletedMs',
    'firstQuestCompletedMs',
  ]);
  if (
    !Array.isArray(quests.questsFailed) ||
    quests.questsFailed.some((questId) => typeof questId !== 'string')
  ) {
    throw new Error(`${where}.quests.questsFailed must be an array of quest ids.`);
  }
  requireNumberRecords(quests, `${where}.quests`, ['questLogAccepts', 'questLogCompletions']);
}

/**
 * Validate the persisted release-baseline contract: every stored entry is a
 * complete `RunStats`, and the stored payload still ingests through the real
 * fun-score normalizer. Count equality prevents a partial producer or publisher
 * from silently storing fewer runs than the aggregate claims.
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

  payload.runs.forEach((run, index) => {
    assertRunStats(run, `Release baseline runs[${index}]`);
  });

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
    sweep: { seeds: '1-50', kind: 'winrate', revision: RELEASE_SWEEP_REVISION },
  });
  writeFileSync(baselinePath, serializeReleaseBaseline(enriched));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
