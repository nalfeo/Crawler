import { describe, it, expect } from 'vitest';
import { FloorMap } from '../../src/core/map/FloorMap';
import { TileMap } from '../../src/core/map/TileMap';
import { RoomGraph } from '../../src/core/map/RoomGraph';
import { TilePresets, DEFAULT_MAP_CONFIG, TerrainType } from '../../src/shared/map-types';

function createSmallFloorMap() {
  const config = { ...DEFAULT_MAP_CONFIG, widthTiles: 20, heightTiles: 15 };
  const tileMap = new TileMap(20, 15);
  tileMap.fill(TilePresets.FLOOR);
  const terrain = new Uint8Array(20 * 15);
  terrain.fill(TerrainType.STONE_FLOOR);
  const roomGraph = new RoomGraph();
  roomGraph.add({ x: 2, y: 2, width: 8, height: 6 });
  return new FloorMap(config, tileMap, roomGraph, terrain, { x: 5, y: 5 });
}

describe('FloorMap', () => {
  it('should expose correct dimensions', () => {
    const floor = createSmallFloorMap();
    expect(floor.width).toBe(20);
    expect(floor.height).toBe(15);
    expect(floor.widthFt).toBe(20 * 4);
    expect(floor.heightFt).toBe(15 * 4);
  });

  it('should delegate flags to TileMap', () => {
    const floor = createSmallFloorMap();
    expect(floor.flags).toBe(floor.tileMap.flags);
  });

  it('should delegate rooms to RoomGraph', () => {
    const floor = createSmallFloorMap();
    expect(floor.rooms).toHaveLength(1);
    expect(floor.rooms[0]!.bounds.x).toBe(2);
  });

  it('should store player spawn', () => {
    const floor = createSmallFloorMap();
    expect(floor.playerSpawn).toEqual({ x: 5, y: 5 });
  });

  describe('worldToTile', () => {
    it('should convert world coords to tile coords', () => {
      const floor = createSmallFloorMap();
      expect(floor.worldToTile(0, 0)).toEqual({ x: 0, y: 0 });
      expect(floor.worldToTile(4, 4)).toEqual({ x: 1, y: 1 });
      expect(floor.worldToTile(6, 6)).toEqual({ x: 1, y: 1 }); // within same tile
      expect(floor.worldToTile(8, 12)).toEqual({ x: 2, y: 3 });
    });
  });

  describe('tileToWorld', () => {
    it('should convert tile coords to world center', () => {
      const floor = createSmallFloorMap();
      expect(floor.tileToWorld(0, 0)).toEqual({ x: 2, y: 2 });
      expect(floor.tileToWorld(1, 1)).toEqual({ x: 6, y: 6 });
    });
  });

  describe('isPassableAt', () => {
    it('should check passability at world coordinates', () => {
      const floor = createSmallFloorMap();
      // All tiles are floor (passable)
      expect(floor.isPassableAt(12.5, 12.5)).toBe(true);

      // Set a wall
      floor.tileMap.setFlags(3, 3, TilePresets.WALL);
      expect(floor.isPassableAt(3 * 4 + 1, 3 * 4 + 1)).toBe(false);
    });
  });

  describe('visibility', () => {
    it('should start fully dark', () => {
      const floor = createSmallFloorMap();
      expect(floor.isVisible(5, 5)).toBe(false);
    });

    it('should mark quarter-tiles visible and expose them via isVisible', () => {
      const floor = createSmallFloorMap();
      // Tile (5,5) has sub-tiles at hx ∈ {10,11}, hy ∈ {10,11}.
      // Setting any one sub-tile should make isVisible(5,5) return true.
      floor.setVisible(10, 10);
      expect(floor.isVisible(5, 5)).toBe(true);
      expect(floor.isVisible(0, 0)).toBe(false);
    });

    it('should clear visibility', () => {
      const floor = createSmallFloorMap();
      floor.setVisible(10, 10);
      floor.clearVisibility();
      expect(floor.isVisible(5, 5)).toBe(false);
    });

    it('should handle out-of-bounds gracefully', () => {
      const floor = createSmallFloorMap();
      expect(floor.isVisible(-1, 0)).toBe(false);
      floor.setVisible(-1, 0); // should not throw
    });

    it('isVisibleSubtile checks exact quarter-tile', () => {
      const floor = createSmallFloorMap();
      floor.setVisible(10, 10);
      expect(floor.isVisibleSubtile(10, 10)).toBe(true);
      expect(floor.isVisibleSubtile(11, 10)).toBe(false);
      expect(floor.isVisibleSubtile(10, 11)).toBe(false);
    });

    it('isVisibleAt resolves world position to quarter-tile (tileSizeFt=4, halfTile=2)', () => {
      const floor = createSmallFloorMap();
      // tileSizeFt = 4; halfTile = 2.
      // Tile (5,5) world centre ≈ (22, 22) ft.
      // worldToSubTile(20, 20) → hx=floor(20/2)=10, hy=10.
      floor.setVisible(10, 10);
      expect(floor.isVisibleAt(20, 20)).toBe(true);
      // Adjacent quarter (hx=11): world x ∈ [22, 24) → not set → false.
      expect(floor.isVisibleAt(22, 20)).toBe(false);
    });

    it('visible bitmap is 4× the tile count', () => {
      const floor = createSmallFloorMap();
      expect(floor.visible.length).toBe(floor.width * floor.height * 4);
      expect(floor.subWidth).toBe(floor.width * 2);
      expect(floor.subHeight).toBe(floor.height * 2);
    });
  });

  describe('hasLineOfSight', () => {
    it('is clear between two world positions over open floor', () => {
      const floor = createSmallFloorMap();
      // tile (2,5) -> tile (9,5), centered within tiles (×4 + 2).
      expect(floor.hasLineOfSight(2 * 4 + 2, 5 * 4 + 2, 9 * 4 + 2, 5 * 4 + 2)).toBe(true);
    });

    it('is blocked when a wall sits between the world endpoints', () => {
      const floor = createSmallFloorMap();
      floor.tileMap.setFlags(5, 5, TilePresets.WALL);
      expect(floor.hasLineOfSight(2 * 4 + 2, 5 * 4 + 2, 9 * 4 + 2, 5 * 4 + 2)).toBe(false);
    });

    it('opens up again once the blocking door is opened', () => {
      const floor = createSmallFloorMap();
      floor.tileMap.setFlags(5, 5, TilePresets.DOOR_CLOSED);
      expect(floor.hasLineOfSight(2 * 4 + 2, 5 * 4 + 2, 9 * 4 + 2, 5 * 4 + 2)).toBe(false);
      floor.tileMap.openDoor(5, 5);
      expect(floor.hasLineOfSight(2 * 4 + 2, 5 * 4 + 2, 9 * 4 + 2, 5 * 4 + 2)).toBe(true);
    });
  });
});
