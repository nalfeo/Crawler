import { describe, expect, it } from 'vitest';
import {
  CAST_FLASH_FRAMES,
  isAbilitySlotCastFlashing,
} from '../../src/engine/ability-bar-flash-state.js';

describe('isAbilitySlotCastFlashing', () => {
  it('does not flash when the ability has never triggered', () => {
    expect(isAbilitySlotCastFlashing(100, undefined)).toBe(false);
  });

  it('flashes on the trigger frame and through the whole flash window', () => {
    const trigger = 100;
    // Frame 0 of the window (the frame the ability fired) flashes...
    expect(isAbilitySlotCastFlashing(trigger, trigger)).toBe(true);
    // ...and it keeps flashing up to the last frame of the window.
    expect(isAbilitySlotCastFlashing(trigger + CAST_FLASH_FRAMES - 1, trigger)).toBe(true);
  });

  it('stops flashing once the flash window elapses', () => {
    const trigger = 100;
    expect(isAbilitySlotCastFlashing(trigger + CAST_FLASH_FRAMES, trigger)).toBe(false);
    expect(isAbilitySlotCastFlashing(trigger + CAST_FLASH_FRAMES + 300, trigger)).toBe(false);
  });

  it('does not flash for a trigger frame in the future (rewound-clock guard)', () => {
    expect(isAbilitySlotCastFlashing(90, 100)).toBe(false);
  });
});
