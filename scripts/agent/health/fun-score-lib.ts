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
  readonly persona?: string;
}

export type FunCriterionStatus = 'healthy' | 'needs_attention' | 'unmeasured';
export type FunTrendStatus = 'improving' | 'degrading' | 'inconclusive' | 'unmeasured';

export interface FunCriterion {
  readonly observed: number | null;
  readonly target: number | null;
  readonly status: FunCriterionStatus;
  readonly reason: string;
}

export interface FunCriteria {
  readonly unsafe_combat_uptime: FunCriterion;
  readonly survivability_variance: FunCriterion;
  readonly run_variety: FunCriterion;
  readonly dopamine_cadence: FunCriterion;
  readonly snowball_frequency: FunCriterion;
  readonly meta_progression: FunCriterion;
  readonly item_viability: FunCriterion;
  readonly early_death_rate: FunCriterion;
}

export interface FunPersonaScore {
  readonly runs: number;
  readonly overall_fun_score: number;
  readonly dimensions: FunDimensionScores;
  readonly confidence: number;
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
  readonly criteria: FunCriteria;
  readonly persona_scores: Readonly<Record<string, FunPersonaScore>>;
}

export interface FunMetricComparison {
  readonly baseline: number | null;
  readonly candidate: number | null;
  readonly delta: number | null;
  readonly status: FunTrendStatus;
}

/**
 * Whether the two scored cohorts are comparable at all. `run_distinctness` is
 * explicitly sample-size sensitive, and persona mix changes behavior, so an
 * unmatched pair can look better/worse purely from composition drift.
 */
export interface FunCohortMatch {
  readonly matched: boolean;
  readonly reasons: ReadonlyArray<string>;
  readonly baseline_runs: number;
  readonly candidate_runs: number;
}

export interface FunScoreComparison {
  readonly cohort: FunCohortMatch;
  readonly overall_fun_score: FunMetricComparison;
  readonly dimensions: Readonly<Record<keyof FunDimensionScores, FunMetricComparison>>;
  readonly criteria: Readonly<Record<keyof FunCriteria, FunMetricComparison>>;
}

export interface FunScoreConfig {
  readonly minOverall: number;
  readonly minDimension: number;
}

export interface FunScoreCLIArgs {
  readonly inputPath: string;
  readonly baselinePath: string | null;
  readonly outputPath: string | null;
  readonly minOverall: number;
  readonly minDimension: number;
}

type UnknownRecord = Record<string, unknown>;
const VALID_OUTCOMES = new Set<RunStats['outcome']>([
  'victory',
  'death',
  'timeout',
  'stalled',
  'error',
]);

const DEFAULT_CONFIG: FunScoreConfig = {
  minOverall: 70,
  minDimension: 55,
};

export const GATED_DIMENSIONS: ReadonlyArray<keyof FunDimensionScores> = [
  'engagement',
  'challenge_balance',
  'excitement',
  'pacing',
  'competence_growth',
  'choice_depth',
];

const DIMENSION_WEIGHTS: Readonly<Record<keyof FunDimensionScores, number>> = {
  engagement: 25,
  challenge_balance: 18,
  excitement: 18,
  pacing: 14,
  competence_growth: 11,
  choice_depth: 7,
  run_distinctness: 7,
};

// Keep in sync with FLOOR_1_MAX_STARTER_CHOICES in src/game/floorScenario.ts.
const FLOOR_1_STARTER_WEAPON_CHOICES = 3;
const SUBJECTIVE_BLEND_WEIGHT = 0.4;

// Dying on Floor 1 or 2 is an "un-fun" tutorial-phase death: the player never
// got past onboarding. Non-death outcomes (timeout/stalled/error) are excluded
// here because they are already penalized elsewhere and are not "died early".
const EARLY_DEATH_MAX_FLOOR = 2;
const EARLY_DEATH_TARGET_RATE = 0.1;

function isEarlyDeath(run: RunStats): boolean {
  return run.outcome === 'death' && run.finalFloor <= EARLY_DEATH_MAX_FLOOR;
}

