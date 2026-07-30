/**
 * FloorMap — composite data structure owning all map data for a single floor.
 *
 * Combines TileMap (physics/LOS), RoomGraph (semantics), terrain (visuals),
 * and FOV visibility bitmap into a single object attached to GameWorld.
 */

import type { MapConfig, FloorMapData, TerritoryZone } from '../../shared/map-types';
import { RoomRole } from '../../shared/map-types';
import { TileMap } from './TileMap';
import { RoomGraph } from './RoomGraph';

/**
 * Default FOV sub-tile factor. Each tile is split into `subFactor`×`subFactor`
 * sub-tiles; factor 2 keeps the historical quarter-tile (2×) resolution.
 */
export const DEFAULT_FOV_SUB_FACTOR = 2;

/**
 * Maximum selectable sub-tile factor. Factor 8 gives 4px cells at 32px tiles
 * (the finest "4×4 pixel" FOV); the default stays {@link DEFAULT_FOV_SUB_FACTOR}.
 */
export const MAX_FOV_SUB_FACTOR = 8;

/** Clamp an arbitrary value to a valid integer sub-tile factor. */
export function normalizeSubFactor(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_FOV_SUB_FACTOR;
  return Math.max(1, Math.min(MAX_FOV_SUB_FACTOR, Math.round(n)));
}

/**
 * Structural, import-free view of the live barrier state that backs the
 * lookups installed via {@link FloorMap.setBarrierLookup} /
 * {@link FloorMap.setBarrierPointLookup}.
 *
 * Its only purpose is to let `hasBarrierAtTile` / `hasBarrierAtPoint` answer
 * `false` **without invoking the lookup closure** when the backing collection
 * is provably empty. On a Floor-1 run those two methods are called 19.4 M and
 * 14.8 M times respectively and return `true` **zero** times, because the
 * registry stays empty for the whole run — so every one of those closure
 * invocations is pure waste.
 *
 * ## Why a live reference and not a cached boolean
 *
 * The sizes are read **fresh on every query**. There is deliberately no flag,
 * no `version` snapshot and no invalidation step, because a stale "no barriers
 * here" flag would mean a barrier raised mid-run silently stops blocking —
 * a gameplay bug the Floor-1 `RunStats` fingerprint could never catch (Floor 1
 * raises no barriers). Reading `Set.size` / `Map.size` consults exactly the
 * same ground truth the lookups themselves consult, so the gate cannot
 * disagree with them.
 *
 * The source is the **world**, not the registry object, so that reassigning
 * `world.barriers` (labs do this) is seen identically by the gate and by the
 * closure — the closure body reads `world.barriers` live too.
 *
 * Kept as a structural type so `FloorMap` retains **zero import dependency**
 * on `src/core/barriers` (see {@link FloorMap.setBarrierLookup}).
 */
export interface BarrierPresenceSource {
  readonly barriers: {
    /** Tile indices occupied by any live barrier — backs `isBarrierTile`. */
    readonly blockedTiles: { readonly size: number };
    /** Analytic (sub-tile) shapes — backs `isBarrierPointBlocked`. */
    readonly ringShapes: { readonly size: number };
  };
}

