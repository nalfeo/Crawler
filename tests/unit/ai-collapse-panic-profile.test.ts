import { describe, expect, it } from 'vitest';
import { computeCollapsePanicProfile } from '../../src/game/ai/bt-ai-provider.js';

describe('computeCollapsePanicProfile', () => {
  it('returns neutral pressure when floor-collapse context is absent', () => {
    expect(computeCollapsePanicProfile(null)).toEqual({
      remainingMs: null,
      panic: 0,
      beeline: false,
      stairsUnlocked: true,
    });
  });

  it('ramps panic up as time runs out and boosts it before stairs unlock', () => {
    const unlocked = computeCollapsePanicProfile({
      elapsedMs: 180_000,
      deadlineMs: 300_000,
      staircaseUnlocked: true,
      staircaseDiscovered: false,
    });
    const locked = computeCollapsePanicProfile({
      elapsedMs: 180_000,
      deadlineMs: 300_000,
      staircaseUnlocked: false,
      staircaseDiscovered: false,
    });

    expect(unlocked.panic).toBeCloseTo(0.5, 3);
    expect(locked.panic).toBeGreaterThan(unlocked.panic);
    expect(locked.panic).toBeLessThanOrEqual(1);
  });

  it('starts panic ramp at exactly 180s remaining', () => {
    const pressure = computeCollapsePanicProfile({
      elapsedMs: 120_000,
      deadlineMs: 300_000,
      staircaseUnlocked: false,
      staircaseDiscovered: false,
    });
    expect(pressure.remainingMs).toBe(180_000);
    expect(pressure.panic).toBe(0);
    expect(pressure.beeline).toBe(false);
  });

  it('hits hard beeline threshold at exactly 60s remaining', () => {
    const pressure = computeCollapsePanicProfile({
      elapsedMs: 240_000,
      deadlineMs: 300_000,
      staircaseUnlocked: true,
      staircaseDiscovered: false,
    });
    expect(pressure.remainingMs).toBe(60_000);
    expect(pressure.beeline).toBe(true);
  });

  it('enters hard beeline under 60s unless stairs are already discovered', () => {
    const pressure = computeCollapsePanicProfile({
      elapsedMs: 250_000,
      deadlineMs: 300_000,
      staircaseUnlocked: false,
      staircaseDiscovered: false,
    });
    expect(pressure.beeline).toBe(true);

    const discovered = computeCollapsePanicProfile({
      elapsedMs: 250_000,
      deadlineMs: 300_000,
      staircaseUnlocked: true,
      staircaseDiscovered: true,
    });
    expect(discovered.beeline).toBe(false);
  });
});
