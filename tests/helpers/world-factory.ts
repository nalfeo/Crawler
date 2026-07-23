import { createGameWorld, type CreateWorldOptions } from '../../src/core/world.js';
import { generatedEquipmentRunKeyFromSeed } from '../../src/shared/generated-equipment-types.js';

export interface CreateTestWorldOptions extends Omit<
  CreateWorldOptions,
  'generatedEquipmentRunKey'
> {
  /**
   * Defaults to a deterministic run key derived from `seed` — matching real
   * gameplay, where `MainGameScene` always derives one from the world seed —
   * so Floor 1/2 resolve-at-unlock reward bundles (equipment + lootBox) work
   * out of the box in tests without every call site wiring one up. Pass
   * `null` explicitly to opt out and exercise the "registry unconfigured"
   * fail-closed path.
   */
  generatedEquipmentRunKey?: string | null;
}

/**
 * Create a test world with sensible defaults.
 * Always use this in tests — never construct worlds manually.
 */
export function createTestWorld(options: CreateTestWorldOptions = {}) {
  const { generatedEquipmentRunKey, seed = 42, ...rest } = options;
  const resolvedRunKey =
    generatedEquipmentRunKey === null
      ? undefined
      : (generatedEquipmentRunKey ?? generatedEquipmentRunKeyFromSeed(seed));
  const world = createGameWorld({
    seed,
    floor: 1,
    entityCapacityMode: 'test',
    ...rest,
    generatedEquipmentRunKey: resolvedRunKey,
  });
  // Default test worlds to legacy (no-telegraph) enemy-projectile behavior so
  // the large pre-existing test suite keeps exercising immediate-fire timing
  // unmodified. Tests targeting the telegraph feature itself opt in
  // explicitly via `world.enemyTelegraphMs = <n>` (or a per-mob override).
  world.enemyTelegraphMs = 0;
  return world;
}
