import { describe, expect, it } from 'vitest';
import type { GameWorld } from '../../src/core/world.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIState, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';
import {
  buildFloor6Tower,
  getFloor6TowerRoster,
  purchaseFloor6UpgradeOffer,
  upgradeFloor6Tower,
} from '../../src/game/floor6Scenario.js';
import type { InputState } from '../../src/shared/input.js';

class IdleFloor6Provider implements AIInputProvider {
  private readonly decision: AIDecision = {
    state: AIState.EXPLORE,
    targetEid: null,
    targetX: null,
    targetY: null,
    reason: 'floor6 tower observation',
    npcInteraction: null,
    debug: null,
  };

  poll(_input: InputState, _world: GameWorld): void {}

  getDecision(): AIDecision {
    return this.decision;
  }

  reset(): void {}
}

function installTowerDecisions(): (world: GameWorld) => void {
  let applied = false;
  return (world) => {
    const state = world.floorExtendedState?.floor6Defense;
    if (applied || state?.phase.kind !== 'DEFEND') return;
    applied = true;
    state.economy.balance = 999;
    state.economy.totalEarned = 999;
    for (const [index, tower] of getFloor6TowerRoster(world).entries()) {
      const site = state.towers.sites[index]!;
      expect(buildFloor6Tower(world, site.siteId, tower.id)).toEqual({ ok: true, reason: 'built' });
      for (const _upgrade of tower.upgrades) {
        expect(upgradeFloor6Tower(world, site.siteId)).toEqual({ ok: true, reason: 'upgraded' });
      }
    }
    for (const offer of state.upgradeOfferManifest ?? []) {
      expect(purchaseFloor6UpgradeOffer(world, offer.offerId)).toEqual({
        ok: true,
        reason: 'purchased',
      });
    }
  };
}

async function runTowerScenario() {
  return runHeadless(new IdleFloor6Provider(), {
    floorId: 'floor6',
    seed: 606,
    maxFrames: 420,
    maxWallTimeMs: 30_000,
    questStallFrames: 0,
    simulationOptions: {
      postSystems: [installTowerDecisions()],
    },
  });
}

describe('Floor 6 towers in the real headless pipeline', () => {
  it('builds every starter tower, applies upgrades, attacks, and replays the combat trace', async () => {
    const [first, second] = await Promise.all([runTowerScenario(), runTowerScenario()]);

    const towers = first.floor6Defense!.towers;
    expect(towers.towerManifest.map((tower) => tower.id)).toEqual([
      'spotlight-lancer',
      'cable-snare',
      'ratings-mortar',
    ]);
    expect(towers.builds).toBe(towers.towerManifest.length);
    expect(towers.upgrades).toBe(
      towers.towerManifest.reduce((sum, tower) => sum + tower.upgrades.length, 0),
    );
    expect(towers.appliedUpgradeOfferIds).toEqual(first.floor6Defense!.selectedOfferIds);
    expect(towers.combatTrace.length).toBeGreaterThan(0);
    expect(towers.activeEffectCount).toBeLessThanOrEqual(
      towers.towerManifest.reduce((sum, tower) => sum + tower.effectLimit, 0),
    );
    expect(towers.combatTrace).toEqual(second.floor6Defense!.towers.combatTrace);
  });
});
