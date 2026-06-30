import type { RunStats } from '../../../src/game/ai/types.js';

export interface PlaytestSurvey {
  readonly enjoyment?: number;
  readonly immersion?: number;
  readonly mastery?: number;
  readonly control?: number;
  readonly tension?: number;
}

export interface FunSession {
  readonly id: string;
  readonly run: RunStats;
  readonly survey?: PlaytestSurvey;
}

export interface FunDimensionScores {
  readonly engagement: number;
  readonly challenge_balance: number;
  readonly excitement: number;
  readonly pacing: number;
  readonly competence_growth: number;
  readonly choice_depth: number;
  readonly run_distinctness: number;
}

export interface FunHotspot {
  readonly dimension: keyof FunDimensionScores | 'survey';
  readonly score: number;
  readonly reason: string;
}

export interface FunGate {
  readonly min_overall: number;
  readonly min_dimension: number;
  readonly gating_overall_score: number;
  readonly pass: boolean;
  readonly failing_dimensions: ReadonlyArray<keyof FunDimensionScores>;
}

export interface FunScoreReport {
  readonly runs: number;
  readonly outcomes: Readonly<Record<RunStats['outcome'], number>>;
  readonly survey_coverage: number;
  readonly overall_fun_score: number;
  readonly dimensions: FunDimensionScores;
  /** Inverse of run_distinctness (0 = very distinct runs, 100 = highly samey runs). */
  readonly sameness_grade: number;
  readonly objective_score: number;
  readonly subjective_score: number | null;
  readonly confidence: number;
  readonly gate: FunGate;
  readonly hotspots: ReadonlyArray<FunHotspot>;
}

export interface FunScoreConfig {
  readonly minOverall: number;
  readonly minDimension: number;
}

const DEFAULT_CONFIG: FunScoreConfig = {
  minOverall: 70,
  minDimension: 55,
};

