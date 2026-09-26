import { describe, expect, it } from 'vitest';
import {
  compareFunReports,
  scoreFunSessions,
  type FunSession,
} from '../../scripts/agent/health/fun-score-lib.js';
import { makeExperienceRun } from '../fixtures/experience-evaluation.js';

// Paired synthetic evidence tests sensitivity to defined mechanics, not enjoyment.
// Keep seed, floor, starter, preset, outcome and duration identical within each pair.
function baseline(): FunSession {
  const run = makeExperienceRun();
  run.rewardEvents = {
    activeDurationMs: run.gameTimeMs,
    events: [80_000, 160_000, 240_000].map((time, index) => ({
      kind: 'rare_loot' as const,
      sourceId: `fixture-loot-${index}`,
      activeTimeMs: time,
      gameTimeMs: time,
    })),
  };
  run.itemInteractions = {
    items: [
      {
        catalogKey: 'fixture-spell',
        kind: 'spell',
        offeredCount: 5,
        selectableExposureCount: 5,
        selectionCount: 1,
        activationCount: 10,
        activeTimeMs: 100_000,
      },
    ],
    uniqueActivationCount: 10,
    dominantActivationCount: 10,
  };
  return { id: 'synthetic-baseline', scenario: 'controlled-diagnostics-v2', run };
}

function paired(mutate: (candidate: FunSession['run']) => void) {
  const before = baseline();
  const after = { ...structuredClone(before), id: 'synthetic-candidate' };
  mutate(after.run);
  const previous = scoreFunSessions([before]);
  const next = scoreFunSessions([after]);
  const comparison = compareFunReports(previous, next);
  expect(comparison.cohort.matched).toBe(true);
  expect(next.runs).toBe(previous.runs);
  expect(after.run.outcome).toBe(before.run.outcome);
  expect(after.run.gameTimeMs).toBe(before.run.gameTimeMs);
  expect(next.confidence).toBeNull();
  return { previous, next, comparison };
}

describe('controlled experience diagnostic regressions', () => {
  it('detects sparse reward timing even when reward count is unchanged', () => {
    const { previous, next, comparison } = paired((run) => {
      run.rewardEvents = {
        ...run.rewardEvents!,
        events: run.rewardEvents!.events.map((event, index) => ({
          ...event,
          activeTimeMs: 10_000 + index * 10_000,
          gameTimeMs: 10_000 + index * 10_000,
        })),
      };
    });
    expect(previous.criteria.reward_cadence.observed).toBe(80);
    expect(next.criteria.reward_cadence.observed).toBe(290);
    expect(comparison.criteria.reward_cadence.delta).toBeGreaterThan(0);
    expect(comparison.criteria.reward_cadence.status).toBe('degrading');
    // Reward timing is a separate criterion, not an invented composite input.
    expect(next.dimensions).toEqual(previous.dimensions);
  });

  it('detects wasted movement without fabricating unsafe threat exposure', () => {
    const { previous, next, comparison } = paired((run) => {
      run.movementQuality = {
        ...run.movementQuality!,
        stuckMs: 32_000,
        stuckPct: 10,
      };
    });
    expect(comparison.dimensions.pacing.status).toBe('degrading');
    expect(next.dimensions.progression).toBe(previous.dimensions.progression);
    expect(next.criteria.unsafe_combat_uptime.observed).toBeNull();
  });

  it('detects reduced acquired progression with reward timing held fixed', () => {
    const { previous, next, comparison } = paired((run) => {
      run.finalLevel = 4;
      run.totalXp = 500;
    });
    expect(comparison.dimensions.progression.status).toBe('degrading');
    expect(next.criteria.reward_cadence).toEqual(previous.criteria.reward_cadence);
    expect(next.dimensions.pacing).toBe(previous.dimensions.pacing);
  });

  it('detects selected-but-inert items without claiming choice depth or build variety', () => {
    const { previous, next, comparison } = paired((run) => {
      run.itemInteractions = {
        ...run.itemInteractions!,
        uniqueActivationCount: 0,
        dominantActivationCount: 0,
        items: run.itemInteractions!.items.map((item) => ({
          ...item,
          activationCount: 0,
          activeTimeMs: 0,
        })),
      };
    });
    expect(previous.criteria.item_viability.observed).toBe(0);
    expect(next.criteria.item_viability.observed).toBe(1);
    expect(comparison.criteria.item_viability.delta).toBe(1);
    expect(comparison.criteria.item_viability.status).toBe('degrading');
    expect(next.dimensions.choice_depth).toBeNull();
    expect(next.dimensions.run_distinctness).toBeNull();
  });

  it('distinguishes missing evidence from observed zero and fails required coverage', () => {
    const { next, comparison } = paired((run) => {
      run.rewardEvents = undefined;
      run.itemInteractions = undefined;
      run.movementQuality = undefined;
      run.runStartLevel = undefined;
    });
    expect(next.criteria.reward_cadence.observed).toBeNull();
    expect(next.criteria.item_viability.observed).toBeNull();
    expect(next.dimensions.pacing).toBeNull();
    expect(next.dimensions.progression).toBeNull();
    expect(next.gate.pass).toBe(false);
    expect(comparison.dimensions.progression.status).toBe('unmeasured');
    expect(comparison.criteria.reward_cadence.status).toBe('unmeasured');
  });

  it('does not turn repeated reward records into better cadence', () => {
    const { previous, next } = paired((run) => {
      run.rewardEvents = {
        ...run.rewardEvents!,
        events: [...run.rewardEvents!.events, ...run.rewardEvents!.events],
      };
    });
    expect(next.criteria.reward_cadence).toEqual(previous.criteria.reward_cadence);
  });

  it.each(['starter', 'count', 'duplicate', 'scenario', 'seed'] as const)(
    'rejects apparent improvement from an unmatched %s',
    (confound) => {
      const before = baseline();
      before.run.totalXp = 100;
      before.run.finalLevel = 4;
      const after = {
        ...baseline(),
        scenario: confound === 'scenario' ? 'another-experiment' : before.scenario,
      };
      if (confound === 'starter') after.run.startingWeapon = 'bow';
      if (confound === 'seed') after.run.evaluationContext!.seed = 43;
      const previous = scoreFunSessions(confound === 'duplicate' ? [before, before] : [before]);
      const next = scoreFunSessions(
        confound === 'count' || confound === 'duplicate' ? [after, after] : [after],
      );
      const comparison = compareFunReports(previous, next);
      expect(next.dimensions.progression!).toBeGreaterThan(previous.dimensions.progression!);
      expect(comparison.cohort.matched).toBe(false);
      expect(comparison.dimensions.progression.status).toBe('inconclusive');
      expect(comparison.overall_fun_score.status).toBe('inconclusive');
      expect(next.confidence).toBeNull();
    },
  );
});
