import type { RunStats } from '../../../src/game/ai/types.js';
import { RELEASE_SWEEP_LEGS, RELEASE_SWEEP_REVISION } from './sweep-legs.js';

export interface ReleaseBalanceSummary {
  revision: number;
  floor1RunCount: number;
  floor2RunCount: number;
  floor6RunCount: number;
  chainedRunCount: number;
  meanFloor1CompletionLevel: number | null;
  meanFloor3EntryLevel: number | null;
  floor1P90CombatSkillLevel: number | null;
  floor2P90CombatSkillLevel: number | null;
  completedBossFightCount: number;
  incompleteBossFightCount: number;
  meanCompletedBossFightMs: number | null;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile90(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.9) - 1] ?? null;
}

function bossDurations(run: RunStats): { completed: number[]; incomplete: number } {
  const encounters = [
    ...Object.values(run.floor1BossProgression?.encounters ?? {}),
    ...Object.values(run.floor2Progression?.families ?? {}),
  ];
  const completed: number[] = [];
  let incomplete = 0;
  for (const encounter of encounters) {
    if (!encounter.encounterStarted) continue;
    if (
      !encounter.encounterDefeated ||
      encounter.encounterStartedMs === null ||
      encounter.encounterDefeatedMs === null
    ) {
      incomplete += 1;
      continue;
    }
    completed.push(encounter.encounterDefeatedMs - encounter.encounterStartedMs);
  }
  return { completed, incomplete };
}

/**
 * Derive deterministic release-balance metrics from the canonical leg payload.
 * Chained runs represent Floor 3 entry by their completed Floor 2 endpoint.
 *
 * Requires complete telemetry: if maxCombatSkillLevel is missing on any run,
 * the result's skill-level fields are null and acceptance gates must require
 * complete observations before passing.
 */
export function analyzeReleaseBalance(input: {
  floor1: readonly RunStats[];
  floor2: readonly RunStats[];
  floor6: readonly RunStats[];
  floor1Chain: readonly RunStats[];
}): ReleaseBalanceSummary {
  const fights = [...input.floor1, ...input.floor2].map(bossDurations);

  // Check for missing maxCombatSkillLevel — if any run is missing it, report null
  const floor1SkillLevels = input.floor1
    .map((run) => run.skills?.maxCombatSkillLevel)
    .filter((level): level is number => level !== undefined && level !== null);
  const floor1SkillsComplete = floor1SkillLevels.length === input.floor1.length;

  const floor2SkillLevels = input.floor2
    .map((run) => run.skills?.maxCombatSkillLevel)
    .filter((level): level is number => level !== undefined && level !== null);
  const floor2SkillsComplete = floor2SkillLevels.length === input.floor2.length;

  return {
    revision: RELEASE_SWEEP_REVISION,
    floor1RunCount: input.floor1.length,
    floor2RunCount: input.floor2.length,
    floor6RunCount: input.floor6.length,
    chainedRunCount: input.floor1Chain.length,
    meanFloor1CompletionLevel: mean(
      input.floor1.filter((run) => run.outcome === 'victory').map((run) => run.finalLevel),
    ),
    meanFloor3EntryLevel: mean(
      input.floor1Chain.filter((run) => run.outcome === 'victory').map((run) => run.finalLevel),
    ),
    floor1P90CombatSkillLevel: floor1SkillsComplete ? percentile90(floor1SkillLevels) : null,
    floor2P90CombatSkillLevel: floor2SkillsComplete ? percentile90(floor2SkillLevels) : null,
    completedBossFightCount: fights.reduce((sum, fight) => sum + fight.completed.length, 0),
    incompleteBossFightCount: fights.reduce((sum, fight) => sum + fight.incomplete, 0),
    meanCompletedBossFightMs: mean(fights.flatMap((fight) => fight.completed)),
  };
}

export function canonicalReleaseBalanceCounts(): Record<string, number> {
  return Object.fromEntries(RELEASE_SWEEP_LEGS.map((leg) => [leg.id, leg.runs]));
}

