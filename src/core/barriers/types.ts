/**
 * Barrier primitive — first-class data types.
 *
 * A **barrier** is a dynamic, tile-granular overlay that blocks movement +
 * projectiles + pathfinding for entities but is TRANSPARENT to LOS/FOV. It is
 * intentionally decoupled from `TileMap.flags`:
 *   - Barriers are an OVERLAY, not a mutation. Underlying tile passability is
 *     never touched, so the "ring landed on walls, so no cage formed" class of
 *     bug is impossible by construction.
 *   - Any system can raise / drop a barrier at runtime (spawner arena, boss
 *     rooms, scripted encounters).
 *   - Barriers have no `Health` entity: `applyDamage` never sees them, so they
 *     are damage-immune by construction, satisfying the "impenetrable fence"
 *     part of the spec.
 *
 * The overlay is a plain `Set<number>` of tile-map indices plus a small
 * per-barrier record. Physics chokepoints (`FloorMap.isPassableAt`, projectile
 * cleanup, pathfinder `isTileTraversable`) consult the set directly; the set
 * is the single source of truth for "is there a barrier on this tile?".
 *
 * See ADR 0046 for the design rationale (overlay vs. flag mutation vs.
 * per-entity Barrier component).
 */

/**
 * Discriminates rendering / audio / feel between kinds of barrier. All kinds
 * behave IDENTICALLY at the physics layer — the primitive is not a place to
 * hang gameplay behaviour differences (that lives in the calling system, e.g.
 * a lava-wall would push damage from a separate hazard system).
 */
export type BarrierKind =
  /** Shimmering energy fence — the spawner arena's default aesthetic. */
  | 'fence'
  /** Solid force-field — reserved for boss encounters / scripted rooms. */
  | 'forcefield'
  /** Ephemeral wall — reserved for constructed-wall abilities. */
  | 'wall';

/**
 * Handle returned by every `create*Barrier` factory. Callers hold this to drop
 * the barrier later. The handle stores the underlying tile list so the
 * renderer + integration tests can iterate directly without re-computing
 * geometry.
 */
export interface BarrierHandle {
  /** Stable id assigned by the registry. Non-negative and monotonically increasing. */
  readonly id: number;
  /** Rendering / audio hint. */
  readonly kind: BarrierKind;
  /**
   * Tile indices (into `world.floorMap.tileMap.flags`) this barrier occupies.
   * Never mutated after creation — dropBarrier removes the entire set.
   */
  readonly tiles: readonly number[];
}

/**
 * Central registry. One instance is created per `GameWorld` and lives on
 * `world.barriers`. Physics consults {@link blockedTiles} for O(1) lookup;
 * {@link version} bumps on every mutation so renderers/pathfinders can
 * cheaply invalidate their local caches.
 *
 * The registry is intentionally allocation-light for the common case of
 * 0–1 active barriers: the `Map` stays empty and `blockedTiles` stays empty
 * on floors that never arm one.
 */
export interface BarrierRegistry {
  /**
   * All active barriers keyed by handle id. Handle ids are dense-ish but
   * non-reused per world lifetime — dropping barrier 3 does not recycle its
   * id when the next one is created. This keeps stale handles safe to compare.
   */
  readonly barriers: Map<number, BarrierHandle>;
  /**
   * Union of every tile occupied by any active barrier. Physics reads THIS,
   * not `barriers`. Kept in sync by every mutation helper in `registry.ts`.
   */
  readonly blockedTiles: Set<number>;
  /**
   * Bumped on every mutation. Renderers cache the last version they drew;
   * pathfinders can invalidate route caches by comparing. Overflow-safe for
   * the run's lifetime (JS Number).
   */
  version: number;
  /** Monotonically increasing handle id source. */
  nextId: number;
}
