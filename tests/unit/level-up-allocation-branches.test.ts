import { describe, expect, it } from 'vitest';
import {
  cancel,
  confirm,
  createLevelUpAllocationState,
  decrementStat,
  incrementStat,
  moveSelection,
  resetDraft,
  selectStat,
  type LevelUpAllocationState,
} from '../../src/shared/level-up-allocation.js';
import { STAT_KEYS, type StatKey } from '../../src/shared/stats.js';

const BOGUS = 'not-a-stat' as StatKey;

function openState(available = 3): LevelUpAllocationState {
  return createLevelUpAllocationState(available);
}

describe('level-up-allocation no-op branches', () => {
  it('moveSelection is a no-op when the net move lands on the same row', () => {
    const state = openState();
    // delta equal to the row count wraps back to the same selectedIndex.
    const moved = moveSelection(state, STAT_KEYS.length);
    expect(moved).toBe(state);
  });

  it('selectStat is a no-op once the screen is confirmed', () => {
    const state = confirm(openState());
    expect(selectStat(state, STAT_KEYS[2])).toBe(state);
  });

  it('selectStat is a no-op for an unknown stat or the already-selected row', () => {
    const state = openState();
    expect(selectStat(state, BOGUS)).toBe(state);
    const selected = STAT_KEYS[state.selectedIndex];
    expect(selected).toBeDefined();
    expect(selectStat(state, selected!)).toBe(state);
  });

  it('incrementStat is a no-op for an unknown stat', () => {
    const state = openState();
    expect(incrementStat(state, BOGUS)).toBe(state);
  });

  it('incrementStat is a no-op with no remaining points', () => {
    const state = openState(0);
    expect(incrementStat(state, STAT_KEYS[0])).toBe(state);
  });

  it('decrementStat is a no-op once cancelled', () => {
    const state = cancel(openState());
    expect(decrementStat(state, STAT_KEYS[0])).toBe(state);
  });

  it('decrementStat is a no-op for an unknown stat or a zero allocation', () => {
    const state = openState();
    expect(decrementStat(state, BOGUS)).toBe(state);
    expect(decrementStat(state, STAT_KEYS[0])).toBe(state);
  });

  it('resetDraft is a no-op when nothing has been spent', () => {
    const state = openState();
    expect(resetDraft(state)).toBe(state);
  });

  it('resetDraft clears a non-empty draft', () => {
    const spent = incrementStat(openState(), STAT_KEYS[1]);
    const reset = resetDraft(spent);
    expect(reset).not.toBe(spent);
    expect(reset.draft[STAT_KEYS[1]]).toBe(0);
  });
});
