/**
 * FloorMap — composite data structure owning all map data for a single floor.
 *
 * Combines TileMap (physics/LOS), RoomGraph (semantics), terrain (visuals),
 * and FOV visibility bitmap into a single object attached to GameWorld.
 */

import type { MapConfig, FloorMapData } from '../../shared/map-types';
import { RoomRole } from '../../shared/map-types';
import { TileMap } from './TileMap';
import { RoomGraph } from './RoomGraph';

export class FloorMap implements FloorMapData {
  readonly config: MapConfig;
  readonly tileMap: TileMap;
  readonly roomGraph: RoomGraph;
  readonly terrain: Uint8Array;
  /**
   * Quarter-tile visibility bitmap at 2× tile resolution.
   *
   * Indexed `hy * (2 * widthTiles) + hx` where `(hx, hy)` are sub-tile
   * coordinates (each tile is split into a 2×2 grid of quarter-tiles).
   * Entry is 1 when the quarter-tile was visible during the last FOV pass.
   *
   * Use `isVisible(tx, ty)` for tile-level queries (any quarter lit),
   * `isVisibleAt(wx, wy)` for world-position sub-tile queries,
   * or `isVisibleSubtile(hx, hy)` for raw sub-tile queries.
   */
  readonly visible: Uint8Array;
  readonly playerSpawn: { readonly x: number; readonly y: number };

  constructor(
    config: MapConfig,
    tileMap: TileMap,
    roomGraph: RoomGraph,
    terrain: Uint8Array,
    playerSpawn: { x: number; y: number },
  ) {
    this.config = config;
    this.tileMap = tileMap;
    this.roomGraph = roomGraph;
    this.terrain = terrain;
    // Quarter-tile resolution: 4 entries per original tile (2× in each axis).
    this.visible = new Uint8Array(config.widthTiles * 2 * config.heightTiles * 2);
    this.playerSpawn = playerSpawn;
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

  /** Quarter-tile grid width (2× tile width). */
  get subWidth(): number {
    return this.config.widthTiles * 2;
  }

  /** Quarter-tile grid height (2× tile height). */
  get subHeight(): number {
    return this.config.heightTiles * 2;
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
   * Convert feet world coords to quarter-tile (sub-tile) coords.
   *
   * Each tile is 2 sub-tiles wide and 2 sub-tiles tall, so sub-tile
   * coordinates run from 0 to `subWidth - 1` / `subHeight - 1`.
   */
  worldToSubTile(x: number, y: number): { x: number; y: number } {
    const halfTile = this.config.tileSizeFt / 2;
    return {
      x: Math.floor(x / halfTile),
      y: Math.floor(y / halfTile),
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

  /** Check if a feet world position is on a passable tile. */
  isPassableAt(x: number, y: number): boolean {
    const t = this.worldToTile(x, y);
    return this.tileMap.isPassable(t.x, t.y);
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
   * Check if a tile has any visible quarter (from last FOV compute).
   *
   * Returns true when at least one of the four quarter-tiles that compose
   * tile `(tx, ty)` was marked visible. Use `isVisibleAt` or
   * `isVisibleSubtile` when you need quarter-tile precision.
   */
  isVisible(tx: number, ty: number): boolean {
    if (tx < 0 || tx >= this.config.widthTiles || ty < 0 || ty >= this.config.heightTiles) {
      return false;
    }
    const sw = this.subWidth;
    const hx = tx * 2;
    const hy = ty * 2;
    return (
      this.visible[hy * sw + hx] !== 0 ||
      this.visible[hy * sw + hx + 1] !== 0 ||
      this.visible[(hy + 1) * sw + hx] !== 0 ||
      this.visible[(hy + 1) * sw + hx + 1] !== 0
    );
  }

  /**
   * Check if the exact quarter-tile containing world position `(wx, wy)` is
   * visible. More precise than `isVisible` — use for entity and lighting
   * queries where sub-tile accuracy matters.
   */
  isVisibleAt(wx: number, wy: number): boolean {
    const ht = this.worldToSubTile(wx, wy);
    return this.isVisibleSubtile(ht.x, ht.y);
  }

  /**
   * Check if a specific quarter-tile coordinate `(hx, hy)` is visible.
   * Sub-tile coords: `hx ∈ [0, subWidth)`, `hy ∈ [0, subHeight)`.
   */
  isVisibleSubtile(hx: number, hy: number): boolean {
    if (hx < 0 || hx >= this.subWidth || hy < 0 || hy >= this.subHeight) return false;
    return this.visible[hy * this.subWidth + hx] !== 0;
  }

  /** Clear the visibility bitmap (called before each FOV recompute). */
  clearVisibility(): void {
    this.visible.fill(0);
  }

  /**
   * Mark a quarter-tile as visible (called by the FOV system).
   *
   * Takes sub-tile coordinates `(hx, hy)` — the FOV runs at 2× tile
   * resolution, so each callback coordinate is a quarter-tile.
   */
  setVisible(hx: number, hy: number): void {
    if (hx < 0 || hx >= this.subWidth || hy < 0 || hy >= this.subHeight) return;
    this.visible[hy * this.subWidth + hx] = 1;
  }
}