export class FloorMap implements FloorMapData {
  readonly config: MapConfig;
  readonly tileMap: TileMap;
  readonly roomGraph: RoomGraph;
  readonly terrain: Uint8Array;
  /**
   * Sub-tile visibility bitmap at `subFactor`× tile resolution.
   *
   * Indexed `hy * subWidth + hx` where `(hx, hy)` are sub-tile coordinates
   * (each tile splits into a `subFactor`×`subFactor` grid). Entry is 1 when the
   * sub-tile was visible during the last FOV pass. Reallocated by
   * {@link setSubFactor}.
   *
   * Use `isVisible(tx, ty)` for O(1) tile-level queries (any sub-tile lit),
   * `isVisibleAt(wx, wy)` for world-position sub-tile queries,
   * or `isVisibleSubtile(hx, hy)` for raw sub-tile queries.
   */
  visible: Uint8Array;
  /**
   * Persistent "discovered" bitmap at `subFactor`× resolution — sub-tiles ever
   * seen since the floor loaded. Set alongside `visible` by the FOV system but,
   * unlike `visible`, NOT cleared each frame, so explored terrain can render as
   * a dim memory instead of full black. Reallocated by {@link setSubFactor}.
   */
  discovered: Uint8Array;
  /**
   * O(1) tile-level visibility cache — mirrors the OR of each tile's sub-tiles
   * so `isVisible(tx, ty)` stays constant-time regardless of `subFactor`
   * (gameplay/AI/culling queries must not scale with fog resolution).
   */
  private tileVisible: Uint8Array;
  /** O(1) tile-level discovered cache (mirror of {@link discovered}). */
  private tileDiscovered: Uint8Array;
  private _subFactor: number;
  readonly playerSpawn: { readonly x: number; readonly y: number };
  /** Floor 2 family spawn-influence zones (empty on other floors). */
  readonly territoryZones: ReadonlyArray<TerritoryZone>;

  /**
   * Bounding box of sub-tile cells set by the most recent FOV pass (sub-tile
   * coords, inclusive). Used by {@link clearVisibility} to zero only the
   * previously-visible window instead of the full bitmap.
   *
   * Invariant: maxX < minX (or maxY < minY) means the box is empty — no
   * cells have been set since the last clear.  Initialised to empty state.
   */
  private lastFovMinX = 0;
  private lastFovMinY = 0;
  private lastFovMaxX = -1;
  private lastFovMaxY = -1;

  constructor(
    config: MapConfig,
    tileMap: TileMap,
    roomGraph: RoomGraph,
    terrain: Uint8Array,
    playerSpawn: { x: number; y: number },
    subFactor: number = DEFAULT_FOV_SUB_FACTOR,
    territoryZones: ReadonlyArray<TerritoryZone> = [],
  ) {
    this.config = config;
    this.tileMap = tileMap;
    this.roomGraph = roomGraph;
    this.terrain = terrain;
    this._subFactor = normalizeSubFactor(subFactor);
    const subCells = config.widthTiles * this._subFactor * config.heightTiles * this._subFactor;
    this.visible = new Uint8Array(subCells);
    this.discovered = new Uint8Array(subCells);
    this.tileVisible = new Uint8Array(config.widthTiles * config.heightTiles);
    this.tileDiscovered = new Uint8Array(config.widthTiles * config.heightTiles);
    this.playerSpawn = playerSpawn;
    this.territoryZones = territoryZones;
  }

  /** Delegate to TileMap for FloorMapData interface. */
  get flags(): Uint8Array {
    return this.tileMap.flags;
  }

  /** Delegate to RoomGraph for FloorMapData interface. */
  get rooms() {
    return this.roomGraph.getAll();
  }

  /** The boss/stair room — boss spawns here and stairs appear after boss death. Null for biomes without discrete rooms. */
  get bossStairRoom() {
    return this.roomGraph.getFirstRoomByRole(RoomRole.BOSS_STAIR) ?? null;
  }

  /** The safe room — objective marker, healing/merchant. Null for biomes without discrete rooms. */
  get safeRoom() {
    return this.roomGraph.getFirstRoomByRole(RoomRole.SAFE) ?? null;
  }

  /** The player spawn room. Null for biomes without discrete rooms. */
  get spawnRoom() {
    return this.roomGraph.getFirstRoomByRole(RoomRole.SPAWN) ?? null;
  }

  /** Map width in tiles. */
  get width(): number {
    return this.config.widthTiles;
  }

  /** Map height in tiles. */
  get height(): number {
    return this.config.heightTiles;
  }

  /** Current FOV sub-tile factor (each tile splits into `subFactor`² sub-tiles). */
  get subFactor(): number {
    return this._subFactor;
  }

  /** Sub-tile grid width (`subFactor`× tile width). */
  get subWidth(): number {
    return this.config.widthTiles * this._subFactor;
  }

