import { describe, expect, it } from 'vitest';
import {
  cancel,
  confirm,
  createLevelUpAllocationState,
  decrementSelected,
  decrementStat,
  incrementSelected,
  incrementStat,
  moveSelection,
  remainingPoints,
  resetDraft,
  selectStat,
  selectedStat,
  spentTotal,
  toAllocations,
} from '../../src/shared/level-up-allocation.js';
import { STAT_KEYS } from '../../src/shared/stats.js';

describe('level-up allocation state', () => {
  it('starts open with an empty draft and all points available', () => {
    const state = createLevelUpAllocationState(5);
    expect(state.status).toBe('open');
    expect(state.available).toBe(5);
    expect(spentTotal(state)).toBe(0);
    expect(remainingPoints(state)).toBe(5);
    expect(selectedStat(state)).toBe(STAT_KEYS[0]);
    expect(toAllocations(state)).toEqual({});
  });

  it('floors and clamps a non-finite/negative available count to zero', () => {
    expect(createLevelUpAllocationState(-3).available).toBe(0);
    expect(createLevelUpAllocationState(2.9).available).toBe(2);
    expect(createLevelUpAllocationState(Number.NaN).available).toBe(0);
  });

  it('increments a stat and decrements remaining points', () => {
    const state = incrementStat(createLevelUpAllocationState(3), 'damage');
    expect(state.draft.damage).toBe(1);
    expect(remainingPoints(state)).toBe(2);
    expect(toAllocations(state)).toEqual({ damage: 1 });
  });

  it('does not increment beyond the available points', () => {
    let state = createLevelUpAllocationState(2);
    state = incrementStat(state, 'armor');
    state = incrementStat(state, 'armor');
    const blocked = incrementStat(state, 'maxHp');
    expect(blocked).toBe(state); // unchanged reference when no points remain
    expect(remainingPoints(state)).toBe(0);
    expect(spentTotal(state)).toBe(2);
  });

  it('does not decrement a stat below zero', () => {
    const state = createLevelUpAllocationState(2);
    const blocked = decrementStat(state, 'armor');
    expect(blocked).toBe(state);
    expect(state.draft.armor).toBe(0);
  });

  it('increment/decrement move the highlight to the touched stat', () => {
    let state = createLevelUpAllocationState(3);
    state = incrementStat(state, 'pickupRange');
    expect(selectedStat(state)).toBe('pickupRange');
    state = decrementStat(state, 'pickupRange');
    expect(selectedStat(state)).toBe('pickupRange');
  });

  it('operates on the highlighted stat via *Selected helpers', () => {
    let state = createLevelUpAllocationState(3);
    state = selectStat(state, 'attackSpeed');
    state = incrementSelected(state);
    state = incrementSelected(state);
    expect(state.draft.attackSpeed).toBe(2);
    state = decrementSelected(state);
    expect(state.draft.attackSpeed).toBe(1);
  });

  it('wraps selection navigation around the ends', () => {
    const state = createLevelUpAllocationState(1);
    const up = moveSelection(state, -1);
    expect(selectedStat(up)).toBe(STAT_KEYS[STAT_KEYS.length - 1]);
    const down = moveSelection(up, 1);
    expect(selectedStat(down)).toBe(STAT_KEYS[0]);
  });

  it('resets the draft back to zero', () => {
    let state = createLevelUpAllocationState(4);
    state = incrementStat(state, 'damage');
    state = incrementStat(state, 'armor');
    expect(spentTotal(state)).toBe(2);
    const reset = resetDraft(state);
    expect(spentTotal(reset)).toBe(0);
    expect(remainingPoints(reset)).toBe(4);
  });

  it('confirm keeps the draft and marks status confirmed (banking is allowed)', () => {
    let state = createLevelUpAllocationState(4);
    state = incrementStat(state, 'maxHp');
    const confirmed = confirm(state);
    expect(confirmed.status).toBe('confirmed');
    expect(toAllocations(confirmed)).toEqual({ maxHp: 1 });
    // One point spent, three banked.
    expect(remainingPoints(confirmed)).toBe(3);
  });

  it('cancel discards the draft and banks all points', () => {
    let state = createLevelUpAllocationState(4);
    state = incrementStat(state, 'maxHp');
    const cancelled = cancel(state);
    expect(cancelled.status).toBe('cancelled');
    expect(toAllocations(cancelled)).toEqual({});
  });

  it('ignores mutations once closed', () => {
    const confirmed = confirm(createLevelUpAllocationState(3));
    expect(incrementStat(confirmed, 'damage')).toBe(confirmed);
    expect(moveSelection(confirmed, 1)).toBe(confirmed);
    expect(resetDraft(confirmed)).toBe(confirmed);
    expect(cancel(confirmed)).toBe(confirmed);
  });

  it('never lets the draft exceed the available points across many ops', () => {
    let state = createLevelUpAllocationState(3);
    for (const stat of STAT_KEYS) {
      state = incrementStat(state, stat);
      state = incrementStat(state, stat);
    }
    expect(spentTotal(state)).toBe(3);
    expect(remainingPoints(state)).toBe(0);
  });
});
