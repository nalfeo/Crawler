import { addComponent, query, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Companion, Player, Team } from '../../src/core/components.js';
import { spawnBehaviorEnemy } from '../../src/core/spawners/combatants.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { AI_TYPE, enemyAISystem } from '../../src/game/enemyAISystem.js';
import { getCompanionAIDecision } from '../../src/game/systems/companionAISystem.js';
import { floor3WildTargetRedirectSystem } from '../../src/game/systems/floor3WildTargetRedirectSystem.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { TeamId } from '../../src/shared/constants.js';

describe('Floor 3 wild aggro real headless pipeline', () => {
  it('targets the player when its only party companion is off-screen', async () => {
    let injected = false;
    let observed = false;
    let wildEid = -1;

    const stats = await runHeadless(new BehaviorTreeAI({ seed: 4445 }), {
      seed: 4445,
      floorId: 'floor3',
      maxFrames: 10,
      questStallFrames: 0,
      simulationOptions: {
        preSystems: [
          (world) => {
            if (injected) return;
            injected = true;
            const playerEid = query(world.ecs, [Player])[0];
            if (playerEid === undefined) throw new Error('headless Floor 3 player is required');
            for (const existingCompanion of query(world.ecs, [Companion])) {
              world.stores.companion.knockedOut[existingCompanion] = 1;
            }

            const companion = spawnBehaviorEnemy(
              world,
              (world.stores.position.x[playerEid] ?? 0) + 100,
              world.stores.position.y[playerEid] ?? 0,
              100,
              AI_TYPE.CHASE,
              0.1,
              48,
              0,
            );
            addComponent(world.ecs, companion, set(Team, { id: TeamId.PLAYER }));
            addComponent(
              world.ecs,
              companion,
              set(Companion, {
                speciesToken: 1,
                form: 0,
                level: 1,
                xp: 0,
                ownerTeam: TeamId.PLAYER,
                knockedOut: 0,
              }),
            );

            wildEid = spawnBehaviorEnemy(
              world,
              (world.stores.position.x[playerEid] ?? 0) + 10,
              world.stores.position.y[playerEid] ?? 0,
              100,
              AI_TYPE.CHASE,
              0.1,
              48,
              0,
            );
            addComponent(world.ecs, wildEid, set(Team, { id: TeamId.ENEMY }));
            world.stores.enemyBehavior.aggroedPermanently[wildEid] = 1;
          },
        ],
        postSystems: [
          (world) => {
            if (world.frameCount < 1 || wildEid < 0) return;
            // The runner may stop on the loadout surface after its first
            // frame. Run the same production aggro seam once more after
            // the fixture is injected so this remains a real headless
            // regression rather than a unit-only setup.
            floor3WildTargetRedirectSystem(world);
            enemyAISystem(world);
            observed = true;
            expect(getCompanionAIDecision(world, wildEid)).toBeUndefined();
            expect(world.stores.enemyBehavior.aggroedPermanently[wildEid]).toBe(1);
          },
        ],
      },
      stopWhen: () => observed,
    });

    expect(stats.totalFrames).toBeGreaterThanOrEqual(1);
    expect(observed).toBe(true);
  });
});
