/**
 * Barrier primitive — public entry point.
 *
 * A barrier is a first-class engine building block that any system (spawner
 * arena, boss room, scripted encounter) can raise/drop at runtime. Barriers
 * block movement + projectiles + pathfinding but let LOS pass; they never
 * mutate `TileMap.flags`, so a ring that lands on walls still forms a valid
 * closed cage without leaks.
 *
 * See ADR 0046 (`docs/knowledge/adr/0046-dynamic-barrier-primitive.md`) for
 * the design rationale and the physics-integration surface (movement,
 * projectile cleanup, pathfinder, LOS/FOV).
 *
 * Usage:
 * ```ts
 * import { createRingBarrier, dropBarrier } from '../../core/barriers/index.js';
 *
 * const handle = createRingBarrier(world, cx, cy, radiusFt, 'fence');
 * // ... later ...
 * dropBarrier(world, handle);
 * ```
 */
export type { BarrierHandle, BarrierKind, BarrierRegistry } from './types.js';
export {
  createBarrierRegistry,
  createPolyBarrier,
  createRingBarrier,
  createRoomBarrier,
  dropBarrier,
  isBarrierAt,
  isBarrierTile,
  type BarrierWorld,
} from './registry.js';
export { collectRingTiles, collectRoomDoorwayTiles, collectRoomInteriorTiles } from './geometry.js';
export { attachBarriersToFloorMap } from './wiring.js';
