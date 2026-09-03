import { describe, expect, it } from 'vitest';
import type { GameWorld } from '../../src/core/index.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import type { Floor6DefenseRunStats } from '../../src/shared/floor-types.js';

function withoutObservedFrameCost(stats: Floor6DefenseRunStats | undefined) {
  if (!stats) return stats;
  return {
    ...stats,
    releaseGate: {
      ...stats.releaseGate,
      observedFrameCostMs: null,
    },
  };
}

describe('Floor 6 economy real headless pipeline', () => {
  it('collects loot, builds, upgrades, and fights through the real headless strategy', async () => {
    const createConfig = () =>
      ({
        floorId: 'floor6',
        seed: 606,
        maxFrames: 7000,
        maxWallTimeMs: 30_000,
        questStallFrames: 3000,
      }) as const;
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 606 }), createConfig());
    const replay = await runHeadless(new BehaviorTreeAI({ seed: 606 }), createConfig());

    expect(stats.combat.totalKills).toBeGreaterThan(0);
    expect(stats.lootEfficiency?.xpCollected).toBeGreaterThan(0);
    expect(stats.lootEfficiency?.goldCollected).toBeGreaterThan(0);
    expect(stats.outcome).toBe('victory');
    expect(stats.floor6Defense?.phase.kind).toBe('VICTORY');
    expect(stats.floor6Defense?.breaksEntered).toBe(2);
    expect(stats.floor6Defense?.breaksExited).toBe(2);
    expect(stats.floor6Defense?.hostileActivityDuringBreak).toBe(0);
    expect(stats.floor6Defense?.finaleBossDefeated).toBe(true);
    expect(stats.floor6Defense?.terminalOutcome).toBe('victory');
    expect(stats.floor6Defense?.terminalOutcomeCount).toBe(1);
    expect(stats.floor6Defense?.victoryPayoutCount).toBe(1);
    expect(stats.floor6Defense?.exitOpenCount).toBe(1);
    expect(stats.floor6Defense?.releaseGate.terminalIntegrity).toEqual({
      terminal: true,
      terminalOutcomeCount: 1,
      victoryPayoutCount: 1,
      exitOpenCount: 1,
    });
    expect(stats.floor6Defense?.releaseGate.cleanup.spawnDebt).toBe(0);
    expect(stats.floor6Defense?.releaseGate.phaseDurations.map((phase) => phase.kind)).toEqual([
      'DEFEND',
      'BREAK',
      'DEFEND',
      'BREAK',
      'DEFEND',
      'FINALE',
      'VICTORY',
    ]);
    expect(stats.floor6Defense?.releaseGate.routePressure).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeId: 'west-service-route',
          released: expect.any(Number),
          stalled: expect.any(Number),
        }),
      ]),
    );
    expect(stats.floor6Defense?.towersTornDown).toBeGreaterThanOrEqual(1);
    expect(stats.floor6Defense?.heroDamageDealt).toBeGreaterThan(0);
    expect(stats.floor6Defense?.towerDamageDealt).toBeGreaterThan(0);
    expect(stats.floor6Defense?.presentation.questGoals).toMatchObject({
      'floor6.defense.briefed': true,
      'floor6.defense.firstWaveCleared': true,
      'floor6.defense.firstBuildPlaced': true,
      'floor6.defense.firstUpgradeChosen': true,
      'floor6.defense.breakCleared': true,
      'floor6.defense.deadlineDefeated': true,
      'floor6.defense.relaySecured': true,
    });
    expect(stats.floor6Defense?.presentation.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ directionLabel: expect.stringMatching(/route/) }),
      ]),
    );
    expect(stats.floor6Defense?.presentation.buildSites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: expect.stringMatching(/VACANT|OCCUPIED/) }),
      ]),
    );
    expect(stats.floor6Defense?.presentation.breakSafetyLabel).toContain('Breaks cleared: 2');
    expect(stats.floor6Defense?.presentation.deadlineLabel).toContain('Deadline defeated');
    expect(stats.floor6Defense?.releaseGate.observedFrameCostMs).not.toBeNull();
    expect(withoutObservedFrameCost(stats.floor6Defense)).toEqual(
      withoutObservedFrameCost(replay.floor6Defense),
    );
  });

  it('executes deterministic tower requests through the real headless pipeline', async () => {
    const createConfig = () => {
      let towerFundingGranted = false;
      return {
        floorId: 'floor6',
        seed: 606,
        maxFrames: 2000,
        maxWallTimeMs: 30_000,
        questStallFrames: 0,
        simulationOptions: {
          preSystems: [
            (world: GameWorld): void => {
              const defense = world.floorExtendedState?.floor6Defense;
              if (towerFundingGranted || defense?.phase.kind !== 'DEFEND') return;
              defense.economy.balance += 16;
              defense.economy.totalEarned += 16;
              towerFundingGranted = true;
            },
          ],
        },
        floor6TowerBuildRequests: [
          { siteId: 'plinth-west-a', towerId: 'signal-slinger' },
          { siteId: 'plinth-west-b', towerId: 'relay-riveter' },
          { siteId: 'plinth-south-a', towerId: 'crane-caster' },
        ],
      } as const;
    };
    const first = await runHeadless(new BehaviorTreeAI({ seed: 606 }), createConfig());
    const second = await runHeadless(new BehaviorTreeAI({ seed: 606 }), createConfig());

    expect(first.floor6Defense?.towers).toEqual([
      { siteId: 'plinth-west-a', towerId: 'signal-slinger' },
      { siteId: 'plinth-west-b', towerId: 'relay-riveter' },
      { siteId: 'plinth-south-a', towerId: 'crane-caster' },
    ]);
    expect(first.floor6Defense?.buildCurrencySpent).toBeGreaterThanOrEqual(14);
    expect(first.floor6Defense?.releaseGate.observedFrameCostMs).not.toBeNull();
    expect(withoutObservedFrameCost(first.floor6Defense)).toEqual(
      withoutObservedFrameCost(second.floor6Defense),
    );
  });
});
