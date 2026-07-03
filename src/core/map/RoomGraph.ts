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
  ): number {
    const id = this.rooms.length;
    this.rooms.push({ id, bounds, doors, neighbors, role, label, familyIndex });
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
