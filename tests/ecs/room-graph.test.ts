import { describe, it, expect } from 'vitest';
import { RoomGraph } from '../../src/core/map/RoomGraph';

describe('RoomGraph', () => {
  it('should start empty', () => {
    const graph = new RoomGraph();
    expect(graph.count).toBe(0);
    expect(graph.getAll()).toEqual([]);
  });

  it('should add rooms with sequential IDs', () => {
    const graph = new RoomGraph();
    const id0 = graph.add({ x: 0, y: 0, width: 10, height: 10 });
    const id1 = graph.add({ x: 20, y: 0, width: 8, height: 8 });
    expect(id0).toBe(0);
    expect(id1).toBe(1);
    expect(graph.count).toBe(2);
  });

  it('should get room by ID', () => {
    const graph = new RoomGraph();
    graph.add({ x: 5, y: 5, width: 10, height: 10 });
    const room = graph.get(0);
    expect(room).toBeDefined();
    expect(room!.bounds.x).toBe(5);
    expect(room!.bounds.width).toBe(10);
  });

  it('should return undefined for invalid ID', () => {
    const graph = new RoomGraph();
    expect(graph.get(0)).toBeUndefined();
    expect(graph.get(-1)).toBeUndefined();
  });

  describe('getRoomAt', () => {
    it('should find room containing a tile (interior only)', () => {
      const graph = new RoomGraph();
      // Room from (0,0) to (9,9), interior is (1,1) to (8,8)
      graph.add({ x: 0, y: 0, width: 10, height: 10 });

      expect(graph.getRoomAt(5, 5)).toBe(0); // interior
      expect(graph.getRoomAt(1, 1)).toBe(0); // interior edge
      expect(graph.getRoomAt(8, 8)).toBe(0); // interior edge
    });

    it('should return -1 for wall tiles', () => {
      const graph = new RoomGraph();
      graph.add({ x: 0, y: 0, width: 10, height: 10 });

      expect(graph.getRoomAt(0, 0)).toBe(-1); // wall corner
      expect(graph.getRoomAt(9, 0)).toBe(-1); // wall edge
    });

    it('should return -1 for tiles outside all rooms', () => {
      const graph = new RoomGraph();
      graph.add({ x: 0, y: 0, width: 5, height: 5 });

      expect(graph.getRoomAt(10, 10)).toBe(-1);
      expect(graph.getRoomAt(-1, -1)).toBe(-1);
    });

    it('should distinguish between multiple rooms', () => {
      const graph = new RoomGraph();
      graph.add({ x: 0, y: 0, width: 10, height: 10 });
      graph.add({ x: 20, y: 20, width: 10, height: 10 });

      expect(graph.getRoomAt(5, 5)).toBe(0);
      expect(graph.getRoomAt(25, 25)).toBe(1);
      expect(graph.getRoomAt(15, 15)).toBe(-1); // between rooms
    });
  });

  describe('getConnectedRooms', () => {
    it('should return connected rooms via neighbors', () => {
      const graph = new RoomGraph();
      graph.add({ x: 0, y: 0, width: 10, height: 10 }, [], [1]);
      graph.add({ x: 15, y: 0, width: 10, height: 10 }, [], [0]);

      const connected = graph.getConnectedRooms(0);
      expect(connected).toHaveLength(1);
      expect(connected[0]!.id).toBe(1);
    });

    it('should return empty for room with no neighbors', () => {
      const graph = new RoomGraph();
      graph.add({ x: 0, y: 0, width: 10, height: 10 });
      expect(graph.getConnectedRooms(0)).toEqual([]);
    });

    it('should return empty for invalid room ID', () => {
      const graph = new RoomGraph();
      expect(graph.getConnectedRooms(99)).toEqual([]);
    });
  });

  describe('getAllDoors', () => {
    it('should collect unique doors across rooms', () => {
      const graph = new RoomGraph();
      const door = { x: 10, y: 5, connectsTo: 1 };
      graph.add({ x: 0, y: 0, width: 10, height: 10 }, [door], [1]);
      // Same door referenced by connected room
      graph.add(
        { x: 11, y: 0, width: 10, height: 10 },
        [{ x: 10, y: 5, connectsTo: 0 }],
        [0],
      );

      const doors = graph.getAllDoors();
      expect(doors).toHaveLength(1); // deduplicated
      expect(doors[0]!.x).toBe(10);
      expect(doors[0]!.y).toBe(5);
    });

    it('should return empty for roomless graph', () => {
      const graph = new RoomGraph();
      expect(graph.getAllDoors()).toEqual([]);
    });
  });

  describe('getRandomInteriorTile', () => {
    it('should return a tile within room interior', () => {
      const graph = new RoomGraph();
      graph.add({ x: 10, y: 10, width: 20, height: 20 });
      const rng = { nextInt: (min: number, _max: number) => min };

      const tile = graph.getRandomInteriorTile(0, rng);
      expect(tile).toBeDefined();
      expect(tile!.x).toBeGreaterThanOrEqual(11);
      expect(tile!.y).toBeGreaterThanOrEqual(11);
      expect(tile!.x).toBeLessThan(29);
      expect(tile!.y).toBeLessThan(29);
    });

    it('should return null for invalid room ID', () => {
      const graph = new RoomGraph();
      const rng = { nextInt: (min: number, _max: number) => min };
      expect(graph.getRandomInteriorTile(99, rng)).toBeNull();
    });
  });
});
