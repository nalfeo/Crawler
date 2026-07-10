import { describe, expect, it } from 'vitest';
import { activeTimeMs, isOfficialWin, SAFE_ROOM_FLAG_MS } from '../../../src/game/ai/scoring.js';

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

describe('SAFE_ROOM_FLAG_MS', () => {
  it('is the maintainer 60s Floor-1 diagnostic threshold', () => {
    expect(SAFE_ROOM_FLAG_MS).toBe(60_000);
  });
});
