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

    it('should mark tiles as visible', () => {
      const floor = createSmallFloorMap();
      floor.setVisible(5, 5);
      expect(floor.isVisible(5, 5)).toBe(true);
      expect(floor.isVisible(0, 0)).toBe(false);
    });

    it('should clear visibility', () => {
      const floor = createSmallFloorMap();
      floor.setVisible(5, 5);
      floor.clearVisibility();
      expect(floor.isVisible(5, 5)).toBe(false);
    });

    it('should handle out-of-bounds gracefully', () => {
      const floor = createSmallFloorMap();
      expect(floor.isVisible(-1, 0)).toBe(false);
      floor.setVisible(-1, 0); // should not throw
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