function hasNumberField(obj: UnknownRecord, key: string): boolean {
  return typeof obj[key] === 'number' && Number.isFinite(obj[key]);
}

export function parseFunScoreArgs(argv: ReadonlyArray<string>): FunScoreCLIArgs {
  let inputPath = '';
  let baselinePath: string | null = null;
  let outputPath: string | null = null;
  let minOverall = 70;
  let minDimension = 55;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--input' && typeof next === 'string') {
      inputPath = next;
      i += 1;
      continue;
    }
    if (arg === '--out' && typeof next === 'string') {
      outputPath = next;
      i += 1;
      continue;
    }
    if (arg === '--baseline' && typeof next === 'string') {
      baselinePath = next;
      i += 1;
      continue;
    }
    if (arg === '--min-overall' && typeof next === 'string') {
      minOverall = Number.parseFloat(next);
      i += 1;
      continue;
    }
    if (arg === '--min-dimension' && typeof next === 'string') {
      minDimension = Number.parseFloat(next);
      i += 1;
      continue;
    }
  }

  if (!inputPath) {
    throw new Error(
      'Missing --input <path>. Accepted JSON: RunStats[], { runs: RunStats[] }, { sessions: [{ id, run, survey? }] }.',
    );
  }
  if (!Number.isFinite(minOverall) || !Number.isFinite(minDimension)) {
    throw new Error('--min-overall and --min-dimension must be numbers.');
  }

  return { inputPath, baselinePath, outputPath, minOverall, minDimension };
}

export function parsePlaytestSurvey(value: unknown): PlaytestSurvey | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const obj = value as UnknownRecord;
  const survey: {
    enjoyment?: number;
    immersion?: number;
    mastery?: number;
    control?: number;
    tension?: number;
  } = {};
  if (typeof obj.enjoyment === 'number' && Number.isFinite(obj.enjoyment))
    survey.enjoyment = obj.enjoyment;
  if (typeof obj.immersion === 'number' && Number.isFinite(obj.immersion))
    survey.immersion = obj.immersion;
  if (typeof obj.mastery === 'number' && Number.isFinite(obj.mastery)) survey.mastery = obj.mastery;
  if (typeof obj.control === 'number' && Number.isFinite(obj.control)) survey.control = obj.control;
  if (typeof obj.tension === 'number' && Number.isFinite(obj.tension)) survey.tension = obj.tension;
  return Object.keys(survey).length > 0 ? survey : undefined;
}

export function isRunStats(value: unknown): value is RunStats {
  if (typeof value !== 'object' || value === null) return false;
  const run = value as UnknownRecord;
  const combat =
    typeof run.combat === 'object' && run.combat !== null ? (run.combat as UnknownRecord) : null;
  const health =
    typeof run.health === 'object' && run.health !== null ? (run.health as UnknownRecord) : null;
  const quests =
    typeof run.quests === 'object' && run.quests !== null ? (run.quests as UnknownRecord) : null;
  const firstQuestCompletedOk =
    quests !== null &&
    (quests.firstQuestCompletedMs === null ||
      (typeof quests.firstQuestCompletedMs === 'number' &&
        Number.isFinite(quests.firstQuestCompletedMs)));
  return (
    typeof run.outcome === 'string' &&
    VALID_OUTCOMES.has(run.outcome as RunStats['outcome']) &&
    hasNumberField(run, 'gameTimeMs') &&
    hasNumberField(run, 'safeRoomMs') &&
    typeof run.startingWeapon === 'string' &&
    hasNumberField(run, 'finalLevel') &&
    hasNumberField(run, 'totalXp') &&
    Array.isArray(run.levelUps) &&
    combat !== null &&
    hasNumberField(combat, 'totalKills') &&
    hasNumberField(combat, 'combatTimeMs') &&
    hasNumberField(combat, 'engagementCount') &&
    hasNumberField(combat, 'damageDealt') &&
    health !== null &&
    hasNumberField(health, 'minHealthPercent') &&
    hasNumberField(health, 'closeCallCount') &&
    hasNumberField(health, 'lowHealthCount') &&
    hasNumberField(health, 'finalHealthPercent') &&
    quests !== null &&
    hasNumberField(quests, 'questsAccepted') &&
    hasNumberField(quests, 'questsCompleted') &&
    firstQuestCompletedOk
  );
}