  /** Sub-tile grid height (`subFactor`× tile height). */
  get subHeight(): number {
    return this.config.heightTiles * this._subFactor;
  }

  /** Map width in feet. */
  get widthFt(): number {
    return this.config.widthTiles * this.config.tileSizeFt;
  }

  /** Map height in feet. */
  get heightFt(): number {
    return this.config.heightTiles * this.config.tileSizeFt;
  }

  /** Convert feet world coords to tile coords. */
  worldToTile(x: number, y: number): { x: number; y: number } {
    return {
      x: Math.floor(x / this.config.tileSizeFt),
      y: Math.floor(y / this.config.tileSizeFt),
    };
  }

  /**
   * Convert feet world coords to sub-tile coords.
   *
   * Each tile is `subFactor` sub-tiles wide and tall, so sub-tile coordinates
   * run from 0 to `subWidth - 1` / `subHeight - 1`.
   */
  worldToSubTile(x: number, y: number): { x: number; y: number } {
    const subSizeFt = this.config.tileSizeFt / this._subFactor;
    return {
      x: Math.floor(x / subSizeFt),
      y: Math.floor(y / subSizeFt),
    };
  }

  /** Convert tile coords to feet world coords (center of tile). */
  tileToWorld(tx: number, ty: number): { x: number; y: number } {
    const half = this.config.tileSizeFt / 2;
    return {
      x: tx * this.config.tileSizeFt + half,
      y: ty * this.config.tileSizeFt + half,
    };
  }

  /**
   * Optional barrier lookup — installed by the ECS wiring so
   * `isPassableAt` also refuses tiles occupied by a dynamic barrier
   * (see `src/core/barriers/`). Returns `true` iff the tile at `tileX,tileY`
   * has ANY live barrier on it. Kept as a callback rather than a direct
   * `BarrierRegistry` reference so FloorMap has zero import dependency on
   * the barrier module — the registry can grow without churning the map
   * layer.
   */
  private barrierLookup: ((tileX: number, tileY: number) => boolean) | null = null;

  /**
   * Live, import-free view of the barrier state backing {@link barrierLookup}
   * and {@link barrierPointLookup}. `null` means "no presence information" —
   * the lookups are then always invoked, which is the pre-existing behaviour
   * and what every non-registry lookup (tests, labs, hand-installed stubs)
   * gets. See {@link BarrierPresenceSource}.
   *
   * Set only as part of a `setBarrier*Lookup` call so a presence source can
   * never outlive the lookup it describes.
   */
  private barrierTilePresence: BarrierPresenceSource | null = null;

  /**
   * Attach the barrier-tile predicate. Called once by the world wiring at
   * floor-load; passing `null` detaches. `isPassableAt` and
   * `isTilePassableWithBarriers` consult it.
   *
   * `presence` is optional and defaults to `null`. Pass it **only** when `fn`
   * answers purely from `presence.barriers.blockedTiles` — i.e. when
   * `blockedTiles.size === 0` implies `fn` returns `false` for every tile.
   * Doing so lets `hasBarrierAtTile` skip the call entirely on the empty-
   * registry fast path. Omitting it is always safe and always correct.
   *
   * Because `presence` is a parameter of this same call, re-installing a
   * different lookup (or detaching with `setBarrierLookup(null)`) clears it
   * automatically — a presence source can never be left attached to a lookup
   * it does not describe.
   */
  setBarrierLookup(
    fn: ((tileX: number, tileY: number) => boolean) | null,
    presence: BarrierPresenceSource | null = null,
  ): void {
    this.barrierLookup = fn;
    this.barrierTilePresence = presence;
  }

  /**
   * Optional feet-precision barrier lookup — installed alongside
   * {@link barrierLookup} by the ECS wiring. Returns `true` iff the world
   * point `(xFt, yFt)` sits inside an ANALYTIC barrier shape (e.g. a 1 ft-thick
   * ring wall). This is the sub-tile chokepoint: tile-granular barriers are too
   * coarse for a thin circular wall, so `isPassableAt` consults this in
   * addition to the tile lookup. Kept as a callback for the same zero-import
   * reason as {@link barrierLookup}.
   */
  private barrierPointLookup: ((xFt: number, yFt: number) => boolean) | null = null;

