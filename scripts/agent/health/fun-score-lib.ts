import type { RunStats } from '../../../src/game/ai/types.js';
import { isOfficialWin } from '../../../src/game/ai/scoring.js';
import { FLOOR1_ACTIVE_TIME_BUDGET_MS } from '../../../src/game/ai/floor1-run-budget.js';

export interface PlaytestSurvey {
  readonly enjoyment?: number;
  readonly immersion?: number;
  readonly mastery?: number;
  readonly control?: number;
  readonly tension?: number;
  readonly comment?: string;
}

export interface FunSession {
  readonly id: string;
  readonly run: RunStats;
  readonly survey?: PlaytestSurvey;
  readonly persona?: string;
  /** Explicit experiment leg, e.g. direct Floor 1 versus a chained run. */
  readonly scenario?: string;
}

export type FunCriterionStatus = 'healthy' | 'needs_attention' | 'unmeasured' | 'descriptive';
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
  readonly reward_cadence: FunCriterion;
  readonly performance_outlier_frequency: FunCriterion;
  readonly meta_progression: FunCriterion;
  readonly item_viability: FunCriterion;
  readonly early_death_rate: FunCriterion;
}

export interface FunPersonaScore {
  readonly runs: number;
  readonly overall_fun_score: number | null;
  readonly dimensions: FunDimensionScores;
  readonly confidence: number | null;
}

export interface FunDimensionScores {
  readonly engagement: number | null;
  readonly challenge_balance: number | null;
  readonly excitement: number | null;
  readonly pacing: number | null;
  readonly progression: number | null;
  readonly choice_depth: number | null;
  readonly run_distinctness: number | null;
}

export interface FunHotspot {
  readonly dimension: keyof FunDimensionScores | 'survey';
  readonly score: number;
  readonly reason: string;
}

export interface FunGate {
  readonly min_overall: number;
  readonly min_dimension: number;
  readonly gating_overall_score: number | null;
  readonly pass: boolean;
  readonly unmeasured_dimensions: ReadonlyArray<keyof FunDimensionScores>;
  readonly failing_dimensions: ReadonlyArray<keyof FunDimensionScores>;
}

export interface FunScoreReport {
  readonly schema_version: 2;
  readonly interpretation: 'uncalibrated_heuristic';
  readonly confidence_reason: string;
  readonly evidence: {
    readonly unique_scenarios: number;
    readonly duplicate_scenarios: number;
    readonly unidentified_runs: number;
    readonly starter_weapon_coverage: number;
    readonly dimension_coverage: Readonly<Record<keyof FunDimensionScores, number>>;
  };
  readonly observed_surveys: Readonly<
    Record<
      'enjoyment' | 'immersion' | 'mastery' | 'control' | 'tension',
      {
        readonly responses: number;
        readonly mean: number | null;
      }
    >
  >;
  readonly per_run: ReadonlyArray<{
    readonly id: string;
    readonly identity: string | null;
    readonly source: 'headless' | 'human' | 'unknown';
    readonly dimensions: FunDimensionScores;
    readonly heuristic_score: number | null;
  }>;
  readonly runs: number;
  readonly outcomes: Readonly<Record<RunStats['outcome'], number>>;
  readonly survey_coverage: number;
  readonly overall_fun_score: number | null;
  readonly dimensions: FunDimensionScores;
  /** Reserved until actual build diversity can be measured. Null in v2. */
  readonly sameness_grade: number | null;
  readonly objective_score: number | null;
  readonly subjective_score: number | null;
  readonly confidence: number | null;
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

/** Whether versions and independent deterministic scenario identities match. */
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
// 'quit' covers a human player closing/leaving mid-run (distinct from
// 'stalled'/'error', which are AI-runner-only outcomes).
const VALID_OUTCOMES = new Set<RunStats['outcome']>([
  'victory',
  'death',
  'timeout',
  'stalled',
  'error',
  'quit',
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
  'progression',
];

const DIMENSION_WEIGHTS: Readonly<Record<keyof FunDimensionScores, number>> = {
  engagement: 25,
  challenge_balance: 18,
  excitement: 18,
  pacing: 14,
  progression: 11,
  choice_depth: 0,
  run_distinctness: 0,
};

// Keep in sync with FLOOR_1_MAX_STARTER_CHOICES in src/game/floorScenario.ts.
const FLOOR_1_STARTER_WEAPON_CHOICES = 3;

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
    comment?: string;
  } = {};
  if (typeof obj.enjoyment === 'number' && Number.isFinite(obj.enjoyment))
    survey.enjoyment = obj.enjoyment;
  if (typeof obj.immersion === 'number' && Number.isFinite(obj.immersion))
    survey.immersion = obj.immersion;
  if (typeof obj.mastery === 'number' && Number.isFinite(obj.mastery)) survey.mastery = obj.mastery;
  if (typeof obj.control === 'number' && Number.isFinite(obj.control)) survey.control = obj.control;
  if (typeof obj.tension === 'number' && Number.isFinite(obj.tension)) survey.tension = obj.tension;
  if (typeof obj.comment === 'string') {
    const trimmed = obj.comment.trim();
    if (trimmed.length > 0) survey.comment = trimmed;
  }
  return Object.keys(survey).length > 0 ? survey : undefined;
}

