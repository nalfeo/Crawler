/**
 * Room-shape variety for the dungeon generator.
 *
 * Applies round (ellipse) and L-shaped interiors to eligible rooms when room
 * variety is enabled. RNG consumption is kept identical for special rooms (where
 * L-shapes are skipped) so the seed stream stays intact across all rooms.
 *
 * Extracted from DungeonGenerator.ts (behavior-preserving split). Depends on
 * `doors.ensureDoorAccess` to repair doorways after reshaping.
 */

import type { DoorLocation } from '../../../../shared/map-types';
import { TilePresets, TerrainType, RoomRole } from '../../../../shared/map-types';
import { SeededRandom } from '../../../../shared/random';
import { TileMap } from '../../TileMap';
import { RoomGraph } from '../../RoomGraph';
import { ensureDoorAccess } from './doors';

/**
 * Apply shape variety to rooms: round (ellipse) or L-shaped.
 * Only rooms with interior size ≥ 5×5 are candidates.
 * Rooms smaller than the threshold keep their rectangular shape.
 *
 * SAFE and BOSS_STAIR rooms may receive an ellipse shape as long as the room
 * is large enough (volume check above). L-shapes are skipped for these rooms
 * because removing an entire quadrant would shrink the usable safe-room /
 * boss-fight area too aggressively; the RNG is still consumed so the sequence
 * for subsequent rooms stays identical to an unguarded run.
 */
export function applyRoomShapes(
  tileMap: TileMap,
  terrain: Uint8Array,
  roomGraph: RoomGraph,
  w: number,
  rng: SeededRandom,
): void {
  for (const room of roomGraph.getAll()) {
    const { x: rx, y: ry, width: rw, height: rh } = room.bounds;
    // Interior dimensions: (rw-2) × (rh-2); require at least 5×5 interior
    if (rw < 7 || rh < 7) continue;

    const roll = rng.next();

    if (roll < 0.25) {
      // Ellipses are allowed for all rooms, including special ones.
      applyEllipseShape(tileMap, terrain, w, rx, ry, rw, rh, room.doors);
    } else if (roll < 0.5) {
      if (room.role === RoomRole.SAFE || room.role === RoomRole.BOSS_STAIR) {
        // L-shapes are skipped for special rooms — consume RNG identically to keep stream intact.
        selectLShapeQuadrant(rx, ry, rw, rh, room.doors, rng);
      } else {
        applyLShape(tileMap, terrain, w, rx, ry, rw, rh, room.doors, rng);
      }
    }
    // 50% stay rectangular — also includes any oversized rooms naturally
  }
}

/**
 * Carve room interior into an ellipse, walling off tiles outside the
 * inscribed ellipse. Boundary tiles (where doors live) are untouched.
 */
export function applyEllipseShape(
  tileMap: TileMap,
  terrain: Uint8Array,
  w: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  doors: readonly DoorLocation[],
): void {
  // Centre of the room (may be fractional)
  const cx = rx + (rw - 1) / 2;
  const cy = ry + (rh - 1) / 2;
  // Semi-radii of the inscribed ellipse (reach to just inside the boundary)
  const ex = (rw - 2) / 2;
  const ey = (rh - 2) / 2;

  for (let ty = ry + 1; ty < ry + rh - 1; ty++) {
    for (let tx = rx + 1; tx < rx + rw - 1; tx++) {
      const dx = (tx - cx) / ex;
      const dy = (ty - cy) / ey;
      if (dx * dx + dy * dy > 1.0) {
        const idx = ty * w + tx;
        terrain[idx] = TerrainType.STONE_WALL;
        tileMap.flags[idx] = TilePresets.WALL;
      }
    }
  }

  ensureDoorAccess(tileMap, terrain, w, rx, ry, rw, rh, doors);
}

/**
 * Select the interior quadrant to remove for an L-shape.
 * Penalizes quadrants adjacent to doors; breaks ties with RNG.
 * Returns null if the room is too small for an L-shape (no RNG consumed).
 */
export function selectLShapeQuadrant(
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  doors: readonly DoorLocation[],
  rng: SeededRandom,
): number | null {
  const halfW = Math.floor((rw - 2) / 2);
  const halfH = Math.floor((rh - 2) / 2);
  if (halfW < 1 || halfH < 1) return null;

  // Quadrant corners: 0=TL 1=TR 2=BL 3=BR
  // Penalize the quadrant closest to each door to avoid removing floor tiles near connectivity points.
  const quadrantScore = [0, 0, 0, 0];
  for (const door of doors) {
    const isLeft = door.x <= rx + halfW;
    const isTop = door.y <= ry + halfH;
    if (isTop && isLeft) quadrantScore[0]! += 2;
    if (isTop && !isLeft) quadrantScore[1]! += 2;
    if (!isTop && isLeft) quadrantScore[2]! += 2;
    if (!isTop && !isLeft) quadrantScore[3]! += 2;
  }

  // Pick the quadrant with the lowest door-adjacency score; break ties with rng.
  // Guard: when only one candidate exists, skip rng to avoid nextInt(0,0) ambiguity.
  const minScore = Math.min(...quadrantScore);
  const candidates = quadrantScore
    .map((s, i) => ({ s, i }))
    .filter((e) => e.s === minScore)
    .map((e) => e.i);
  return candidates.length === 1
    ? candidates[0]!
    : candidates[rng.nextInt(0, candidates.length - 1)]!;
}

/**
 * Remove one interior quadrant of the room to produce an L-shape.
 * The quadrant furthest from any door is selected to keep connectivity safe.
 * After removal, tiles immediately inside each door are guaranteed floor.
 */
export function applyLShape(
  tileMap: TileMap,
  terrain: Uint8Array,
  w: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  doors: readonly DoorLocation[],
  rng: SeededRandom,
): void {
  const quadrant = selectLShapeQuadrant(rx, ry, rw, rh, doors, rng);
  if (quadrant === null) return;

  // Interior bounds (exclusive)
  const ix1 = rx + 1;
  const iy1 = ry + 1;
  const ix2 = rx + rw - 1; // exclusive right edge of interior
  const iy2 = ry + rh - 1; // exclusive bottom edge of interior
  const halfW = Math.floor((rw - 2) / 2);
  const halfH = Math.floor((rh - 2) / 2);

  // Determine the tile range to fill for the chosen quadrant
  let qx1: number, qy1: number, qx2: number, qy2: number;
  switch (quadrant) {
    case 0:
      qx1 = ix1;
      qy1 = iy1;
      qx2 = ix1 + halfW;
      qy2 = iy1 + halfH;
      break; // TL
    case 1:
      qx1 = ix1 + halfW;
      qy1 = iy1;
      qx2 = ix2;
      qy2 = iy1 + halfH;
      break; // TR
    case 2:
      qx1 = ix1;
      qy1 = iy1 + halfH;
      qx2 = ix1 + halfW;
      qy2 = iy2;
      break; // BL
    default:
      qx1 = ix1 + halfW;
      qy1 = iy1 + halfH;
      qx2 = ix2;
      qy2 = iy2;
      break; // BR
  }

  for (let ty = qy1; ty < qy2; ty++) {
    for (let tx = qx1; tx < qx2; tx++) {
      const idx = ty * w + tx;
      terrain[idx] = TerrainType.STONE_WALL;
      tileMap.flags[idx] = TilePresets.WALL;
    }
  }

  // Ensure every door still has a reachable interior tile on its inner side
  ensureDoorAccess(tileMap, terrain, w, rx, ry, rw, rh, doors);
}
