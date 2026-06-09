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
});
