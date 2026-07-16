import { createGameWorld, type CreateWorldOptions } from '../../src/core/world.js';

/**
 * Create a test world with sensible defaults.
 * Always use this in tests — never construct worlds manually.
 */
export function createTestWorld(options: CreateWorldOptions = {}) {
  const world = createGameWorld({
    seed: 42,
    floor: 1,
    entityCapacityMode: 'test',
    ...options,
  });
  // Default test worlds to legacy (no-telegraph) enemy-projectile behavior so
  // the large pre-existing test suite keeps exercising immediate-fire timing
  // unmodified. Tests targeting the telegraph feature itself opt in
  // explicitly via `world.enemyTelegraphMs = <n>` (or a per-mob override).
  world.enemyTelegraphMs = 0;
  return world;
}
