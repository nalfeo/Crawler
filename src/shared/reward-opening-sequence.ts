/**
 * reward-opening-sequence — pure, deterministic phase state machine for the
 * reward-opening UX (`src/engine/RewardOpeningUI.ts` renders it; both
 * `AchievementsUI` and `BossChestUI` drive it).
 *
 * Mirrors the immutable-transition shape of `level-up-allocation.ts`: every
 * mutator returns a new state object and never mutates its input. No
 * Phaser/DOM/timer imports — `tick(state, deltaMs)` is driven externally by
 * the caller's own update loop, which keeps this fully headless-reproducible
 * (same input timeline -> same output timeline, every time).
 *
 * Phases: `anticipation` -> `revealing` (per-item, count driven by
 * `itemCount`) -> `summary` -> `claimed`. `skip()` jumps straight to
 * `summary` from any earlier phase. `acknowledge()` is the only way out of
 * `summary`, into the terminal `claimed` phase, and is idempotent (duplicate
 * acknowledge/claim input is always a no-op once `claimed`).
 *
 * Reduced motion does not skip phases (every phase is still visited, so the
 * summary is never skipped outright) — it shortens/collapses the timing:
 * anticipation is near-instant and every item reveals together on the first
 * `revealing` tick instead of one at a time.
 */

export const REWARD_OPENING_PHASES = ['anticipation', 'revealing', 'summary', 'claimed'] as const;
export type RewardOpeningPhase = (typeof REWARD_OPENING_PHASES)[number];

/** Default (non-reduced-motion) phase durations, in milliseconds. */
export const DEFAULT_ANTICIPATION_MS = 900;
export const DEFAULT_PER_ITEM_REVEAL_MS = 450;
/** Reduced-motion durations: short but non-zero, so every phase is still observable/testable. */
export const REDUCED_MOTION_ANTICIPATION_MS = 120;
export const REDUCED_MOTION_REVEAL_MS = 60;

export interface RewardOpeningConfig {
  readonly anticipationMs: number;
  readonly perItemRevealMs: number;
  readonly reducedMotion: boolean;
}

export interface RewardOpeningState {
  readonly phase: RewardOpeningPhase;
  /** Total number of discrete items this sequence will reveal (>= 1). */
  readonly itemCount: number;
  /** Items revealed so far, monotonically non-decreasing until it hits `itemCount`. */
  readonly revealedCount: number;
  /** Elapsed time within the CURRENT phase only (resets on every transition). */
  readonly elapsedInPhaseMs: number;
  readonly config: RewardOpeningConfig;
}

function resolveConfig(reducedMotion: boolean): RewardOpeningConfig {
  return reducedMotion
    ? {
        anticipationMs: REDUCED_MOTION_ANTICIPATION_MS,
        perItemRevealMs: REDUCED_MOTION_REVEAL_MS,
        reducedMotion: true,
      }
    : {
        anticipationMs: DEFAULT_ANTICIPATION_MS,
        perItemRevealMs: DEFAULT_PER_ITEM_REVEAL_MS,
        reducedMotion: false,
      };
}

/**
 * Start a new sequence for `itemCount` discrete reveal items (e.g. 1 for a
 * single equipment instance, or 1 for a lootBox's combined gold+materials
 * reveal — callers decide how many discrete "beats" a reward has).
 */
export function createRewardOpeningState(
  itemCount: number,
  options?: { readonly reducedMotion?: boolean },
): RewardOpeningState {
  const safeItemCount = Number.isFinite(itemCount) ? Math.max(1, Math.floor(itemCount)) : 1;
  return {
    phase: 'anticipation',
    itemCount: safeItemCount,
    revealedCount: 0,
    elapsedInPhaseMs: 0,
    config: resolveConfig(options?.reducedMotion === true),
  };
}

function withPhase(
  state: RewardOpeningState,
  phase: RewardOpeningPhase,
  overrides?: Partial<Pick<RewardOpeningState, 'revealedCount' | 'elapsedInPhaseMs'>>,
): RewardOpeningState {
  return {
    ...state,
    phase,
    elapsedInPhaseMs: 0,
    ...overrides,
  };
}

/**
 * Advance the sequence by `deltaMs`. No-op (returns the same state) once
 * `summary` or `claimed` is reached — those phases only advance via explicit
 * `advanceToSummary`/`acknowledge` calls, never by time alone.
 */
export function tick(state: RewardOpeningState, deltaMs: number): RewardOpeningState {
  if (state.phase === 'summary' || state.phase === 'claimed') {
    return state;
  }
  const safeDelta = Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0;
  if (safeDelta === 0) {
    return state;
  }
  const elapsed = state.elapsedInPhaseMs + safeDelta;

  if (state.phase === 'anticipation') {
    if (elapsed < state.config.anticipationMs) {
      return { ...state, elapsedInPhaseMs: elapsed };
    }
    // Reduced motion reveals every item together on entry to `revealing`.
    const revealedCount = state.config.reducedMotion ? state.itemCount : 0;
    return withPhase(state, 'revealing', { revealedCount, elapsedInPhaseMs: 0 });
  }

  // state.phase === 'revealing'
  if (state.revealedCount >= state.itemCount) {
    return withPhase(state, 'summary', { revealedCount: state.itemCount });
  }
  const revealedCount = Math.min(
    state.itemCount,
    state.config.reducedMotion
      ? state.itemCount
      : Math.floor(elapsed / state.config.perItemRevealMs),
  );
  if (revealedCount >= state.itemCount) {
    return withPhase(state, 'summary', { revealedCount: state.itemCount });
  }
  return { ...state, elapsedInPhaseMs: elapsed, revealedCount };
}

/**
 * Jump straight to `summary` with every item revealed, regardless of the
 * current phase/elapsed time. No-op once already at `summary`/`claimed`.
 * This is the deterministic target for skip/fast-forward input.
 */
export function skip(state: RewardOpeningState): RewardOpeningState {
  if (state.phase === 'summary' || state.phase === 'claimed') {
    return state;
  }
  return withPhase(state, 'summary', { revealedCount: state.itemCount });
}

/**
 * Acknowledge the summary, ending the sequence (`claimed`). Only valid from
 * `summary`; idempotent everywhere else (including repeated calls once
 * already `claimed`) so duplicate claim-button/keypress input is always safe.
 */
export function acknowledge(state: RewardOpeningState): RewardOpeningState {
  if (state.phase !== 'summary') {
    return state;
  }
  return withPhase(state, 'claimed', { revealedCount: state.itemCount });
}

export function isRewardOpeningComplete(state: RewardOpeningState): boolean {
  return state.phase === 'claimed';
}

/** 0..1 fraction of items revealed so far — convenient for progress rendering. */
export function revealProgress(state: RewardOpeningState): number {
  return state.itemCount === 0 ? 1 : state.revealedCount / state.itemCount;
}
