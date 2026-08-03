/**
 * Resolve the active floor's behavior flags for a world.
 *
 * Generic systems call this instead of branching on a hardcoded floor number or
 * floor id. Resolution prefers the explicit `world.floorId`, falls back to the
 * numeric `world.floor` (worlds built before a scenario assigns an id), and
 * finally to the all-off default when no manifest is registered.
 */
import { getFloorManifest } from '../shared/floor-registry.js';
import type { FloorManifestDef } from '../shared/floor-manifest.js';
import { DEFAULT_FLOOR_BEHAVIOR, type FloorBehavior } from '../shared/floor-behavior.js';
import type { GameWorld } from './world.js';

export type { FloorBehavior };

/** Manifest for the floor this world is currently running, if one is registered. */
export function getWorldFloorManifest(world: GameWorld): FloorManifestDef | undefined {
  return (
    (world.floorId ? getFloorManifest(world.floorId) : undefined) ??
    getFloorManifest(`floor${world.floor}`)
  );
}

/** Behavior flags for the floor this world is currently running. */
export function getWorldFloorBehavior(world: GameWorld): FloorBehavior {
  return getWorldFloorManifest(world)?.behavior ?? DEFAULT_FLOOR_BEHAVIOR;
}
