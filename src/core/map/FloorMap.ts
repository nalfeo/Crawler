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
    this.visible = new Uint8Array(config.widthTiles * config.heightTiles);
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

  /** Check if a tile is visible to the player (from last FOV compute). */
  isVisible(tx: number, ty: number): boolean {
    const idx = this.tileMap.index(tx, ty);
    if (idx === -1) return false;
    return this.visible[idx] === 1;
  }

  /** Clear the visibility bitmap (called before each FOV recompute). */
  clearVisibility(): void {
    this.visible.fill(0);
  }

  /** Mark a tile as visible (called by the FOV system). */
  setVisible(tx: number, ty: number): void {
    const idx = this.tileMap.index(tx, ty);
    if (idx !== -1) this.visible[idx] = 1;
  }
}
