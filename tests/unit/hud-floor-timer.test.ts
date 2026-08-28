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

  it('holds the countdown steady while a safe room banks timer credit', () => {
    // Issue #3674: the HUD must read the same credited deadline the floor
    // collapses on, or the displayed countdown keeps falling inside a safe room
    // that has already stopped the timer.
    const world = createTestWorld({ floor: 2 });
    world.elapsedMs = 90_000;
    world.safeRoomTimerCreditMs = 30_000;

    expect(resolveFloorTimerRemainingMs(world)).toBe(19 * 60 * 1000);
  });
});