export function validateReleaseBalanceSummary(summary: ReleaseBalanceSummary): string[] {
  const errors: string[] = [];
  const expectedCounts = canonicalReleaseBalanceCounts();

  const expectedFloor1 = expectedCounts.floor1 ?? 300;
  const expectedFloor2 = expectedCounts.floor2 ?? 150;
  const expectedFloor6 = expectedCounts.floor6 ?? 150;
  const expectedChained = expectedCounts['floor1-chain'] ?? 150;

  if (summary.floor1RunCount !== expectedFloor1) {
    errors.push(
      `Expected ${expectedFloor1} Floor 1 runs for the release cohort, received ${summary.floor1RunCount}.`,
    );
  }
  if (summary.floor2RunCount !== expectedFloor2) {
    errors.push(
      `Expected ${expectedFloor2} Floor 2 runs for the release cohort, received ${summary.floor2RunCount}.`,
    );
  }
  if (summary.floor6RunCount !== expectedFloor6) {
    errors.push(
      `Expected ${expectedFloor6} Floor 6 runs for the release cohort, received ${summary.floor6RunCount}.`,
    );
  }
  if (summary.chainedRunCount !== expectedChained) {
    errors.push(
      `Expected ${expectedChained} chained runs for the release cohort, received ${summary.chainedRunCount}.`,
    );
  }

  const floor1MeanMin = 6.5;
  const floor1MeanMax = 7.5;
  const floor3MeanMin = 9.5;
  const floor3MeanMax = 10.5;

  if (summary.meanFloor1CompletionLevel === null) {
    errors.push('Floor 1 completion-level telemetry is required for the canonical release gate.');
  } else if (
    summary.meanFloor1CompletionLevel < floor1MeanMin ||
    summary.meanFloor1CompletionLevel > floor1MeanMax
  ) {
    errors.push(
      `Floor 1 mean completion level ${summary.meanFloor1CompletionLevel} is outside ${floor1MeanMin}–${floor1MeanMax}.`,
    );
  }

  if (summary.meanFloor3EntryLevel === null) {
    errors.push('Floor 3-entry telemetry is required for the canonical release gate.');
  } else if (
    summary.meanFloor3EntryLevel < floor3MeanMin ||
    summary.meanFloor3EntryLevel > floor3MeanMax
  ) {
    errors.push(
      `Floor 3 entry mean level ${summary.meanFloor3EntryLevel} is outside ${floor3MeanMin}–${floor3MeanMax}.`,
    );
  }

  if (summary.floor1P90CombatSkillLevel === null) {
    errors.push(
      'Floor 1 skill telemetry is incomplete; canonical release gate requires complete observations.',
    );
  } else if (summary.floor1P90CombatSkillLevel > 4) {
    errors.push(
      `Floor 1 p90 combat skill level ${summary.floor1P90CombatSkillLevel} exceeds the 4-level cap.`,
    );
  }

  if (summary.floor2P90CombatSkillLevel === null) {
    errors.push(
      'Floor 2 skill telemetry is incomplete; canonical release gate requires complete observations.',
    );
  } else if (summary.floor2P90CombatSkillLevel > 6) {
    errors.push(
      `Floor 2 p90 combat skill level ${summary.floor2P90CombatSkillLevel} exceeds the 6-level cap.`,
    );
  }

  if (summary.meanCompletedBossFightMs === null) {
    errors.push(
      'Boss-fight duration telemetry is incomplete; canonical release gate requires complete observations.',
    );
  } else if (
    summary.meanCompletedBossFightMs < 27_000 ||
    summary.meanCompletedBossFightMs > 33_000
  ) {
    errors.push(
      `Mean completed boss-fight duration ${summary.meanCompletedBossFightMs}ms is outside 27,000–33,000ms.`,
    );
  }

  return errors;
}

export function assertReleaseBalanceSummary(summary: ReleaseBalanceSummary): void {
  const errors = validateReleaseBalanceSummary(summary);
  if (errors.length > 0) {
    throw new Error(`Canonical release-balance gate failed:\n- ${errors.join('\n- ')}`);
  }
}