  /**
   * Live presence view backing {@link barrierPointLookup} — the analytic
   * (sub-tile) half of the same idea as {@link barrierTilePresence}. Gated on
   * `ringShapes.size`.
   */
  private barrierPointPresence: BarrierPresenceSource | null = null;

  /**
   * Attach the feet-precision barrier predicate. Called once by the world
   * wiring at floor-load; passing `null` detaches.
   *
   * `presence` follows the same contract as in {@link setBarrierLookup}: pass
   * it only when `fn` answers purely from `presence.barriers.ringShapes`, so
   * that `ringShapes.size === 0` implies `fn` returns `false` everywhere.
   */
  setBarrierPointLookup(
    fn: ((xFt: number, yFt: number) => boolean) | null,
    presence: BarrierPresenceSource | null = null,
  ): void {
    this.barrierPointLookup = fn;
    this.barrierPointPresence = presence;
  }

  /**
   * True iff the world point `(xFt, yFt)` sits inside an analytic barrier
   * shape. Returns `false` when no lookup is attached (the no-overlay happy
   * path). Movement collision is point-based, so this is the only surface that
   * needs feet precision — pathfinding stays tile-granular (an analytic ring
   * owns no tiles, which is acceptable: everyone is inside the arena and
   * movement collision enforces the wall).
   *
   * Fast path: when a {@link BarrierPresenceSource} is attached and it holds
   * zero analytic shapes, the answer is `false` by construction and the lookup
   * is skipped. The size is re-read every call, so a shape raised mid-run is
   * seen immediately.
   */
  hasBarrierAtPoint(xFt: number, yFt: number): boolean {
    const presence = this.barrierPointPresence;
    if (presence !== null && presence.barriers.ringShapes.size === 0) return false;
    return this.barrierPointLookup !== null ? this.barrierPointLookup(xFt, yFt) : false;
  }

  /**
   * Public accessor primarily for pathfinding — check whether a tile is
   * blocked by a barrier without going through the world-position wrapper.
   * Returns `false` when no lookup has been attached (i.e. no barriers on
   * this floor), which is the "no overlay" happy path.
   *
   * Fast path: when a {@link BarrierPresenceSource} is attached and it holds
   * zero blocked tiles, the answer is `false` by construction and the lookup
   * is skipped. The size is re-read every call, so a barrier raised mid-run is
   * seen immediately.
   */
  hasBarrierAtTile(tileX: number, tileY: number): boolean {
    const presence = this.barrierTilePresence;
    if (presence !== null && presence.barriers.blockedTiles.size === 0) return false;
    return this.barrierLookup !== null ? this.barrierLookup(tileX, tileY) : false;
  }

  /** Check if a feet world position is on a passable tile. */
  isPassableAt(x: number, y: number): boolean {
    const t = this.worldToTile(x, y);
    if (!this.tileMap.isPassable(t.x, t.y)) return false;
    // Barriers overlay tile passability: even on a normally-walkable tile,
    // a live barrier blocks movement. Underlying flags are untouched — see
    // ADR 0050 for why we don't mutate them.
    if (this.hasBarrierAtTile(t.x, t.y)) return false;
    // Analytic (sub-tile) barriers — e.g. a 1 ft-thick ring wall — are queried
    // at feet precision so a thin wall blocks exactly instead of snapping to
    // a 4 ft tile. No-op fast path when no analytic barrier is installed.
    return !this.hasBarrierAtPoint(x, y);
  }

  /**
   * Check whether a straight line between two feet world positions is
   * unobstructed by opaque tiles. Converts both endpoints to tile coordinates
   * and delegates to `TileMap.lineOfSight`. Used by combat targeting so weapons
   * never fire through walls at enemies in the next room.
   */
  hasLineOfSight(x0: number, y0: number, x1: number, y1: number): boolean {
    const from = this.worldToTile(x0, y0);
    const to = this.worldToTile(x1, y1);
    return this.tileMap.lineOfSight(from.x, from.y, to.x, to.y);
  }

