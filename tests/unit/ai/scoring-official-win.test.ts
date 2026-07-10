import { describe, expect, it } from 'vitest';
import { activeTimeMs, isOfficialWin, SAFE_ROOM_FLAG_MS } from '../../../src/game/ai/scoring.js';
import { GAME } from '../../../src/shared/constants.js';

/**
 * Regression suite for the safe-room win-definition fix.
 *
 * The floor-collapse deadline PAUSES while the player rests in a safe room, so a
 * Floor-1 clear that exceeds the 6-minute budget in raw game time can still be a
 * legitimate win once the paused safe-room dwell is credited. The sweep used to
 * classify wins on RAW `gameTimeMs`, wrongly downgrading such victories to
 * timeouts. `isOfficialWin` (via `activeTimeMs`) is the single source of truth
 * that credits safe-room time to match the game's own deadline pause.
 */

const BUDGET_MS = 6 * 60 * 1000; // 360_000 — the Floor-1 AI time budget

describe('activeTimeMs', () => {
  it('subtracts safe-room dwell from raw game time', () => {
    expect(activeTimeMs({ gameTimeMs: 380_000, safeRoomMs: 40_000 })).toBe(340_000);
  });

  it('coalesces a missing safeRoomMs to raw game time (stale-artifact safety)', () => {
    expect(activeTimeMs({ gameTimeMs: 300_000 })).toBe(300_000);
  });

  it('clamps at 0 when safe-room dwell exceeds game time', () => {
    expect(activeTimeMs({ gameTimeMs: 10_000, safeRoomMs: 25_000 })).toBe(0);
  });
});

describe('isOfficialWin', () => {
  it('counts a victory comfortably under the raw budget', () => {
    expect(
      isOfficialWin({ outcome: 'victory', gameTimeMs: 300_000, safeRoomMs: 0 }, BUDGET_MS),
    ).toBe(true);
  });

  it('rejects an over-budget victory with no safe-room dwell', () => {
    expect(
      isOfficialWin({ outcome: 'victory', gameTimeMs: 390_000, safeRoomMs: 0 }, BUDGET_MS),
    ).toBe(false);
  });

  it('THE BUG REPRO: credits safe-room dwell so an over-raw-budget victory wins', () => {
    // 390s raw, 45s of it paused in a safe room -> 345s active < 360s budget.
    expect(
      isOfficialWin({ outcome: 'victory', gameTimeMs: 390_000, safeRoomMs: 45_000 }, BUDGET_MS),
    ).toBe(true);
  });

  it('still rejects when safe-room credit is insufficient to get under budget', () => {
    // 390s raw, only 20s safe-room -> 370s active, still over the 360s budget.
    expect(
      isOfficialWin({ outcome: 'victory', gameTimeMs: 390_000, safeRoomMs: 20_000 }, BUDGET_MS),
    ).toBe(false);
  });

  it('never counts a timeout as a win, even with large safe-room credit', () => {
    expect(
      isOfficialWin({ outcome: 'timeout', gameTimeMs: 390_000, safeRoomMs: 200_000 }, BUDGET_MS),
    ).toBe(false);
  });

  it('never counts a death as a win', () => {
    expect(isOfficialWin({ outcome: 'death', gameTimeMs: 100_000, safeRoomMs: 0 }, BUDGET_MS)).toBe(
      false,
    );
  });

  it('coalesces a missing safeRoomMs to raw game time', () => {
    // undefined safeRoomMs -> active === raw 300_000 < budget -> win.
    expect(isOfficialWin({ outcome: 'victory', gameTimeMs: 300_000 }, BUDGET_MS)).toBe(true);
    // undefined safeRoomMs -> active === raw 390_000 >= budget -> loss.
    expect(isOfficialWin({ outcome: 'victory', gameTimeMs: 390_000 }, BUDGET_MS)).toBe(false);
  });

  it('treats the budget as a strict upper bound (active exactly at budget is a loss)', () => {
    expect(
      isOfficialWin({ outcome: 'victory', gameTimeMs: 360_000, safeRoomMs: 0 }, BUDGET_MS),
    ).toBe(false);
  });
});

