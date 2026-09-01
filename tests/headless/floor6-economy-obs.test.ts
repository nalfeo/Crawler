import { describe, expect, it } from 'vitest';
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
    const config = {
      floorId: 'floor6',
      seed: 606,
      maxFrames: 2000,
      maxWallTimeMs: 30_000,
      questStallFrames: 0,
      floor6TowerBuildRequests: [{ siteId: 'plinth-west-a', towerId: 'signal-slinger' }],
    } as const;
    const first = await runHeadless(new BehaviorTreeAI({ seed: 606 }), config);
    const second = await runHeadless(new BehaviorTreeAI({ seed: 606 }), config);

    expect(first.floor6Defense?.towers).toEqual([
      { siteId: 'plinth-west-a', towerId: 'signal-slinger' },
    ]);
    expect(first.floor6Defense?.buildCurrencySpent).toBeGreaterThanOrEqual(4);
    expect(first.floor6Defense).toEqual(second.floor6Defense);
  });
});
