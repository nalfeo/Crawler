import { describe, expect, it } from 'vitest';
import type { GameWorld } from '../../src/core/index.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';

describe('Floor 6 economy real headless pipeline', () => {
  it('collects ordinary loot and unlocks at least one run-scoped upgrade offer', async () => {
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 606 }), {
      floorId: 'floor6',
      seed: 606,
      maxFrames: 2000,
      maxWallTimeMs: 30_000,
      questStallFrames: 0,
    });

    expect(stats.combat.totalKills).toBeGreaterThan(0);
    expect(stats.lootEfficiency?.xpCollected).toBeGreaterThan(0);
    expect(stats.lootEfficiency?.goldCollected).toBeGreaterThan(0);
    expect(stats.floor6Defense?.buildCurrencyPickupsCollected).toBeGreaterThan(0);
    expect(stats.floor6Defense?.buildCurrencyBalance).toBeGreaterThanOrEqual(
      stats.floor6Defense?.upgradeOffers[0]?.cost ?? Number.POSITIVE_INFINITY,
    );
    expect(stats.floor6Defense?.unlockedOfferIds.length).toBeGreaterThanOrEqual(1);
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
    expect(first.floor6Defense?.buildCurrencySpent).toBeGreaterThanOrEqual(16);
    expect(first.floor6Defense).toEqual(second.floor6Defense);
  });
});