export function normalizeFunSessions(payload: unknown): FunSession[] {
  // Legacy fun-score payloads predate the required `safeRoomMs` field (added when
  // the official win definition began crediting safe-room time). Coalesce a
  // MISSING `safeRoomMs` to 0 so historical artifacts stay ingestible, while a
  // present-but-invalid value still fails `isRunStats` (corruption, not legacy).
  const withDefaultedSafeRoomMs = (candidate: unknown): unknown => {
    if (typeof candidate !== 'object' || candidate === null) return candidate;
    const obj = candidate as UnknownRecord;
    if ('safeRoomMs' in obj) return candidate;
    return { ...obj, safeRoomMs: 0 };
  };
  const toSession = (candidate: unknown, index: number): FunSession => {
    if (typeof candidate !== 'object' || candidate === null) {
      throw new Error(`Entry ${index + 1} is not an object.`);
    }
    const obj = candidate as UnknownRecord;
    const id = typeof obj.id === 'string' ? obj.id : `run-${index + 1}`;
    const runCandidate = withDefaultedSafeRoomMs('run' in obj ? obj.run : obj);
    if (!isRunStats(runCandidate)) {
      throw new Error(`Entry ${index + 1} is missing a valid RunStats payload.`);
    }
    const persona =
      typeof obj.persona === 'string'
        ? obj.persona
        : typeof runCandidate.playerPersona === 'string'
          ? runCandidate.playerPersona
          : undefined;
    return { id, run: runCandidate, survey: parsePlaytestSurvey(obj.survey), persona };
  };

  if (Array.isArray(payload)) {
    return payload.map((entry, index) => toSession(entry, index));
  }
  if (typeof payload === 'object' && payload !== null) {
    const root = payload as UnknownRecord;
    if (Array.isArray(root.sessions)) {
      return root.sessions.map((entry, index) => toSession(entry, index));
    }
    if (Array.isArray(root.runs)) {
      return root.runs.map((entry, index) => toSession(entry, index));
    }
    const bareRun = withDefaultedSafeRoomMs(root);
    if (isRunStats(bareRun)) {
      // Route through `toSession` so a bare RunStats keeps its `playerPersona`
      // cohort instead of dropping out of `persona_scores`.
      return [toSession(root, 0)];
    }
  }
  throw new Error(
    'Unsupported input shape. Expected RunStats[], { runs: RunStats[] }, or { sessions: [{ id, run, survey? }] }.',
  );
}

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
    (run.outcome === 'error' ? 50 : 0) +
    // Dying in the tutorial-phase floors (1-2) is un-fun regardless of how
    // "balanced" the fight felt in the moment: the player never got past
    // onboarding, so it is penalized on top of a plain death.
    (isEarlyDeath(run) ? 35 : 0);

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
  const numerator = GATED_DIMENSIONS.reduce(
    (sum, key) => sum + dimensions[key] * DIMENSION_WEIGHTS[key],
    0,
  );
  const denominator = GATED_DIMENSIONS.reduce((sum, key) => sum + DIMENSION_WEIGHTS[key], 0);
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
  const uniqueRatio = clamp01(weaponCounts.size / FLOOR_1_STARTER_WEAPON_CHOICES);
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
  includePersonaBreakdown = true,
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
        failing_dimensions: [...GATED_DIMENSIONS],
      },
      hotspots: [
        {
          dimension: 'engagement',
          score: 0,
          reason: 'No runs provided. Score requires gameplay sessions.',
        },
      ],
      criteria: {
        unsafe_combat_uptime: {
          observed: null,
          target: 0.75,
          status: 'unmeasured',
          reason: 'No runs provided.',
        },
        survivability_variance: {
          observed: null,
          target: SURVIVABILITY_VARIANCE_BAND.min,
          status: 'unmeasured',
          reason: 'No runs provided.',
        },
        run_variety: {
          observed: null,
          target: 60,
          status: 'unmeasured',
          reason: 'No runs provided.',
        },
        dopamine_cadence: {
          observed: null,
          target: 90,
          status: 'unmeasured',
          reason: 'Run event timestamps are not present in RunStats.',
        },
        snowball_frequency: {
          observed: null,
          target: 0.1,
          status: 'unmeasured',
          reason: 'Snowball/exploit telemetry is not present in RunStats.',
        },
        meta_progression: {
          observed: null,
          target: 0,
          status: 'unmeasured',
          reason: 'Permanent progression is not implemented in RunStats.',
        },
        item_viability: {
          observed: null,
          target: 0,
          status: 'unmeasured',
          reason: 'Item exposure/contribution telemetry is not present in RunStats.',
        },
        early_death_rate: {
          observed: null,
          target: EARLY_DEATH_TARGET_RATE,
          status: 'unmeasured',
          reason: 'No runs provided.',
        },
      },
      persona_scores: {},
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

  const survivabilityValues = sessions.map((session) => normalizedOutcome(session.run));
  const survivabilityVariance = stdDev(survivabilityValues);
  const criterion = (
    observed: number | null,
    target: number | null,
    healthy: boolean,
    reason: string,
  ): FunCriterion => ({
    observed,
    target,
    status: observed === null ? 'unmeasured' : healthy ? 'healthy' : 'needs_attention',
    reason,
  });
  const criteria: FunCriteria = {
    unsafe_combat_uptime: criterion(
      // `RunStats.combat.combatTimeMs` accumulates on every frame where any
      // Enemy entity exists anywhere in the world -- including frames spent in
      // a safe room -- while the denominator would exclude all safe-room time.
      // That ratio can exceed 1 and report healthy without any sustained
      // nearby combat, so this stays unmeasured until zone-aware combat time
      // is recorded on RunStats.
      null,
      0.75,
      false,
      'Needs zone-aware combat time on RunStats; combatTimeMs includes safe-room frames.',
    ),
    survivability_variance: criterion(
      round2(survivabilityVariance),
      SURVIVABILITY_VARIANCE_BAND.min,
      survivabilityVariance >= SURVIVABILITY_VARIANCE_BAND.min &&
        survivabilityVariance <= SURVIVABILITY_VARIANCE_BAND.max,
      `Healthy band is ${SURVIVABILITY_VARIANCE_BAND.min}-${SURVIVABILITY_VARIANCE_BAND.max} standard deviations of normalized outcome: too little spread is monotone, too much is coin-flip volatility. Inspect tails before tuning.`,
    ),
    run_variety: criterion(
      dimensions.run_distinctness,
      60,
      dimensions.run_distinctness >= 60,
      'Run variety reuses the existing distinctness score.',
    ),
    dopamine_cadence: criterion(
      null,
      90,
      false,
      'Needs timestamped dopamine-event telemetry; end-of-run RunStats cannot measure cadence.',
    ),
    snowball_frequency: criterion(
      null,
      0.1,
      false,
      'Needs a deterministic snowball/exploit signal and tail classification.',
    ),
    meta_progression: criterion(
      null,
      0,
      false,
      'Needs permanent-power-before/after telemetry once meta progression exists.',
    ),
    item_viability: criterion(
      null,
      0,
      false,
      'Needs item offer, selection, and contribution telemetry with exposure counts.',
    ),
    early_death_rate: criterion(
      round2(sessions.filter((session) => isEarlyDeath(session.run)).length / sessions.length),
      EARLY_DEATH_TARGET_RATE,
      sessions.filter((session) => isEarlyDeath(session.run)).length / sessions.length <=
        EARLY_DEATH_TARGET_RATE,
      `Fraction of runs that ended in death on Floor ${EARLY_DEATH_MAX_FLOOR} or earlier. Tutorial-phase deaths are un-fun; healthy is <= ${EARLY_DEATH_TARGET_RATE * 100}%.`,
    ),
  };

  const objectiveScore = weightedObjectiveScore(dimensions);
  const gatingObjectiveScore = weightedGatedObjectiveScore(dimensions);
  const subjectiveScore = surveyScores.length > 0 ? round2(mean(surveyScores)) : null;
  const surveyCoverage = round2(surveyScores.length / sessions.length);
  const subjectiveWeight = subjectiveScore === null ? 0 : SUBJECTIVE_BLEND_WEIGHT * surveyCoverage;
  const objectiveWeight = 1 - subjectiveWeight;
  const overall =
    subjectiveScore === null
      ? objectiveScore
      : round2(objectiveScore * objectiveWeight + subjectiveScore * subjectiveWeight);
  const gatingOverall =
    subjectiveScore === null
      ? gatingObjectiveScore
      : round2(gatingObjectiveScore * objectiveWeight + subjectiveScore * subjectiveWeight);

  const failingDimensions = GATED_DIMENSIONS.filter((key) => dimensions[key] < merged.minDimension);

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

  const personaScores: Record<string, FunPersonaScore> = {};
  if (includePersonaBreakdown) {
    const byPersona = new Map<string, FunSession[]>();
    for (const session of sessions) {
      if (!session.persona) continue;
      const group = byPersona.get(session.persona) ?? [];
      group.push(session);
      byPersona.set(session.persona, group);
    }
    for (const [persona, personaSessions] of byPersona) {
      const personaReport = scoreFunSessions(personaSessions, config, false);
      personaScores[persona] = {
        runs: personaReport.runs,
        overall_fun_score: personaReport.overall_fun_score,
        dimensions: personaReport.dimensions,
        confidence: personaReport.confidence,
      };
    }
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
    criteria,
    persona_scores: personaScores,
  };
}