const DIMENSION_WEIGHTS: Readonly<Record<keyof FunDimensionScores, number>> = {
  engagement: 25,
  challenge_balance: 18,
  excitement: 18,
  pacing: 14,
  competence_growth: 11,
  choice_depth: 7,
  run_distinctness: 7,
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clamp100(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function bandScore(value: number, target: number, tolerance: number): number {
  if (tolerance <= 0) return value === target ? 100 : 0;
  const distance = Math.abs(value - target);
  return clamp100((1 - distance / tolerance) * 100);
}

function normalizedOutcome(run: RunStats): number {
  switch (run.outcome) {
    case 'victory':
      return 1;
    case 'death':
      return 0.55;
    case 'timeout':
      return 0.35;
    case 'stalled':
      return 0.2;
    case 'error':
      return 0;
    default:
      return 0;
  }
}

function runMinutes(run: RunStats): number {
  return Math.max(1 / 60, run.gameTimeMs / 60_000);
}

function engagementForRun(run: RunStats): number {
  const minutes = runMinutes(run);
  const killsPerMin = run.combat.totalKills / minutes;
  const combatRatio = ratio(run.combat.combatTimeMs, run.gameTimeMs);
  const questRatio =
    run.quests.questsAccepted > 0 ? run.quests.questsCompleted / run.quests.questsAccepted : 0;
  const outcome = normalizedOutcome(run) * 100;
  return round2(
    outcome * 0.35 +
      bandScore(killsPerMin, 18, 14) * 0.2 +
      bandScore(combatRatio, 0.45, 0.35) * 0.25 +
      bandScore(questRatio, 0.85, 0.85) * 0.2,
  );
}

function challengeBalanceForRun(run: RunStats): number {
  const minutes = runMinutes(run);
  const closeCallsPerMin = run.health.closeCallCount / minutes;
  const lowHealthPerMin = run.health.lowHealthCount / minutes;
  const finalHealth = clamp01(run.health.finalHealthPercent);
  const minHealth = clamp01(run.health.minHealthPercent);
  const penalties =
    (run.outcome === 'timeout' ? 20 : 0) +
    (run.outcome === 'stalled' ? 25 : 0) +
    (run.outcome === 'error' ? 50 : 0);

  const base =
    bandScore(closeCallsPerMin, 0.8, 0.9) * 0.3 +
    bandScore(lowHealthPerMin, 1.6, 1.5) * 0.25 +
    bandScore(finalHealth, 0.35, 0.35) * 0.2 +
    bandScore(minHealth, 0.18, 0.18) * 0.25;
  return round2(clamp100(base - penalties));
}

function excitementForRun(run: RunStats): number {
  const minutes = runMinutes(run);
  const damageRate = run.combat.damageDealt / minutes;
  const engagementRate = run.combat.engagementCount / minutes;
  const clutchSignal =
    run.outcome === 'victory' && run.health.closeCallCount > 0
      ? Math.min(run.health.closeCallCount, 4)
      : 0;
  return round2(
    bandScore(damageRate, 850, 650) * 0.4 +
      bandScore(engagementRate, 0.75, 0.6) * 0.35 +
      bandScore(clutchSignal, 2, 2) * 0.25,
  );
}

function pacingForRun(run: RunStats): number {
  const firstQuestMs = run.quests.firstQuestCompletedMs;
  const firstQuestSec = firstQuestMs === null ? 600 : firstQuestMs / 1000;
  const levelUpsPerMin = run.levelUps.length / runMinutes(run);
  const timeoutPenalty = run.outcome === 'timeout' || run.outcome === 'stalled' ? 20 : 0;
  const base =
    bandScore(firstQuestSec, 120, 120) * 0.55 + bandScore(levelUpsPerMin, 1.1, 1.0) * 0.45;
  return round2(clamp100(base - timeoutPenalty));
}

function competenceGrowthForRun(run: RunStats): number {
  const levelScore = bandScore(run.finalLevel, 8, 6);
  const xpScore = bandScore(run.totalXp, 2000, 1800);
  const questCompletion =
    run.quests.questsAccepted > 0 ? run.quests.questsCompleted / run.quests.questsAccepted : 0;
  const questScore = bandScore(questCompletion, 0.9, 0.9);
  return round2(levelScore * 0.4 + xpScore * 0.25 + questScore * 0.35);
}

function mapSurveyScale(value: number): number {
  const clamped = Math.max(1, Math.min(5, value));
  return ((clamped - 1) / 4) * 100;
}

function surveyScore(survey: PlaytestSurvey): number | null {
  const weighted: Array<[number, number]> = [];
  if (typeof survey.enjoyment === 'number') weighted.push([mapSurveyScale(survey.enjoyment), 0.35]);
  if (typeof survey.immersion === 'number') weighted.push([mapSurveyScale(survey.immersion), 0.2]);
  if (typeof survey.mastery === 'number') weighted.push([mapSurveyScale(survey.mastery), 0.2]);
  if (typeof survey.control === 'number') weighted.push([mapSurveyScale(survey.control), 0.15]);
  if (typeof survey.tension === 'number')
    weighted.push([100 - mapSurveyScale(survey.tension), 0.1]);
  if (weighted.length === 0) return null;

  const weightSum = weighted.reduce((sum, [, w]) => sum + w, 0);
  if (weightSum <= 0) return null;
  const value = weighted.reduce((sum, [score, w]) => sum + score * w, 0) / weightSum;
  return round2(value);
}

function mean(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values: ReadonlyArray<number>): number {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function weightedObjectiveScore(dimensions: FunDimensionScores): number {
  const numerator = (Object.keys(DIMENSION_WEIGHTS) as Array<keyof FunDimensionScores>).reduce(
    (sum, key) => sum + dimensions[key] * DIMENSION_WEIGHTS[key],
    0,
  );
  const denominator = Object.values(DIMENSION_WEIGHTS).reduce((sum, w) => sum + w, 0);
  return round2(numerator / denominator);
}

function weightedGatedObjectiveScore(dimensions: FunDimensionScores): number {
  const gatedKeys: ReadonlyArray<keyof FunDimensionScores> = [
    'engagement',
    'challenge_balance',
    'excitement',
    'pacing',
    'competence_growth',
    'choice_depth',
  ];
  const numerator = gatedKeys.reduce(
    (sum, key) => sum + dimensions[key] * DIMENSION_WEIGHTS[key],
    0,
  );
  const denominator = gatedKeys.reduce((sum, key) => sum + DIMENSION_WEIGHTS[key], 0);
  return round2(numerator / denominator);
}

function choiceDepthAcrossRuns(sessions: ReadonlyArray<FunSession>): number {
  if (sessions.length === 0) return 0;
  const weaponCounts = new Map<string, number>();
  for (const session of sessions) {
    const weapon = session.run.startingWeapon || 'unknown';
    weaponCounts.set(weapon, (weaponCounts.get(weapon) ?? 0) + 1);
  }
  const total = sessions.length;
  let entropy = 0;
  for (const count of weaponCounts.values()) {
    const p = count / total;
    entropy += -p * Math.log2(p);
  }
  const maxEntropy = weaponCounts.size > 1 ? Math.log2(weaponCounts.size) : 1;
  const normalizedEntropy = clamp01(entropy / maxEntropy);
  const uniqueRatio = clamp01(weaponCounts.size / 3);
  return round2((normalizedEntropy * 0.65 + uniqueRatio * 0.35) * 100);
}

function normalizedEntropyFromCounts(counts: ReadonlyMap<string, number>): number {
  if (counts.size <= 1) return 0;
  const total = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
  if (total <= 0) return 0;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    if (p > 0) entropy += -p * Math.log2(p);
  }
  return clamp01(entropy / Math.log2(counts.size));
}

function runDistinctnessAcrossRuns(sessions: ReadonlyArray<FunSession>): number {
  if (sessions.length <= 1) return 0;
  const weaponCounts = new Map<string, number>();
  const outcomeCounts = new Map<string, number>();
  const durationsSec: number[] = [];
  const levels: number[] = [];
  const firstQuestSec: number[] = [];

  for (const session of sessions) {
    const weapon = session.run.startingWeapon || 'unknown';
    weaponCounts.set(weapon, (weaponCounts.get(weapon) ?? 0) + 1);
    outcomeCounts.set(session.run.outcome, (outcomeCounts.get(session.run.outcome) ?? 0) + 1);
    durationsSec.push(Math.max(1, session.run.gameTimeMs / 1000));
    levels.push(session.run.finalLevel);
    firstQuestSec.push(
      session.run.quests.firstQuestCompletedMs === null
        ? 600
        : session.run.quests.firstQuestCompletedMs / 1000,
    );
  }

  const weaponEntropy = normalizedEntropyFromCounts(weaponCounts) * 100;
  const outcomeEntropy = normalizedEntropyFromCounts(outcomeCounts) * 100;

  const meanDuration = mean(durationsSec);
  const durationCv = meanDuration <= 0 ? 0 : stdDev(durationsSec) / meanDuration;
  const durationVariety = bandScore(durationCv, 0.22, 0.22);
  const levelVariety = bandScore(stdDev(levels), 1.5, 1.5);
  const questTimingVariety = bandScore(stdDev(firstQuestSec), 55, 55);

  const sampleFactor = clamp01(Math.sqrt(sessions.length / 30));
  const blended =
    weaponEntropy * 0.3 +
    outcomeEntropy * 0.2 +
    durationVariety * 0.2 +
    levelVariety * 0.15 +
    questTimingVariety * 0.15;
  return round2(clamp100(blended * sampleFactor + 15 * (1 - sampleFactor)));
}

function scoreConfidence(
  runs: number,
  surveyCoverage: number,
  runOverallScores: ReadonlyArray<number>,
): number {
  const sampleConfidence = clamp01(Math.sqrt(runs / 300));
  const stabilityConfidence = clamp01(1 - stdDev(runOverallScores) / 35);
  const surveyConfidence = surveyCoverage > 0 ? clamp01(surveyCoverage) : 0.5;
  return round2(sampleConfidence * 0.5 + stabilityConfidence * 0.3 + surveyConfidence * 0.2);
}

export function scoreFunSessions(
  sessions: ReadonlyArray<FunSession>,
  config: Partial<FunScoreConfig> = {},
): FunScoreReport {
  const merged: FunScoreConfig = { ...DEFAULT_CONFIG, ...config };
  if (sessions.length === 0) {
    return {
      runs: 0,
      outcomes: { victory: 0, death: 0, timeout: 0, stalled: 0, error: 0 },
      survey_coverage: 0,
      overall_fun_score: 0,
      dimensions: {
        engagement: 0,
        challenge_balance: 0,
        excitement: 0,
        pacing: 0,
        competence_growth: 0,
        choice_depth: 0,
        run_distinctness: 0,
      },
      sameness_grade: 100,
      objective_score: 0,
      subjective_score: null,
      confidence: 0,
      gate: {
        min_overall: merged.minOverall,
        min_dimension: merged.minDimension,
        gating_overall_score: 0,
        pass: false,
        failing_dimensions: [
          'engagement',
          'challenge_balance',
          'excitement',
          'pacing',
          'competence_growth',
          'choice_depth',
          'run_distinctness',
        ],
      },
      hotspots: [
        {
          dimension: 'engagement',
          score: 0,
          reason: 'No runs provided. Score requires gameplay sessions.',
        },
      ],
    };
  }

  const outcomeCounts: Record<RunStats['outcome'], number> = {
    victory: 0,
    death: 0,
    timeout: 0,
    stalled: 0,
    error: 0,
  };

  const engagementScores: number[] = [];
  const challengeScores: number[] = [];
  const excitementScores: number[] = [];
  const pacingScores: number[] = [];
  const growthScores: number[] = [];
  const objectivePerRun: number[] = [];
  const surveyScores: number[] = [];

  for (const session of sessions) {
    outcomeCounts[session.run.outcome] += 1;
    const engagement = engagementForRun(session.run);
    const challenge = challengeBalanceForRun(session.run);
    const excitement = excitementForRun(session.run);
    const pacing = pacingForRun(session.run);
    const growth = competenceGrowthForRun(session.run);
    engagementScores.push(engagement);
    challengeScores.push(challenge);
    excitementScores.push(excitement);
    pacingScores.push(pacing);
    growthScores.push(growth);
    objectivePerRun.push(
      weightedGatedObjectiveScore({
        engagement,
        challenge_balance: challenge,
        excitement,
        pacing,
        competence_growth: growth,
        choice_depth: 50,
        run_distinctness: 0,
      }),
    );
    if (session.survey) {
      const score = surveyScore(session.survey);
      if (score !== null) surveyScores.push(score);
    }
  }

  const dimensions: FunDimensionScores = {
    engagement: round2(mean(engagementScores)),
    challenge_balance: round2(mean(challengeScores)),
    excitement: round2(mean(excitementScores)),
    pacing: round2(mean(pacingScores)),
    competence_growth: round2(mean(growthScores)),
    choice_depth: choiceDepthAcrossRuns(sessions),
    run_distinctness: runDistinctnessAcrossRuns(sessions),
  };

  const objectiveScore = weightedObjectiveScore(dimensions);
  const gatingObjectiveScore = weightedGatedObjectiveScore(dimensions);
  const subjectiveScore = surveyScores.length > 0 ? round2(mean(surveyScores)) : null;
  const surveyCoverage = round2(surveyScores.length / sessions.length);
  const overall =
    subjectiveScore === null
      ? objectiveScore
      : round2(objectiveScore * 0.6 + subjectiveScore * 0.4);
  const gatingOverall =
    subjectiveScore === null
      ? gatingObjectiveScore
      : round2(gatingObjectiveScore * 0.6 + subjectiveScore * 0.4);

  const gatedDimensions: ReadonlyArray<keyof FunDimensionScores> = [
    'engagement',
    'challenge_balance',
    'excitement',
    'pacing',
    'competence_growth',
    'choice_depth',
  ];
  const failingDimensions = gatedDimensions.filter((key) => dimensions[key] < merged.minDimension);

  const gate: FunGate = {
    min_overall: merged.minOverall,
    min_dimension: merged.minDimension,
    gating_overall_score: gatingOverall,
    pass: gatingOverall >= merged.minOverall && failingDimensions.length === 0,
    failing_dimensions: failingDimensions,
  };

  const hotspots: FunHotspot[] = [
    ...((Object.keys(dimensions) as Array<keyof FunDimensionScores>)
      .map((dimension) => ({
        dimension,
        score: dimensions[dimension],
      }))
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)
      .map((entry) => ({
        ...entry,
        reason:
          entry.dimension === 'choice_depth'
            ? 'Limited build diversity across evaluated runs.'
            : entry.dimension === 'run_distinctness'
              ? 'Runs look too similar across weapon/outcome/timing patterns.'
              : 'Dimension score is below peers and drags overall fun.',
      })) as FunHotspot[]),
  ];
  if (subjectiveScore !== null && subjectiveScore < objectiveScore - 10) {
    hotspots.push({
      dimension: 'survey',
      score: subjectiveScore,
      reason: 'Survey sentiment trails telemetry-based score by >10 points.',
    });
  }

  return {
    runs: sessions.length,
    outcomes: outcomeCounts,
    survey_coverage: surveyCoverage,
    overall_fun_score: overall,
    dimensions,
    sameness_grade: round2(100 - dimensions.run_distinctness),
    objective_score: objectiveScore,
    subjective_score: subjectiveScore,
    confidence: scoreConfidence(sessions.length, surveyCoverage, objectivePerRun),
    gate,
    hotspots,
  };
}
