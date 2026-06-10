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

  /** Map width in pixels. */
  get widthPx(): number {
    return this.config.widthTiles * this.config.tileSizePx;
  }

  /** Map height in pixels. */
  get heightPx(): number {
    return this.config.heightTiles * this.config.tileSizePx;
  }

  /** Convert pixel coords to tile coords. */
  pixelToTile(px: number, py: number): { x: number; y: number } {
    return {
      x: Math.floor(px / this.config.tileSizePx),
      y: Math.floor(py / this.config.tileSizePx),
    };
  }

  /** Convert tile coords to pixel coords (center of tile). */
  tileToPixel(tx: number, ty: number): { x: number; y: number } {
    const half = this.config.tileSizePx / 2;
    return {
      x: tx * this.config.tileSizePx + half,
      y: ty * this.config.tileSizePx + half,
    };
  }

  /** Check if a pixel position is on a passable tile. */
  isPassableAt(px: number, py: number): boolean {
    const t = this.pixelToTile(px, py);
    return this.tileMap.isPassable(t.x, t.y);
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
