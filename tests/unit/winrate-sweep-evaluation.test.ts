import { describe, expect, it, vi } from 'vitest';
import * as progressionRunner from '../../src/game/ai/progression-runner.js';
import { runSweepTask } from '../../scripts/agent/perf/winrate-sweep.js';
import {
  compareFunReports,
  normalizeFunSessions,
  scoreFunSessions,
} from '../../scripts/agent/health/fun-score-lib.js';

describe('release sweep evaluation identity', () => {
  it.each([false, true])('attributes the real production preset (chain=%s)', async (chain) => {
    const result = await runSweepTask(
      { weapon: 'sword', seed: 7 },
      {
        maxFrames: 1,
        maxFramesExplicit: true,
        enemyDamageMultiplier: 1,
        floorId: 'floor1',
        skipEvents: true,
        forceWeapon: true,
        chain,
      },
    );
    expect(result.stats.playerPersona).toBe('experienced_player');
    expect(result.stats.evaluationContext).toMatchObject({
      source: 'headless',
      seed: 7,
      startFloor: 'floor1',
    });
    const report = scoreFunSessions(normalizeFunSessions([result.stats]));
    expect(report.evidence.unidentified_runs).toBe(0);
    expect(compareFunReports(report, report).cohort.matched).toBe(true);
  });

  it('does not treat final-leg counters divided by chain time as full-chain observations', async () => {
    const config = {
      maxFrames: 1,
      maxFramesExplicit: true,
      enemyDamageMultiplier: 1,
      floorId: 'floor1',
      skipEvents: true,
      forceWeapon: true,
      chain: false,
    };
    const first = await runSweepTask({ weapon: 'sword', seed: 7 }, config);
    const last = {
      ...first.stats,
      finalFloor: 2,
      evaluationContext: { ...first.stats.evaluationContext!, startFloor: 'floor2' },
    };
    const spy = vi.spyOn(progressionRunner, 'runProgression').mockResolvedValueOnce({
      legs: [
        { floorId: 'floor1', stats: first.stats },
        { floorId: 'floor2', stats: last },
      ],
      clearedFloorIds: ['floor1'],
      winnableFloorIds: ['floor1', 'floor2'],
      exhibitionFloorIds: [],
      finalFloorId: 'floor2',
      reachedFinalVictory: false,
      totalGameTimeMs: 32,
      totalSafeRoomMs: 0,
      totalActiveTimeMs: 32,
      totalFrames: 2,
      totalWallTimeMs: 1,
      budgetMs: null,
      officialWin: false,
    });
    try {
      const chain = await runSweepTask({ weapon: 'sword', seed: 7 }, { ...config, chain: true });
      expect(chain.stats.evaluationContext).toMatchObject({
        seed: 7,
        startFloor: 'floor1',
        available: { combat: false, health: false, progression: false, quests: false },
      });
      const report = scoreFunSessions(normalizeFunSessions([chain.stats]));
      expect(report.evidence.unidentified_runs).toBe(0);
      expect(report.overall_fun_score).toBeNull();
      expect(report.gate.pass).toBe(false);
      expect(report.criteria.reward_cadence.status).toBe('unmeasured');
      expect(report.criteria.item_viability.status).toBe('unmeasured');
    } finally {
      spy.mockRestore();
    }
  });
});
