/**
 * Post-boss farm window — the AI's decision to keep working Floor 1 after the
 * final boss is dead instead of walking straight out.
 *
 * Requirements validated (issue #3275 items 2 and 4):
 *  1. A cohort with a farm appetite keeps farming while the floor still holds
 *     more than its exit reserve.
 *  2. The window closes once only the exit reserve is left — the run always
 *     leaves with `reserveFraction` of the budget in hand (rule #12: no trading
 *     wins for loot).
 *  3. A cohort that opts out (`reserveFraction >= 1`) never farms.
 *  4. The window is only open between "stairs unlocked" and "descend
 *     committed".
 *  5. Nonsense inputs fail closed (leave the floor) rather than farming
 *     forever.
 *  6. The window is bounded even when the planning deadline is inflated by a
 *     paused collapse clock — it must always close as `elapsedMs` grows.
 */

import { describe, expect, it } from 'vitest';
import { resolvePostBossFarmWindow } from '../../../src/game/ai/post-boss-farm-window.js';

const BUDGET_MS = 600_000;

type PostBossFarmWindowParams = Parameters<typeof resolvePostBossFarmWindow>[0];

function params(overrides: Partial<PostBossFarmWindowParams> = {}): PostBossFarmWindowParams {
  return {
    reserveFraction: 0.2,
    elapsedMs: 0,
    planningDeadlineMs: BUDGET_MS,
    floorBudgetMs: BUDGET_MS,
    staircaseUnlocked: true,
    staircaseDiscovered: false,
    ...overrides,
  };
}

describe('post-boss farm window — open while budget remains', () => {
  it('farms the leftover budget instead of exiting early', () => {
    // The pre-fix seed-42 run left at 470.9s of the 600s budget.
    const window = resolvePostBossFarmWindow(params({ elapsedMs: 470_900 }));
    expect(window.farming).toBe(true);
    expect(window.remainingMs).toBe(BUDGET_MS - 470_900 - 120_000);
  });

  it('reports the remaining farm time', () => {
    expect(resolvePostBossFarmWindow(params({ elapsedMs: 100_000 })).remainingMs).toBe(380_000);
  });
});

describe('post-boss farm window — exit reserve is never spent', () => {
  it('closes exactly when only the exit reserve is left', () => {
    expect(resolvePostBossFarmWindow(params({ elapsedMs: 480_000 })).farming).toBe(false);
  });

  it('stays closed past the reserve boundary', () => {
    const window = resolvePostBossFarmWindow(params({ elapsedMs: 599_000 }));
    expect(window.farming).toBe(false);
    expect(window.remainingMs).toBe(0);
  });

  it('honours a tighter cohort reserve', () => {
    // min_max_cheeser keeps 15%: farms 30s longer than the 20% default.
    expect(
      resolvePostBossFarmWindow(params({ elapsedMs: 480_000, reserveFraction: 0.15 })).farming,
    ).toBe(true);
  });

  it('shrinks the window when the runner deadline is tighter than the floor budget', () => {
    // The planning deadline (frame budget) bounds the window; the reserve is
    // still measured against the floor budget, so a 500s deadline leaves no
    // farm time at all past 380s.
    expect(
      resolvePostBossFarmWindow(params({ elapsedMs: 300_000, planningDeadlineMs: 500_000 }))
        .remainingMs,
    ).toBe(80_000);
    expect(
      resolvePostBossFarmWindow(params({ elapsedMs: 400_000, planningDeadlineMs: 500_000 }))
        .farming,
    ).toBe(false);
  });
});

describe('post-boss farm window — cohorts that opt out', () => {
  it('never farms at reserveFraction 1 (new_player leaves immediately)', () => {
    expect(resolvePostBossFarmWindow(params({ elapsedMs: 0, reserveFraction: 1 })).farming).toBe(
      false,
    );
  });

  it('never farms above reserveFraction 1', () => {
    expect(resolvePostBossFarmWindow(params({ reserveFraction: 1.5 })).farming).toBe(false);
  });
});

describe('post-boss farm window — lifecycle gating', () => {
  it('is closed before the staircase unlocks', () => {
    expect(resolvePostBossFarmWindow(params({ staircaseUnlocked: false })).farming).toBe(false);
  });

  it('is closed once the descend is committed', () => {
    expect(resolvePostBossFarmWindow(params({ staircaseDiscovered: true })).farming).toBe(false);
  });
});

describe('post-boss farm window — fails closed', () => {
  it('does not farm on a non-finite deadline', () => {
    expect(
      resolvePostBossFarmWindow(params({ planningDeadlineMs: Number.POSITIVE_INFINITY })).farming,
    ).toBe(false);
  });

  it('does not farm on a non-finite budget', () => {
    expect(resolvePostBossFarmWindow(params({ floorBudgetMs: Number.NaN })).farming).toBe(false);
  });

  it('does not farm on a negative reserve fraction', () => {
    expect(resolvePostBossFarmWindow(params({ reserveFraction: -0.5 })).farming).toBe(false);
  });
});

describe('post-boss farm window — bounded against a paused collapse clock', () => {
  // Floor 1 pauses the collapse deadline while the player stands in a safe
  // room, so `planningDeadlineMs` can advance in lockstep with `elapsedMs`.
  // Measuring the reserve against that inflated deadline made `remainingMs`
  // constant and the window unclosable, which is one half of the seed-1
  // stall beside the staircase. The clamp to `floorBudgetMs` restores
  // strict monotonicity.
  it('closes once the floor budget is spent even while the deadline keeps growing', () => {
    const elapsedMs = 900_000;
    expect(
      resolvePostBossFarmWindow(params({ elapsedMs, planningDeadlineMs: elapsedMs + 200_000 }))
        .farming,
    ).toBe(false);
  });

  it('keeps remainingMs strictly decreasing in elapsedMs under a paused clock', () => {
    const earlier = resolvePostBossFarmWindow(
      params({ elapsedMs: 100_000, planningDeadlineMs: 100_000 + 500_000 }),
    );
    const later = resolvePostBossFarmWindow(
      params({ elapsedMs: 200_000, planningDeadlineMs: 200_000 + 500_000 }),
    );
    expect(earlier.farming).toBe(true);
    expect(later.remainingMs).toBeLessThan(earlier.remainingMs);
  });

  it('still honours a planning deadline tighter than the floor budget', () => {
    expect(
      resolvePostBossFarmWindow(params({ elapsedMs: 0, planningDeadlineMs: 100_000 })).farming,
    ).toBe(false);
  });
});
