/**
 * TileMap — flat typed-array tile grid for physics and LOS.
 *
 * Stores per-tile bitflags (passable, transparent, door, liquid) in a
 * Uint8Array indexed by `y * width + x`. All queries are O(1).
 *
 * This is a pure data structure — no rendering or ECS imports.
 */

import { TileFlags, TilePresets } from '../../shared/map-types';

export class TileMap {
  readonly width: number;
  readonly height: number;
  readonly flags: Uint8Array;

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
    this.flags[idx] = value;
  }

  /** Open a door tile — sets passable + transparent, keeps door flag. */
  openDoor(x: number, y: number): void {
    const idx = this.index(x, y);
    if (idx === -1) return;
    this.flags[idx] = TilePresets.DOOR_OPEN;
  }

  /** Close a door tile — clears passable + transparent, keeps door flag. */
  closeDoor(x: number, y: number): void {
    const idx = this.index(x, y);
    if (idx === -1) return;
    this.flags[idx] = TilePresets.DOOR_CLOSED;
  }

  /** Fill entire map with a flag value (e.g., all walls). */
  fill(value: number): void {
    this.flags.fill(value);
  }

  /** Fill a rectangular region with a flag value. */
  fillRect(x: number, y: number, w: number, h: number, value: number): void {
    for (let ty = y; ty < y + h; ty++) {
      for (let tx = x; tx < x + w; tx++) {
        const idx = this.index(tx, ty);
        if (idx !== -1) this.flags[idx] = value;
      }
    }
  }

  /**
   * lightPasses callback compatible with rot-js FOV.
   * Returns a function that checks tile transparency.
   */
  createLightPassesCallback(): (x: number, y: number) => boolean {
    return (x: number, y: number) => this.isTransparent(x, y);
  }
}
