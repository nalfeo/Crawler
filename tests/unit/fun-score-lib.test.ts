import { describe, expect, it } from 'vitest';
import type { RunStats } from '../../src/game/ai/types.js';
import type { FunScoreReport, FunSession } from '../../scripts/agent/health/fun-score-lib.js';
import {
  compareFunReports,
  GATED_DIMENSIONS,
  scoreFunSessions,
} from '../../scripts/agent/health/fun-score-lib.js';

function makeRun(overrides: Partial<RunStats> = {}): RunStats {
  const run: RunStats = {
    totalFrames: 20_000,
    wallTimeMs: 3000,
    gameTimeMs: 320_000,
    safeRoomMs: 0,
    finalFloor: 1,
    finalScore: 1500,
    outcome: 'victory',
    levelUps: [
      { level: 2, gameTimeMs: 45_000, frame: 2700 },
      { level: 3, gameTimeMs: 105_000, frame: 6300 },
      { level: 4, gameTimeMs: 180_000, frame: 10_800 },
    ],
    combat: {
      totalKills: 125,
      killsByType: { rat: 80, slime: 45 },
      combatTimeMs: 165_000,
      engagementCount: 6,
      damageDealt: 4200,
      damageTaken: 950,
      damageTakenBySource: {},
    },
    health: {
      minHealthPercent: 0.15,
      closeCallCount: 2,
      lowHealthCount: 4,
      finalHealthPercent: 0.32,
    },
    quests: {
      questsAccepted: 2,
      questsCompleted: 2,
      questsFailed: [],
      mainQuestAcceptedMs: 30_000,
      mainQuestCompletedMs: 270_000,
      firstQuestCompletedMs: 120_000,
      questLogAccepts: { main: 30_000, side: 90_000 },
      questLogCompletions: { main: 270_000, side: 210_000 },
    },
    finalLevel: 7,
    totalXp: 2050,
    totalGold: 190,
    startingWeapon: 'sword',
  };
  return { ...run, ...overrides };
}