/**
 * Smallest delta treated as a real movement, expressed in each criterion's own
 * units. Ratio criteria live in [0,1], so the 2-point dimension threshold would
 * make even a full 0 -> 1 swing permanently `inconclusive`.
 */
const CRITERION_MEANINGFUL_DELTA: Readonly<Record<keyof FunCriteria, number>> = {
  unsafe_combat_uptime: 0.05,
  survivability_variance: 0.05,
  run_variety: 2,
  dopamine_cadence: 5,
  snowball_frequency: 0.02,
  meta_progression: 0.05,
  item_viability: 0.05,
  early_death_rate: 0.02,
};

/**
 * Survivability variance is a BAND, not a "more is better" metric: no spread
 * means every run resolves identically, while runaway spread means the outcome
 * is a coin flip. Both tails are unhealthy, so it is compared by distance to
 * the band rather than by direction.
 */
const SURVIVABILITY_VARIANCE_BAND = { min: 0.14, max: 0.45 } as const;

function compareMetric(
  baseline: number | null,
  candidate: number | null,
  higherIsBetter: boolean,
  minimumMeaningfulDelta = 2,
): FunMetricComparison {
  if (baseline === null || candidate === null) {
    return { baseline, candidate, delta: null, status: 'unmeasured' };
  }
  const delta = round2(candidate - baseline);
  if (Math.abs(delta) < minimumMeaningfulDelta) {
    return { baseline, candidate, delta, status: 'inconclusive' };
  }
  const improved = higherIsBetter ? delta > 0 : delta < 0;
  return { baseline, candidate, delta, status: improved ? 'improving' : 'degrading' };
}

