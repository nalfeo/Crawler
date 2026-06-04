export interface InputState {
  /** Normalized movement direction (-1 to 1 on each axis) */
  moveX: number;
  moveY: number;
  /** Whether the primary action is pressed */
  action: boolean;
  /** Mouse/pointer position in world coordinates */
  pointerX: number;
  pointerY: number;
}

export function createInputState(): InputState {
  return {
    moveX: 0,
    moveY: 0,
    action: false,
    pointerX: 0,
    pointerY: 0,
  };
}

export function normalizeInputDirection(
  moveX: number,
  moveY: number,
): Pick<InputState, 'moveX' | 'moveY'> {
  const length = Math.hypot(moveX, moveY);

  if (length === 0) {
    return { moveX: 0, moveY: 0 };
  }

  if (length <= 1) {
    return { moveX, moveY };
  }

  return {
    moveX: moveX / length,
    moveY: moveY / length,
  };
}
