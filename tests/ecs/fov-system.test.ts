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
    tileSizePx: 32,
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
});
