import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { getEquipmentState } from '../../src/core/systems/equipmentSystem.js';
import { MERCHANTS_CHARM_DEF } from '../../src/shared/equipmentDefs.js';
import { setGoalFlag } from '../../src/core/door-lock.js';
import { FLOOR2_VICTORY_GOAL_ID } from '../../src/game/floor2Scenario.js';

describe('Floor 2 headless completion', () => {
  it('starts direct Floor 2 headless runs at level 5 with the charm equipped', async () => {
    let observedLevel = -1;
    let observedUnspent = -1;
    let observedCharmId: string | undefined;

    const stats = await runHeadless(new BehaviorTreeAI({ seed: 91 }), {
      seed: 91,
      floorId: 'floor2',
      maxFrames: 1,
      onFinish: (world) => {
        observedLevel = world.playerLevel.level;
        observedUnspent = world.playerLevel.unspentPoints;
        const playerEid = 1;
        const equipment = getEquipmentState(world, playerEid);
        const neckInstanceId = equipment?.equipped.neck ?? null;
        observedCharmId =
          neckInstanceId === null ? undefined : equipment?.instances.get(neckInstanceId)?.def.id;
      },
    });

    expect(observedLevel).toBe(5);
    expect(observedUnspent).toBe(0);
    expect(observedCharmId).toBe(MERCHANTS_CHARM_DEF.id);
    expect(Object.keys(stats.familyTrashKills ?? {}).length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(stats.familyTrashKills ?? {}).length).toBeLessThanOrEqual(4);
    expect(Object.values(stats.familyTrashKills ?? {}).every((count) => count === 0)).toBe(true);
  });

  it('exercises floor 2 den-progress and boss-targeting flow without win gating', async () => {
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 77 }), {
      seed: 77,
      floorId: 'floor2',
      maxFrames: 20000,
    });

    expect(['victory', 'timeout', 'death']).toContain(stats.outcome);
    expect(stats.aiTelemetry?.decisionStateCounts.ENGAGE ?? 0).toBeGreaterThan(0);
    expect(stats.aiTelemetry?.decisionStateCounts.EXPLORE ?? 0).toBeGreaterThan(0);
    expect(
      Object.keys(stats.quests.questLogAccepts).some((questId) =>
        questId.startsWith('floor2-den-'),
      ),
    ).toBe(true);
    expect(stats.familyTrashKills).toBeDefined();
  }, 300_000);

  it('does not treat floor2-victory alone as headless completion before exit', async () => {
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 123 }), {
      seed: 123,
      floorId: 'floor2',
      maxFrames: 1,
      simulationOptions: {
        postSystems: [
          (world) => {
            setGoalFlag(world, FLOOR2_VICTORY_GOAL_ID, true);
          },
        ],
      },
    });

    expect(stats.outcome).toBe('timeout');
  });

  it('confirms Floor 2 stairs headlessly once the exit is reachable', async () => {
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 124 }), {
      seed: 124,
      floorId: 'floor2',
      maxFrames: 1,
      simulationOptions: {
        postSystems: [
          (world) => {
            const floor2State = world.floorExtendedState?.familyState;
            if (!floor2State) {
              return;
            }
            const playerEid = 1;
            floor2State.staircaseUnlocked = true;
            floor2State.staircaseSpawned = true;
            floor2State.staircasePos = {
              x: world.stores.position.x[playerEid] ?? 0,
              y: world.stores.position.y[playerEid] ?? 0,
            };
            setGoalFlag(world, FLOOR2_VICTORY_GOAL_ID, true);
          },
        ],
      },
    });

    expect(stats.outcome).toBe('victory');
  });
});
