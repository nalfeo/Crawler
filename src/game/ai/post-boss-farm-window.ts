/**
 * Post-boss farm window — should the AI keep working the floor instead of
 * taking the stairs?
 *
 * Floor 1's deadline is a *budget*, not a target. Once the final boss is dead
 * and the staircase is unlocked, nothing on the floor can fail the run except
 * the collapse clock, so a confident contestant spends the leftover time
 * farming loot and XP rather than walking straight out with a third of the
 * floor unused (observed on seed 42: exit at 470.9s of the 600s budget, 454
 * gold unspent).
 *
 * Pure and deterministic (rule #4): every input is passed in, nothing is read
 * from the clock. Shared by the behavior tree's Progress objective (so the AI
 * farms instead of navigating to the stairs) and the headless
 * auto-progression driver (so it does not confirm the descend underneath), which
 * is what keeps the two from disagreeing about when the run should leave.
 */

/** Inputs to {@link resolvePostBossFarmWindow}. All times are simulated ms. */
interface PostBossFarmWindowParams {
  /**
   * Fraction of {@link floorBudgetMs} the cohort keeps in reserve for the exit.
   * `1` (or anything >= 1) opts out — leave as soon as the stairs open.
   */
  readonly reserveFraction: number;
  /** Simulated elapsed time on this floor. */
  readonly elapsedMs: number;
  /**
   * Deadline the AI plans against — the collapse-panic deadline, which already
   * sits earlier than the raw objective deadline. Farming never runs past it.
   */
  readonly planningDeadlineMs: number;
  /** Total floor time budget the reserve fraction is measured against. */
  readonly floorBudgetMs: number;
  /** True once the final boss is dead and the staircase is unlocked. */
  readonly staircaseUnlocked: boolean;
  /** True once the run has already committed to the descend. */
  readonly staircaseDiscovered: boolean;
}

/** Verdict returned by {@link resolvePostBossFarmWindow}. */
export interface PostBossFarmWindow {
  /** True while the AI should keep farming instead of exiting. */
  readonly farming: boolean;
  /** Simulated time left in the farm window (0 once it has closed). */
  readonly remainingMs: number;
}

const CLOSED: PostBossFarmWindow = { farming: false, remainingMs: 0 };

/**
 * Decide whether the post-boss farm window is still open.
 *
 * The window closes — permanently, because `elapsedMs` only grows — as soon as
 * the remaining planning budget falls to the cohort's exit reserve. That
 * reserve is what keeps this from trading wins for loot (rule #12): the AI
 * still leaves with `reserveFraction` of the floor budget in hand, and the
 * collapse-panic beeline underneath is untouched.
 */
export function resolvePostBossFarmWindow(params: PostBossFarmWindowParams): PostBossFarmWindow {
  const {
    reserveFraction,
    elapsedMs,
    planningDeadlineMs,
    floorBudgetMs,
    staircaseUnlocked,
    staircaseDiscovered,
  } = params;
  if (!staircaseUnlocked || staircaseDiscovered) {
    return CLOSED;
  }
  if (!Number.isFinite(reserveFraction) || reserveFraction >= 1 || reserveFraction < 0) {
    return CLOSED;
  }
  if (!Number.isFinite(planningDeadlineMs) || !Number.isFinite(floorBudgetMs)) {
    return CLOSED;
  }
  const reserveMs = floorBudgetMs * reserveFraction;
  const remainingMs = planningDeadlineMs - elapsedMs - reserveMs;
  return remainingMs > 0 ? { farming: true, remainingMs } : CLOSED;
}
