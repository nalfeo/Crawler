import { describe, it, expect, beforeEach } from 'vitest';
import { addEntity, addComponent, set } from 'bitecs';
import { createTestWorld } from '../../tests/helpers/world-factory';
import { fovSystem } from '../../src/core/systems/fovSystem';
import { Player, Position } from '../../src/core/components';
import { FloorMap } from '../../src/core/map/FloorMap';
import { TileMap } from '../../src/core/map/TileMap';
import { RoomGraph } from '../../src/core/map/RoomGraph';
import { TilePresets, BiomeType } from '../../src/shared/map-types';
import type { MapConfig } from '../../src/shared/map-types';
import type { GameWorld } from '../../src/core/world';

function makeSmallMap(): FloorMap {
  const config: MapConfig = {
    widthTiles: 20,
    heightTiles: 20,
    tileSizeFt: 32,
    biome: BiomeType.ARENA,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };

  const tileMap = new TileMap(20, 20);
  const terrain = new Uint8Array(400);
  const roomGraph = new RoomGraph();

  // Open room from (1,1) to (18,18), walls on border
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const idx = y * 20 + x;
      if (x === 0 || x === 19 || y === 0 || y === 19) {
        tileMap.flags[idx] = TilePresets.WALL;
      } else {
        tileMap.flags[idx] = TilePresets.FLOOR;
      }
    }
  }

  return new FloorMap(config, tileMap, roomGraph, terrain, { x: 10, y: 10 });
}

