import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Companion, Player, Team } from '../../src/core/index.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';

describe('Floor 3 field Trainer circuit in the headless pipeline', () => {
  it('requires travel before the first authored rival team enters automatic combat', async () => {
    let movedToTrainer = false;
    let observed: { started: boolean; rosterCount: number; secondStarted: boolean } | null = null;

    await runHeadless(new BehaviorTreeAI({ seed: 616 }), {
      seed: 616,
      floorId: 'floor3',
      maxFrames: 120,
      questStallFrames: 0,
      stopWhen: (world) => {
        const state = world.floorExtendedState?.floor3Studios;
        const trainer = state?.fieldTrainers?.[0];
        if (!trainer) return false;
        if (!movedToTrainer) {
          const player = query(world.ecs, [Player])[0];
          if (player === undefined) return false;
          // The only injected intent is locomotion to the visible Trainer.
          // The subsequent rival spawn and combat are scenario-owned.
          world.stores.position.x[player] = trainer.x;
          world.stores.position.y[player] = trainer.y;
          movedToTrainer = true;
          return false;
        }
        const rosterCount = query(world.ecs, [Companion, Team]).filter(
          (eid) => (world.stores.team.id[eid] ?? -1) === trainer.teamId,
        ).length;
        observed = {
          started: trainer.started,
          rosterCount,
          secondStarted: state?.fieldTrainers?.[1]?.started ?? false,
        };
        return trainer.started && rosterCount > 0;
      },
    });

    expect(movedToTrainer).toBe(true);
    expect(observed).toEqual({ started: true, rosterCount: 2, secondStarted: false });
  });
});
