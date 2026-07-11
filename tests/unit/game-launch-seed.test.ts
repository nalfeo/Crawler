import { describe, expect, it, vi } from 'vitest';

import {
  generateGameLaunchSeed,
  resolveGameLaunchSeed,
} from '../../src/bootstrap/game-launch-seed.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('real-game launch seed', () => {
  it('generates a fresh seed when the launch URL omits one', () => {
    const generateSeed = vi.fn(() => 731_204);

    expect(resolveGameLaunchSeed('?floor=floor1', generateSeed)).toBe(731_204);
    expect(generateSeed).toHaveBeenCalledOnce();
  });

  it('preserves an explicit URL seed without generating a replacement', () => {
    const generateSeed = vi.fn(() => 731_204);

    expect(resolveGameLaunchSeed('?floor=floor1&seed=42', generateSeed)).toBe(42);
    expect(generateSeed).not.toHaveBeenCalled();
  });

  it('uses browser entropy and returns a non-zero seed', () => {
    const getRandomValues = vi
      .spyOn(globalThis.crypto, 'getRandomValues')
      .mockImplementation((values) => {
        (values as Uint32Array)[0] = 1_234_567;
        return values;
      });

    expect(generateGameLaunchSeed()).toBe(1_234_567);
    getRandomValues.mockRestore();
  });

  it('leaves the internal world default at 42', () => {
    expect(createTestWorld({ seed: undefined }).seed).toBe(42);
  });
});
