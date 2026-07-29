/**
 * RoomGraph — semantic overlay of rooms and their connections.
 *
 * Stores room bounds, door locations, and adjacency for AI patrolling,
 * enemy spawning, and narrative systems. Does not own tile data.
 */

import type { RoomData, RoomBounds, DoorLocation } from '../../shared/map-types';
import { RoomRole } from '../../shared/map-types';

export class RoomGraph {
  private readonly rooms: RoomData[];
  /** Spatial lookup cache — maps "x,y" to room index. Built lazily. */
  private spatialCache: Map<string, number> | null = null;

  constructor(rooms: RoomData[] = []) {
    this.rooms = rooms;
  }

  /** Number of rooms. */
  get count(): number {
    return this.rooms.length;
  }

  /** Get all rooms (read-only). */
  getAll(): readonly RoomData[] {
    return this.rooms;
  }

  /** Get a room by its index. */
  get(id: number): RoomData | undefined {
    return this.rooms[id];
  }

  /** Add a room and return its assigned ID. */
  add(
    bounds: RoomBounds,
    doors: DoorLocation[] = [],
    neighbors: number[] = [],
    role: RoomRole = RoomRole.NORMAL,
    label?: string,
    familyIndex?: number,
    interiorCells?: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  ): number {
    const id = this.rooms.length;
    this.rooms.push({ id, bounds, doors, neighbors, role, label, familyIndex, interiorCells });
    this.spatialCache = null; // invalidate cache
    return id;
  }

  /** Assign or update the semantic role of a room. */
  setRole(id: number, role: RoomRole): void {
    const room = this.rooms[id];
    if (room) {
      room.role = role;
    }
  }

  /**
   * Replace a room's geometry (bounds/doors/role/label) in place, rebuilding the
   * underlying record so readonly fields stay honest, and invalidate the spatial
   * cache so {@link getRoomAt} reflects the new footprint. Used by prefab
   * set-piece carving, which resizes a room's bounds to the prefab footprint.
   */
  updateRoom(
    id: number,
    patch: Partial<Pick<RoomData, 'bounds' | 'doors' | 'role' | 'label' | 'interiorCells'>>,
  ): void {
    const room = this.rooms[id];
    if (!room) return;
    this.rooms[id] = { ...room, ...patch };
    this.spatialCache = null; // invalidate cache
  }

  /**
   * Append a neighbour to `id`'s adjacency list, rebuilding the underlying
   * array (RoomData.neighbors is declared readonly, so we replace the array
   * instead of mutating it). No-op if the neighbour is already present.
   */
  addNeighbor(id: number, neighborId: number): void {
    const room = this.rooms[id];
    if (!room) return;
    if (room.neighbors.includes(neighborId)) return;
    const next = [...room.neighbors, neighborId];
    this.rooms[id] = { ...room, neighbors: next };
    this.spatialCache = null;
  }

  /** Return the first room that has the given role, or undefined if none. */
  getFirstRoomByRole(role: RoomRole): RoomData | undefined {
    return this.rooms.find((r) => r.role === role);
  }

  /** Return all rooms that have the given role. */
  getRoomsByRole(role: RoomRole): readonly RoomData[] {
    return this.rooms.filter((r) => r.role === role);
  }

  /** Find which room a tile belongs to (interior only, not walls). Returns -1 if none. */
  getRoomAt(tileX: number, tileY: number): number {
    if (!this.spatialCache) {
      this.buildSpatialCache();
    }
    return this.spatialCache!.get(`${tileX},${tileY}`) ?? -1;
  }

  /** Get rooms connected to a given room via doors/corridors. */
  getConnectedRooms(roomId: number): readonly RoomData[] {
    const room = this.rooms[roomId];
    if (!room) return [];
    return room.neighbors.map((id) => this.rooms[id]).filter((r): r is RoomData => r !== undefined);
  }

  /** Get all door locations across all rooms. */
  getAllDoors(): DoorLocation[] {
    const seen = new Set<string>();
    const doors: DoorLocation[] = [];
    for (const room of this.rooms) {
      for (const door of room.doors) {
        const key = `${door.x},${door.y}`;
        if (!seen.has(key)) {
          seen.add(key);
          doors.push(door);
        }
      }
    }
    return doors;
  }

  /** Get a random floor tile within a room's interior (excluding walls). */
  getRandomInteriorTile(
    roomId: number,
    rng: { nextInt(min: number, max: number): number },
  ): { x: number; y: number } | null {
    const room = this.rooms[roomId];
    if (!room) return null;
    // Irregular-shape rooms (e.g. cave caverns) pre-populate an explicit interior mask;
    // fall back to the bounds-inset for rectangular rooms.
    if (room.interiorCells && room.interiorCells.length > 0) {
      const idx = rng.nextInt(0, room.interiorCells.length - 1);
      const cell = room.interiorCells[idx]!;
      return { x: cell.x, y: cell.y };
    }
    const { x, y, width, height } = room.bounds;
    // Interior = 1 tile inset from bounds
    const ix = x + 1;
    const iy = y + 1;
    const iw = Math.max(1, width - 2);
    const ih = Math.max(1, height - 2);
    return {
      x: rng.nextInt(ix, ix + iw - 1),
      y: rng.nextInt(iy, iy + ih - 1),
    };
  }

  private buildSpatialCache(): void {
    this.spatialCache = new Map();
    for (const room of this.rooms) {
      if (room.interiorCells && room.interiorCells.length > 0) {
        for (const cell of room.interiorCells) {
          this.spatialCache.set(`${cell.x},${cell.y}`, room.id);
        }
        continue;
      }
      const { x, y, width, height } = room.bounds;
      // Interior tiles (1 tile inset from walls)
      for (let ty = y + 1; ty < y + height - 1; ty++) {
        for (let tx = x + 1; tx < x + width - 1; tx++) {
          this.spatialCache.set(`${tx},${ty}`, room.id);
        }
      }
    }
  }
}
