/**
 * TileMap — flat typed-array tile grid for physics and LOS.
 *
 * Stores per-tile bitflags (passable, transparent, door, liquid) in a
 * Uint8Array indexed by `y * width + x`. All queries are O(1).
 *
 * This is a pure data structure — no rendering or ECS imports.
 */

import { TileFlags, TilePresets } from '../../shared/map-types';

/**
 * The bits every passability predicate reads. `isPassable` tests PASSABLE and
 * `isDoor` tests DOOR, and `buildDoorAwarePassable` is built from exactly those
 * two, so a mutation that leaves both bits alone cannot change reachability.
 */
const NAV_TOPOLOGY_FLAGS = TileFlags.PASSABLE | TileFlags.DOOR;

export class TileMap {
  readonly width: number;
  readonly height: number;
  readonly flags: Uint8Array;
  private _transparencyRevision = 0;
  private _navTopologyRevision = 0;

  constructor(width: number, height: number, initialFlags?: Uint8Array) {
    this.width = width;
    this.height = height;
    if (initialFlags) {
      const expected = width * height;
      if (initialFlags.length !== expected) {
        throw new Error(
          `TileMap: initialFlags length ${initialFlags.length} does not match ${width}×${height} = ${expected}`,
        );
      }

      this.flags = initialFlags;
    } else {
      this.flags = new Uint8Array(width * height);
    }
  }

  /**
   * Monotonic revision for line-of-sight topology.
   *
   * Runtime tile mutations increment this only when the transparent bit changes,
   * so callers can cache visibility work without being invalidated by idempotent
   * door-system writes or passability-only changes.
   */
  get transparencyRevision(): number {
    return this._transparencyRevision;
  }

  /**
   * Monotonic revision for navigation topology.
   *
   * Bumped only when a runtime tile mutation flips the PASSABLE or DOOR bit —
   * exactly the two bits every passability predicate in the codebase reads
   * (`isPassable`, `isDoor`, and therefore `buildDoorAwarePassable`). Callers
   * can cache reachability work against this without being invalidated by
   * idempotent door-system writes or transparency-only changes.
   *
   * This is deliberately separate from {@link transparencyRevision}: doors flip
   * both bits, but lighting/fog changes flip only transparency, and a shared
   * counter would spuriously invalidate navigation caches.
   */
  get navTopologyRevision(): number {
    return this._navTopologyRevision;
  }

  private setFlagsAtIndex(idx: number, value: number): void {
    const previous = this.flags[idx]!;
    if (((previous ^ value) & TileFlags.TRANSPARENT) !== 0) {
      this._transparencyRevision += 1;
    }
    if (((previous ^ value) & NAV_TOPOLOGY_FLAGS) !== 0) {
      this._navTopologyRevision += 1;
    }
    this.flags[idx] = value;
  }

  /** Convert tile coords to flat index. Returns -1 if out of bounds. */
  index(x: number, y: number): number {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return -1;
    return y * this.width + x;
  }

  /** Check if tile coordinates are within map bounds. */
  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  /** Check if a tile is passable (entities can walk through). */
  isPassable(x: number, y: number): boolean {
    const idx = this.index(x, y);
    if (idx === -1) return false;
    return (this.flags[idx]! & TileFlags.PASSABLE) !== 0;
  }

  /** Check if a tile is transparent (LOS passes through). */
  isTransparent(x: number, y: number): boolean {
    const idx = this.index(x, y);
    if (idx === -1) return false;
    return (this.flags[idx]! & TileFlags.TRANSPARENT) !== 0;
  }

  /** Check if a tile is a door. */
  isDoor(x: number, y: number): boolean {
    const idx = this.index(x, y);
    if (idx === -1) return false;
    return (this.flags[idx]! & TileFlags.DOOR) !== 0;
  }

  /** Check if a tile is liquid (affects movement speed). */
  isLiquid(x: number, y: number): boolean {
    const idx = this.index(x, y);
    if (idx === -1) return false;
    return (this.flags[idx]! & TileFlags.LIQUID) !== 0;
  }

  /** Set raw flags for a tile. */
  setFlags(x: number, y: number, value: number): void {
    const idx = this.index(x, y);
    if (idx === -1) return;
    this.setFlagsAtIndex(idx, value);
  }

  /** Open a door tile — sets passable + transparent, keeps door flag. */
  openDoor(x: number, y: number): void {
    const idx = this.index(x, y);
    if (idx === -1) return;
    this.setFlagsAtIndex(idx, TilePresets.DOOR_OPEN);
  }

  /** Close a door tile — clears passable + transparent, keeps door flag. */
  closeDoor(x: number, y: number): void {
    const idx = this.index(x, y);
    if (idx === -1) return;
    this.setFlagsAtIndex(idx, TilePresets.DOOR_CLOSED);
  }

  /** Fill entire map with a flag value (e.g., all walls). */
  fill(value: number): void {
    const transparent = (value & TileFlags.TRANSPARENT) !== 0;
    let transparencyChanged = false;
    let navTopologyChanged = false;
    for (const current of this.flags) {
      if (((current & TileFlags.TRANSPARENT) !== 0) !== transparent) {
        transparencyChanged = true;
      }
      if (((current ^ value) & NAV_TOPOLOGY_FLAGS) !== 0) {
        navTopologyChanged = true;
      }
      if (transparencyChanged && navTopologyChanged) {
        break;
      }
    }
    this.flags.fill(value);
    if (transparencyChanged) {
      this._transparencyRevision += 1;
    }
    if (navTopologyChanged) {
      this._navTopologyRevision += 1;
    }
  }

