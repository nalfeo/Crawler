import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { WeaponSweepOutput } from './weapon-sweep-results.js';
import type { RunStats } from '../../../src/game/ai/types.js';

export const EXPERIMENT_ARTIFACT_DIRECTORY = join('artifacts', 'experiments');
export const EXPERIMENT_SCHEMA_VERSION = 'crawler.experiment.v1';

export interface ExperimentRecord {
  id: string;
  seed?: number;
  outcome?: string;
  dimensions: Record<string, string | number | boolean>;
  metrics: Record<string, number | string | boolean | null>;
  payload?: unknown;
}

export interface ExperimentAggregate {
  dimensions: Record<string, string | number | boolean>;
  metrics: Record<string, number | string | boolean | null>;
  counts?: Record<string, number>;
}

export interface ExperimentResult {
  schemaVersion: typeof EXPERIMENT_SCHEMA_VERSION;
  experiment: {
    type: string;
    id: string;
    parameters: Record<string, unknown>;
  };
  runAt: string;
  dimensions: Record<string, Array<string | number | boolean>>;
  records: ExperimentRecord[];
  aggregates: ExperimentAggregate[];
  extensions?: Record<string, unknown>;
}

export function weaponSweepToExperiment(
  output: WeaponSweepOutput,
): ExperimentResult & WeaponSweepOutput {
  const records = output.allRecords.map((record) => ({
    id: `${record.weapon}:${record.seed}`,
    seed: record.seed,
    outcome: record.outcome,
    dimensions: { weapon: record.weapon },
    metrics: {
      gameTimeSec: record.gameTimeSec,
      finalLevel: record.finalLevel,
      totalKills: record.totalKills,
      totalXp: record.totalXp,
      totalGold: record.totalGold,
      score: record.score,
      minHealthPct: record.minHealthPct,
      closeCallCount: record.closeCallCount,
      questsCompleted: record.questsCompleted,
    },
    payload: record,
  }));

  return {
    ...output,
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    experiment: {
      type: 'weapon-sweep',
      id: `weapon-sweep-${output.runAt}`,
      parameters: {
        floors: output.floors ?? null,
        seeds: output.seeds,
        weapons: output.weapons,
        maxFrames: output.maxFrames,
        weaponPersonas: output.weaponPersonas,
        budgetSec: output.budgetSec,
      },
    },
    runAt: output.runAt,
    dimensions: {
      weapon: output.weapons,
    },
    records,
    aggregates: output.summaries.map((summary) => ({
      dimensions: { weapon: summary.weapon },
      metrics: {
        winRate: summary.winRate,
        meanGameTimeSec: summary.meanGameTimeSec,
        meanLevel: summary.meanLevel,
        meanKills: summary.meanKills,
        meanXp: summary.meanXp,
        meanScore: summary.meanScore,
        meanMinHealthPct: summary.meanMinHealthPct,
        meanCloseCallCount: summary.meanCloseCallCount,
        meanQuestsCompleted: summary.meanQuestsCompleted,
      },
      counts: { runs: summary.runs, victories: summary.victories },
    })),
  };
}

export function runStatsToExperiment(
  type: string,
  id: string,
  runAt: string,
  runs: readonly RunStats[],
  parameters: Record<string, unknown> = {},
): ExperimentResult {
  const records = runs.map((run, index) => {
    const raw = run as unknown as Record<string, unknown>;
    const metrics: Record<string, number | string | boolean | null> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
        metrics[key] = value;
      }
    }
    const dimensions: Record<string, string | number | boolean> = {};
    for (const key of ['playerPersona', 'startingWeapon', 'weaponPersona']) {
      const value = raw[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        dimensions[key] = value;
      }
    }
    const seed = typeof raw.seed === 'number' ? raw.seed : undefined;
    return {
      id: `${id}:${seed ?? 'record'}:${index}`,
      seed,
      outcome: typeof raw.outcome === 'string' ? raw.outcome : undefined,
      dimensions,
      metrics,
      payload: run,
    };
  });
  const dimensions: Record<string, Array<string | number | boolean>> = {};
  for (const name of ['playerPersona', 'startingWeapon', 'weaponPersona']) {
    dimensions[name] = [
      ...new Set(
        records
          .map((record) => record.dimensions[name])
          .filter((value): value is string | number | boolean => value !== undefined),
      ),
    ];
  }
  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    experiment: { type, id, parameters },
    runAt,
    dimensions,
    records,
    aggregates: [],
  };
}

export function defaultExperimentOutputPath(
  workingDirectory: string,
  type: string,
  runAt: Date,
  collisionIndex = 1,
): string {
  if (!Number.isFinite(runAt.getTime())) {
    throw new Error('Experiment output timestamp must be a valid date');
  }
  const suffix = collisionIndex > 1 ? `-${collisionIndex}` : '';
  const timestamp = runAt.toISOString().replaceAll(':', '-');
  return join(
    workingDirectory,
    EXPERIMENT_ARTIFACT_DIRECTORY,
    `${type}-${timestamp}${suffix}.json`,
  );
}

export function writeExperimentResult(
  result: ExperimentResult,
  explicitPath: string | undefined,
  workingDirectory = process.cwd(),
): string {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (explicitPath) {
    writeFileSync(explicitPath, serialized);
    return explicitPath;
  }
  const date = new Date(result.runAt);
  const directory = dirname(
    defaultExperimentOutputPath(workingDirectory, result.experiment.type, date),
  );
  mkdirSync(directory, { recursive: true });
  for (let collisionIndex = 1; ; collisionIndex += 1) {
    const candidate = defaultExperimentOutputPath(
      workingDirectory,
      result.experiment.type,
      date,
      collisionIndex,
    );
    try {
      writeFileSync(candidate, serialized, { flag: 'wx' });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}
