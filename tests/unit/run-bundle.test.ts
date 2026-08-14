import { describe, expect, it } from 'vitest';
import { assembleRunStats } from '../../src/shared/run-stats-collector.js';
import { createRunBundle } from '../../src/shared/run-bundle.js';

describe('run bundle contracts', () => {
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
