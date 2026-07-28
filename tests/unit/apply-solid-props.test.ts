import { describe, expect, it } from 'vitest';
import { applySolidProps } from '../../src/core/map/applySolidProps.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import {
  DEFAULT_MAP_CONFIG,
  TerrainType,
  TileFlags,
  TilePresets,
  type DoorLocation,
  type RoomBounds,
} from '../../src/shared/map-types.js';
import type { SetPieceDef } from '../../src/shared/set-piece-types.js';

const BOUNDS: RoomBounds = { x: 1, y: 1, width: 7, height: 7 };
const DOORS: readonly DoorLocation[] = [{ x: 4, y: 7, connectsTo: -1 }];

/** 9x9 map holding one 7x7 walled room with a single door on the bottom ring. */
function createRoomMap(): FloorMap {
  const config = { ...DEFAULT_MAP_CONFIG, widthTiles: 9, heightTiles: 9 };
  const tileMap = new TileMap(9, 9);
  tileMap.fill(TilePresets.WALL);
  for (let y = BOUNDS.y + 1; y < BOUNDS.y + BOUNDS.height - 1; y += 1) {
    for (let x = BOUNDS.x + 1; x < BOUNDS.x + BOUNDS.width - 1; x += 1) {
      tileMap.setFlags(x, y, TilePresets.FLOOR);
    }
  }
  tileMap.setFlags(DOORS[0]!.x, DOORS[0]!.y, TilePresets.DOOR_CLOSED);
  const terrain = new Uint8Array(9 * 9);
  terrain.fill(TerrainType.STONE_FLOOR);
  const roomGraph = new RoomGraph();
  roomGraph.add({ ...BOUNDS });
  return new FloorMap(config, tileMap, roomGraph, terrain, { x: 4, y: 4 });
}

/** Minimal def carrying only the fields applySolidProps reads. */
function defWith(
  props: { id: string; x: number; y: number; width: number; height: number; solid: boolean }[],
): SetPieceDef {
  return { id: 'test', width: 7, height: 7, props } as unknown as SetPieceDef;
}

const isPassable = (map: FloorMap, x: number, y: number): boolean =>
  (map.tileMap.flags[y * map.width + x]! & TileFlags.PASSABLE) !== 0;
const isTransparent = (map: FloorMap, x: number, y: number): boolean =>
  (map.tileMap.flags[y * map.width + x]! & TileFlags.TRANSPARENT) !== 0;

describe('applySolidProps', () => {
  it('blocks the footprint of a solid prop', () => {
    const map = createRoomMap();
    const def = defWith([{ id: 'desk', x: 2, y: 2, width: 1, height: 1, solid: true }]);

    expect(isPassable(map, 3, 3)).toBe(true);
    const applied = applySolidProps(map, def, BOUNDS.x, BOUNDS.y, BOUNDS, DOORS);

    expect(applied).toEqual(['desk']);
    expect(isPassable(map, 3, 3)).toBe(false);
  });

  it('leaves solid props transparent so line of sight (and NPC dialogue) still works over them', () => {
    const map = createRoomMap();
    const def = defWith([{ id: 'desk', x: 2, y: 2, width: 1, height: 1, solid: true }]);

    applySolidProps(map, def, BOUNDS.x, BOUNDS.y, BOUNDS, DOORS);

    // Impassable but see-through: an opaque desk would block talking to the
    // shopkeeper standing behind it.
    expect(isPassable(map, 3, 3)).toBe(false);
    expect(isTransparent(map, 3, 3)).toBe(true);
    expect(map.hasLineOfSight(2 * 4 + 2, 3 * 4 + 2, 4 * 4 + 2, 3 * 4 + 2)).toBe(true);
  });

  it('does not block props that are not marked solid', () => {
    const map = createRoomMap();
    const def = defWith([{ id: 'rug', x: 2, y: 2, width: 1, height: 1, solid: false }]);

    expect(applySolidProps(map, def, BOUNDS.x, BOUNDS.y, BOUNDS, DOORS)).toEqual([]);
    expect(isPassable(map, 3, 3)).toBe(true);
  });

  it('reverts a solid prop that would disconnect the room, leaving it render-only', () => {
    const map = createRoomMap();
    // Spans the full interior width on one row -> would split the interior in two.
    const def = defWith([{ id: 'barricade', x: 1, y: 3, width: 5, height: 1, solid: true }]);

    const applied = applySolidProps(map, def, BOUNDS.x, BOUNDS.y, BOUNDS, DOORS);

    expect(applied).toEqual([]);
    for (let x = 2; x <= 6; x += 1) {
      expect(isPassable(map, x, 4)).toBe(true);
    }
  });

  it("never blocks a door's inside approach", () => {
    const map = createRoomMap();
    // Covers the whole bottom interior row, including the approach tile (4,6).
    const def = defWith([{ id: 'clutter', x: 1, y: 5, width: 5, height: 1, solid: true }]);

    applySolidProps(map, def, BOUNDS.x, BOUNDS.y, BOUNDS, DOORS);

    expect(isPassable(map, 4, 6)).toBe(true);
  });

  it('claims a tile only when the prop covers its centre, so sub-tile props do not over-seal', () => {
    const map = createRoomMap();
    // Local x 1.6..2.6 -> world 2.6..3.6. Only tile 3 has its centre (3.5) inside;
    // tile 2 (centre 2.5) is merely touched and must stay walkable.
    const def = defWith([{ id: 'stool', x: 1.6, y: 2, width: 1, height: 1, solid: true }]);

    applySolidProps(map, def, BOUNDS.x, BOUNDS.y, BOUNDS, DOORS);

    expect(isPassable(map, 3, 3)).toBe(false);
    expect(isPassable(map, 2, 3)).toBe(true);
  });
});
