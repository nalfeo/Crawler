import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { requireDefaultMaxFrames } from '../../src/game/ai/floor-run-budget.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { floor6Manifest } from '../../src/shared/floor-manifest.js';

const FLOOR6_RELEASE_SMOKE_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

describe('Floor 6 release gate headless telemetry', () => {
  it('intercepts the release-baseline seed 36 raider wave before the relay falls', async () => {
    const seed = 36;
    const stats = await runHeadless(new BehaviorTreeAI({ seed }), {
      floorId: 'floor6',
      seed,
      maxFrames: requireDefaultMaxFrames('floor6'),
      maxWallTimeMs: 30_000,
    });

    expect(stats.outcome).toBe('victory');
    expect(stats.floor6Defense?.terminalOutcome).toBe('victory');
    expect(stats.floor6Defense?.relayHp ?? 0).toBeGreaterThan(0);
    expect(stats.aiTelemetry?.decisionStateMs.ENGAGE ?? 0).toBeGreaterThan(
      stats.aiTelemetry?.decisionStateMs.EXPLORE ?? 0,
    );
  });

  it('meets the release-gate thresholds on the local 10-seed smoke panel', async () => {
    const maxFrames = requireDefaultMaxFrames('floor6');
    const runs = [];
    for (const seed of FLOOR6_RELEASE_SMOKE_SEEDS) {
      runs.push({
        seed,
        stats: await runHeadless(new BehaviorTreeAI({ seed }), {
          floorId: 'floor6',
          seed,
          maxFrames,
          maxWallTimeMs: 30_000,
        }),
      });
    }

    const gate = floor6Manifest.floor6?.releaseGate;
    if (!gate) throw new Error('Floor 6 release gate thresholds missing');

    const wins = runs.filter((run) => run.stats.outcome === 'victory');
    expect(wins.length / runs.length).toBeGreaterThanOrEqual(gate.completionRateTarget);

    for (const { seed, stats } of runs) {
      const defense = stats.floor6Defense;
      expect(defense, `seed ${seed} emitted Floor 6 telemetry`).toBeDefined();
      if (!defense) continue;
      const frameBudget = defense.releaseGate.frameBudget;
      if (frameBudget === null) throw new Error(`seed ${seed} missing Floor 6 frame budget`);

      expect(defense.releaseGate.terminalIntegrity.terminal, `seed ${seed} reached terminal`).toBe(
        true,
      );
      expect(
        defense.releaseGate.terminalIntegrity.terminalOutcomeCount,
        `seed ${seed} wrote one terminal outcome`,
      ).toBe(1);
      expect(
        defense.releaseGate.observedFrameCostMs,
        `seed ${seed} measured headless frame cost`,
      ).not.toBeNull();
      expect(
        defense.releaseGate.observedFrameCostMs ?? Number.POSITIVE_INFINITY,
        `seed ${seed} stayed under the frame-cost budget`,
      ).toBeLessThanOrEqual(defense.releaseGate.maxFrameCostMs);
      if (stats.outcome !== 'victory') {
        expect(defense.terminalOutcome, `seed ${seed} recorded a non-victory terminal`).toBe(
          'defeat',
        );
        expect(defense.releaseGate.terminalIntegrity.victoryPayoutCount).toBe(0);
        expect(defense.releaseGate.terminalIntegrity.exitOpenCount).toBe(0);
        continue;
      }
      expect(stats.totalFrames, `seed ${seed} stayed under the frame budget`).toBeLessThanOrEqual(
        frameBudget,
      );
      expect(defense.terminalOutcome).toBe('victory');
      expect(defense.releaseGate.terminalIntegrity).toEqual({
        terminal: true,
        terminalOutcomeCount: 1,
        victoryPayoutCount: 1,
        exitOpenCount: 1,
      });
      expect(defense.releaseGate.cleanup.liveEnemyCount).toBeLessThanOrEqual(gate.maxLiveEnemies);
      expect(defense.releaseGate.cleanup.spawnDebt).toBe(0);
      expect(defense.stalledCount).toBeLessThanOrEqual(gate.maxStalledRaiders);
      expect(defense.releaseGate.routePressure.every((route) => route.released > 0)).toBe(true);
      expect(defense.releaseGate.phaseDurations.map((duration) => duration.kind)).toEqual(
        expect.arrayContaining(['DEFEND', 'BREAK', 'FINALE', 'VICTORY']),
      );
      expect(defense.heroDamageDealt).toBeGreaterThan(0);
      expect(defense.towerDamageDealt).toBeGreaterThan(0);
      expect(defense.relayHp / defense.relayMaxHp).toBeGreaterThanOrEqual(
        gate.minimumRelayHealthPct,
      );
    }
  });
});
