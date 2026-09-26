import { describe, expect, it, vi } from 'vitest';
import { query } from 'bitecs';
import { Player } from '../../../src/core/index.js';
import { spawnPlayer } from '../../../src/core/helpers.js';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import { collectHumanRunStats } from '../../../src/game/ai/run-stats-collector.js';
import { createTestWorld } from '../../helpers/world-factory.js';

describe('evaluation measurement coverage', () => {
  it('keeps human placeholder zeros distinguishable from measured observations', () => {
    const world = createTestWorld({ seed: 23 });
    world.floorId = 'floor2';
    const player = spawnPlayer(world, 0, 0);
    const stats = collectHumanRunStats(world, player, 'quit');

    expect(stats.combat.combatTimeMs).toBe(0);
    expect(stats.levelUps).toEqual([]);
    expect(stats.quests.questsCompleted).toBe(0);
    expect(stats.evaluationContext).toEqual({
      source: 'human',
      seed: 23,
      startFloor: 'floor2',
      available: { combat: false, health: false, progression: false, quests: false },
    });
  });

  it('requires all recorded health observations, while accepting measured zero counts', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const recorder = {
      totalEvents: 1,
      totalSamples: 1,
      totalKills: 0,
      durationMs: 16,
      controller: 'MANUAL' as const,
      minHealthPercent: 1,
      closeCallCount: 0,
      lowHealthCount: 0,
    };
    expect(
      collectHumanRunStats(world, player, 'quit', 0, recorder).evaluationContext?.available.health,
    ).toBe(true);
    const { lowHealthCount: _missing, ...incomplete } = recorder;
    expect(
      collectHumanRunStats(world, player, 'quit', 0, incomplete).evaluationContext?.available
        .health,
    ).toBe(false);
  });

  it('emits original seed/scenario and measured counters from the real headless pipeline', async () => {
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 7 }), {
      seed: 7,
      floorId: 'floor1',
      maxFrames: 1,
    });
    expect(stats.outcome).not.toBe('error');
    expect(stats.levelUps).toEqual([]);
    expect(stats.evaluationContext).toEqual({
      source: 'headless',
      seed: 7,
      startFloor: 'floor1',
      available: { combat: true, health: true, progression: true, quests: true },
    });
  });

  it('does not count a seeded advanced starting level as earned progression', async () => {
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 7 }), {
      seed: 7,
      floorId: 'floor1',
      startPlayerLevel: 8,
      maxFrames: 1,
    });
    expect(stats.outcome).not.toBe('error');
    expect(stats.finalLevel).toBe(8);
    expect(stats.levelUps).toEqual([]);
  });

  it('preserves provenance but marks interrupted observations unavailable on failure', async () => {
    const ai = new BehaviorTreeAI({ seed: 9 });
    vi.spyOn(ai, 'poll').mockImplementation(() => {
      throw new Error('test collection interruption');
    });
    const stats = await runHeadless(ai, { seed: 9, floorId: 'floor1', maxFrames: 1 });
    expect(stats.outcome).toBe('error');
    expect(stats.evaluationContext).toEqual({
      source: 'headless',
      seed: 9,
      startFloor: 'floor1',
      available: { combat: false, health: false, progression: false, quests: false },
    });
  });

  it('samples health against the current maximum after an in-run maximum change', async () => {
    let samples = 0;
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 7 }), {
      seed: 7,
      maxFrames: 2,
      simulationOptions: {
        postSystems: [
          (world) => {
            const player = query(world.ecs, [Player])[0]!;
            samples += 1;
            world.stores.health.max[player] = samples === 1 ? 200 : 400;
            world.stores.health.current[player] = samples === 1 ? 60 : 300;
          },
        ],
      },
    });
    expect(stats.outcome).not.toBe('error');
    expect(samples).toBe(2);
    expect(stats.health.minHealthPercent).toBeCloseTo(0.3);
    expect(stats.health.finalHealthPercent).toBeCloseTo(0.75);
    expect(stats.health.lowHealthCount).toBe(1);
    expect(stats.evaluationContext?.available.health).toBe(true);
  });

  it('marks a zero-maximum health observation unavailable', async () => {
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 7 }), {
      seed: 7,
      maxFrames: 1,
      simulationOptions: {
        postSystems: [
          (world) => {
            const player = query(world.ecs, [Player])[0]!;
            world.stores.health.max[player] = 0;
          },
        ],
      },
    });
    expect(stats.outcome).not.toBe('error');
    expect(stats.evaluationContext?.available.health).toBe(false);
  });
});
