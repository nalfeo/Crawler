import { createGameWorld, type CreateWorldOptions } from '../../src/core/world.js';

/**
 * Create a test world with sensible defaults.
 * Always use this in tests — never construct worlds manually.
 */
export function createTestWorld(options: CreateWorldOptions = {}) {
  return createGameWorld({
    seed: 42,
    floor: 1,
    ...options,
  });
}
