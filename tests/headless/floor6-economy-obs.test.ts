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
});