describe('FOV System', () => {
  let world: GameWorld;

  beforeEach(() => {
    world = createTestWorld({ seed: 42 });
  });

  it('should do nothing when no floorMap exists', () => {
    world.floorMap = null;
    expect(() => fovSystem(world)).not.toThrow();
  });

  it('should do nothing when no player exists', () => {
    world.floorMap = makeSmallMap();
    expect(() => fovSystem(world)).not.toThrow();
  });

  it('should mark tiles visible around the player', () => {
    const floorMap = makeSmallMap();
    world.floorMap = floorMap;

    // Create player at tile (10, 10) → pixel (320, 320)
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 320, y: 320 }));
    addComponent(world.ecs, eid, Player);

    fovSystem(world);

    // Player's own tile should be visible
    expect(floorMap.isVisible(10, 10)).toBe(true);

    // Adjacent open tiles should be visible
    expect(floorMap.isVisible(11, 10)).toBe(true);
    expect(floorMap.isVisible(9, 10)).toBe(true);
    expect(floorMap.isVisible(10, 11)).toBe(true);
  });

  it('should not see through walls', () => {
    const floorMap = makeSmallMap();
    // Add an internal wall blocking line of sight
    for (let y = 3; y < 17; y++) {
      floorMap.tileMap.flags[y * 20 + 5] = TilePresets.WALL;
    }
    world.floorMap = floorMap;

    // Player at tile (3, 10) → pixel (96, 320)
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 96, y: 320 }));
    addComponent(world.ecs, eid, Player);

    fovSystem(world);

    // Player's tile visible
    expect(floorMap.isVisible(3, 10)).toBe(true);

    // Behind the wall should not be visible
    expect(floorMap.isVisible(8, 10)).toBe(false);
    expect(floorMap.isVisible(15, 10)).toBe(false);
  });

  it('should clear visibility before recomputing', () => {
    const floorMap = makeSmallMap();
    world.floorMap = floorMap;

    // Player at tile (10, 10)
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 320, y: 320 }));
    addComponent(world.ecs, eid, Player);

    fovSystem(world);
    expect(floorMap.isVisible(10, 10)).toBe(true);

    // Place a wall ring around (10,10) so it cannot be seen from far away
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const idx = (10 + dy) * floorMap.tileMap.width + (10 + dx);
        floorMap.tileMap.flags[idx] = TilePresets.WALL;
      }
    }

    // Move player far away — old tile (10,10) should no longer be visible
    world.stores.position.x[eid] = 64; // tile (2, 2)
    world.stores.position.y[eid] = 64;

    fovSystem(world);
    expect(floorMap.isVisible(2, 2)).toBe(true);
    expect(floorMap.isVisible(10, 10)).toBe(false);
  });

  it('should handle player at map edge gracefully', () => {
    const floorMap = makeSmallMap();
    world.floorMap = floorMap;

    // Player at tile (1, 1) — near edge
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 32, y: 32 }));
    addComponent(world.ecs, eid, Player);

    expect(() => fovSystem(world)).not.toThrow();
    expect(floorMap.isVisible(1, 1)).toBe(true);
  });

  it('should mark quarter-tiles visible at sub-tile granularity', () => {
    const floorMap = makeSmallMap();
    world.floorMap = floorMap;

    // Player at tile (10, 10); tileSizeFt = 32, so halfTile = 16.
    // worldToSubTile(320, 320) → (20, 20), the TL quadrant of tile (10,10).
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 320, y: 320 }));
    addComponent(world.ecs, eid, Player);

    fovSystem(world);

    // The visible array has 4 entries per tile.
    expect(floorMap.visible.length).toBe(floorMap.subWidth * floorMap.subHeight);

    // isVisibleSubtile checks raw sub-tile coords.
    // Player origin sub-tile (20,20) must be visible.
    expect(floorMap.isVisibleSubtile(20, 20)).toBe(true);

    // isVisibleAt using world position maps to the same sub-tile.
    expect(floorMap.isVisibleAt(320, 320)).toBe(true);
    // A world position of (336, 320) → hx = floor(336/16) = 21 (still tile 10)
    expect(floorMap.isVisibleAt(336, 320)).toBe(true);

    // Sub-tiles of a far-away tile should not be visible (close to map edge wall)
    expect(floorMap.isVisibleSubtile(0, 0)).toBe(false);
  });

  it('visible bitmap is quarter-tile sized (4× tile count)', () => {
    const floorMap = makeSmallMap();
    const tileCount = floorMap.width * floorMap.height;
    expect(floorMap.visible.length).toBe(tileCount * 4);
    expect(floorMap.subWidth).toBe(floorMap.width * 2);
    expect(floorMap.subHeight).toBe(floorMap.height * 2);
  });

  it('marks discovered alongside visible', () => {
    const floorMap = makeSmallMap();
    world.floorMap = floorMap;

    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 320, y: 320 }));
    addComponent(world.ecs, eid, Player);

    fovSystem(world);

    // Everything currently visible must also be recorded as discovered.
    expect(floorMap.isVisible(10, 10)).toBe(true);
    expect(floorMap.isDiscovered(10, 10)).toBe(true);
    expect(floorMap.isDiscovered(11, 10)).toBe(true);
  });

  it('retains discovered memory for tiles that leave the view', () => {
    const floorMap = makeSmallMap();
    world.floorMap = floorMap;

    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 320, y: 320 }));
    addComponent(world.ecs, eid, Player);

    fovSystem(world);
    expect(floorMap.isVisible(10, 10)).toBe(true);
    expect(floorMap.isDiscovered(10, 10)).toBe(true);

    // Wall-ring tile (10,10) so it can't be seen from afar, then move the player
    // away. (The 20×20 room is smaller than the vision radius, so occlusion —
    // not distance — is what removes a tile from FOV here.)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        floorMap.tileMap.flags[(10 + dy) * floorMap.tileMap.width + (10 + dx)] = TilePresets.WALL;
      }
    }
    world.stores.position.x[eid] = 64; // tile (2,2)
    world.stores.position.y[eid] = 64;
    fovSystem(world);

    // No longer visible, but the discovered memory persists (dim, not black).
    expect(floorMap.isVisible(10, 10)).toBe(false);
    expect(floorMap.isDiscovered(10, 10)).toBe(true);
  });

  it('keeps tile-level gameplay visibility identical at a finer sub-factor', () => {
    // subFactor only changes fog *resolution*; tile-level isVisible (used by
    // AI/culling) must be unchanged. Compare factor 2 (default) vs factor 8.
    const coarse = makeSmallMap();
    const fine = makeSmallMap();
    fine.setSubFactor(8);
    expect(fine.subFactor).toBe(8);

    for (const floorMap of [coarse, fine]) {
      world = createTestWorld({ seed: 42 });
      world.floorMap = floorMap;
      const eid = addEntity(world.ecs);
      addComponent(world.ecs, eid, set(Position, { x: 320, y: 320 }));
      addComponent(world.ecs, eid, Player);
      fovSystem(world);
    }

    // Sample the interior tiles; tile-level visibility must match factor-for-factor.
    for (let ty = 5; ty <= 15; ty++) {
      for (let tx = 5; tx <= 15; tx++) {
        expect(fine.isVisible(tx, ty)).toBe(coarse.isVisible(tx, ty));
      }
    }
    // The finer map carries 16× the sub-tiles even though tile visibility matches.
    expect(fine.visible.length).toBe(coarse.visible.length * 16);
  });
});
