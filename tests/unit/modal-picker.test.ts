import { describe, expect, it } from 'vitest';
import {
  cancelModalPickerSelection,
  confirmModalPickerSelection,
  createModalPickerState,
  getModalPickerSelectedOption,
  moveModalPickerSelection,
  setModalPickerOptions,
  setModalPickerSelectedId,
} from '../../src/shared/modal-picker.js';

describe('modal picker state', () => {
  it('preserves an optional picker kind for automation to identify the open flow', () => {
    const state = createModalPickerState({
      kind: 'spell-broker',
      title: 'Choose',
      options: [{ id: 'a', label: 'A' }],
    });

    expect(state.kind).toBe('spell-broker');
  });

  it('selects the first enabled option on create', () => {
    const state = createModalPickerState({
      title: 'Choose',
      options: [
        { id: 'a', label: 'A', disabled: true },
        { id: 'b', label: 'B' },
      ],
    });

    expect(state.selectedIndex).toBe(1);
    expect(getModalPickerSelectedOption(state)?.id).toBe('b');
  });

  it('wraps and skips disabled options during keyboard navigation', () => {
    const state = createModalPickerState({
      title: 'Choose',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B', disabled: true },
        { id: 'c', label: 'C' },
      ],
      initialSelectedId: 'a',
    });

    const next = moveModalPickerSelection(state, 1);
    expect(getModalPickerSelectedOption(next)?.id).toBe('c');

    const wrapped = moveModalPickerSelection(next, 1);
    expect(getModalPickerSelectedOption(wrapped)?.id).toBe('a');
  });

  it('keeps selection null and cannot confirm when all options are disabled', () => {
    const state = createModalPickerState({
      title: 'Choose',
      options: [
        { id: 'a', label: 'A', disabled: true },
        { id: 'b', label: 'B', disabled: true },
      ],
    });

    expect(state.selectedIndex).toBeNull();
    expect(confirmModalPickerSelection(state).status).toBe('open');
  });

  it('supports explicit selected-id updates only for enabled options', () => {
    const state = createModalPickerState({
      title: 'Choose',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B', disabled: true },
      ],
    });

    const ignored = setModalPickerSelectedId(state, 'b');
    expect(getModalPickerSelectedOption(ignored)?.id).toBe('a');

    const selected = setModalPickerSelectedId(state, 'a');
    expect(getModalPickerSelectedOption(selected)?.id).toBe('a');
  });

  it('revalidates selection when options are replaced', () => {
    const state = createModalPickerState({
      title: 'Choose',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      initialSelectedId: 'b',
    });

    const replaced = setModalPickerOptions(state, [
      { id: 'c', label: 'C', disabled: true },
      { id: 'd', label: 'D' },
    ]);
    expect(getModalPickerSelectedOption(replaced)?.id).toBe('d');
  });

  it('confirms and cancels according to allowCancel', () => {
    const cancellable = createModalPickerState({
      title: 'Choose',
      options: [{ id: 'a', label: 'A' }],
      allowCancel: true,
    });
    expect(confirmModalPickerSelection(cancellable).status).toBe('confirmed');
    expect(cancelModalPickerSelection(cancellable).status).toBe('cancelled');

    const nonCancellable = createModalPickerState({
      title: 'Choose',
      options: [{ id: 'a', label: 'A' }],
      allowCancel: false,
    });
    expect(cancelModalPickerSelection(nonCancellable).status).toBe('open');
  });

  it('moves from null selection to the last enabled option when navigating backward', () => {
    const state = createModalPickerState({
      title: 'Choose',
      options: [
        { id: 'a', label: 'A', disabled: true },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
      ],
    });

    const noSelection = { ...state, selectedIndex: null };
    const moved = moveModalPickerSelection(noSelection, -1);
    expect(getModalPickerSelectedOption(moved)?.id).toBe('c');
  });

  it('keeps null selection when all options are disabled and moving backward', () => {
    const state = createModalPickerState({
      title: 'Choose',
      options: [
        { id: 'a', label: 'A', disabled: true },
        { id: 'b', label: 'B', disabled: true },
      ],
    });

    const moved = moveModalPickerSelection(state, -1);
    expect(moved.selectedIndex).toBeNull();
  });

  it('returns the same object when navigation cannot change selection', () => {
    const state = createModalPickerState({
      title: 'Choose',
      options: [{ id: 'a', label: 'A' }],
    });

    const moved = moveModalPickerSelection(state, 1);
    expect(moved).toBe(state);
  });

  it('returns the same object when moving after confirm', () => {
    const state = createModalPickerState({
      title: 'Choose',
      options: [{ id: 'a', label: 'A' }],
    });
    const confirmed = confirmModalPickerSelection(state);

    expect(moveModalPickerSelection(confirmed, 1)).toBe(confirmed);
  });

  it('returns the same object when selecting an id after confirm', () => {
    const state = createModalPickerState({
      title: 'Choose',
      options: [{ id: 'a', label: 'A' }],
    });
    const confirmed = confirmModalPickerSelection(state);

    expect(setModalPickerSelectedId(confirmed, 'a')).toBe(confirmed);
  });

  it('returns the same object when confirming an already confirmed state', () => {
    const state = createModalPickerState({
      title: 'Choose',
      options: [{ id: 'a', label: 'A' }],
    });
    const confirmed = confirmModalPickerSelection(state);

    expect(confirmModalPickerSelection(confirmed)).toBe(confirmed);
  });

  it('recomputes selection when replacing options with all disabled entries', () => {
    const state = createModalPickerState({
      title: 'Choose',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      initialSelectedId: 'a',
    });

    const replaced = setModalPickerOptions(state, [
      { id: 'c', label: 'C', disabled: true },
      { id: 'd', label: 'D', disabled: true },
    ]);
    expect(replaced.selectedIndex).toBeNull();
  });

  it('clears selection when replacing options with an empty list', () => {
    const state = createModalPickerState({
      title: 'Choose',
      options: [{ id: 'a', label: 'A' }],
    });

    const replaced = setModalPickerOptions(state, []);
    expect(replaced.selectedIndex).toBeNull();
    expect(getModalPickerSelectedOption(replaced)).toBeUndefined();
  });

  it('handles invalid selected index on empty option lists without throwing', () => {
    const state = {
      title: 'Choose',
      options: [] as const,
      allowCancel: true,
      selectedIndex: 0,
      status: 'open' as const,
    };

    const moved = moveModalPickerSelection(state, 1);
    expect(moved.selectedIndex).toBeNull();
  });
});