  /**
   * Check if a tile has any visible sub-tile (from last FOV compute).
   *
   * O(1): reads the tile-level cache (updated alongside the sub-tile bitmap by
   * `setVisible`), so gameplay/AI/culling cost never scales with `subFactor`.
   * Use `isVisibleAt` or `isVisibleSubtile` when you need sub-tile precision.
   */
  isVisible(tx: number, ty: number): boolean {
    if (tx < 0 || tx >= this.config.widthTiles || ty < 0 || ty >= this.config.heightTiles) {
      return false;
    }

    return this.tileVisible[ty * this.config.widthTiles + tx] !== 0;
  }

  /** True when the current FOV pass has exposed at least one tile. */
  hasVisibleTiles(): boolean {
    return this.lastFovMaxX >= this.lastFovMinX && this.lastFovMaxY >= this.lastFovMinY;
  }

  /**
   * Check if the exact sub-tile containing world position `(wx, wy)` is
   * visible. More precise than `isVisible` — use for entity and lighting
   * queries where sub-tile accuracy matters.
   */
  isVisibleAt(wx: number, wy: number): boolean {
    const ht = this.worldToSubTile(wx, wy);
    return this.isVisibleSubtile(ht.x, ht.y);
  }

  /**
   * Check if a specific sub-tile coordinate `(hx, hy)` is visible.
   * Sub-tile coords: `hx ∈ [0, subWidth)`, `hy ∈ [0, subHeight)`.
   */
  isVisibleSubtile(hx: number, hy: number): boolean {
    if (hx < 0 || hx >= this.subWidth || hy < 0 || hy >= this.subHeight) return false;
    return this.visible[hy * this.subWidth + hx] !== 0;
  }

  /**
   * Mark a sub-tile as both visible and discovered in one call.
   *
   * Exactly equivalent to `setVisible(hx, hy)` followed by
   * `setDiscovered(hx, hy)` — the FOV system's only write pattern — but shares
   * the bounds check, the sub-tile index, and the tile-index derivation that
   * the two separate calls each recompute. FOV writes this for every lit
   * sub-tile (up to ~10 K per pass at `subFactor` 2), so the duplicated work
   * was measurable in the sim profile.
   *
   * Callers that need only one of the two bitmaps must keep using the
   * individual setters.
   */
  markVisibleAndDiscovered(hx: number, hy: number): void {
    const sw = this.subWidth;
    if (hx < 0 || hx >= sw || hy < 0 || hy >= this.subHeight) return;
    const subIdx = hy * sw + hx;
    this.visible[subIdx] = 1;
    this.discovered[subIdx] = 1;

    const sf = this._subFactor;
    const tileIdx = Math.floor(hy / sf) * this.config.widthTiles + Math.floor(hx / sf);
    this.tileVisible[tileIdx] = 1;
    this.tileDiscovered[tileIdx] = 1;

    // Expand the bounding box that clearVisibility() will zero next frame.
    if (hx < this.lastFovMinX) this.lastFovMinX = hx;
    if (hy < this.lastFovMinY) this.lastFovMinY = hy;
    if (hx > this.lastFovMaxX) this.lastFovMaxX = hx;
    if (hy > this.lastFovMaxY) this.lastFovMaxY = hy;
  }

