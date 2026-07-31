/**
 * applySolidProps — give bulk set-piece furniture real physical collision.
 *
 * Set-piece props are decor by default: the stamping pass draws them and writes
 * no tiles, so the player walks straight through a desk or a bookcase. A prop
 * that opts in with `solid: true` gets its footprint written as
 * **impassable-but-transparent** (`TilePresets.WINDOW`).
 *
 * Transparent matters as much as impassable. Movement, pathfinding and FOV all
 * read the same tile flags, so an opaque desk would block line of sight to the
 * shopkeeper standing behind it — and `npcSystem` now requires line of sight
 * before an NPC is interactable, so an opaque desk would make its own
 * shopkeeper unreachable. Furniture blocks feet, not eyes.
 *
 * ## Why a tile is claimed by centre coverage, not by overlap
 *
 * Props are authored on sub-tile coordinates (x = 0.85, width = 1.5). Claiming
 * every tile a prop's rectangle *touches* over-claims badly: a 6 ft desk
 * straddling a tile seam would seal three tiles instead of two, and a prop can
 * end up sealing an approach it does not visually occupy. A tile is therefore
 * claimed only when the prop covers that tile's **centre**, which makes the
 * blocked region match what the player sees.
 *
 * ## Why this can never strand a room
 *
 * Solidity is applied one prop at a time and each prop is committed only if the
 * room's interior is still fully connected afterwards: every door approach and
 * every other reachable interior tile must remain mutually reachable. A prop
 * whose blocking would cut the room in half is reverted and stays render-only.
 * This is a deterministic guard, not a sampling argument — no reachability
 * sweep is required to trust it, and it degrades to "decor" rather than to a
 * softlock.
 */

import {
  TileFlags,
  TilePresets,
  type DoorLocation,
  type RoomBounds,
} from '../../shared/map-types.js';
import type { SetPieceDef } from '../../shared/set-piece-types.js';
import type { FloorMap } from './FloorMap.js';
import { ORTHO_NEIGHBORS } from './grid-utils.js';

/** Tiles whose centre falls inside the prop's footprint, clamped to the interior. */
function claimedTiles(
  prop: SetPieceDef['props'][number],
  originX: number,
  originY: number,
  interior: RoomBounds,
): number[] {
  const x0 = originX + prop.x;
  const y0 = originY + prop.y;
  const x1 = x0 + prop.width;
  const y1 = y0 + prop.height;

  const out: number[] = [];
  for (let ty = Math.floor(y0); ty < Math.ceil(y1); ty += 1) {
    for (let tx = Math.floor(x0); tx < Math.ceil(x1); tx += 1) {
      // Centre coverage — see the module header.
      const cx = tx + 0.5;
      const cy = ty + 0.5;
      if (cx < x0 || cx > x1 || cy < y0 || cy > y1) continue;
      if (
        tx < interior.x ||
        tx >= interior.x + interior.width ||
        ty < interior.y ||
        ty >= interior.y + interior.height
      ) {
        continue;
      }
      out.push(ty * 100000 + tx);
    }
  }
  return out;
}

/** Flood the room interior over passable tiles, returning the visited set. */
function floodInterior(floorMap: FloorMap, start: number, interior: RoomBounds): Set<number> {
  const w = floorMap.width;
  const seen = new Set<number>();
  const stack = [start];
  seen.add(start);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const x = cur % w;
    const y = (cur - x) / w;
    for (const [dx, dy] of ORTHO_NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      if (
        nx < interior.x ||
        nx >= interior.x + interior.width ||
        ny < interior.y ||
        ny >= interior.y + interior.height
      ) {
        continue;
      }
      const idx = ny * w + nx;
      if (seen.has(idx)) continue;
      if ((floorMap.tileMap.flags[idx]! & TileFlags.PASSABLE) === 0) continue;
      seen.add(idx);
      stack.push(idx);
    }
  }
  return seen;
}

/** Every passable interior tile, as flat indices. */
function passableInterior(floorMap: FloorMap, interior: RoomBounds): number[] {
  const w = floorMap.width;
  const out: number[] = [];
  for (let y = interior.y; y < interior.y + interior.height; y += 1) {
    for (let x = interior.x; x < interior.x + interior.width; x += 1) {
      const idx = y * w + x;
      if ((floorMap.tileMap.flags[idx]! & TileFlags.PASSABLE) !== 0) out.push(idx);
    }
  }
  return out;
}

/**
 * Write collision tiles for every `solid: true` prop in `def`, skipping any prop
 * whose blocking would disconnect the room. Returns the ids of the props that
 * were actually made solid, in declaration order.
 */
export function applySolidProps(
  floorMap: FloorMap,
  def: SetPieceDef,
  originX: number,
  originY: number,
  bounds: RoomBounds,
  doors: readonly DoorLocation[],
): string[] {
  const w = floorMap.width;
  // The wall ring is the outermost row/column of the footprint; furniture only
  // ever occupies the interior.
  const interior: RoomBounds = {
    x: bounds.x + 1,
    y: bounds.y + 1,
    width: Math.max(0, bounds.width - 2),
    height: Math.max(0, bounds.height - 2),
  };
  if (interior.width <= 0 || interior.height <= 0) return [];

  // Never block a door's inside approach: the tile the player steps onto when
  // entering. Sealing it would make the door useless without disconnecting
  // anything the flood can see.
  const protectedTiles = new Set<number>();
  for (const door of doors) {
    for (const [dx, dy] of ORTHO_NEIGHBORS) {
      protectedTiles.add((door.y + dy) * w + (door.x + dx));
    }
  }

  const applied: string[] = [];
  for (const prop of def.props) {
    if (!prop.solid) continue;

    const targets: number[] = [];
    for (const packed of claimedTiles(prop, originX, originY, interior)) {
      const tx = packed % 100000;
      const ty = (packed - tx) / 100000;
      const idx = ty * w + tx;
      if (protectedTiles.has(idx)) continue;
      if ((floorMap.tileMap.flags[idx]! & TileFlags.PASSABLE) === 0) continue;
      targets.push(idx);
    }
    if (targets.length === 0) continue;

    const previous = targets.map((idx) => floorMap.tileMap.flags[idx]!);
    for (const idx of targets) {
      const tx = idx % w;
      const ty = (idx - tx) / w;
      floorMap.tileMap.setFlags(tx, ty, TilePresets.WINDOW);
    }

    // Guard: the remaining passable interior must still be one connected region.
    const remaining = passableInterior(floorMap, interior);
    const connected =
      remaining.length === 0 ||
      floodInterior(floorMap, remaining[0]!, interior).size === remaining.length;
    if (connected) {
      applied.push(prop.id);
    } else {
      targets.forEach((idx, i) => {
        const tx = idx % w;
        const ty = (idx - tx) / w;
        floorMap.tileMap.setFlags(tx, ty, previous[i]!);
      });
    }
  }
  return applied;
}
