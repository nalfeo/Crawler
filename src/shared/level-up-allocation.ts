/**
 * level-up-allocation — pure, deterministic state for the level-up core-stat
 * allocation screen.
 *
 * The Phaser overlay (`src/engine/LevelUpUI.ts`) and the lab render this state
 * and dispatch transitions; all of the spend/clamp/navigation rules live here so
 * they can be unit-tested without a renderer. No Phaser/DOM imports.
 *
 * Players allocate points to PRIMARY_STATS (Strength, Dexterity, …) which then
 * derive the STAT_KEYS gameplay stats via `CORE_STAT_GAINS` in stats.ts.
 *
 * Mirrors the immutable-transition shape of `src/shared/modal-picker.ts`:
 * every mutator returns a new state object and never mutates its input.
 */
import { PRIMARY_STATS, isAllocatablePrimaryStat, type PrimaryStatId } from './stats.js';

export type LevelUpStatus = 'open' | 'confirmed' | 'cancelled';

export interface LevelUpAllocationState {
  /** Total points granted by the level-up(s) being allocated. */
  readonly available: number;
  /** Points tentatively assigned to each core stat (the draft). */
  readonly draft: Readonly<Record<PrimaryStatId, number>>;
  /** Index into PRIMARY_STATS of the currently highlighted row. */
  readonly selectedIndex: number;
  readonly status: LevelUpStatus;
}

function emptyDraft(): Record<PrimaryStatId, number> {
  const draft = {} as Record<PrimaryStatId, number>;
  for (const stat of PRIMARY_STATS) {
    draft[stat] = 0;
  }
  return draft;
}

/** Create a fresh allocation screen for `available` unspent points. */
export function createLevelUpAllocationState(available: number): LevelUpAllocationState {
  const safeAvailable = Number.isFinite(available) ? Math.max(0, Math.floor(available)) : 0;
  return {
    available: safeAvailable,
    draft: emptyDraft(),
    selectedIndex: 0,
    status: 'open',
  };
}

/** Total points spent across all stats in the current draft. */
export function spentTotal(state: LevelUpAllocationState): number {
  let total = 0;
  for (const stat of PRIMARY_STATS) {
    total += state.draft[stat];
  }
  return total;
}

/** Points still available to spend. */
export function remainingPoints(state: LevelUpAllocationState): number {
  return state.available - spentTotal(state);
}

/** The PrimaryStatId currently highlighted. */
export function selectedStat(state: LevelUpAllocationState): PrimaryStatId {
  return PRIMARY_STATS[state.selectedIndex] ?? PRIMARY_STATS[0]!;
}

/**
 * Move the highlight by `delta` rows, wrapping around the ends (matching the
 * modal-picker navigation feel). No-op once the screen is confirmed/cancelled.
 */
export function moveSelection(
  state: LevelUpAllocationState,
  delta: number,
): LevelUpAllocationState {
  if (state.status !== 'open') {
    return state;
  }
  const count = PRIMARY_STATS.length;
  const next = (((state.selectedIndex + delta) % count) + count) % count;
  if (next === state.selectedIndex) {
    return state;
  }
  return { ...state, selectedIndex: next };
}

/** Highlight a specific stat by id. No-op if the id is unknown or closed. */
export function selectStat(
  state: LevelUpAllocationState,
  stat: PrimaryStatId,
): LevelUpAllocationState {
  if (state.status !== 'open') {
    return state;
  }
  const index = PRIMARY_STATS.indexOf(stat);
  if (index < 0 || index === state.selectedIndex) {
    return state;
  }
  return { ...state, selectedIndex: index };
}

/** Add one point to `stat`, capped by remaining points. */
export function incrementStat(
  state: LevelUpAllocationState,
  stat: PrimaryStatId,
): LevelUpAllocationState {
  if (state.status !== 'open' || remainingPoints(state) <= 0 || !isAllocatablePrimaryStat(stat)) {
    return state;
  }
  const index = PRIMARY_STATS.indexOf(stat);
  if (index < 0) {
    return state;
  }
  return {
    ...state,
    selectedIndex: index,
    draft: { ...state.draft, [stat]: state.draft[stat] + 1 },
  };
}

/** Remove one point from `stat`, floored at zero. */
export function decrementStat(
  state: LevelUpAllocationState,
  stat: PrimaryStatId,
): LevelUpAllocationState {
  if (state.status !== 'open') {
    return state;
  }
  const index = PRIMARY_STATS.indexOf(stat);
  if (index < 0 || state.draft[stat] <= 0) {
    return state;
  }
  return {
    ...state,
    selectedIndex: index,
    draft: { ...state.draft, [stat]: state.draft[stat] - 1 },
  };
}

/** Increment whichever stat is currently highlighted. */
export function incrementSelected(state: LevelUpAllocationState): LevelUpAllocationState {
  return incrementStat(state, selectedStat(state));
}

/** Decrement whichever stat is currently highlighted. */
export function decrementSelected(state: LevelUpAllocationState): LevelUpAllocationState {
  return decrementStat(state, selectedStat(state));
}

/** Clear the draft back to zero allocations (keeps the highlight). */
export function resetDraft(state: LevelUpAllocationState): LevelUpAllocationState {
  if (state.status !== 'open' || spentTotal(state) === 0) {
    return state;
  }
  return { ...state, draft: emptyDraft() };
}

/** Confirm the current draft. Allowed even with points banked for later. */
export function confirm(state: LevelUpAllocationState): LevelUpAllocationState {
  if (state.status !== 'open') {
    return state;
  }
  return { ...state, status: 'confirmed' };
}

/** Cancel the screen, banking all points (draft is discarded). */
export function cancel(state: LevelUpAllocationState): LevelUpAllocationState {
  if (state.status !== 'open') {
    return state;
  }
  return { ...state, draft: emptyDraft(), status: 'cancelled' };
}

/**
 * The non-zero allocations to hand to `spendPoints`. When the draft is empty
 * (e.g. cancelled or untouched) the result is an empty object so no points are
 * spent and the unspent total is banked toward the next level.
 */
export function toAllocations(
  state: LevelUpAllocationState,
): Partial<Record<PrimaryStatId, number>> {
  const allocations: Partial<Record<PrimaryStatId, number>> = {};
  for (const stat of PRIMARY_STATS) {
    if (state.draft[stat] > 0) {
      allocations[stat] = state.draft[stat];
    }
  }
  return allocations;
}