  /**
   * Mark **every** sub-tile of tile `(tx, ty)` as visible and discovered.
   *
   * Used by the FOV system for opaque tiles. Shadowcasting only reports the
   * sub-tiles a ray physically lands on, so a wall would otherwise be revealed
   * (and lit) as a ragged partial block with the rest of the same tile still
   * black. A wall the player can see is seen as a whole tile.
   *
   * Cheap: `subFactor` row fills plus one tile-cache write, and the FOV system
   * calls it at most once per opaque tile per pass.
   */
  markTileVisibleAndDiscovered(tx: number, ty: number): void {
    const tw = this.config.widthTiles;
    if (tx < 0 || tx >= tw || ty < 0 || ty >= this.config.heightTiles) return;

    const sf = this._subFactor;
    const sw = this.subWidth;
    const hx0 = tx * sf;
    const hy0 = ty * sf;
    const hx1 = hx0 + sf - 1;
    const hy1 = hy0 + sf - 1;
    for (let hy = hy0; hy <= hy1; hy++) {
      const rowStart = hy * sw + hx0;
      const rowEnd = rowStart + sf;
      this.visible.fill(1, rowStart, rowEnd);
      this.discovered.fill(1, rowStart, rowEnd);
    }

    const tileIdx = ty * tw + tx;
    this.tileVisible[tileIdx] = 1;
    this.tileDiscovered[tileIdx] = 1;

    // Expand the bounding box that clearVisibility() will zero next frame.
    if (hx0 < this.lastFovMinX) this.lastFovMinX = hx0;
    if (hy0 < this.lastFovMinY) this.lastFovMinY = hy0;
    if (hx1 > this.lastFovMaxX) this.lastFovMaxX = hx1;
    if (hy1 > this.lastFovMaxY) this.lastFovMaxY = hy1;
  }

  /**
   * Clear the per-frame visibility bitmap (called before each FOV recompute).
   * Does NOT clear `discovered` — explored terrain persists for the floor.
   *
   * Performance: instead of zeroing the entire sub-tile bitmap (up to 134 K
   * cells for a 240×140 map at subFactor=2), only the bounding box of cells
   * set during the previous FOV pass is zeroed.  The FOV radius is 25 tiles
   * → the active window is at most (2×25+1)²×subFactor² ≈ 10 K sub-cells,
   * compared to ~134 K without bounding, a ~13× reduction.
   */
  clearVisibility(): void {
    const minX = this.lastFovMinX;
    const minY = this.lastFovMinY;
    const maxX = this.lastFovMaxX;
    const maxY = this.lastFovMaxY;
    if (maxX >= minX && maxY >= minY) {
      // Zero only the previously-visible sub-tile rows.
      const sw = this.subWidth;
      for (let hy = minY; hy <= maxY; hy++) {
        const rowBase = hy * sw;
        this.visible.fill(0, rowBase + minX, rowBase + maxX + 1);
      }
      // Zero the corresponding tile-level cache entries (inclusive tile range).
      const sf = this._subFactor;
      const tMinX = Math.floor(minX / sf);
      const tMinY = Math.floor(minY / sf);
      const tMaxX = Math.floor(maxX / sf);
      const tMaxY = Math.floor(maxY / sf);
      const tw = this.config.widthTiles;
      for (let ty = tMinY; ty <= tMaxY; ty++) {
        const rowBase = ty * tw;
        this.tileVisible.fill(0, rowBase + tMinX, rowBase + tMaxX + 1);
      }
    }
    // Reset bounds so the next FOV pass builds a fresh bounding box.
    this.lastFovMinX = this.subWidth;
    this.lastFovMinY = this.subHeight;
    this.lastFovMaxX = -1;
    this.lastFovMaxY = -1;
  }

  /**
   * Mark a sub-tile as visible (called by the FOV system). Takes sub-tile
   * coordinates `(hx, hy)` in the current `subFactor`× grid. Also updates the
   * O(1) tile-level cache read by `isVisible`, and expands the per-frame
   * bounding box used by {@link clearVisibility}.
   */
  setVisible(hx: number, hy: number): void {
    if (hx < 0 || hx >= this.subWidth || hy < 0 || hy >= this.subHeight) return;
    this.visible[hy * this.subWidth + hx] = 1;
    const tx = Math.floor(hx / this._subFactor);
    const ty = Math.floor(hy / this._subFactor);
    this.tileVisible[ty * this.config.widthTiles + tx] = 1;
    // Expand the bounding box that clearVisibility() will zero next frame.
    if (hx < this.lastFovMinX) this.lastFovMinX = hx;
    if (hy < this.lastFovMinY) this.lastFovMinY = hy;
    if (hx > this.lastFovMaxX) this.lastFovMaxX = hx;
    if (hy > this.lastFovMaxY) this.lastFovMaxY = hy;
  }

