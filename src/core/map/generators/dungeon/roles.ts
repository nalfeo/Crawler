/**
 * Room role pre-assignment for the dungeon generator.
 *
 * Assigns SPAWN / BOSS_STAIR / SAFE roles before room-variety post-processing so
 * that special rooms can be excluded from shape transforms and wall protection.
 * Candidate selection enforces a minimum size and a connectivity-safety check so
 * that sealing a special room's perimeter can never disconnect other rooms.
 *
 * Extracted from DungeonGenerator.ts (behavior-preserving split).
 */

import { TileFlags, RoomRole } from '../../../../shared/map-types';
import { TileMap } from '../../TileMap';
import { RoomGraph } from '../../RoomGraph';

/**
 * Assign room roles before room-variety post-processing so that SAFE and
 * BOSS_STAIR rooms can be excluded from shape transforms and wall protection.
 *
 * Candidates are selected by:
 * 1. Meeting the minimum size (minWidth × minHeight bounds, walls included).
 * 2. Being farthest from the spawn room centre.
 * 3. Preserving dungeon connectivity when their perimeter is sealed — sealing a
 *    perimeter that disconnects other rooms would cause cullIsolatedFloorTiles to
 *    wall off those rooms' interiors. Any candidate that would break connectivity
 *    is skipped in favour of the next best candidate.
 *
 * Fallback order when the ideal candidate is unavailable:
 *   1. Min-size + connectivity-safe (farthest first)
 *   2. Any-size + connectivity-safe (farthest first)
 *   3. Farthest regardless (original behaviour, for tiny test maps with no safe option)
 */
export function preAssignRoles(
  roomGraph: RoomGraph,
  tileMap: TileMap,
  terrain: Uint8Array,
  w: number,
  minWidth: number,
  minHeight: number,
): void {
  roomGraph.setRole(0, RoomRole.SPAWN);
  if (roomGraph.count < 2) return;

  const h = terrain.length / w;
  const spawnRoom = roomGraph.get(0)!;
  const refX = Math.floor(spawnRoom.bounds.x + spawnRoom.bounds.width / 2);
  const refY = Math.floor(spawnRoom.bounds.y + spawnRoom.bounds.height / 2);

  type ScoredRoom = { id: number; distanceSq: number };

  const scored: ScoredRoom[] = roomGraph
    .getAll()
    .filter((r) => r.id !== 0)
    .map((room) => {
      const cx = Math.floor(room.bounds.x + room.bounds.width / 2);
      const cy = Math.floor(room.bounds.y + room.bounds.height / 2);
      return { id: room.id, distanceSq: (cx - refX) ** 2 + (cy - refY) ** 2 };
    });
  scored.sort((a, b) => b.distanceSq - a.distanceSq);

  /**
   * Compute the set of tile indices that sealSpecialRoomPerimeters would wall for
   * this room (passable, non-door perimeter tiles).
   */
  function buildSealSet(roomId: number): ReadonlySet<number> {
    const room = roomGraph.get(roomId)!;
    const { x, y, width, height } = room.bounds;
    const doorIdxSet = new Set(room.doors.map((d) => d.y * w + d.x));
    const sealed = new Set<number>();
    const addIfSealable = (tx: number, ty: number): void => {
      const idx = ty * w + tx;
      if (doorIdxSet.has(idx)) return;
      const flags = tileMap.flags[idx]!;
      if ((flags & TileFlags.PASSABLE) !== 0 && (flags & TileFlags.DOOR) === 0) {
        sealed.add(idx);
      }
    };
    for (let tx = x; tx < x + width; tx++) {
      addIfSealable(tx, y);
      addIfSealable(tx, y + height - 1);
    }
    for (let ty = y + 1; ty < y + height - 1; ty++) {
      addIfSealable(x, ty);
      addIfSealable(x + width - 1, ty);
    }
    return sealed;
  }

  /**
   * Return true when treating `sealedTiles` as walls still leaves every room
   * (other than spawn) reachable from the spawn centre via passable/door tiles.
   * Rooms with no doors are skipped (they cannot be door-reachable by definition).
   */
  function sealingPreservesConnectivity(
    sealedTiles: ReadonlySet<number>,
    extraSealedTiles?: ReadonlySet<number>,
  ): boolean {
    if (sealedTiles.size === 0 && (!extraSealedTiles || extraSealedTiles.size === 0)) return true;

    const startIdx = refY * w + refX;
    const visited = new Uint8Array(w * h);
    visited[startIdx] = 1;
    const stack = [startIdx];

    while (stack.length > 0) {
      const idx = stack.pop()!;
      const cx = idx % w;
      const cy = (idx - cx) / w;
      for (const [nx, ny] of [
        [cx + 1, cy],
        [cx - 1, cy],
        [cx, cy + 1],
        [cx, cy - 1],
      ] as [number, number][]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nIdx = ny * w + nx;
        if (visited[nIdx]) continue;
        if (sealedTiles.has(nIdx) || extraSealedTiles?.has(nIdx)) continue;
        const flags = tileMap.flags[nIdx]!;
        if ((flags & TileFlags.PASSABLE) === 0 && (flags & TileFlags.DOOR) === 0) continue;
        visited[nIdx] = 1;
        stack.push(nIdx);
      }
    }

    for (const room of roomGraph.getAll()) {
      if (room.id === 0 || room.doors.length === 0) continue;
      if (!room.doors.some((d) => visited[d.y * w + d.x] === 1)) return false;
    }
    return true;
  }

  /**
   * Pick the best candidate for a special role from the given pool.
   * `alreadySealedTiles` holds tiles that will be sealed by previously-assigned
   * special rooms; the new candidate's seal set is combined with it before the
   * connectivity check.
   *
   * Priority:
   *   1. Meets min size AND connectivity-safe (farthest first)
   *   2. Any size AND connectivity-safe (farthest first)
   *   3. Farthest regardless (fallback for tiny maps)
   */
  function pickCandidate(
    pool: ScoredRoom[],
    alreadySealedTiles: ReadonlySet<number>,
  ): ScoredRoom | undefined {
    const meetsSize = (r: ScoredRoom): boolean => {
      const room = roomGraph.get(r.id)!;
      return room.bounds.width >= minWidth && room.bounds.height >= minHeight;
    };
    const safeCache = new Map<number, boolean>();
    const isSafe = (r: ScoredRoom): boolean => {
      if (safeCache.has(r.id)) return safeCache.get(r.id)!;
      const sealSet = buildSealSet(r.id);
      const result =
        sealSet.size === 0 && alreadySealedTiles.size === 0
          ? true
          : sealingPreservesConnectivity(sealSet, alreadySealedTiles);
      safeCache.set(r.id, result);
      return result;
    };

    for (const r of pool) {
      if (meetsSize(r) && isSafe(r)) return r;
    }
    for (const r of pool) {
      if (isSafe(r)) return r;
    }
    return pool[0]; // fallback: farthest (preserves old behaviour on tiny maps)
  }

  const bossCandidate = pickCandidate(scored, new Set<number>());
  if (bossCandidate) {
    roomGraph.setRole(bossCandidate.id, RoomRole.BOSS_STAIR);
  }

  if (roomGraph.count >= 3) {
    const remainingPool = scored.filter((r) => r.id !== bossCandidate?.id);
    const bossSealTiles = bossCandidate ? buildSealSet(bossCandidate.id) : new Set<number>();
    const safeCandidate = pickCandidate(remainingPool, bossSealTiles);
    if (safeCandidate) roomGraph.setRole(safeCandidate.id, RoomRole.SAFE);
  }
}
