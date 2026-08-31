import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import type { GameWorld } from '../../src/core/world.js';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIState, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';
import { getFloor6InitializationArtifact } from '../../src/game/floor6Scenario.js';
import type { InputState } from '../../src/shared/input.js';
import { createTestWorld } from '../helpers/world-factory.js';

class IdleFloor6Provider implements AIInputProvider {
  private readonly decision: AIDecision = {
    state: AIState.EXPLORE,
    targetEid: null,
    targetX: null,
    targetY: null,
    reason: 'floor6 foundation parity',
    npcInteraction: null,
    debug: null,
  };

  poll(_input: InputState, _world: GameWorld): void {}

  getDecision(): AIDecision {
    return this.decision;
  }

  reset(): void {}
}

describe('Floor 6 foundation real-pipeline parity', () => {
  it('loads byte-equivalent map and phase artifacts in windowed and headless initialization', async () => {
    const windowedWorld = createTestWorld({ seed: 606 });
    const untouchedWorld = createTestWorld({ seed: 606 });
    const player = spawnPlayer(windowedWorld, 0, 0);
    createFloorMainSceneOptions('floor6').configureWorld!(windowedWorld, player);
    const windowedArtifact = getFloor6InitializationArtifact(windowedWorld);

    let headlessArtifact: ReturnType<typeof getFloor6InitializationArtifact> = null;
    await runHeadless(new IdleFloor6Provider(), {
      floorId: 'floor6',
      seed: 606,
      maxFrames: 0,
      questStallFrames: 0,
      onFinish: (world) => {
        headlessArtifact = getFloor6InitializationArtifact(world);
      },
    });

    expect(windowedArtifact?.phase).toEqual({ kind: 'SETUP' });
    expect(windowedArtifact?.phaseTrace).toEqual([]);
    expect(windowedArtifact?.rngStreamKeys).toEqual({
      waves: '606:floor6:waves',
      routes: '606:floor6:routes',
      rewards: '606:floor6:rewards',
      upgrades: '606:floor6:upgrades',
      dressing: '606:floor6:dressing',
      bosses: '606:floor6:bosses',
    });
    expect(JSON.stringify(headlessArtifact)).toBe(JSON.stringify(windowedArtifact));
    expect(windowedWorld.rng.next()).toBe(untouchedWorld.rng.next());
  });
});
