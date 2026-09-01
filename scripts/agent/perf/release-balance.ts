import type { RunStats } from '../../../src/game/ai/types.js';
import { RELEASE_SWEEP_LEGS, RELEASE_SWEEP_REVISION } from './sweep-legs.js';

export interface ReleaseBalanceSummary {
  revision: number;
  floor1RunCount: number;
  floor2RunCount: number;
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
