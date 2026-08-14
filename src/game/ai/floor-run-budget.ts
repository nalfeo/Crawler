/**
 * Floor-parameterized run budgets for the headless runner, sweeps, and gates.
 *
 * The ACTIVE-time budget and the derived raw frame cap used to be Floor-1
 * constants (`floor1-run-budget.ts`). They are now resolved per floor from the
 * floor manifest's `implemented.winBudgetMs`, so a sweep can run any
 * implemented floor with that floor's own budget instead of silently borrowing
 * Floor 1's.
 *
 * Floor 1's values are unchanged and must stay byte-identical: the FP-safe
 * division form below is load-bearing (see {@link getDefaultMaxFrames}).
 */
import { GAME } from '../../shared/constants.js';
import { getFloorWinBudgetMs } from '../../shared/floor-registry.js';

/**
 * The ACTIVE-time budget (simulated game ms) an official win on `floorId` must
 * land under, or `null` when the floor declares no validated budget — in which
 * case a win is raw victory with no time bound.
 */
export function getActiveTimeBudgetMs(floorId: string): number | null {
  return getFloorWinBudgetMs(floorId);
}

/**
 * Raw simulation frame cap for `floorId`: the win budget plus ~10 % slack.
 *
 * The slack is REQUIRED wherever a floor's win is safe-room-credited — the win
 * check compares `gameTimeMs - safeRoomMs` against the budget, so a legitimate
 * clear can run PAST the budget in RAW game time while still being under the
 * ACTIVE budget. Capping the sim at exactly the budget would force-terminate
 * those wins and miscount them as timeouts, biasing the win rate DOWN.
 *
 * The `(budget * 1.1) / DELTA_MS` division form is load-bearing and must not be
 * rewritten as `Math.ceil(frames * 1.1)`: for Floor 1 the latter rounds up to
 * 23_761 because `21_600 * 1.1 === 23760.000000000004`, whereas this form
 * yields 23_760 — the value every existing Floor-1 sweep, gate, and fingerprint
 * is calibrated on.
 *
 * Returns `null` for a floor with no declared budget, so callers keep their
 * existing "no floor-derived cap" behavior rather than inheriting Floor 1's.
 */
export function getDefaultMaxFrames(floorId: string): number | null {
  const budgetMs = getActiveTimeBudgetMs(floorId);
  return budgetMs === null ? null : Math.ceil((budgetMs * 1.1) / GAME.DELTA_MS);
}

/**
 * Budget frames WITHOUT slack — the exact win budget expressed in frames.
 * Returns `null` for a floor with no declared budget.
 */
export function getBudgetFrames(floorId: string): number | null {
  const budgetMs = getActiveTimeBudgetMs(floorId);
  return budgetMs === null ? null : budgetMs / GAME.DELTA_MS;
}

/**
 * Resolve a floor's budget, throwing when the floor declares none. Use from
 * call sites that are only meaningful for a budgeted floor (e.g. the Floor-1
 * gate), so a manifest edit that drops the budget fails loudly.
 */
export function requireActiveTimeBudgetMs(floorId: string): number {
  const budgetMs = getActiveTimeBudgetMs(floorId);
  if (budgetMs === null) {
    throw new Error(
      `Floor "${floorId}" declares no implemented.winBudgetMs, but a win budget is required here.`,
    );
  }
  return budgetMs;
}

/** As {@link getDefaultMaxFrames}, but throws for a floor with no budget. */
export function requireDefaultMaxFrames(floorId: string): number {
  const budgetMs = requireActiveTimeBudgetMs(floorId);
  return Math.ceil((budgetMs * 1.1) / GAME.DELTA_MS);
}
