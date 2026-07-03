import { describe, it, expect } from 'vitest';
import { RoomGraph } from '../../src/core/map/RoomGraph';
import { RoomRole } from '../../src/shared/map-types';

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

  describe('role management', () => {
    it('new rooms default to NORMAL role', () => {
      const graph = new RoomGraph();
      graph.add({ x: 0, y: 0, width: 10, height: 10 });
      expect(graph.get(0)!.role).toBe(RoomRole.NORMAL);
    });

    it('setRole updates room role', () => {
      const graph = new RoomGraph();
      graph.add({ x: 0, y: 0, width: 10, height: 10 });
      graph.setRole(0, RoomRole.BOSS_STAIR);
      expect(graph.get(0)!.role).toBe(RoomRole.BOSS_STAIR);
    });

    it('getFirstRoomByRole returns the first matching room', () => {
      const graph = new RoomGraph();
      graph.add({ x: 0, y: 0, width: 10, height: 10 });
      graph.add({ x: 20, y: 0, width: 10, height: 10 });
      graph.setRole(1, RoomRole.SAFE);

      const safe = graph.getFirstRoomByRole(RoomRole.SAFE);
      expect(safe).toBeDefined();
      expect(safe!.id).toBe(1);
    });

    it('getFirstRoomByRole returns undefined when no match', () => {
      const graph = new RoomGraph();
      graph.add({ x: 0, y: 0, width: 10, height: 10 });
      expect(graph.getFirstRoomByRole(RoomRole.BOSS_STAIR)).toBeUndefined();
    });

    it('getRoomsByRole returns all matching rooms', () => {
      const graph = new RoomGraph();
      graph.add({ x: 0, y: 0, width: 10, height: 10 });
      graph.add({ x: 20, y: 0, width: 10, height: 10 });
      graph.add({ x: 40, y: 0, width: 10, height: 10 });
      graph.setRole(0, RoomRole.NORMAL);
      graph.setRole(1, RoomRole.SAFE);
      graph.setRole(2, RoomRole.SAFE);

      const safeRooms = graph.getRoomsByRole(RoomRole.SAFE);
      expect(safeRooms).toHaveLength(2);
      expect(safeRooms.map((r) => r.id)).toEqual([1, 2]);
    });

    it('add() accepts an explicit role', () => {
      const graph = new RoomGraph();
      graph.add({ x: 0, y: 0, width: 10, height: 10 }, [], [], RoomRole.SPAWN);
      expect(graph.get(0)!.role).toBe(RoomRole.SPAWN);
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
      graph.add({ x: 11, y: 0, width: 10, height: 10 }, [{ x: 10, y: 5, connectsTo: 0 }], [0]);

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

    describe('interiorCells branch', () => {
      const cells: ReadonlyArray<{ x: number; y: number }> = [
        { x: 100, y: 100 },
        { x: 101, y: 100 },
        { x: 100, y: 101 },
      ];

      it('samples from the explicit interiorCells mask when present', () => {
        const graph = new RoomGraph();
        // Bounds are far from the cell coordinates, so a returned interiorCells
        // value proves the mask is used rather than the bounds-inset fallback.
        graph.add(
          { x: 0, y: 0, width: 10, height: 10 },
          [],
          [],
          RoomRole.NORMAL,
          undefined,
          0,
          cells,
        );
        const rng = { nextInt: (min: number, _max: number) => min }; // index 0
        expect(graph.getRandomInteriorTile(0, rng)).toEqual({ x: 100, y: 100 });
      });

      it('returns the interiorCells entry at the rng-selected index', () => {
        const graph = new RoomGraph();
        graph.add(
          { x: 0, y: 0, width: 10, height: 10 },
          [],
          [],
          RoomRole.NORMAL,
          undefined,
          0,
          cells,
        );
        const rng = { nextInt: (_min: number, max: number) => max }; // last index
        expect(graph.getRandomInteriorTile(0, rng)).toEqual(cells[cells.length - 1]);
      });

      it('asks the rng for an index across the full [0, length-1] range', () => {
        const graph = new RoomGraph();
        graph.add(
          { x: 0, y: 0, width: 10, height: 10 },
          [],
          [],
          RoomRole.NORMAL,
          undefined,
          0,
          cells,
        );
        let captured: [number, number] | null = null;
        const rng = {
          nextInt: (min: number, max: number) => {
            captured = [min, max];
            return min;
          },
        };
        graph.getRandomInteriorTile(0, rng);
        expect(captured).toEqual([0, cells.length - 1]);
      });

      it('falls back to the bounds-inset when interiorCells is empty', () => {
        const graph = new RoomGraph();
        graph.add(
          { x: 10, y: 10, width: 20, height: 20 },
          [],
          [],
          RoomRole.NORMAL,
          undefined,
          0,
          [],
        );
        const rng = { nextInt: (min: number, _max: number) => min };
        // Empty mask → inset path (interior starts at bounds + 1), not a cell value.
        expect(graph.getRandomInteriorTile(0, rng)).toEqual({ x: 11, y: 11 });
      });
    });
  });

  describe('addNeighbor', () => {
    it('appends a neighbour without mutating the original array', () => {
      const graph = new RoomGraph();
      graph.add({ x: 0, y: 0, width: 10, height: 10 }, [], [1]); // room 0
      graph.add({ x: 20, y: 0, width: 10, height: 10 }); // room 1
      graph.add({ x: 40, y: 0, width: 10, height: 10 }); // room 2

      const before = graph.get(0)!.neighbors;
      graph.addNeighbor(0, 2);
      const after = graph.get(0)!.neighbors;

      expect(after).toEqual([1, 2]);
      expect(after).not.toBe(before); // readonly-array rebuild, not in-place mutation
      expect(before).toEqual([1]); // original array untouched
      expect(graph.getConnectedRooms(0).map((r) => r.id)).toEqual([1, 2]);
    });

    it('de-duplicates neighbours already present (no-op)', () => {
      const graph = new RoomGraph();
      graph.add({ x: 0, y: 0, width: 10, height: 10 }, [], [1]);
      graph.addNeighbor(0, 1); // already present
      expect(graph.get(0)!.neighbors).toEqual([1]);
      graph.addNeighbor(0, 2);
      graph.addNeighbor(0, 2); // duplicate
      expect(graph.get(0)!.neighbors).toEqual([1, 2]);
    });

    it('is a no-op for an invalid room ID', () => {
      const graph = new RoomGraph();
      graph.add({ x: 0, y: 0, width: 10, height: 10 });
      expect(() => graph.addNeighbor(99, 0)).not.toThrow();
      expect(graph.count).toBe(1);
      expect(graph.get(0)!.neighbors).toEqual([]);
    });

    it('invalidates the spatial cache and keeps lookups correct after rebuild', () => {
      const graph = new RoomGraph();
      graph.add({ x: 0, y: 0, width: 10, height: 10 }); // room 0
      graph.add({ x: 20, y: 20, width: 10, height: 10 }); // room 1
      expect(graph.getRoomAt(5, 5)).toBe(0); // primes the spatial cache

      graph.addNeighbor(0, 1); // replaces room 0's object → must invalidate cache

      // Next query rebuilds the cache; spatial lookups still resolve correctly.
      expect(graph.getRoomAt(5, 5)).toBe(0);
      expect(graph.getRoomAt(25, 25)).toBe(1);
    });
  });
});
