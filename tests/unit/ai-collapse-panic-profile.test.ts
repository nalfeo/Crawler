import { describe, expect, it } from 'vitest';
import {
  computeCollapsePanicProfile,
  resolveFloor1AiCollapsePanicDeadlineMs,
} from '../../src/game/ai/bt-ai-provider.js';

describe('computeCollapsePanicProfile', () => {
  it('returns neutral pressure when floor-collapse context is absent', () => {
    expect(computeCollapsePanicProfile(null)).toEqual({
      remainingMs: null,
      panic: 0,
      beeline: false,
      stairsUnlocked: true,
      travelBeelineActive: false,
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

  it('anchors Floor 1 AI panic to the 10-minute floor-collapse deadline', () => {
    const aiDeadlineMs = resolveFloor1AiCollapsePanicDeadlineMs(600_000);
    expect(aiDeadlineMs).toBe(10 * 60 * 1000);

    const pressure = computeCollapsePanicProfile({
      elapsedMs: 10 * 60 * 1000 - 55_000,
      deadlineMs: aiDeadlineMs,
      staircaseUnlocked: false,
      staircaseDiscovered: false,
    });

    expect(pressure.remainingMs).toBe(55_000);
    expect(pressure.beeline).toBe(true);
  });

  describe('travel-time beeline threshold escalation', () => {
    it('escalates beeline threshold above the fixed 60s when travel time is high', () => {
      // Post-boss regression: 63s remaining, staircase unlocked but not yet
      // discovered, A* says the run needs ~70s of travel. The legacy fixed 60s
      // threshold would leave beeline false (63s > 60s) and let the AI keep
      // taking XP/farm detours until it's physically impossible to reach the
      // stairs. With the travel-derived escalation (70s + 5s safety = 75s)
      // the threshold rises to max(60_000, 75_000) → 75_000, so 63s remaining
      // now falls below the threshold and the beeline fires early — well
      // before the AI runs out of time to reach the stairs.
      const withHighTravel = computeCollapsePanicProfile({
        elapsedMs: 297_000,
        deadlineMs: 360_000,
        staircaseUnlocked: true,
        staircaseDiscovered: false,
        playerToStairsTravelMs: 70_000,
      });
      expect(withHighTravel.remainingMs).toBe(63_000);
      expect(withHighTravel.beeline).toBe(true);
      expect(withHighTravel.travelBeelineActive).toBe(true);
    });

    it('does NOT escalate before the staircase is unlocked (early prerequisite protection)', () => {
      // Same remaining/travel as above but staircase still locked → the AI
      // should still be working on prerequisites (quests, bosses), so we must
      // NOT fire the travel beeline and starve XP/gold progression.
      const stillLocked = computeCollapsePanicProfile({
        elapsedMs: 297_000,
        deadlineMs: 360_000,
        staircaseUnlocked: false,
        staircaseDiscovered: false,
        playerToStairsTravelMs: 70_000,
      });
      expect(stillLocked.remainingMs).toBe(63_000);
      expect(stillLocked.beeline).toBe(false);
      expect(stillLocked.travelBeelineActive).toBe(false);
    });

    it('does NOT escalate once the staircase has been discovered', () => {
      // After discovery the base BT already commits to the stairs — the
      // travel threshold is moot and must not override the discovered branch.
      const discovered = computeCollapsePanicProfile({
        elapsedMs: 297_000,
        deadlineMs: 360_000,
        staircaseUnlocked: true,
        staircaseDiscovered: true,
        playerToStairsTravelMs: 70_000,
      });
      expect(discovered.beeline).toBe(false);
      expect(discovered.travelBeelineActive).toBe(false);
    });

    it('ignores non-finite / negative travel-time inputs (defensive)', () => {
      const nan = computeCollapsePanicProfile({
        elapsedMs: 100_000,
        deadlineMs: 300_000,
        staircaseUnlocked: true,
        staircaseDiscovered: false,
        playerToStairsTravelMs: Number.NaN,
      });
      const inf = computeCollapsePanicProfile({
        elapsedMs: 100_000,
        deadlineMs: 300_000,
        staircaseUnlocked: true,
        staircaseDiscovered: false,
        playerToStairsTravelMs: Number.POSITIVE_INFINITY,
      });
      const neg = computeCollapsePanicProfile({
        elapsedMs: 100_000,
        deadlineMs: 300_000,
        staircaseUnlocked: true,
        staircaseDiscovered: false,
        playerToStairsTravelMs: -500,
      });
      // 200_000 ms remaining → beeline false regardless; travelBeelineActive
      // must also be false for all three since inputs were rejected.
      for (const profile of [nan, inf, neg]) {
        expect(profile.beeline).toBe(false);
        expect(profile.travelBeelineActive).toBe(false);
      }
    });

    it('does NOT flip travelBeelineActive when the travel estimate is below 60s', () => {
      // Travel estimate is small (5s + 5s safety = 10s), which does not raise
      // the beeline threshold above the fixed 60s floor. The eventual beeline
      // must therefore be attributed to the legacy remaining-time path.
      const pressure = computeCollapsePanicProfile({
        elapsedMs: 259_000,
        deadlineMs: 300_000,
        staircaseUnlocked: true,
        staircaseDiscovered: false,
        playerToStairsTravelMs: 5_000,
      });
      expect(pressure.remainingMs).toBe(41_000);
      expect(pressure.beeline).toBe(true);
      expect(pressure.travelBeelineActive).toBe(false);
    });

    it('preserves legacy behavior when playerToStairsTravelMs is omitted', () => {
      // No optional field → identical to the pre-existing behavior tested
      // above (60s remaining → beeline).
      const pressure = computeCollapsePanicProfile({
        elapsedMs: 240_000,
        deadlineMs: 300_000,
        staircaseUnlocked: true,
        staircaseDiscovered: false,
      });
      expect(pressure.beeline).toBe(true);
      expect(pressure.travelBeelineActive).toBe(false);
    });
  });
});