describe('isOfficialWin — floating-point boundary robustness', () => {
  // The real headless runner produces gameTimeMs by REPEATED ADDITION of
  // GAME.DELTA_MS per frame (simulation-step.ts: `world.elapsedMs += deltaMs`),
  // while safeRoomMs is a SINGLE MULTIPLICATION (headless-runner.ts:
  // `safeRoomFrames * GAME.DELTA_MS`). activeTimeMs subtracts the two, mixing an
  // accumulated sum with a product, so the difference carries floating-point
  // drift. This suite proves the strict `<` budget comparison stays correct at
  // the exact frame boundary — using values ACCUMULATED from GAME.DELTA_MS, not
  // the exact literal 360_000 the other boundary test uses.
  const DELTA_MS = GAME.DELTA_MS;
  // 360_000 / (1000/60) === 21_600 exactly, so the budget lands on an integer frame.
  const BUDGET_FRAMES = BUDGET_MS / DELTA_MS;

  /** Mirror simulation-step.ts: world.elapsedMs advances by repeated addition. */
  const accumulateElapsedMs = (frames: number): number => {
    let elapsed = 0;
    for (let i = 0; i < frames; i += 1) elapsed += DELTA_MS;
    return elapsed;
  };

  it('the Floor-1 budget lands on an exact integer frame (21_600)', () => {
    expect(BUDGET_FRAMES).toBe(21_600);
    expect(Number.isInteger(BUDGET_FRAMES)).toBe(true);
  });

  it('a victory at EXACTLY the budget frame is a loss despite accumulation drift', () => {
    // Repeated addition of 1000/60 drifts slightly ABOVE 360_000 (the divisor
    // rounds up in IEEE-754), so the exact-budget run reads correctly as
    // >= budget -> NOT an official win. A boundary tolerance would wrongly flip
    // this to a win, contradicting the game's `elapsed >= deadline` timeout.
    const gameTimeMs = accumulateElapsedMs(BUDGET_FRAMES); // ~360000.0000000529
    expect(gameTimeMs).toBeGreaterThan(BUDGET_MS); // drift is upward, never below
    expect(isOfficialWin({ outcome: 'victory', gameTimeMs, safeRoomMs: 0 }, BUDGET_MS)).toBe(false);
  });

  it('a victory one frame under the budget is a win (drift never bridges a frame)', () => {
    // One frame (16.67ms) below budget dwarfs the ~5e-8ms accumulation drift, so
    // the classification can never flip between adjacent frame counts.
    const gameTimeMs = accumulateElapsedMs(BUDGET_FRAMES - 1); // ~359983.33
    expect(isOfficialWin({ outcome: 'victory', gameTimeMs, safeRoomMs: 0 }, BUDGET_MS)).toBe(true);
  });

  it('classifies the accumulate-minus-multiply path correctly at the boundary', () => {
    // A 23_000-frame run that rested 1_400 frames in a safe room has 21_600
    // ACTIVE frames -> exactly the budget -> a loss. gameTimeMs uses the runner's
    // accumulation form; safeRoomMs uses its multiplication form.
    const totalFrames = 23_000;
    const safeFrames = totalFrames - BUDGET_FRAMES; // 1_400 -> active === budget
    const gameTimeMs = accumulateElapsedMs(totalFrames);
    expect(
      isOfficialWin(
        { outcome: 'victory', gameTimeMs, safeRoomMs: safeFrames * DELTA_MS },
        BUDGET_MS,
      ),
    ).toBe(false);

    // One extra safe-room frame -> 21_599 active frames -> under budget -> a win.
    expect(
      isOfficialWin(
        { outcome: 'victory', gameTimeMs, safeRoomMs: (safeFrames + 1) * DELTA_MS },
        BUDGET_MS,
      ),
    ).toBe(true);
  });
});

describe('SAFE_ROOM_FLAG_MS', () => {
  it('is the maintainer 60s Floor-1 diagnostic threshold', () => {
    expect(SAFE_ROOM_FLAG_MS).toBe(60_000);
  });
});
