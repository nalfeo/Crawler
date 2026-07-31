import { describe, it, expect } from 'vitest';
import { TileMap } from '../../src/core/map/TileMap';
import { TilePresets, TileFlags } from '../../src/shared/map-types';

describe('TileMap', () => {
  it('should create with correct dimensions', () => {
    const map = new TileMap(10, 20);
    expect(map.width).toBe(10);
    expect(map.height).toBe(20);
    expect(map.flags.length).toBe(200);
  });

  it('should default all tiles to 0 (wall)', () => {
    const map = new TileMap(5, 5);
    for (let i = 0; i < 25; i++) {
      expect(map.flags[i]).toBe(0);
    }
  });

  it('should accept initial flags', () => {
    const flags = new Uint8Array(4);
    flags[0] = TilePresets.FLOOR;
    const map = new TileMap(2, 2, flags);
    expect(map.isPassable(0, 0)).toBe(true);
    expect(map.isPassable(1, 0)).toBe(false);
  });

  describe('index', () => {
    it('should return correct flat index', () => {
      const map = new TileMap(10, 10);
      expect(map.index(0, 0)).toBe(0);
      expect(map.index(5, 3)).toBe(35);
      expect(map.index(9, 9)).toBe(99);
    });

    it('should return -1 for out of bounds', () => {
      const map = new TileMap(10, 10);
      expect(map.index(-1, 0)).toBe(-1);
      expect(map.index(0, -1)).toBe(-1);
      expect(map.index(10, 0)).toBe(-1);
      expect(map.index(0, 10)).toBe(-1);
    });
  });

  describe('inBounds', () => {
    it('should return true for valid coords', () => {
      const map = new TileMap(10, 10);
      expect(map.inBounds(0, 0)).toBe(true);
      expect(map.inBounds(9, 9)).toBe(true);
    });

    it('should return false for out of bounds', () => {
      const map = new TileMap(10, 10);
      expect(map.inBounds(-1, 0)).toBe(false);
      expect(map.inBounds(10, 0)).toBe(false);
    });
  });

  describe('tile queries', () => {
    it('should check passability correctly', () => {
      const map = new TileMap(5, 5);
      map.setFlags(2, 2, TilePresets.FLOOR);
      expect(map.isPassable(2, 2)).toBe(true);
      expect(map.isPassable(0, 0)).toBe(false); // wall
    });

    it('should check transparency correctly', () => {
      const map = new TileMap(5, 5);
      map.setFlags(2, 2, TilePresets.WINDOW); // transparent but not passable
      expect(map.isTransparent(2, 2)).toBe(true);
      expect(map.isPassable(2, 2)).toBe(false);
    });

    it('should check door status correctly', () => {
      const map = new TileMap(5, 5);
      map.setFlags(2, 2, TilePresets.DOOR_CLOSED);
      expect(map.isDoor(2, 2)).toBe(true);
      expect(map.isPassable(2, 2)).toBe(false);
      expect(map.isTransparent(2, 2)).toBe(false);
    });

    it('should check liquid status correctly', () => {
      const map = new TileMap(5, 5);
      map.setFlags(2, 2, TilePresets.SHALLOW_WATER);
      expect(map.isLiquid(2, 2)).toBe(true);
      expect(map.isPassable(2, 2)).toBe(true);
    });

    it('should return false for out-of-bounds queries', () => {
      const map = new TileMap(5, 5);
      expect(map.isPassable(-1, 0)).toBe(false);
      expect(map.isTransparent(5, 5)).toBe(false);
      expect(map.isDoor(0, -1)).toBe(false);
      expect(map.isLiquid(10, 10)).toBe(false);
    });
  });

  describe('doors', () => {
    it('should open a door (passable + transparent + door)', () => {
      const map = new TileMap(5, 5);
      map.setFlags(2, 2, TilePresets.DOOR_CLOSED);
      map.openDoor(2, 2);
      expect(map.isPassable(2, 2)).toBe(true);
      expect(map.isTransparent(2, 2)).toBe(true);
      expect(map.isDoor(2, 2)).toBe(true);
      expect(map.flags[map.index(2, 2)]).toBe(TilePresets.DOOR_OPEN);
    });

    it('should close a door (not passable + not transparent + door)', () => {
      const map = new TileMap(5, 5);
      map.setFlags(2, 2, TilePresets.DOOR_OPEN);
      map.closeDoor(2, 2);
      expect(map.isPassable(2, 2)).toBe(false);
      expect(map.isTransparent(2, 2)).toBe(false);
      expect(map.isDoor(2, 2)).toBe(true);
      expect(map.flags[map.index(2, 2)]).toBe(TilePresets.DOOR_CLOSED);
    });

    it('should no-op for out-of-bounds door operations', () => {
      const map = new TileMap(5, 5);
      map.openDoor(-1, 0); // should not throw
      map.closeDoor(5, 5); // should not throw
    });

    it('increments transparency revision only when transparency changes', () => {
      const map = new TileMap(5, 5);
      expect(map.transparencyRevision).toBe(0);

      map.setFlags(2, 2, TilePresets.DOOR_CLOSED);
      expect(map.transparencyRevision).toBe(0);
      map.openDoor(2, 2);
      expect(map.transparencyRevision).toBe(1);
      map.openDoor(2, 2);
      expect(map.transparencyRevision).toBe(1);
      map.closeDoor(2, 2);
      expect(map.transparencyRevision).toBe(2);
    });
  });

  describe('fill operations', () => {
    it('should fill entire map', () => {
      const map = new TileMap(5, 5);
      map.fill(TilePresets.FLOOR);
      for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 5; x++) {
          expect(map.isPassable(x, y)).toBe(true);
        }
      }
    });

    it('should fill a rectangular region', () => {
      const map = new TileMap(10, 10);
      map.fillRect(2, 2, 3, 3, TilePresets.FLOOR);
      expect(map.isPassable(2, 2)).toBe(true);
      expect(map.isPassable(4, 4)).toBe(true);
      expect(map.isPassable(1, 1)).toBe(false); // outside rect
      expect(map.isPassable(5, 5)).toBe(false); // outside rect
    });
  });

  describe('lightPasses callback', () => {
    it('should return a function compatible with rot-js FOV', () => {
      const map = new TileMap(5, 5);
      map.setFlags(2, 2, TilePresets.FLOOR);
      const cb = map.createLightPassesCallback();
      expect(typeof cb).toBe('function');
      expect(cb(2, 2)).toBe(true);
      expect(cb(0, 0)).toBe(false);
    });
  });

  describe('lineOfSight', () => {
    function openMap(w = 10, h = 10): TileMap {
      const map = new TileMap(w, h);
      map.fill(TilePresets.FLOOR);
      return map;
    }

    it('is clear across open floor', () => {
      const map = openMap();
      expect(map.lineOfSight(1, 1, 8, 1)).toBe(true);
      expect(map.lineOfSight(1, 1, 8, 8)).toBe(true);
    });

    it('is blocked by an opaque wall between the endpoints', () => {
      const map = openMap();
      map.setFlags(4, 1, TilePresets.WALL);
      expect(map.lineOfSight(1, 1, 8, 1)).toBe(false);
    });

    it('treats the endpoint tiles as non-blocking', () => {
      const map = openMap();
      // Even if the shooter and target tiles are opaque, they never block.
      map.setFlags(1, 1, TilePresets.WALL);
      map.setFlags(8, 1, TilePresets.WALL);
      expect(map.lineOfSight(1, 1, 8, 1)).toBe(true);
    });

    it('always has sight to an adjacent tile', () => {
      const map = openMap();
      map.setFlags(2, 1, TilePresets.WALL);
      // Target is the wall tile itself (adjacent) — no tile lies between.
      expect(map.lineOfSight(1, 1, 2, 1)).toBe(true);
    });

    it('passes through an open door but not a closed one', () => {
      const map = openMap();
      map.setFlags(4, 1, TilePresets.DOOR_OPEN);
      expect(map.lineOfSight(1, 1, 8, 1)).toBe(true);
      map.setFlags(4, 1, TilePresets.DOOR_CLOSED);
      expect(map.lineOfSight(1, 1, 8, 1)).toBe(false);
    });

    it('passes through a transparent window', () => {
      const map = openMap();
      map.setFlags(4, 1, TilePresets.WINDOW); // transparent, not passable
      expect(map.lineOfSight(1, 1, 8, 1)).toBe(true);
    });

    it('is symmetric for a straight blocked line', () => {
      const map = openMap();
      map.setFlags(4, 4, TilePresets.WALL);
      expect(map.lineOfSight(1, 4, 8, 4)).toBe(false);
      expect(map.lineOfSight(8, 4, 1, 4)).toBe(false);
    });

    it('returns true for a zero-length line', () => {
      const map = openMap();
      expect(map.lineOfSight(3, 3, 3, 3)).toBe(true);
    });

    it('blocks diagonal LOS through a blocked corner seam', () => {
      const map = openMap();
      // Crossing from (1,1) -> (2,2) passes between (2,1) and (1,2).
      map.setFlags(2, 1, TilePresets.WALL);
      map.setFlags(1, 2, TilePresets.WALL);
      expect(map.lineOfSight(1, 1, 2, 2)).toBe(false);
    });

    it('allows diagonal LOS when only one side of the corner seam is blocked', () => {
      const map = openMap();
      map.setFlags(2, 1, TilePresets.WALL);
      expect(map.lineOfSight(1, 1, 2, 2)).toBe(true);
    });

    it('blocks multi-step diagonal LOS through the same corner seam in both directions', () => {
      const map = openMap();
      map.setFlags(2, 1, TilePresets.WALL);
      map.setFlags(1, 2, TilePresets.WALL);
      expect(map.lineOfSight(1, 1, 3, 3)).toBe(false);
      expect(map.lineOfSight(3, 3, 1, 1)).toBe(false);
    });

    // HARD GATE: an interior room corner is the wall block diagonally across
    // the seam formed by the two wall runs that meet at it. The light field
    // gates source illumination on lineOfSight (light-field.ts calls
    // FloorMap.hasLineOfSight for every cell it lights, wall cells included),
    // so if this returns false the corner renders at ambient only — revealed
    // but black. Regression for "room corners don't get lighting".
    it('reaches an opaque tile across the seam formed by its own two walls', () => {
      const map = openMap();
      map.setFlags(2, 1, TilePresets.WALL);
      map.setFlags(1, 2, TilePresets.WALL);
      map.setFlags(2, 2, TilePresets.WALL);
      expect(map.lineOfSight(1, 1, 2, 2)).toBe(true);
    });

    // HARD GATE: the exemption covers ONLY the terminal step. An opaque tile
    // sitting behind a seam crossed EARLIER on the ray must stay blocked,
    // otherwise a wall genuinely peeked at through a diagonal gap becomes
    // visible and lit.
    it('does not reach an opaque tile behind an earlier blocked corner seam', () => {
      const map = openMap();
      map.setFlags(2, 1, TilePresets.WALL);
      map.setFlags(1, 2, TilePresets.WALL);
      map.setFlags(3, 3, TilePresets.WALL);
      expect(map.lineOfSight(1, 1, 3, 3)).toBe(false);
    });

    // HARD GATE: the exemption keys off the TARGET being opaque, never the
    // origin. A wall-mounted light source must not shine through a diagonal
    // gap just because it sits on an opaque tile.
    it('does not exempt the seam when only the origin is opaque', () => {
      const map = openMap();
      map.setFlags(2, 1, TilePresets.WALL);
      map.setFlags(1, 2, TilePresets.WALL);
      map.setFlags(2, 2, TilePresets.WALL);
      expect(map.lineOfSight(2, 2, 1, 1)).toBe(false);
    });
  });

  describe('tile flag bitfield correctness', () => {
    it('should have non-overlapping flags', () => {
      expect(TileFlags.PASSABLE & TileFlags.TRANSPARENT).toBe(0);
      expect(TileFlags.PASSABLE & TileFlags.DOOR).toBe(0);
      expect(TileFlags.PASSABLE & TileFlags.LIQUID).toBe(0);
      expect(TileFlags.TRANSPARENT & TileFlags.DOOR).toBe(0);
      expect(TileFlags.TRANSPARENT & TileFlags.LIQUID).toBe(0);
      expect(TileFlags.DOOR & TileFlags.LIQUID).toBe(0);
    });

    it('DOOR_OPEN should have PASSABLE + TRANSPARENT + DOOR', () => {
      expect(TilePresets.DOOR_OPEN & TileFlags.PASSABLE).not.toBe(0);
      expect(TilePresets.DOOR_OPEN & TileFlags.TRANSPARENT).not.toBe(0);
      expect(TilePresets.DOOR_OPEN & TileFlags.DOOR).not.toBe(0);
    });

    it('DOOR_CLOSED should have only DOOR', () => {
      expect(TilePresets.DOOR_CLOSED & TileFlags.PASSABLE).toBe(0);
      expect(TilePresets.DOOR_CLOSED & TileFlags.TRANSPARENT).toBe(0);
      expect(TilePresets.DOOR_CLOSED & TileFlags.DOOR).not.toBe(0);
    });
  });
});
