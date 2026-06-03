import { describe, expect, it } from 'vitest';
import { createInputState } from '../../src/shared/input.js';

describe('createInputState', () => {
  it('returns a zeroed input state', () => {
    expect(createInputState()).toEqual({
      moveX: 0,
      moveY: 0,
      action: false,
      pointerX: 0,
      pointerY: 0,
    });
  });
});