/** Distance from `value` to the nearest edge of `band` (0 while inside it). */
function distanceToBand(
  value: number,
  band: { readonly min: number; readonly max: number },
): number {
  if (value < band.min) return band.min - value;
  if (value > band.max) return value - band.max;
  return 0;
}

function compareToBand(
  baseline: number | null,
  candidate: number | null,
  band: { readonly min: number; readonly max: number },
  minimumMeaningfulDelta: number,
): FunMetricComparison {
  if (baseline === null || candidate === null) {
    return { baseline, candidate, delta: null, status: 'unmeasured' };
  }
  const delta = round2(candidate - baseline);
  const movedTowardBand = distanceToBand(baseline, band) - distanceToBand(candidate, band);
  if (Math.abs(movedTowardBand) < minimumMeaningfulDelta) {
    return { baseline, candidate, delta, status: 'inconclusive' };
  }
  return { baseline, candidate, delta, status: movedTowardBand > 0 ? 'improving' : 'degrading' };
}

/** Largest persona-share drift (in share points) tolerated between cohorts. */
const MAX_PERSONA_SHARE_DRIFT = 0.1;
/** Largest relative run-count drift tolerated between cohorts. */
const MAX_RUN_COUNT_DRIFT = 0.1;

/**
 * Baseline/candidate reports are only comparable when they were scored over
 * comparable cohorts. Sample size feeds `run_distinctness` directly and persona
 * mix changes behavior, so composition drift is reported and downgrades every
 * measured status to `inconclusive` instead of emitting a confident but
 * confounded verdict.
 */
