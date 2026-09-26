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
    evaluationContext: {
      source: 'headless',
      seed: 42,
      startFloor: 'floor1',
      available: { combat: true, health: true, progression: true, quests: true },
    },
    playerPersona: 'experienced_player',
    runStartXp: 0,
    runStartLevel: 1,
    movementQuality: {
      wiggleMs: 0,
      wigglePct: 0,
      idleMs: 0,
      idlePct: 0,
      stuckMs: 0,
      stuckPct: 0,
      excludedMs: 0,
      excludedPct: 0,
      travelEfficiency: 1,
      totalPathTravel: 10,
      totalNetDisp: 10,
    },
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
    expect(report.dimensions.choice_depth).toBeNull();
    expect(report.evidence.starter_weapon_coverage).toBe(100);
    expect(report.dimensions.run_distinctness).toBeNull();
    expect(report.sameness_grade).toBeNull();
    expect(report.confidence).toBeNull();
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

    expect(badReport.dimensions.pacing).toBeLessThan(goodReport.dimensions.pacing!);

    // Runs without movementQuality (e.g. pre-existing fixtures/recordings)
    // must be explicitly unmeasured, not silently awarded perfect movement.
    const noMovementReport = scoreFunSessions([
      { id: 'a', run: makeRun({ movementQuality: undefined }) },
    ]);
    expect(noMovementReport.dimensions.pacing).toBeNull();
    expect(noMovementReport.gate.pass).toBe(false);
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
      lateFloorDeath.dimensions.challenge_balance!,
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
    expect(report.gate.unmeasured_dimensions).toEqual([...GATED_DIMENSIONS]);
    expect(report.gate.failing_dimensions).not.toContain('run_distinctness');
  });

  it('keeps direct human responses separate and tension descriptive', () => {
    const run = makeRun();
    run.evaluationContext!.source = 'human';
    const base = scoreFunSessions([{ id: 'human', run }]);
    const low = scoreFunSessions([{ id: 'human', run, survey: { enjoyment: 1, tension: 1 } }]);
    const high = scoreFunSessions([{ id: 'human', run, survey: { enjoyment: 1, tension: 5 } }]);
    expect(high.overall_fun_score).toBe(base.overall_fun_score);
    expect(high.gate).toEqual(base.gate);
    expect(high.subjective_score).toBe(0);
    expect(high.subjective_score).toBe(low.subjective_score);
    expect(high.observed_surveys.tension).toEqual({ responses: 1, mean: 5 });
    expect(high.observed_surveys.enjoyment).toEqual({ responses: 1, mean: 1 });
    const tensionOnly = scoreFunSessions([{ id: 'human', run, survey: { tension: 5 } }]);
    expect(tensionOnly.subjective_score).toBeNull();
    expect(tensionOnly.survey_coverage).toBe(0);
  });

  it('does not infer build diversity or experience from a sweep weapon mix', () => {
    const same = scoreFunSessions(
      ['sword', 'sword', 'sword'].map((startingWeapon, i) => ({
        id: String(i),
        run: makeRun({ startingWeapon }),
      })),
    );
    const varied = scoreFunSessions(
      ['sword', 'bow', 'baseball-bat'].map((startingWeapon, i) => ({
        id: String(i),
        run: makeRun({ startingWeapon }),
      })),
    );
    expect(same.overall_fun_score).toBe(varied.overall_fun_score);
    expect(same.gate).toEqual(varied.gate);
    expect(same.evidence.starter_weapon_coverage).toBeLessThan(
      varied.evidence.starter_weapon_coverage,
    );
    expect(varied.dimensions.choice_depth).toBeNull();
    expect(varied.dimensions.run_distinctness).toBeNull();
    expect(varied.criteria.run_variety.status).toBe('unmeasured');
  });

  it('reports measurable criteria and groups runs by evaluator persona', () => {
    const report = scoreFunSessions([
      { id: 'new', persona: 'new_player', run: makeRun() },
      { id: 'expert', persona: 'experienced_player', run: makeRun({ startingWeapon: 'bow' }) },
    ]);

    // combatTimeMs accumulates during safe-room frames too, so uptime stays
    // unmeasured until zone-aware combat time is recorded.
    expect(report.criteria.unsafe_combat_uptime.status).toBe('unmeasured');
    expect(report.criteria.reward_cadence.status).toBe('unmeasured');
    expect(report.criteria.performance_outlier_frequency.status).toBe('unmeasured');
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
    expect(healthy.criteria.reward_cadence).toMatchObject({
      observed: 60,
      status: 'healthy',
    });
    expect(healthy.criteria.reward_cadence.reason).toContain('100%');

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
    expect(sparse.criteria.reward_cadence).toMatchObject({
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
    expect(report.criteria.performance_outlier_frequency).toMatchObject({
      observed: 0.1,
      status: 'descriptive',
    });
    expect(report.criteria.performance_outlier_frequency.reason).toContain('1/10');
    expect(report.criteria.performance_outlier_frequency.reason).toContain('3.5');
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
    expect(report.criteria.performance_outlier_frequency.status).toBe('unmeasured');
    expect(report.criteria.performance_outlier_frequency.reason).toContain('at least 10');
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
    expect(mixed.criteria.reward_cadence.status).toBe('unmeasured');
    expect(mixed.criteria.item_viability.status).toBe('unmeasured');
    expect(mixed.criteria.meta_progression.status).toBe('unmeasured');
  });

  it('classifies meaningful baseline deltas without gating on them', () => {
    const baseline = scoreFunSessions([{ id: 'baseline', run: makeRun() }]);
    const candidate = {
      ...baseline,
      overall_fun_score: baseline.overall_fun_score! + 5,
    };

    const comparison = compareFunReports(baseline, candidate);

    expect(comparison.overall_fun_score.status).toBe('improving');
    expect(comparison.criteria.reward_cadence.status).toBe('unmeasured');
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
    expect(comparison.criteria.reward_cadence.status).toBe('unmeasured');
  });

  it('does not call identical victories unhealthy or give outcome dispersion a preferred direction', () => {
    const base = scoreFunSessions([{ id: 'victory', run: makeRun() }]);
    expect(base.criteria.survivability_variance).toMatchObject({
      observed: 0,
      status: 'descriptive',
      target: null,
    });
    expect(
      compareFunReports(withVariance(base, 0), withVariance(base, 0.3)).criteria
        .survivability_variance.status,
    ).toBe('inconclusive');
  });

  it('never treats duplicate records as enjoyment confidence', () => {
    const report = scoreFunSessions(
      Array.from({ length: 300 }, (_, i) => ({ id: String(i), run: makeRun() })),
    );
    expect(report.confidence).toBeNull();
    expect(report.evidence.unique_scenarios).toBe(1);
    expect(report.evidence.duplicate_scenarios).toBe(299);
    expect(report.per_run).toHaveLength(300);
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

  it('counts sparse human survey responses without changing the diagnostic score', () => {
    const run = makeRun();
    run.evaluationContext!.source = 'human';
    const sessions = Array.from({ length: 5 }, (_, i) => ({ id: String(i), run }));
    const base = scoreFunSessions(sessions);
    const sparse = scoreFunSessions(
      sessions.map((session, i) => (i === 0 ? { ...session, survey: { enjoyment: 1 } } : session)),
    );
    expect(sparse.survey_coverage).toBe(0.2);
    expect(sparse.observed_surveys.enjoyment.responses).toBe(1);
    expect(sparse.overall_fun_score).toBe(base.overall_fun_score);
  });

  it('does not punish exceeding output and acquired-progression references', () => {
    const run = makeRun();
    const stronger = structuredClone(run);
    stronger.combat.totalKills *= 4;
    stronger.combat.damageDealt *= 4;
    stronger.totalXp *= 4;
    stronger.finalLevel = 25;
    stronger.levelUps = Array.from({ length: 24 }, (_, i) => ({
      level: i + 2,
      gameTimeMs: i * 1000,
      frame: i * 60,
    }));
    stronger.health.finalHealthPercent = 1;
    const before = scoreFunSessions([{ id: 'before', run }]);
    const after = scoreFunSessions([{ id: 'after', run: stronger }]);
    expect(after.overall_fun_score).toBeGreaterThanOrEqual(before.overall_fun_score!);
    expect(after.dimensions.excitement).toBeGreaterThanOrEqual(before.dimensions.excitement!);
    expect(after.dimensions.progression).toBeGreaterThanOrEqual(before.dimensions.progression!);
  });

  it('does not reward an injected starting level or XP', () => {
    const run = makeRun({
      totalXp: 2000,
      runStartXp: 2000,
      runStartLevel: 8,
      finalLevel: 8,
      levelUps: [],
    });
    const advanced = makeRun({
      totalXp: 8000,
      runStartXp: 8000,
      runStartLevel: 20,
      finalLevel: 20,
      levelUps: [],
    });
    expect(scoreFunSessions([{ id: 'a', run }]).dimensions.progression).toBe(
      scoreFunSessions([{ id: 'b', run: advanced }]).dimensions.progression,
    );
  });

  it('counts earned levels independently of XP pickup batching', () => {
    const spread = makeRun({ runStartLevel: 1, finalLevel: 4 });
    const batched = makeRun({ runStartLevel: 1, finalLevel: 4, levelUps: [spread.levelUps[2]!] });
    const score = (run: RunStats) => scoreFunSessions([{ id: 'run', run }]).dimensions.progression;
    expect(score(batched)).toBe(score(spread));
    expect(score(makeRun({ runStartLevel: undefined }))).toBeNull();
  });

  it('fails closed for legacy, partially observed, and mixed telemetry', () => {
    const legacy = makeRun({ evaluationContext: undefined });
    const report = scoreFunSessions([
      { id: 'legacy', run: legacy },
      { id: 'measured', run: makeRun() },
    ]);
    expect(report.overall_fun_score).toBeNull();
    expect(report.gate.pass).toBe(false);
    expect(report.gate.unmeasured_dimensions).toEqual(GATED_DIMENSIONS);
    expect(report.evidence.dimension_coverage.engagement).toBe(1);
    expect(report.evidence.unidentified_runs).toBe(1);
    expect(report.per_run[0]?.heuristic_score).toBeNull();
  });

  it('does not use global enemy existence or legacy engagement counters', () => {
    const run = makeRun();
    const changed = structuredClone(run);
    changed.combat.combatTimeMs = run.gameTimeMs;
    changed.combat.engagementCount = 500;
    expect(scoreFunSessions([{ id: 'a', run }]).dimensions).toEqual(
      scoreFunSessions([{ id: 'b', run: changed }]).dimensions,
    );
  });

  it('matches scenario multisets independent of IDs/order and rejects seed, floor, persona, weapon, and source drift', () => {
    const first = makeRun();
    const second = makeRun({ startingWeapon: 'bow' });
    const baseline = scoreFunSessions([
      { id: 'a', run: first },
      { id: 'b', run: second },
    ]);
    const reordered = scoreFunSessions([
      { id: 'different-id', run: second },
      { id: 'other-id', run: first },
    ]);
    expect(compareFunReports(baseline, reordered).cohort.matched).toBe(true);
    for (const modify of [
      (run: RunStats) => {
        run.evaluationContext!.seed += 1;
      },
      (run: RunStats) => {
        run.evaluationContext!.startFloor = 'floor2';
      },
      (run: RunStats) => {
        run.evaluationContext!.source = 'human';
      },
      (run: RunStats) => {
        run.playerPersona = 'new_player';
      },
      (run: RunStats) => {
        run.startingWeapon = 'baseball-bat';
      },
    ]) {
      const modified = structuredClone(first);
      modify(modified);
      const candidate = scoreFunSessions([
        { id: 'a', run: modified },
        { id: 'b', run: second },
      ]);
      expect(compareFunReports(baseline, candidate).cohort.matched).toBe(false);
      expect(compareFunReports(baseline, candidate).overall_fun_score.status).toBe('inconclusive');
    }
    const duplicates = scoreFunSessions([
      { id: 'a', run: first },
      { id: 'b', run: first },
    ]);
    expect(compareFunReports(baseline, duplicates).cohort.matched).toBe(false);
  });

  it('rejects legacy comparisons without undefined deltas or NaN', () => {
    const current = scoreFunSessions([{ id: 'a', run: makeRun() }]);
    const legacy = {
      ...current,
      schema_version: undefined,
      per_run: undefined,
      dimensions: { engagement: 80 },
      criteria: {},
    } as unknown as FunScoreReport;
    const comparison = compareFunReports(legacy, current);
    expect(comparison.cohort.matched).toBe(false);
    expect(comparison.dimensions.progression.status).toBe('unmeasured');
    expect(JSON.stringify(comparison)).not.toContain('NaN');
    expect(comparison.overall_fun_score.status).toBe('inconclusive');
  });
});
