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

/** Clone a report with a forced `survivability_variance` observation. */
function withVariance(report: FunScoreReport, observed: number): FunScoreReport {
  return {
    ...report,
    criteria: {
      ...report.criteria,
      survivability_variance: { ...report.criteria.survivability_variance, observed },
    },
  };
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

  it('lowers the pacing dimension when movementQuality reports sustained stuck/wiggle time (issue #3198)', () => {
    const goodMovement = makeRun({
      movementQuality: {
        wiggleMs: 0,
        wigglePct: 0,
        idleMs: 0,
        idlePct: 0,
        stuckMs: 0,
        stuckPct: 0,
        excludedMs: 0,
        excludedPct: 0,
        travelEfficiency: 0.95,
        totalPathTravel: 1000,
        totalNetDisp: 950,
      },
    });
    const badMovement = makeRun({
      movementQuality: {
        wiggleMs: 96_000,
        wigglePct: 30,
        idleMs: 0,
        idlePct: 0,
        stuckMs: 32_000,
        stuckPct: 10,
        excludedMs: 0,
        excludedPct: 0,
        travelEfficiency: 0.2,
        totalPathTravel: 1000,
        totalNetDisp: 200,
      },
    });

    const goodReport = scoreFunSessions([{ id: 'a', run: goodMovement }]);
    const badReport = scoreFunSessions([{ id: 'a', run: badMovement }]);

    expect(badReport.dimensions.pacing).toBeLessThan(goodReport.dimensions.pacing);

    // Runs without movementQuality (e.g. pre-existing fixtures/recordings)
    // must be scored neutrally rather than crashing or being penalized.
    const noMovementReport = scoreFunSessions([{ id: 'a', run: makeRun() }]);
    expect(noMovementReport.dimensions.pacing).toBe(goodReport.dimensions.pacing);
  });

  it('reports and penalizes tutorial-phase deaths', () => {
    const healthyReport = scoreFunSessions([
      { id: 'a', run: makeRun({ outcome: 'victory' }) },
      { id: 'b', run: makeRun({ outcome: 'death', finalFloor: 4 }) },
    ]);
    expect(healthyReport.criteria.early_death_rate).toMatchObject({
      observed: 0,
      status: 'healthy',
    });

    const earlyDeathReport = scoreFunSessions([
      { id: 'a', run: makeRun({ outcome: 'death', finalFloor: 1 }) },
      { id: 'b', run: makeRun({ outcome: 'death', finalFloor: 2 }) },
      { id: 'c', run: makeRun({ outcome: 'victory' }) },
    ]);
    expect(earlyDeathReport.criteria.early_death_rate.observed).toBeCloseTo(2 / 3);
    expect(earlyDeathReport.criteria.early_death_rate.status).toBe('needs_attention');

    const lateFloorDeath = scoreFunSessions([
      { id: 'late', run: makeRun({ outcome: 'death', finalFloor: 5 }) },
    ]);
    const earlyFloorDeath = scoreFunSessions([
      { id: 'early', run: makeRun({ outcome: 'death', finalFloor: 1 }) },
    ]);
    expect(earlyFloorDeath.dimensions.challenge_balance).toBeLessThan(
      lateFloorDeath.dimensions.challenge_balance,
    );
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

  it('measures dopamine cadence from active-time events including boundary gaps', () => {
    const healthy = scoreFunSessions([
      {
        id: 'healthy',
        run: makeRun({
          rewardEvents: {
            activeDurationMs: 180_000,
            events: [
              { kind: 'level_up', sourceId: '2', gameTimeMs: 60_000, activeTimeMs: 60_000 },
              {
                kind: 'quest_complete',
                sourceId: 'main',
                gameTimeMs: 150_000,
                activeTimeMs: 120_000,
              },
            ],
          },
        }),
      },
    ]);
    expect(healthy.criteria.dopamine_cadence).toMatchObject({
      observed: 60,
      status: 'healthy',
    });
    expect(healthy.criteria.dopamine_cadence.reason).toContain('100%');

    const sparse = scoreFunSessions([
      {
        id: 'sparse',
        run: makeRun({
          rewardEvents: {
            activeDurationMs: 200_000,
            events: [{ kind: 'level_up', sourceId: '2', gameTimeMs: 50_000, activeTimeMs: 50_000 }],
          },
        }),
      },
    ]);
    expect(sparse.criteria.dopamine_cadence).toMatchObject({
      observed: 150,
      status: 'needs_attention',
    });
  });

  it('classifies robust multi-feature snowball outliers without forcing a percentile', () => {
    const sessions: FunSession[] = Array.from({ length: 10 }, (_, index) => {
      const outlier = index === 9;
      return {
        id: `snow-${index}`,
        run: makeRun({
          runPerformance: {
            activeClearTimeMs: outlier ? 100_000 : 300_000 + index * 1_000,
            damagePerActiveMinute: outlier ? 5_000 : 1_000 + index * 10,
            killsPerActiveMinute: 20 + index,
            dominantItemUsageShare: 0.4 + index * 0.005,
          },
        }),
      };
    });
    const report = scoreFunSessions(sessions);
    expect(report.criteria.snowball_frequency).toMatchObject({
      observed: 0.1,
      status: 'healthy',
    });
    expect(report.criteria.snowball_frequency.reason).toContain('1/10');
    expect(report.criteria.snowball_frequency.reason).toContain('3.5');
  });

  it('requires enough complete official wins before measuring snowball frequency', () => {
    const report = scoreFunSessions([
      {
        id: 'one',
        run: makeRun({
          runPerformance: {
            activeClearTimeMs: 300_000,
            damagePerActiveMinute: 1_000,
            killsPerActiveMinute: 20,
            dominantItemUsageShare: 0.5,
          },
        }),
      },
    ]);
    expect(report.criteria.snowball_frequency.status).toBe('unmeasured');
    expect(report.criteria.snowball_frequency.reason).toContain('at least 10');
  });

  it('flags avoided and inert catalog items while accepting used items', () => {
    const report = scoreFunSessions([
      {
        id: 'items',
        run: makeRun({
          itemInteractions: {
            uniqueActivationCount: 12,
            dominantActivationCount: 8,
            items: [
              {
                catalogKey: 'weapon:sword',
                kind: 'starter_weapon',
                offeredCount: 1,
                selectableExposureCount: 1,
                selectionCount: 1,
                activationCount: 12,
                activeTimeMs: 0,
              },
              {
                catalogKey: 'spell:heal',
                kind: 'spell',
                offeredCount: 1,
                selectableExposureCount: 1,
                selectionCount: 0,
                activationCount: 0,
                activeTimeMs: 0,
              },
              {
                catalogKey: 'generated:ring',
                kind: 'generated_equipment',
                offeredCount: 1,
                selectableExposureCount: 1,
                selectionCount: 1,
                activationCount: 0,
                activeTimeMs: 0,
              },
            ],
          },
        }),
      },
    ]);
    expect(report.criteria.item_viability).toMatchObject({
      observed: 0.67,
      status: 'needs_attention',
    });
  });

  it('flags items selected below 10% after enough exposures', () => {
    const report = scoreFunSessions([
      {
        id: 'rarely-selected',
        run: makeRun({
          itemInteractions: {
            uniqueActivationCount: 1,
            dominantActivationCount: 1,
            items: [
              {
                catalogKey: 'spell:rare-choice',
                kind: 'spell',
                offeredCount: 11,
                selectableExposureCount: 11,
                selectionCount: 1,
                activationCount: 1,
                activeTimeMs: 0,
              },
            ],
          },
        }),
      },
    ]);

    expect(report.criteria.item_viability).toMatchObject({
      observed: 1,
      status: 'needs_attention',
    });
    expect(report.criteria.item_viability.reason).toContain('below 10% after 5+ exposures');
  });

  it('consumes permanent-power hooks but leaves legacy mixed inputs unmeasured', () => {
    const measured = scoreFunSessions([
      {
        id: 'meta',
        run: makeRun({
          metaProgression: { permanentPowerBefore: 100, permanentPowerAfter: 103 },
        }),
      },
    ]);
    expect(measured.criteria.meta_progression).toMatchObject({
      observed: 0.03,
      status: 'healthy',
    });

    const mixed = scoreFunSessions([
      {
        id: 'new',
        run: makeRun({
          rewardEvents: { activeDurationMs: 10_000, events: [] },
          itemInteractions: {
            items: [],
            uniqueActivationCount: 0,
            dominantActivationCount: 0,
          },
        }),
      },
      { id: 'legacy', run: makeRun() },
    ]);
    expect(mixed.criteria.dopamine_cadence.status).toBe('unmeasured');
    expect(mixed.criteria.item_viability.status).toBe('unmeasured');
    expect(mixed.criteria.meta_progression.status).toBe('unmeasured');
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

  it('downgrades comparisons to inconclusive when the cohorts are not comparable', () => {
    const baseline = scoreFunSessions([
      { id: 'b1', persona: 'new_player', run: makeRun() },
      { id: 'b2', persona: 'new_player', run: makeRun({ startingWeapon: 'bow' }) },
    ]);
    const candidate = scoreFunSessions([
      { id: 'c1', persona: 'min_max_cheeser', run: makeRun() },
      { id: 'c2', persona: 'min_max_cheeser', run: makeRun({ startingWeapon: 'bow' }) },
    ]);

    const comparison = compareFunReports(baseline, candidate);

    expect(comparison.cohort.matched).toBe(false);
    expect(comparison.cohort.reasons.length).toBeGreaterThan(0);
    expect(comparison.dimensions.engagement.status).toBe('inconclusive');
    // Unmeasured criteria stay unmeasured rather than being relabelled.
    expect(comparison.criteria.dopamine_cadence.status).toBe('unmeasured');
  });

  it('treats survivability variance as a band, so runaway volatility is degrading', () => {
    const baseline = scoreFunSessions([{ id: 'baseline', run: makeRun() }]);
    const inBand: FunScoreReport = withVariance(baseline, 0.3);
    const volatile: FunScoreReport = withVariance(baseline, 0.95);

    expect(compareFunReports(inBand, volatile).criteria.survivability_variance.status).toBe(
      'degrading',
    );
    expect(compareFunReports(volatile, inBand).criteria.survivability_variance.status).toBe(
      'improving',
    );
  });

  it('uses per-criterion deltas so ratio criteria are not permanently inconclusive', () => {
    const baseline = scoreFunSessions([{ id: 'baseline', run: makeRun() }]);
    const candidate = withVariance(baseline, 0.2);

    const comparison = compareFunReports(baseline, candidate);

    // A 0.2 move on a [0,1] ratio would be `inconclusive` under the 2-point
    // dimension threshold; the per-criterion threshold classifies it.
    expect(comparison.criteria.survivability_variance.status).toBe('improving');
  });

  it('treats a lower item-viability failure rate as improving', () => {
    const baseline = scoreFunSessions([{ id: 'baseline', run: makeRun() }]);
    const candidate = scoreFunSessions([{ id: 'candidate', run: makeRun() }]);
    const withItemRate = (report: FunScoreReport, observed: number): FunScoreReport => ({
      ...report,
      criteria: {
        ...report.criteria,
        item_viability: { ...report.criteria.item_viability, observed },
      },
    });

    expect(
      compareFunReports(withItemRate(baseline, 0.5), withItemRate(candidate, 0.1)).criteria
        .item_viability.status,
    ).toBe('improving');
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
