import { describe, expect, it } from 'vitest';
import { collectHumanRunStats } from '../../src/game/ai/run-stats-collector.js';
import { assembleRunStats } from '../../src/shared/run-stats-collector.js';
import { createRunBundle } from '../../src/shared/run-bundle.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('run bundle contracts', () => {
  it('collects a stable human RunStats shape from a test world', () => {
    const world = createTestWorld({ seed: 7 });
    world.combatEvents.push({
      type: 'death',
      x: 0,
      y: 0,
      amount: 1,
      targetType: 'enemy',
      timestamp: 0,
      sourceEid: 0,
    });
    world.combatEvents.push({
      type: 'death',
      x: 0,
      y: 0,
      amount: 1,
      targetType: 'enemy',
      timestamp: 0,
      sourceEid: 999,
    });
    const stats = collectHumanRunStats(world, 0, 'quit', 3, {
      totalEvents: 4,
      totalSamples: 4,
      totalKills: 4,
      durationMs: 0,
      minHealthPercent: 0.1,
      closeCallCount: 2,
      lowHealthCount: 3,
      controller: 'MANUAL',
    });

    expect(stats.outcome).toBe('quit');
    expect(stats.combat.totalKills).toBe(1);
    expect(stats.health.minHealthPercent).toBe(0.1);
    expect(stats.health.closeCallCount).toBe(2);
    expect(stats.health.lowHealthCount).toBe(3);
    expect(stats.runStartXp).toBe(3);
    expect(stats.startingWeapon).toBe('unknown');
  });

  it('preserves the assembled RunStats values without pipeline-specific behavior', () => {
    const stats = {
      outcome: 'victory' as const,
      totalFrames: 12,
      nested: { kills: 3 },
    };
    expect(assembleRunStats(stats)).toEqual(stats);
    expect(assembleRunStats(stats)).not.toBe(stats);
  });

  it('copies recorder and log payloads into a bounded run artifact', () => {
    const logs = ['[info] game started'];
    const bundle = createRunBundle({
      runStats: { outcome: 'death' },
      recorderJsonl: '{"frame":1}\n',
      logs,
      meta: { endReason: 'death', floorId: 'floor1', seed: 7 },
    });
    logs.push('mutated');
    expect(bundle).toEqual({
      runStats: { outcome: 'death' },
      recorderJsonl: '{"frame":1}\n',
      logs: ['[info] game started'],
      meta: { endReason: 'death', floorId: 'floor1', seed: 7 },
    });
  });
});