function matchCohorts(baseline: FunScoreReport, candidate: FunScoreReport): FunCohortMatch {
  const reasons: string[] = [];
  const largerRunCount = Math.max(baseline.runs, candidate.runs, 1);
  if (Math.abs(baseline.runs - candidate.runs) / largerRunCount > MAX_RUN_COUNT_DRIFT) {
    reasons.push(`run counts differ materially (${baseline.runs} vs ${candidate.runs})`);
  }

  const personaKeys = new Set([
    ...Object.keys(baseline.persona_scores),
    ...Object.keys(candidate.persona_scores),
  ]);
  for (const persona of [...personaKeys].sort()) {
    const baselineShare =
      (baseline.persona_scores[persona]?.runs ?? 0) / Math.max(baseline.runs, 1);
    const candidateShare =
      (candidate.persona_scores[persona]?.runs ?? 0) / Math.max(candidate.runs, 1);
    if (Math.abs(baselineShare - candidateShare) > MAX_PERSONA_SHARE_DRIFT) {
      reasons.push(
        `persona "${persona}" share differs (${round2(baselineShare)} vs ${round2(candidateShare)})`,
      );
    }
  }

  return {
    matched: reasons.length === 0,
    reasons,
    baseline_runs: baseline.runs,
    candidate_runs: candidate.runs,
  };
}

export function compareFunReports(
  baseline: FunScoreReport,
  candidate: FunScoreReport,
): FunScoreComparison {
  const dimensionKeys = Object.keys(baseline.dimensions) as Array<keyof FunDimensionScores>;
  const criterionKeys = Object.keys(baseline.criteria) as Array<keyof FunCriteria>;
  const dimensions = {} as Record<keyof FunDimensionScores, FunMetricComparison>;
  for (const key of dimensionKeys) {
    dimensions[key] = compareMetric(baseline.dimensions[key], candidate.dimensions[key], true);
  }

  const criteria = {} as Record<keyof FunCriteria, FunMetricComparison>;
  const higherIsBetter: Readonly<Record<keyof FunCriteria, boolean>> = {
    unsafe_combat_uptime: true,
    survivability_variance: true,
    run_variety: true,
    dopamine_cadence: false,
    snowball_frequency: false,
    meta_progression: true,
    item_viability: true,
    early_death_rate: false,
  };
  for (const key of criterionKeys) {
    criteria[key] =
      key === 'survivability_variance'
        ? compareToBand(
            baseline.criteria[key].observed,
            candidate.criteria[key].observed,
            SURVIVABILITY_VARIANCE_BAND,
            CRITERION_MEANINGFUL_DELTA[key],
          )
        : compareMetric(
            baseline.criteria[key].observed,
            candidate.criteria[key].observed,
            higherIsBetter[key],
            CRITERION_MEANINGFUL_DELTA[key],
          );
  }

  const cohort = matchCohorts(baseline, candidate);
  const gate = (comparison: FunMetricComparison): FunMetricComparison =>
    cohort.matched || comparison.status === 'unmeasured'
      ? comparison
      : { ...comparison, status: 'inconclusive' };

  for (const key of dimensionKeys) dimensions[key] = gate(dimensions[key]);
  for (const key of criterionKeys) criteria[key] = gate(criteria[key]);

  return {
    cohort,
    overall_fun_score: gate(
      compareMetric(baseline.overall_fun_score, candidate.overall_fun_score, true),
    ),
    dimensions,
    criteria,
  };
}
