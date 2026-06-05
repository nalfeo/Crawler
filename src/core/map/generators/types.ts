/**
 * MapGenerator interface — all biome generators implement this contract.
 *
 * Generators are pure functions: given config + RNG, they produce a FloorMap.
 * No side effects, no rendering, no ECS dependencies.
 */

import type { MapConfig } from '../../../shared/map-types';
import type { SeededRandom } from '../../../shared/random';
import type { FloorMap } from '../FloorMap';

export interface MapGenerator {
  /** Human-readable name for debugging and labs. */
  readonly name: string;
  /** Generate a complete FloorMap from configuration and seeded RNG. */
  generate(config: MapConfig, rng: SeededRandom): FloorMap;
}
