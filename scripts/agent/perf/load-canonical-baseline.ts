import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunStats } from '../../../src/game/ai/types.js';

export interface CanonicalBaselineData {
  floor1Runs: RunStats[];
  floor2Runs: RunStats[];
  chainedRuns: RunStats[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load the published canonical release-matrix revision-2 baseline.
 *
 * The baseline is stored on the `baselines` branch at:
 * by-sha/26df582d99a660af0fa1e42a4761e6781b6f557f.json
 *
 * It contains:
 * - 300 Floor 1 direct runs (at .runs)
 * - 150 Floor 2 runs (at .legs.floor2.runs)
 * - 150 chained Floor 1→2 runs (at .legs.floor1-chain.runs)
 */
export async function loadCanonicalBaseline(): Promise<CanonicalBaselineData> {
  let baselineJson: string;

  try {
    baselineJson = execFileSync(
      'git',
      ['show', 'FETCH_HEAD:by-sha/26df582d99a660af0fa1e42a4761e6781b6f557f.json'],
      {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    throw new Error('Failed to load canonical baseline. Run `git fetch origin baselines` first.', {
      cause: error,
    });
  }

  const baseline = JSON.parse(baselineJson) as {
    runs: RunStats[];
    legs?: {
      floor2?: { runs?: RunStats[] };
      'floor1-chain'?: { runs?: RunStats[] };
    };
  };

  return {
    floor1Runs: baseline.runs ?? [],
    floor2Runs: baseline.legs?.floor2?.runs ?? [],
    chainedRuns: baseline.legs?.['floor1-chain']?.runs ?? [],
  };
}

/**
 * Get the metadata of the canonical release-matrix revision-2 baseline.
 * This is useful for validating cohort identity without loading all 600 runs.
 */
export function getCanonicalBaselineMetadata(): {
  commit: string;
  commitDate: string;
  revision: number;
  expectedRunCounts: { floor1: number; floor2: number; chained: number };
} {
  // Path from scripts/agent/perf/ to tests/fixtures/:
  // ../../tests/fixtures/canonical-release-baseline-summary.json
  const fixture = JSON.parse(
    readFileSync(
      path.resolve(
        __dirname,
        '../../..',
        'tests',
        'fixtures',
        'canonical-release-baseline-summary.json',
      ),
      'utf8',
    ),
  ) as {
    meta: { commit: string; commitDate: string; sweep: { revision: number } };
    floor1Count: number;
    floor2Count: number;
    chainedCount: number;
  };

  return {
    commit: fixture.meta.commit,
    commitDate: fixture.meta.commitDate,
    revision: fixture.meta.sweep.revision,
    expectedRunCounts: {
      floor1: fixture.floor1Count,
      floor2: fixture.floor2Count,
      chained: fixture.chainedCount,
    },
  };
}