  /**
   * Check if a tile has ever been discovered. O(1) tile-level query — the
   * persistent memory used to render explored-but-out-of-FOV terrain dim.
   */
  isDiscovered(tx: number, ty: number): boolean {
    if (tx < 0 || tx >= this.config.widthTiles || ty < 0 || ty >= this.config.heightTiles) {
      return false;
    }

    return this.tileDiscovered[ty * this.config.widthTiles + tx] !== 0;
  }

  /** O(1) tile-index lookup used by deterministic frontier searches. */
  isDiscoveredIndex(index: number): boolean {
    return index >= 0 && index < this.tileDiscovered.length && this.tileDiscovered[index] !== 0;
  }

  /** Check if the sub-tile containing world position `(wx, wy)` was discovered. */
  isDiscoveredAt(wx: number, wy: number): boolean {
    const ht = this.worldToSubTile(wx, wy);
    return this.isDiscoveredSubtile(ht.x, ht.y);
  }

  /** Check if a specific sub-tile coordinate `(hx, hy)` was discovered. */
  isDiscoveredSubtile(hx: number, hy: number): boolean {
    if (hx < 0 || hx >= this.subWidth || hy < 0 || hy >= this.subHeight) return false;
    return this.discovered[hy * this.subWidth + hx] !== 0;
  }

  /**
   * Mark a sub-tile as discovered (called by the FOV system alongside
   * `setVisible`). Persists until the floor changes / `setSubFactor` reallocs.
   */
  setDiscovered(hx: number, hy: number): void {
    if (hx < 0 || hx >= this.subWidth || hy < 0 || hy >= this.subHeight) return;
    this.discovered[hy * this.subWidth + hx] = 1;
    const tx = Math.floor(hx / this._subFactor);
    const ty = Math.floor(hy / this._subFactor);
    this.tileDiscovered[ty * this.config.widthTiles + tx] = 1;
  }

  /** Clear all discovered memory (both sub-tile and tile-level caches). */
  clearDiscovered(): void {
    this.discovered.fill(0);
    this.tileDiscovered.fill(0);
  }

  /**
   * Reveal the entire map (mark every tile visible). Convenience for labs /
   * snapshots that render without fog; keeps the O(1) tile cache in sync.
   * Also sets the FOV bounding box to the full map so a subsequent
   * {@link clearVisibility} call correctly zeroes the whole bitmap.
   */
  revealAll(): void {
    this.visible.fill(1);
    this.tileVisible.fill(1);
    // Full map is now "visible", so the clear bounding box must cover it all.
    this.lastFovMinX = 0;
    this.lastFovMinY = 0;
    this.lastFovMaxX = this.subWidth - 1;
    this.lastFovMaxY = this.subHeight - 1;
  }

  /**
   * Change the FOV sub-tile factor at runtime (dynamic granularity).
   *
   * No-op when the (normalized) factor is unchanged — preserving `discovered`.
   * Otherwise reallocates the sub-tile buffers zeroed (discovered memory is
   * reset; callers should recompute FOV + rebuild any dependent light field).
   * Returns the normalized factor actually applied.
   */
  setSubFactor(n: number): number {
    const next = normalizeSubFactor(n);
    if (next === this._subFactor) return next;
    this._subFactor = next;
    const subCells = this.config.widthTiles * next * this.config.heightTiles * next;
    this.visible = new Uint8Array(subCells);
    this.discovered = new Uint8Array(subCells);
    this.tileVisible.fill(0);
    this.tileDiscovered.fill(0);
    // Reset the FOV bounding box — old coords no longer map to the new resolution.
    this.lastFovMinX = this.subWidth;
    this.lastFovMinY = this.subHeight;
    this.lastFovMaxX = -1;
    this.lastFovMaxY = -1;
    return next;
  }
}
