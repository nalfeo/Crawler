export const FLOOR4_COMPLETION_CRITERIA = [
  'scenario-initialized',
  'physical-wave-hostile-spawned',
  'all-wave-windows-released',
  'all-headliners-spawned-and-defeated',
  'intermission-public-interaction',
  'phase-reached-victory',
  'runstats-outcome-victory',
  'terminated-before-stall-backstop',
] as const;

export type Floor4CompletionCriterion = (typeof FLOOR4_COMPLETION_CRITERIA)[number];

export interface Floor4CompletionEvidence {
  scenarioInitialized: boolean;
  phaseKind: string | null;
  wavesReleased: number | undefined;
  enemiesSpawned: number | undefined;
  headlinersSpawned: number | undefined;
  headlinersDefeated: number | undefined;
  intermissionActs: readonly number[];
  intermissionReasons: readonly string[];
  runStatsOutcome: string | null;
  totalFrames: number;
  maxFrames: number;
  stallBackstopReached: boolean;
}

export interface Floor4CompletionAssessment {
  criteria: Record<Floor4CompletionCriterion, boolean>;
  firstFailedCriterion: Floor4CompletionCriterion | null;
}

export function assessFloor4Completion(
  evidence: Floor4CompletionEvidence,
): Floor4CompletionAssessment {
  const criteria: Record<Floor4CompletionCriterion, boolean> = {
    'scenario-initialized': evidence.scenarioInitialized,
    'physical-wave-hostile-spawned': (evidence.enemiesSpawned ?? 0) > 0,
    'all-wave-windows-released': (evidence.wavesReleased ?? 0) >= 5,
    'all-headliners-spawned-and-defeated':
      evidence.headlinersSpawned === 5 && evidence.headlinersDefeated === 5,
    'intermission-public-interaction':
      new Set(evidence.intermissionActs).size === 5 &&
      evidence.intermissionReasons.length === 5 &&
      evidence.intermissionReasons.every(
        (reason) => reason !== 'slice2-auto-green-room-exit' && reason !== 'slice2-auto-stairs',
      ),
    'phase-reached-victory': evidence.phaseKind === 'VICTORY',
    'runstats-outcome-victory': evidence.runStatsOutcome === 'victory',
    'terminated-before-stall-backstop':
      !evidence.stallBackstopReached && evidence.totalFrames < evidence.maxFrames,
  };
  const firstFailedCriterion =
    FLOOR4_COMPLETION_CRITERIA.find((criterion) => !criteria[criterion]) ?? null;

  return { criteria, firstFailedCriterion };
}