function validEvaluationContext(value: unknown): boolean {
  if (value === undefined) return true; // Legacy, explicitly unknown coverage.
  if (typeof value !== 'object' || value === null) return false;
  const context = value as UnknownRecord;
  if (typeof context.available !== 'object' || context.available === null) return false;
  const available = context.available as UnknownRecord;
  return (
    (context.source === 'headless' || context.source === 'human') &&
    Number.isSafeInteger(context.seed) &&
    typeof context.startFloor === 'string' &&
    context.startFloor.trim().length > 0 &&
    ['combat', 'health', 'progression', 'quests'].every(
      (key) => typeof available[key] === 'boolean',
    )
  );
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
    validEvaluationContext(run.evaluationContext) &&
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
    const scenario = typeof obj.scenario === 'string' ? obj.scenario : undefined;
    return { id, run: runCandidate, survey: parsePlaytestSurvey(obj.survey), persona, scenario };
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
  return Math.max(1 / 60, (run.gameTimeMs - run.safeRoomMs) / 60_000);
}

// These reference levels are diagnostic hypotheses, not enjoyment thresholds.
function saturationScore(value: number, reference: number): number {
  return clamp01(value / reference) * 100;
}

function engagementForRun(run: RunStats): number {
  const killsPerMin = run.combat.totalKills / runMinutes(run);
  const questRatio = ratio(run.quests.questsCompleted, run.quests.questsAccepted);
  // Global enemy existence is not combat proximity. Do not consume the legacy
  // combatTimeMs or engagementCount counters as player-engagement evidence.
  return round2(
    normalizedOutcome(run) * 35 +
      saturationScore(killsPerMin, 18) * 0.4 +
      saturationScore(questRatio, 0.85) * 0.25,
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
    (isEarlyDeath(run) ? 35 : 0);

  const base =
    bandScore(closeCallsPerMin, 0.8, 0.9) * 0.3 +
    bandScore(lowHealthPerMin, 1.6, 1.5) * 0.25 +
    saturationScore(finalHealth, 0.35) * 0.2 +
    bandScore(minHealth, 0.18, 0.18) * 0.25;
  return round2(clamp100(base - penalties));
}

function excitementForRun(run: RunStats): number {
  const minutes = runMinutes(run);
  return round2(
    saturationScore(run.combat.damageDealt / minutes, 850) * 0.6 +
      saturationScore(run.combat.totalKills / minutes, 18) * 0.4,
  );
}

function pacingForRun(run: RunStats): number {
  const firstQuestMs = run.quests.firstQuestCompletedMs;
  const firstQuestSec = firstQuestMs === null ? 600 : firstQuestMs / 1000;
  const levelUpsPerMin = run.levelUps.length / runMinutes(run);
  const timeoutPenalty = run.outcome === 'timeout' || run.outcome === 'stalled' ? 20 : 0;
  // Issue #3198: stuck/wiggle time ("wasted motion" — the player thrashing
  // in place at a wall or territory boundary instead of playing) is a "not
  // fun" signal and must move pacing. `movementQuality` is optional (older
  // recordings / synthetic fixtures may not have it), so treat a missing
  // value as neutral (no penalty, no bonus) rather than skewing the score.
  // `stuckPct` and `wigglePct` are NOT mutually exclusive per-sample buckets
  // (a sustained stuck window opens on any non-excluded sample regardless of
  // that sample's own wiggle/idle classification — see event-log.ts's module
  // doc), so summing them would double-count overlapping time. Take the max
  // instead: whichever "wasted motion" signal is worse drives the score.
  // Target is 0% wasted motion (the issue's own <1% goal); scores fall to 0
  // once the worse of the two reaches 10%.
  const movementScore = run.movementQuality
    ? bandScore(Math.max(run.movementQuality.stuckPct, run.movementQuality.wigglePct), 0, 10)
    : 100;
  const base =
    clamp100(100 - (Math.max(0, firstQuestSec - 120) / 120) * 100) * 0.45 +
    saturationScore(levelUpsPerMin, 1.1) * 0.35 +
    movementScore * 0.2;
  return round2(clamp100(base - timeoutPenalty));
}

function progressionForRun(run: RunStats): number {
  // Count acquired levels/XP, not an injected starting build or perceived mastery.
  const levelScore = saturationScore(Math.max(0, run.finalLevel - run.runStartLevel!), 7);
  const xpScore = saturationScore(Math.max(0, run.totalXp - (run.runStartXp ?? 0)), 2000);
  const questScore = saturationScore(
    ratio(run.quests.questsCompleted, run.quests.questsAccepted),
    0.9,
  );
  return round2(levelScore * 0.4 + xpScore * 0.25 + questScore * 0.35);
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

interface CriterionMeasurement {
  readonly observed: number | null;
  readonly target: number;
  readonly healthy: boolean;
  readonly reason: string;
}

const DOPAMINE_GAP_TARGET_MS = 90_000;
const SNOWBALL_MINIMUM_WINS = 10;
const ROBUST_Z_THRESHOLD = 3.5;
const ROBUST_Z_SCALE = 0.6745;
const ITEM_RARE_SELECTION_MIN_EXPOSURES = 5;
const ITEM_RARE_SELECTION_RATE = 0.1;
const META_PROGRESSION_MAX_FRACTION = 0.05;

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function measureDopamineCadence(sessions: readonly FunSession[]): CriterionMeasurement {
  const measured = sessions.map((session) => session.run.rewardEvents);
  if (
    measured.some(
      (telemetry) =>
        !telemetry ||
        !finiteNonNegative(telemetry.activeDurationMs) ||
        !Array.isArray(telemetry.events) ||
        telemetry.events.some(
          (event) =>
            !finiteNonNegative(event.activeTimeMs) ||
            event.activeTimeMs > telemetry.activeDurationMs ||
            typeof event.kind !== 'string' ||
            typeof event.sourceId !== 'string',
        ),
    )
  ) {
    return {
      observed: null,
      target: 90,
      healthy: false,
      reason:
        'Timestamped reward events are absent or malformed in at least one run (legacy/mixed input).',
    };
  }

  let worstGapMs = 0;
  let coveredMs = 0;
  let totalActiveMs = 0;
  for (const telemetry of measured) {
    const deduplicated = [
      ...new Map(
        telemetry!.events.map((event) => [
          `${event.kind}\u0000${event.sourceId}\u0000${event.activeTimeMs}`,
          event,
        ]),
      ).values(),
    ].sort((left, right) => left.activeTimeMs - right.activeTimeMs);
    const boundaries = [
      0,
      ...deduplicated.map((event) => event.activeTimeMs),
      telemetry!.activeDurationMs,
    ];
    for (let index = 1; index < boundaries.length; index += 1) {
      const gapMs = boundaries[index]! - boundaries[index - 1]!;
      worstGapMs = Math.max(worstGapMs, gapMs);
      if (gapMs <= DOPAMINE_GAP_TARGET_MS) coveredMs += gapMs;
    }
    totalActiveMs += telemetry!.activeDurationMs;
  }
  const coverage = totalActiveMs > 0 ? coveredMs / totalActiveMs : 1;
  return {
    observed: round2(worstGapMs / 1000),
    target: 90,
    healthy: worstGapMs <= DOPAMINE_GAP_TARGET_MS,
    reason: `Worst active-play gap is ${round2(worstGapMs / 1000)}s; ${round2(
      coverage * 100,
    )}% of active time is in gaps at or below 90s.`,
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function measureSnowballFrequency(sessions: readonly FunSession[]): CriterionMeasurement {
  const wins = sessions.filter((session) =>
    isOfficialWin(session.run, FLOOR1_ACTIVE_TIME_BUDGET_MS),
  );
  const signals = wins.map((session) => session.run.runPerformance);
  if (
    signals.some(
      (signal) =>
        !signal ||
        !finiteNonNegative(signal.activeClearTimeMs) ||
        !finiteNonNegative(signal.damagePerActiveMinute) ||
        !finiteNonNegative(signal.killsPerActiveMinute) ||
        !finiteNonNegative(signal.dominantItemUsageShare) ||
        signal.dominantItemUsageShare > 1,
    )
  ) {
    return {
      observed: null,
      target: 0.1,
      healthy: false,
      reason:
        'Run performance data is absent or malformed in at least one official victory (legacy/mixed input).',
    };
  }
  if (signals.length < SNOWBALL_MINIMUM_WINS) {
    return {
      observed: null,
      target: 0.1,
      healthy: false,
      reason: `Need at least ${SNOWBALL_MINIMUM_WINS} official victories with complete run performance data; found ${signals.length}.`,
    };
  }

  const rows = signals.map((signal) => [
    signal!.activeClearTimeMs,
    signal!.damagePerActiveMinute,
    signal!.killsPerActiveMinute,
    signal!.dominantItemUsageShare,
  ]);
  const columns = rows[0]!.map((_, column) => rows.map((row) => row[column]!));
  const medians = columns.map(median);
  const mads = columns.map((column, index) =>
    median(column.map((value) => Math.abs(value - medians[index]!))),
  );
  const classified = rows.filter((row) => {
    let outlierFeatures = 0;
    for (let index = 0; index < row.length; index += 1) {
      const mad = mads[index]!;
      if (mad === 0) continue;
      const direction = index === 0 ? -1 : 1;
      const robustZ = (ROBUST_Z_SCALE * direction * (row[index]! - medians[index]!)) / mad;
      if (robustZ >= ROBUST_Z_THRESHOLD) outlierFeatures += 1;
    }
    return outlierFeatures >= 2;
  }).length;
  const frequency = classified / signals.length;
  return {
    observed: round2(frequency),
    target: 0.1,
    healthy: frequency <= 0.1,
    reason: `${classified}/${signals.length} official victories crossed robust z >= ${ROBUST_Z_THRESHOLD} on at least two non-zero-MAD features.`,
  };
}

function measureItemViability(sessions: readonly FunSession[]): CriterionMeasurement {
  const telemetry = sessions.map((session) => session.run.itemInteractions);
  if (
    telemetry.some(
      (run) =>
        !run ||
        !Array.isArray(run.items) ||
        run.items.some(
          (item) =>
            typeof item.catalogKey !== 'string' ||
            !finiteNonNegative(item.offeredCount) ||
            !finiteNonNegative(item.selectableExposureCount) ||
            !finiteNonNegative(item.selectionCount) ||
            !finiteNonNegative(item.activationCount) ||
            !finiteNonNegative(item.activeTimeMs),
        ),
    )
  ) {
    return {
      observed: null,
      target: 0,
      healthy: false,
      reason:
        'Item interaction data is absent or malformed in at least one run (legacy/mixed input).',
    };
  }

  const catalog = new Map<
    string,
    { exposures: number; selections: number; activations: number; activeTimeMs: number }
  >();
  for (const run of telemetry) {
    for (const item of run!.items) {
      const aggregate = catalog.get(item.catalogKey) ?? {
        exposures: 0,
        selections: 0,
        activations: 0,
        activeTimeMs: 0,
      };
      aggregate.exposures += item.selectableExposureCount;
      aggregate.selections += item.selectionCount;
      aggregate.activations += item.activationCount;
      aggregate.activeTimeMs += item.activeTimeMs;
      catalog.set(item.catalogKey, aggregate);
    }
  }
  const evaluable = [...catalog.entries()].filter(([, item]) => item.exposures > 0);
  if (evaluable.length === 0) {
    return {
      observed: null,
      target: 0,
      healthy: false,
      reason: 'No selectable item exposures were recorded.',
    };
  }
  const flagged = evaluable.filter(([, item]) => {
    const avoided = item.selections === 0;
    const rarelySelected =
      item.exposures >= ITEM_RARE_SELECTION_MIN_EXPOSURES &&
      item.selections / item.exposures < ITEM_RARE_SELECTION_RATE;
    const inert = item.selections > 0 && item.activations === 0 && item.activeTimeMs === 0;
    return avoided || rarelySelected || inert;
  });
  const failureRate = flagged.length / evaluable.length;
  return {
    observed: round2(failureRate),
    target: 0,
    healthy: flagged.length === 0,
    reason: `${flagged.length}/${evaluable.length} exposed catalog items were avoided, selected below 10% after 5+ exposures, or selected but inert.`,
  };
}

function measureMetaProgression(sessions: readonly FunSession[]): CriterionMeasurement {
  const hooks = sessions.map((session) => session.run.metaProgression);
  if (
    hooks.some(
      (hook) =>
        !hook ||
        !finiteNonNegative(hook.permanentPowerBefore) ||
        !finiteNonNegative(hook.permanentPowerAfter) ||
        hook.permanentPowerBefore === 0,
    )
  ) {
    return {
      observed: null,
      target: META_PROGRESSION_MAX_FRACTION,
      healthy: false,
      reason:
        'Permanent-power run data is absent because the Production Office/full meta-progression system is deferred.',
    };
  }
  const averageIncrease = mean(
    hooks.map(
      (hook) =>
        (hook!.permanentPowerAfter - hook!.permanentPowerBefore) / hook!.permanentPowerBefore,
    ),
  );
  return {
    observed: round2(averageIncrease),
    target: META_PROGRESSION_MAX_FRACTION,
    healthy: averageIncrease > 0 && averageIncrease <= META_PROGRESSION_MAX_FRACTION,
    reason: `Average permanent-power increase is ${round2(
      averageIncrease * 100,
    )}%; the planned slow-positive band is >0% to 5% per run.`,
  };
}

function weightedGatedObjectiveScore(dimensions: FunDimensionScores): number | null {
  if (GATED_DIMENSIONS.some((key) => dimensions[key] === null || !Number.isFinite(dimensions[key])))
    return null;
  const numerator = GATED_DIMENSIONS.reduce(
    (sum, key) => sum + dimensions[key]! * DIMENSION_WEIGHTS[key],
    0,
  );
  const denominator = GATED_DIMENSIONS.reduce((sum, key) => sum + DIMENSION_WEIGHTS[key], 0);
  return round2(numerator / denominator);
}

function starterWeaponCoverage(sessions: ReadonlyArray<FunSession>): number {
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

function scenarioIdentity(session: FunSession): string | null {
  const context = session.run.evaluationContext;
  const persona = session.persona ?? session.run.playerPersona;
  // Human comparisons need participant identity and a study design, neither of
  // which is supplied by a seed. Unlabelled bot policies cannot be matched either.
  if (
    !context ||
    context.source !== 'headless' ||
    !Number.isSafeInteger(context.seed) ||
    !context.startFloor ||
    !session.run.startingWeapon ||
    !persona
  )
    return null;
  return JSON.stringify([
    context.source,
    context.seed,
    context.startFloor,
    session.run.startingWeapon,
    persona,
    session.scenario ?? null,
  ]);
}

function measuredDimensions(run: RunStats): FunDimensionScores {
  const available = run.evaluationContext?.available;
  const validDuration =
    finiteNonNegative(run.gameTimeMs) &&
    finiteNonNegative(run.safeRoomMs) &&
    run.safeRoomMs <= run.gameTimeMs;
  const combat =
    validDuration &&
    available?.combat === true &&
    finiteNonNegative(run.combat.totalKills) &&
    finiteNonNegative(run.combat.damageDealt);
  const health =
    validDuration &&
    available?.health === true &&
    [run.health.minHealthPercent, run.health.finalHealthPercent].every(
      (value) => finiteNonNegative(value) && value <= 1,
    ) &&
    finiteNonNegative(run.health.closeCallCount) &&
    finiteNonNegative(run.health.lowHealthCount);
  const progression =
    validDuration &&
    available?.progression === true &&
    finiteNonNegative(run.totalXp) &&
    run.levelUps.every(
      (event) => finiteNonNegative(event.gameTimeMs) && event.gameTimeMs <= run.gameTimeMs,
    );
  const quests =
    validDuration &&
    available?.quests === true &&
    finiteNonNegative(run.quests.questsAccepted) &&
    finiteNonNegative(run.quests.questsCompleted);
  const movement =
    run.movementQuality &&
    [run.movementQuality.wigglePct, run.movementQuality.stuckPct].every(
      (value) => finiteNonNegative(value) && value <= 100,
    );
  return {
    engagement: combat && quests ? engagementForRun(run) : null,
    challenge_balance: health ? challengeBalanceForRun(run) : null,
    excitement: combat ? excitementForRun(run) : null,
    pacing: progression && quests && movement ? pacingForRun(run) : null,
    progression:
      progression &&
      quests &&
      finiteNonNegative(run.runStartXp) &&
      finiteNonNegative(run.runStartLevel)
        ? progressionForRun(run)
        : null,
    choice_depth: null,
    run_distinctness: null,
  };
}

const DIMENSION_KEYS = Object.keys(DIMENSION_WEIGHTS) as Array<keyof FunDimensionScores>;
const SURVEY_KEYS = ['enjoyment', 'immersion', 'mastery', 'control', 'tension'] as const;

export function scoreFunSessions(
  sessions: ReadonlyArray<FunSession>,
  config: Partial<FunScoreConfig> = {},
  includePersonaBreakdown = true,
): FunScoreReport {
  const merged = { ...DEFAULT_CONFIG, ...config };
  const outcomes: Record<RunStats['outcome'], number> = {
    victory: 0,
    death: 0,
    timeout: 0,
    stalled: 0,
    error: 0,
    quit: 0,
  };
  const perRun = sessions.map((session) => {
    outcomes[session.run.outcome] += 1;
    const dimensions = measuredDimensions(session.run);
    return {
      id: session.id,
      identity: scenarioIdentity(session),
      source: session.run.evaluationContext?.source ?? ('unknown' as const),
      dimensions,
      heuristic_score: weightedGatedObjectiveScore(dimensions),
    };
  });
  const dimensions = {} as { -readonly [K in keyof FunDimensionScores]: FunDimensionScores[K] };
  const coverage = {} as Record<keyof FunDimensionScores, number>;
  for (const key of DIMENSION_KEYS) {
    const values = perRun
      .map((row) => row.dimensions[key])
      .filter((value): value is number => value !== null && Number.isFinite(value));
    coverage[key] = values.length;
    dimensions[key] =
      values.length > 0 && values.length === sessions.length ? round2(mean(values)) : null;
  }
  const observedSurveys = {} as Record<
    (typeof SURVEY_KEYS)[number],
    { responses: number; mean: number | null }
  >;
  for (const key of SURVEY_KEYS) {
    const values = sessions
      .filter((session) => session.run.evaluationContext?.source === 'human')
      .map((session) => session.survey?.[key])
      .filter(
        (value): value is number =>
          typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5,
      );
    observedSurveys[key] = {
      responses: values.length,
      mean: values.length ? round2(mean(values)) : null,
    };
  }
  const reward = measureDopamineCadence(sessions);
  const outliers = measureSnowballFrequency(sessions);
  const items = measureItemViability(sessions);
  const meta = measureMetaProgression(sessions);
  const fromMeasurement = (measurement: CriterionMeasurement): FunCriterion => ({
    observed: measurement.observed,
    target: measurement.target,
    reason: measurement.reason,
    status:
      measurement.observed === null
        ? 'unmeasured'
        : measurement.healthy
          ? 'healthy'
          : 'needs_attention',
  });
  const unmeasured = (reason: string): FunCriterion => ({
    observed: null,
    target: null,
    status: 'unmeasured',
    reason,
  });
  const criteria: FunCriteria = {
    unsafe_combat_uptime: unmeasured(
      'Requires zone-aware nearby combat duration; global enemy existence is not combat uptime.',
    ),
    survivability_variance: sessions.length
      ? {
          observed: round2(stdDev(sessions.map((session) => normalizedOutcome(session.run)))),
          target: null,
          status: 'descriptive',
          reason:
            'Outcome dispersion is descriptive; neither identical victories nor varied outcomes establish fun or fairness.',
        }
      : unmeasured('No runs supplied.'),
    run_variety: unmeasured(
      'Build and decision diversity are not measured by starting weapons, outcome entropy, or duration variance.',
    ),
    reward_cadence: sessions.length ? fromMeasurement(reward) : unmeasured('No runs supplied.'),
    performance_outlier_frequency:
      outliers.observed === null
        ? { ...fromMeasurement(outliers), target: null }
        : {
            observed: outliers.observed,
            target: null,
            status: 'descriptive',
            reason:
              outliers.reason +
              ' Relative performance outliers do not establish exploits or satisfying power growth.',
          },
    meta_progression: sessions.length ? fromMeasurement(meta) : unmeasured('No runs supplied.'),
    item_viability: sessions.length ? fromMeasurement(items) : unmeasured('No runs supplied.'),
    early_death_rate: sessions.length
      ? {
          observed: round2(
            sessions.filter((session) => isEarlyDeath(session.run)).length / sessions.length,
          ),
          target: EARLY_DEATH_TARGET_RATE,
          status:
            sessions.filter((session) => isEarlyDeath(session.run)).length / sessions.length <=
            EARLY_DEATH_TARGET_RATE
              ? 'healthy'
              : 'needs_attention',
          reason:
            'Tutorial death-rate diagnostic; the independent Floor-1 official-win requirement remains unchanged.',
        }
      : unmeasured('No runs supplied.'),
  };
  const objective = weightedGatedObjectiveScore(dimensions);
  const unmeasuredDimensions = GATED_DIMENSIONS.filter((key) => dimensions[key] === null);
  const failingDimensions = GATED_DIMENSIONS.filter(
    (key) => dimensions[key] !== null && dimensions[key]! < merged.minDimension,
  );
  const identities = perRun.flatMap((row) => (row.identity === null ? [] : [row.identity]));
  const hotspots: FunHotspot[] = GATED_DIMENSIONS.filter(
    (key) => dimensions[key] !== null && dimensions[key]! < merged.minDimension,
  ).map((dimension) => ({
    dimension,
    score: dimensions[dimension]!,
    reason:
      'Below the heuristic reference; investigate the per-run evidence before drawing experience conclusions.',
  }));
  const personaScores: Record<string, FunPersonaScore> = {};
  if (includePersonaBreakdown) {
    const groups = new Map<string, FunSession[]>();
    for (const session of sessions) {
      const persona = session.persona ?? session.run.playerPersona;
      if (!persona) continue;
      const group = groups.get(persona) ?? [];
      group.push(session);
      groups.set(persona, group);
    }
    for (const [persona, group] of groups) {
      const report = scoreFunSessions(group, config, false);
      personaScores[persona] = {
        runs: group.length,
        overall_fun_score: report.overall_fun_score,
        dimensions: report.dimensions,
        confidence: null,
      };
    }
  }
  return {
    schema_version: 2,
    interpretation: 'uncalibrated_heuristic',
    confidence: null,
    confidence_reason:
      'No human-calibrated enjoyment predictor. Run count and score stability do not establish validity.',
    runs: sessions.length,
    outcomes,
    dimensions,
    overall_fun_score: objective,
    objective_score: objective,
    subjective_score:
      observedSurveys.enjoyment.mean === null
        ? null
        : round2((observedSurveys.enjoyment.mean - 1) * 25),
    survey_coverage: round2(
      ratio(
        observedSurveys.enjoyment.responses,
        sessions.filter((session) => session.run.evaluationContext?.source === 'human').length,
      ),
    ),
    observed_surveys: observedSurveys,
    sameness_grade: null,
    gate: {
      min_overall: merged.minOverall,
      min_dimension: merged.minDimension,
      gating_overall_score: objective,
      pass:
        objective !== null &&
        objective >= merged.minOverall &&
        unmeasuredDimensions.length === 0 &&
        failingDimensions.length === 0,
      unmeasured_dimensions: unmeasuredDimensions,
      failing_dimensions: failingDimensions,
    },
    evidence: {
      unique_scenarios: new Set(identities).size,
      duplicate_scenarios: identities.length - new Set(identities).size,
      unidentified_runs: perRun.length - identities.length,
      starter_weapon_coverage: starterWeaponCoverage(sessions),
      dimension_coverage: coverage,
    },
    per_run: perRun,
    criteria,
    hotspots,
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
  reward_cadence: 5,
  performance_outlier_frequency: 0.02,
  meta_progression: 0.05,
  item_viability: 0.05,
  early_death_rate: 0.02,
};

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

function matchCohorts(baseline: FunScoreReport, candidate: FunScoreReport): FunCohortMatch {
  const reasons: string[] = [];
  if (baseline.schema_version !== 2 || candidate.schema_version !== 2)
    reasons.push('Scoring versions differ or are legacy.');
  const identities = (report: FunScoreReport): string[] | null => {
    if (
      !Array.isArray(report.per_run) ||
      report.per_run.length !== report.runs ||
      report.runs === 0 ||
      report.per_run.some((row) => typeof row.identity !== 'string')
    )
      return null;
    return report.per_run.map((row) => row.identity!).sort();
  };
  const left = identities(baseline);
  const right = identities(candidate);
  if (left === null || right === null)
    reasons.push(
      'Missing complete headless scenario identity; human comparisons require a participant-aware study design.',
    );
  else {
    if (new Set(left).size !== left.length || new Set(right).size !== right.length)
      reasons.push('Duplicate deterministic scenarios are not independent comparison evidence.');
    if (left.length !== right.length || left.some((value, index) => value !== right[index]))
      reasons.push(
        'Seed, starting floor, weapon, persona, source, scenario leg, or repetition counts differ.',
      );
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
  const dimensionKeys = DIMENSION_KEYS;
  const criterionKeys = Object.keys(CRITERION_MEANINGFUL_DELTA) as Array<keyof FunCriteria>;
  const dimensions = {} as Record<keyof FunDimensionScores, FunMetricComparison>;
  for (const key of dimensionKeys) {
    dimensions[key] = compareMetric(
      baseline.dimensions[key] ?? null,
      candidate.dimensions[key] ?? null,
      true,
    );
  }

  const criteria = {} as Record<keyof FunCriteria, FunMetricComparison>;
  const higherIsBetter: Readonly<Record<keyof FunCriteria, boolean>> = {
    unsafe_combat_uptime: true,
    survivability_variance: true,
    run_variety: true,
    reward_cadence: false,
    performance_outlier_frequency: false,
    meta_progression: true,
    item_viability: false,
    early_death_rate: false,
  };
  for (const key of criterionKeys) {
    const previous = baseline.criteria[key];
    const current = candidate.criteria[key];
    const descriptive = previous?.status === 'descriptive' || current?.status === 'descriptive';
    const comparison = compareMetric(
      previous?.observed ?? null,
      current?.observed ?? null,
      higherIsBetter[key],
      CRITERION_MEANINGFUL_DELTA[key],
    );
    criteria[key] =
      descriptive && comparison.status !== 'unmeasured'
        ? { ...comparison, status: 'inconclusive' }
        : comparison;
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
