import { describe, expect, it } from 'vitest';
import { query } from 'bitecs';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { Enemy, FamilyMembership } from '../../src/core/components.js';

describe('Floor 2 headless completion', () => {
  it('reaches floor2-victory through the real headless objective tick path with auto-victory disabled', async () => {
    let seededBossDeaths = false;
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 77 }), {
      seed: 77,
      floorId: 'floor2',
      maxFrames: 180,
      simulationOptions: {
        preSystems: [
          (world) => {
            if (seededBossDeaths) {
              return;
            }
            // Disable manifest-assisted instant win so this run proves the
            // objective tick path, not autoVictoryOnStart.
            world.goalFlags.set('floor2-victory', false);

            const bossField = world.stores.familyMembership.isBoss;
            for (const eid of query(world.ecs, [Enemy, FamilyMembership])) {
              if ((bossField[eid] ?? 0) !== 1) {
                continue;
              }
              world.combatEvents.push({
                type: 'death',
                x: world.stores.position.x[eid] ?? 0,
                y: world.stores.position.y[eid] ?? 0,
                amount: world.stores.health.current[eid] ?? 0,
                targetType: 'enemy',
                timestamp: world.elapsedMs,
                targetEid: eid,
              });
            }
            seededBossDeaths = true;
          },
        ],
      },
    });

    expect(stats.outcome).toBe('victory');
  });
});