  /** Fill a rectangular region with a flag value. */
  fillRect(x: number, y: number, w: number, h: number, value: number): void {
    let transparencyChanged = false;
    let navTopologyChanged = false;
    for (let ty = y; ty < y + h; ty++) {
      for (let tx = x; tx < x + w; tx++) {
        const idx = this.index(tx, ty);
        if (idx !== -1) {
          const previous = this.flags[idx]!;
          if (((previous ^ value) & TileFlags.TRANSPARENT) !== 0) {
            transparencyChanged = true;
          }
          if (((previous ^ value) & NAV_TOPOLOGY_FLAGS) !== 0) {
            navTopologyChanged = true;
          }
          this.flags[idx] = value;
        }
      }
    }
    if (transparencyChanged) {
      this._transparencyRevision += 1;
    }
    if (navTopologyChanged) {
      this._navTopologyRevision += 1;
    }
  }

  /**
   * lightPasses callback compatible with rot-js FOV.
   * Returns a function that checks tile transparency.
   */
  createLightPassesCallback(): (x: number, y: number) => boolean {
    return (x: number, y: number) => this.isTransparent(x, y);
  }

  /**
   * Check if a ray has any blocked corner seams (diagonal passages with both
   * orthogonal neighbors opaque).
   *
   * Walks a Bresenham line from (x0,y0) to (x1,y1) and applies the corner-seam
   * blocking rule: if a diagonal step has both orthogonal corner tiles opaque,
   * the passage is blocked. Returns `true` if a blocked seam is encountered
   * (ray should be occluded), `false` if the ray is clear of all seam blocks.
   *
   * Used by the FOV visibility callback to ensure consistent corner-seam
   * behavior across the full ray.
   *
   * Terminal-step exemption: when the *target* tile is itself opaque, the seam
   * formed by the final step into it is ignored. A wall block diagonally across
   * an inside room corner is part of the room's own enclosure — the player is
   * standing in the room looking at it — so it must read as seen and lit rather
   * than as a peek through a gap. Seams encountered *earlier* on the ray still
   * block, so this never exempts a whole ray. The exemption keys off the target
   * only, never the origin: exempting an opaque origin would let a
   * wall-mounted light source leak through diagonal gaps.
   */
  hasBlockedCornerSeam(x0: number, y0: number, x1: number, y1: number): boolean {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    const targetOpaque = !this.isTransparent(x1, y1);

    while (x !== x1 || y !== y1) {
      const prevX = x;
      const prevY = y;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
      const reachedTarget = x === x1 && y === y1;
      if (reachedTarget && targetOpaque) break;
      const steppedDiagonally = x !== prevX && y !== prevY;
      if (steppedDiagonally && !this.isTransparent(x, prevY) && !this.isTransparent(prevX, y)) {
        return true;
      }
      if (reachedTarget) break;
    }

    return false;
  }

  /**
   * Deterministic tile line-of-sight check between two tile coordinates.
   *
   * Walks a Bresenham line from (x0,y0) to (x1,y1) and returns `false` if any
   * tile strictly between the endpoints is opaque (not transparent). The two
   * endpoint tiles never block — the shooter and target stand on them — so an
   * adjacent target always has line of sight. Out-of-bounds tiles count as
   * opaque, mirroring `isTransparent`.
   *
   * Also applies corner-seam blocking: if a diagonal step has both orthogonal
   * corners opaque, the passage is blocked, ensuring consistent visibility
   * rules across all rays.
   *
   * Terminal-step exemption (mirrors `hasBlockedCornerSeam`): when the target
   * tile is itself opaque, the seam formed by the final step into it is
   * ignored, so an inside room corner is lit by the light field rather than
   * left at ambient. `light-field.ts` calls this via `FloorMap.hasLineOfSight`
   * for every cell it lights, wall cells included. This makes LOS asymmetric
   * when exactly one endpoint is opaque — it is NOT symmetric in that case —
   * which is safe because nothing ever occupies an opaque tile: every gameplay
   * consumer (combat targeting, NPC checks) has both endpoints on walkable
   * floor. The exemption keys off the target only, never the origin.
   *
   * Pure integer math: no allocation, no randomness, no floating point.
   */
  lineOfSight(x0: number, y0: number, x1: number, y1: number): boolean {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    const targetOpaque = !this.isTransparent(x1, y1);

    while (x !== x1 || y !== y1) {
      const prevX = x;
      const prevY = y;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
      const reachedTarget = x === x1 && y === y1;
      if (reachedTarget && targetOpaque) break;
      const steppedDiagonally = x !== prevX && y !== prevY;
      if (steppedDiagonally && !this.isTransparent(x, prevY) && !this.isTransparent(prevX, y)) {
        return false;
      }
      // Reaching the target tile means the path was clear; the target tile
      // itself is never treated as a blocker.
      if (reachedTarget) break;
      if (!this.isTransparent(x, y)) return false;
    }

    return true;
  }
}
