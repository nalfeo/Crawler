/**
 * Room adjacency derivation for the dungeon generator.
 *
 * Flood-fills connected components over CORRIDOR + DOOR + CAVE_FLOOR terrain and
 * treats every room whose interior is orthogonally adjacent to such a component
 * as a mutual neighbor. Source of truth for the RoomGraph adjacency that
 * pathfinding, AI, and welcome-sign placement depend on.
 *
 * Extracted from DungeonGenerator.ts (behavior-preserving split).
 */

import { TerrainType } from '../../../../shared/map-types';
import { RoomGraph } from '../../RoomGraph';

/**
 * Derive room adjacency from the final tile state.
 *
 * Flood-fills connected components over CORRIDOR + DOOR + CAVE_FLOOR terrain and
 * treats every room whose interior is orthogonally adjacent to such a component
 * as a mutual neighbor. This is the source of truth for the RoomGraph adjacency that
 * pathfinding, AI, and welcome-sign placement depend on.
 *
 * Called AFTER all tile-modifying passes (cave carving, ensureRoomsReachable,
 * culling, door pruning) so that the resulting neighbor sets and door connectsTo
 * values reflect the fully-settled tile layout.
 *
 * Calling this function resets and rebuilds all existing neighbor/door data.
 */
export function computeRoomAdjacency(
  terrain: Uint8Array,
  roomGraph: RoomGraph,
  w: number,
  h: number,
): void {
  // All traversable floor terrain types count as connectors. CAVE_FLOOR is
  // included because cave carving can overwrite CORRIDOR tiles — those paths
  // are still fully navigable and must be counted for adjacency purposes.
  const isConnector = (idx: number): boolean =>
    terrain[idx] === TerrainType.CORRIDOR ||
    terrain[idx] === TerrainType.DOOR ||
    terrain[idx] === TerrainType.CAVE_FLOOR;

  const componentId = new Int32Array(w * h).fill(-1);
  const componentRooms: Set<number>[] = [];

  for (let startY = 0; startY < h; startY++) {
    for (let startX = 0; startX < w; startX++) {
      const startIdx = startY * w + startX;
      if (componentId[startIdx] !== -1 || !isConnector(startIdx)) continue;

      const cid = componentRooms.length;
      const roomsTouched = new Set<number>();
      const stack: number[] = [startIdx];
      componentId[startIdx] = cid;

      while (stack.length > 0) {
        const idx = stack.pop()!;
        const cx = idx % w;
        const cy = (idx - cx) / w;
        const adj: ReadonlyArray<readonly [number, number]> = [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ];
        for (const [nx, ny] of adj) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nIdx = ny * w + nx;
          // A room interior orthogonally adjacent to this connector is linked here.
          const roomAt = roomGraph.getRoomAt(nx, ny);
          if (roomAt !== -1) roomsTouched.add(roomAt);
          if (componentId[nIdx] === -1 && isConnector(nIdx)) {
            componentId[nIdx] = cid;
            stack.push(nIdx);
          }
        }
      }
      componentRooms.push(roomsTouched);
    }
  }

  // Build mutual adjacency: rooms sharing a corridor component are neighbors.
  const neighborSets: Set<number>[] = roomGraph.getAll().map(() => new Set<number>());
  for (const rooms of componentRooms) {
    const ids = [...rooms];
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        neighborSets[ids[a]!]!.add(ids[b]!);
        neighborSets[ids[b]!]!.add(ids[a]!);
      }
    }
  }

  // Persist neighbors and point each door at a room it actually reaches.
  // RoomData.doors/neighbors (and DoorLocation.connectsTo) are readonly, so
  // rebuild them as fresh values and write them back via Object.assign.
  const allRooms = roomGraph.getAll();
  for (let id = 0; id < allRooms.length; id++) {
    const room = roomGraph.get(id)!;
    const resolvedDoors = room.doors.map((door) => {
      const comp = componentId[door.y * w + door.x] ?? -1;
      let target = -1;
      if (comp !== -1) {
        for (const r of componentRooms[comp]!) {
          if (r !== id) {
            target = r;
            break;
          }
        }
      }
      return { ...door, connectsTo: target };
    });
    Object.assign(room, {
      doors: resolvedDoors,
      neighbors: [...neighborSets[id]!],
    });
  }
}
