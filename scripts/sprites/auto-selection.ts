import type { RunSummaryEntry } from './run-artifacts.js';

export type AutoSelectionRejectReason =
  | 'missing-judge-scorecard'
  | 'hard-block-not-evaluated'
  | 'sensor-failures-exceeded'
  | 'hard-blocked';

export interface AutoSelectionRejectedDiagnostic {
  readonly entryIndex: number;
  readonly reason: AutoSelectionRejectReason;
  readonly sensorFailures: number;
  readonly judgeMinScore: number | null;
  readonly judgeConfidence: number | null;
  readonly hardBlockEvaluated: boolean;
  readonly hardBlocked: boolean;
  readonly hardBlockInstruction: string | null;
  readonly hardBlockRationale: string | null;
}

export interface AutoSelectionResult {
  readonly selected: ReadonlyArray<RunSummaryEntry>;
  readonly rejected: ReadonlyArray<AutoSelectionRejectedDiagnostic>;
}

export interface AutoSelectionOptions {
  readonly maxVariants?: number;
}

const DEFAULT_MAX_VARIANTS = 3;
const MAX_SENSOR_FAILURES = 2;

function sensorFailures(entry: RunSummaryEntry): number {
  return entry.outOf - entry.score;
}

export function autoSelectVariants(
  entries: ReadonlyArray<RunSummaryEntry>,
  options: AutoSelectionOptions = {},
): AutoSelectionResult {
  const maxVariants = options.maxVariants ?? DEFAULT_MAX_VARIANTS;
  const acceptable: RunSummaryEntry[] = [];
  const rejected: AutoSelectionRejectedDiagnostic[] = [];

  for (const entry of entries) {
    const failures = sensorFailures(entry);
    const judge = entry.judgeScorecard;
    if (!judge) {
      rejected.push({
        entryIndex: entry.index,
        reason: 'missing-judge-scorecard',
        sensorFailures: failures,
        judgeMinScore: null,
        judgeConfidence: null,
        hardBlockEvaluated: false,
        hardBlocked: false,
        hardBlockInstruction: null,
        hardBlockRationale: null,
      });
      continue;
    }
    if (judge.hardBlockEvaluated !== true) {
      rejected.push({
        entryIndex: entry.index,
        reason: 'hard-block-not-evaluated',
        sensorFailures: failures,
        judgeMinScore: judge.minScore,
        judgeConfidence: typeof judge.confidence === 'number' ? judge.confidence : null,
        hardBlockEvaluated: false,
        hardBlocked: false,
        hardBlockInstruction: null,
        hardBlockRationale: null,
      });
      continue;
    }
    if (failures > MAX_SENSOR_FAILURES) {
      rejected.push({
        entryIndex: entry.index,
        reason: 'sensor-failures-exceeded',
        sensorFailures: failures,
        judgeMinScore: judge.minScore,
        judgeConfidence: typeof judge.confidence === 'number' ? judge.confidence : null,
        hardBlockEvaluated: true,
        hardBlocked: judge.hardBlocked === true,
        hardBlockInstruction: judge.hardBlockInstruction ?? null,
        hardBlockRationale: judge.hardBlockRationale ?? null,
      });
      continue;
    }
    if (judge.hardBlocked === true) {
      rejected.push({
        entryIndex: entry.index,
        reason: 'hard-blocked',
        sensorFailures: failures,
        judgeMinScore: judge.minScore,
        judgeConfidence: typeof judge.confidence === 'number' ? judge.confidence : null,
        hardBlockEvaluated: true,
        hardBlocked: true,
        hardBlockInstruction: judge.hardBlockInstruction ?? null,
        hardBlockRationale: judge.hardBlockRationale ?? null,
      });
      continue;
    }
    acceptable.push(entry);
  }

  const selected = [...acceptable]
    .sort((a, b) => {
      const sensorFailureDelta = sensorFailures(a) - sensorFailures(b);
      if (sensorFailureDelta !== 0) return sensorFailureDelta;
      const minScoreDelta =
        (b.judgeScorecard?.minScore ?? -Infinity) - (a.judgeScorecard?.minScore ?? -Infinity);
      if (minScoreDelta !== 0) return minScoreDelta;
      const confidenceDelta =
        (typeof b.judgeScorecard?.confidence === 'number'
          ? b.judgeScorecard.confidence
          : -Infinity) -
        (typeof a.judgeScorecard?.confidence === 'number'
          ? a.judgeScorecard.confidence
          : -Infinity);
      if (confidenceDelta !== 0) return confidenceDelta;
      return a.index - b.index;
    })
    .slice(0, maxVariants);

  return { selected, rejected };
}