describe('scoreFunSessions', () => {
  it('returns a passing score for healthy runs', () => {
    const sessions: FunSession[] = [
      { id: 'a', run: makeRun({ startingWeapon: 'sword' }) },
      { id: 'b', run: makeRun({ startingWeapon: 'bow', totalXp: 2150 }) },
      { id: 'c', run: makeRun({ startingWeapon: 'baseball-bat', finalLevel: 8 }) },
    ];
    const report = scoreFunSessions(sessions);

    expect(report.overall_fun_score).toBeGreaterThan(70);
    expect(report.gate.pass).toBe(true);
    expect(report.gate.gating_overall_score).toBeGreaterThanOrEqual(70);
    expect(report.dimensions.choice_depth).toBeGreaterThan(70);
    expect(report.dimensions.run_distinctness).toBeGreaterThan(15);
    expect(report.sameness_grade).toBeLessThan(85);
    expect(Number.isFinite(report.confidence)).toBe(true);
    expect(report.confidence).toBeGreaterThanOrEqual(0);
    expect(report.confidence).toBeLessThanOrEqual(1);
  });

  it('fails gate for poor timeout-heavy runs', () => {
    const badRun = makeRun({
      outcome: 'timeout',
      combat: {
        totalKills: 18,
        killsByType: { rat: 10, slime: 8 },
        combatTimeMs: 25_000,
        engagementCount: 1,
        damageDealt: 600,
        damageTaken: 1400,
        damageTakenBySource: {},
      },
      health: {
        minHealthPercent: 0.01,
        closeCallCount: 8,
        lowHealthCount: 14,
        finalHealthPercent: 0.05,
      },
      quests: {
        questsAccepted: 2,
        questsCompleted: 0,
        questsFailed: ['main'],
        mainQuestAcceptedMs: 30_000,
        mainQuestCompletedMs: null,
        firstQuestCompletedMs: null,
        questLogAccepts: { main: 30_000 },
        questLogCompletions: {},
      },
      finalLevel: 2,
      totalXp: 450,
      startingWeapon: 'sword',
    });
    const report = scoreFunSessions([
      { id: 'bad-1', run: badRun },
      { id: 'bad-2', run: badRun },
    ]);

    expect(report.gate.pass).toBe(false);
    expect(report.overall_fun_score).toBeLessThan(70);
    expect(report.gate.failing_dimensions.length).toBeGreaterThan(0);
  });

  it('uses only gated dimensions for empty-input gate failures', () => {
    const report = scoreFunSessions([]);
    expect(report.gate.failing_dimensions).toEqual([...GATED_DIMENSIONS]);
    expect(report.gate.failing_dimensions).not.toContain('run_distinctness');
  });

  it('blends in survey sentiment when available', () => {
    const baseSessions: FunSession[] = [
      { id: 'x', run: makeRun() },
      { id: 'y', run: makeRun({ startingWeapon: 'bow' }) },
    ];
    const withSurvey: FunSession[] = [
      {
        id: 'x',
        run: makeRun(),
        survey: { enjoyment: 5, immersion: 5, mastery: 4, control: 5, tension: 2 },
      },
      {
        id: 'y',
        run: makeRun({ startingWeapon: 'bow' }),
        survey: { enjoyment: 5, immersion: 4, mastery: 4, control: 5, tension: 2 },
      },
    ];

    const objectiveOnly = scoreFunSessions(baseSessions);
    const blended = scoreFunSessions(withSurvey);

    expect(objectiveOnly.subjective_score).toBeNull();
    expect(blended.subjective_score).not.toBeNull();
    expect(blended.survey_coverage).toBe(1);
    expect(blended.overall_fun_score).toBeGreaterThanOrEqual(objectiveOnly.overall_fun_score - 5);
  });

  it('grades repeated identical runs as more samey than varied runs', () => {
    const samey = scoreFunSessions([
      { id: 's1', run: makeRun({ startingWeapon: 'sword', outcome: 'victory' }) },
      { id: 's2', run: makeRun({ startingWeapon: 'sword', outcome: 'victory' }) },
      { id: 's3', run: makeRun({ startingWeapon: 'sword', outcome: 'victory' }) },
    ]);
    const varied = scoreFunSessions([
      {
        id: 'v1',
        run: makeRun({
          startingWeapon: 'sword',
          outcome: 'victory',
          finalLevel: 8,
          gameTimeMs: 280_000,
        }),
      },
      {
        id: 'v2',
        run: makeRun({
          startingWeapon: 'bow',
          outcome: 'death',
          finalLevel: 4,
          gameTimeMs: 210_000,
          quests: {
            questsAccepted: 2,
            questsCompleted: 1,
            questsFailed: [],
            mainQuestAcceptedMs: 20_000,
            mainQuestCompletedMs: null,
            firstQuestCompletedMs: 170_000,
            questLogAccepts: { main: 20_000 },
            questLogCompletions: { main: 170_000 },
          },
        }),
      },
      {
        id: 'v3',
        run: makeRun({
          startingWeapon: 'baseball-bat',
          outcome: 'timeout',
          finalLevel: 3,
          gameTimeMs: 360_000,
          quests: {
            questsAccepted: 2,
            questsCompleted: 0,
            questsFailed: ['main'],
            mainQuestAcceptedMs: 30_000,
            mainQuestCompletedMs: null,
            firstQuestCompletedMs: null,
            questLogAccepts: { main: 30_000 },
            questLogCompletions: {},
          },
        }),
      },
    ]);

    expect(varied.dimensions.run_distinctness).toBeGreaterThan(samey.dimensions.run_distinctness);
    expect(varied.sameness_grade).toBeLessThan(samey.sameness_grade);
  });

  it('reports measurable criteria and groups runs by evaluator persona', () => {
    const report = scoreFunSessions([
      { id: 'new', persona: 'new_player', run: makeRun() },
      { id: 'expert', persona: 'experienced_player', run: makeRun({ startingWeapon: 'bow' }) },
    ]);

    // combatTimeMs accumulates during safe-room frames too, so uptime stays
    // unmeasured until zone-aware combat time is recorded.
    expect(report.criteria.unsafe_combat_uptime.status).toBe('unmeasured');
    expect(report.criteria.dopamine_cadence.status).toBe('unmeasured');
    expect(report.criteria.snowball_frequency.status).toBe('unmeasured');
    expect(report.persona_scores.new_player?.runs).toBe(1);
    expect(report.persona_scores.experienced_player?.runs).toBe(1);
  });

  it('classifies meaningful baseline deltas without gating on them', () => {
    const baseline = scoreFunSessions([{ id: 'baseline', run: makeRun() }]);
    const candidate = {
      ...baseline,
      overall_fun_score: baseline.overall_fun_score + 5,
    };

    const comparison = compareFunReports(baseline, candidate);

    expect(comparison.overall_fun_score.status).toBe('improving');
    expect(comparison.criteria.dopamine_cadence.status).toBe('unmeasured');
  });

  it('uses per-criterion deltas so ratio criteria are not permanently inconclusive', () => {
    const baseline = scoreFunSessions([{ id: 'baseline', run: makeRun() }]);
    const candidate: FunScoreReport = {
      ...baseline,
      criteria: {
        ...baseline.criteria,
        survivability_variance: {
          ...baseline.criteria.survivability_variance,
          observed: (baseline.criteria.survivability_variance.observed ?? 0) + 0.2,
        },
      },
    };

    const comparison = compareFunReports(baseline, candidate);

    expect(comparison.criteria.survivability_variance.status).toBe('improving');
  });

  it('scales subjective blending with survey coverage', () => {
    const objectiveSessions: FunSession[] = [
      { id: 'o1', run: makeRun({ startingWeapon: 'sword' }) },
      { id: 'o2', run: makeRun({ startingWeapon: 'bow' }) },
      { id: 'o3', run: makeRun({ startingWeapon: 'baseball-bat' }) },
      { id: 'o4', run: makeRun({ startingWeapon: 'sword' }) },
      { id: 'o5', run: makeRun({ startingWeapon: 'bow' }) },
    ];
    const sparseSurveySessions: FunSession[] = objectiveSessions.map((session, index) =>
      index === 0
        ? {
            ...session,
            survey: { enjoyment: 1, immersion: 1, mastery: 1, control: 1, tension: 5 },
          }
        : session,
    );

    const objective = scoreFunSessions(objectiveSessions);
    const sparse = scoreFunSessions(sparseSurveySessions);
    const full = scoreFunSessions(
      objectiveSessions.map((session) => ({
        ...session,
        survey: { enjoyment: 1, immersion: 1, mastery: 1, control: 1, tension: 5 },
      })),
    );

    expect(sparse.survey_coverage).toBe(0.2);
    expect(full.survey_coverage).toBe(1);
    expect(sparse.overall_fun_score).toBeGreaterThan(full.overall_fun_score);
    expect(objective.overall_fun_score - sparse.overall_fun_score).toBeLessThan(
      objective.overall_fun_score - full.overall_fun_score,
    );
  });
});
