import { describe, expect, it } from 'vitest';
import { resolveFloorTimerRemainingMs } from '../../src/engine/floor-timer-state.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('resolveFloorTimerRemainingMs', () => {
  it('uses the Floor 2 manifest 20-minute duration', () => {
    const world = createTestWorld({ floor: 2 });
    expect(resolveFloorTimerRemainingMs(world)).toBe(20 * 60 * 1000);

    world.elapsedMs = 90_000;
    expect(resolveFloorTimerRemainingMs(world)).toBe(18 * 60 * 1000 + 30_000);
  });
});
