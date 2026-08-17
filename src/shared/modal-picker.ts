export interface ModalPickerOption<TId extends string = string> {
  readonly id: TId;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export interface ModalPickerConfig<TId extends string = string> {
  /** Stable identity for automation that must distinguish simultaneous picker flows. */
  readonly kind?: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly body?: string;
  readonly options: readonly ModalPickerOption<TId>[];
  readonly allowCancel?: boolean;
  readonly initialSelectedId?: TId;
}

export interface ModalPickerScenario<
  TId extends string = string,
  TContext = unknown,
> extends ModalPickerConfig<TId> {
  readonly defaultOptionId?: TId;
  readonly onConfirm: (context: TContext, optionId: TId) => void;
  readonly onCancel?: (context: TContext) => void;
}

export type ModalPickerStatus = 'open' | 'confirmed' | 'cancelled';

export interface ModalPickerState<TId extends string = string> {
  readonly kind?: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly body?: string;
  readonly options: readonly ModalPickerOption<TId>[];
  readonly allowCancel: boolean;
  readonly selectedIndex: number | null;
  readonly status: ModalPickerStatus;
}

function findOptionIndexById<TId extends string>(
  options: readonly ModalPickerOption<TId>[],
  optionId: TId,
): number {
  return options.findIndex((option) => option.id === optionId);
}

function findFirstEnabledIndex<TId extends string>(
  options: readonly ModalPickerOption<TId>[],
): number | null {
  for (let index = 0; index < options.length; index += 1) {
    if (!options[index]?.disabled) {
      return index;
    }
  }
  return null;
}

function findLastEnabledIndex<TId extends string>(
  options: readonly ModalPickerOption<TId>[],
): number | null {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index]?.disabled) {
      return index;
    }
  }
  return null;
}

function findNearestEnabledIndex<TId extends string>(
  options: readonly ModalPickerOption<TId>[],
  fromIndex: number,
): number | null {
  if (options.length === 0) {
    return null;
  }

  const clamped = Math.max(0, Math.min(fromIndex, options.length - 1));
  const atIndex = options[clamped];
  if (atIndex && !atIndex.disabled) {
    return clamped;
  }

  for (let distance = 1; distance < options.length; distance += 1) {
    const left = clamped - distance;
    const right = clamped + distance;
    if (left >= 0 && options[left] && !options[left].disabled) {
      return left;
    }
    if (right < options.length && options[right] && !options[right].disabled) {
      return right;
    }
  }

  return null;
}

function findNextEnabledIndex<TId extends string>(
  options: readonly ModalPickerOption<TId>[],
  fromIndex: number,
  direction: 1 | -1,
): number | null {
  if (options.length === 0) {
    return null;
  }

  let index = ((fromIndex % options.length) + options.length) % options.length;
  for (let step = 0; step < options.length; step += 1) {
    index = (index + direction + options.length) % options.length;
    const option = options[index];
    if (option && !option.disabled) {
      return index;
    }
  }

  return null;
}

export function createModalPickerState<TId extends string>(
  config: ModalPickerConfig<TId>,
): ModalPickerState<TId> {
  const explicitIndex =
    config.initialSelectedId !== undefined
      ? findOptionIndexById(config.options, config.initialSelectedId)
      : -1;
  const selectedIndex =
    explicitIndex >= 0 && !config.options[explicitIndex]?.disabled
      ? explicitIndex
      : findFirstEnabledIndex(config.options);

  return {
    kind: config.kind,
    title: config.title,
    subtitle: config.subtitle,
    body: config.body,
    options: config.options,
    allowCancel: config.allowCancel ?? true,
    selectedIndex,
    status: 'open',
  };
}

export function getModalPickerSelectedOption<TId extends string>(
  state: ModalPickerState<TId>,
): ModalPickerOption<TId> | undefined {
  if (state.selectedIndex === null) {
    return undefined;
  }
  return state.options[state.selectedIndex];
}

export function moveModalPickerSelection<TId extends string>(
  state: ModalPickerState<TId>,
  direction: 1 | -1,
): ModalPickerState<TId> {
  if (state.status !== 'open') {
    return state;
  }

  const options = state.options;
  const nextIndex =
    state.selectedIndex === null
      ? direction === 1
        ? findFirstEnabledIndex(options)
        : findLastEnabledIndex(options)
      : findNextEnabledIndex(options, state.selectedIndex, direction);

  if (nextIndex === state.selectedIndex) {
    return state;
  }

  return {
    ...state,
    selectedIndex: nextIndex,
  };
}

export function setModalPickerOptions<TId extends string>(
  state: ModalPickerState<TId>,
  options: readonly ModalPickerOption<TId>[],
): ModalPickerState<TId> {
  const selectedOption = getModalPickerSelectedOption(state);
  const selectedIndexFromId =
    selectedOption !== undefined ? findOptionIndexById(options, selectedOption.id) : -1;
  const selectedIndex =
    selectedIndexFromId >= 0 && !options[selectedIndexFromId]?.disabled
      ? selectedIndexFromId
      : findNearestEnabledIndex(options, state.selectedIndex ?? 0);

  return {
    ...state,
    options,
    selectedIndex,
  };
}

export function setModalPickerSelectedId<TId extends string>(
  state: ModalPickerState<TId>,
  optionId: TId,
): ModalPickerState<TId> {
  if (state.status !== 'open') {
    return state;
  }

  const index = findOptionIndexById(state.options, optionId);
  if (index < 0 || state.options[index]?.disabled) {
    return state;
  }

  return {
    ...state,
    selectedIndex: index,
  };
}

export function confirmModalPickerSelection<TId extends string>(
  state: ModalPickerState<TId>,
): ModalPickerState<TId> {
  if (state.status !== 'open') {
    return state;
  }

  const selected = getModalPickerSelectedOption(state);
  if (!selected || selected.disabled) {
    return state;
  }

  return {
    ...state,
    status: 'confirmed',
  };
}

export function cancelModalPickerSelection<TId extends string>(
  state: ModalPickerState<TId>,
): ModalPickerState<TId> {
  if (state.status !== 'open' || !state.allowCancel) {
    return state;
  }

  return {
    ...state,
    status: 'cancelled',
  };
}
