import { addComponent, addEntity, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Position, Velocity } from '../../src/core/components.js';
import { movementSystem } from '../../src/core/systems/movementSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TilePresets, BiomeType } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';

/** Create a 10×10 map with walls on borders and a wall column at x=5. */
function makeWalledMap(): FloorMap {
  const config: MapConfig = {
    widthTiles: 10,
    heightTiles: 10,
    tileSizePx: 32,
    biome: BiomeType.ARENA,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(10, 10);
  const terrain = new Uint8Array(100);

  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      const idx = y * 10 + x;
      if (x === 0 || x === 9 || y === 0 || y === 9 || x === 5) {
        tileMap.flags[idx] = TilePresets.WALL;
      } else {
        tileMap.flags[idx] = TilePresets.FLOOR;
      }
    }
  }
  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 3, y: 3 });
}

describe('movementSystem', () => {
  it('moves an entity by its velocity each frame', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 10, y: 20 }));
    addComponent(world.ecs, eid, set(Velocity, { x: 1.5, y: -2.25 }));

    movementSystem(world);

    expect(world.stores.position.x[eid]).toBeCloseTo(11.5);
    expect(world.stores.position.y[eid]).toBeCloseTo(17.75);
  });

  it("doesn't move an entity with zero velocity", () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: -8, y: 14 }));
    addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));

    movementSystem(world);

    expect(world.stores.position.x[eid]).toBe(-8);
    expect(world.stores.position.y[eid]).toBe(14);
  });

  it('moves multiple entities independently', () => {
    const world = createTestWorld();
    const first = addEntity(world.ecs);
    const second = addEntity(world.ecs);

    addComponent(world.ecs, first, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, first, set(Velocity, { x: 2, y: 3 }));
    addComponent(world.ecs, second, set(Position, { x: 10, y: -5 }));
    addComponent(world.ecs, second, set(Velocity, { x: -4, y: 1 }));

    movementSystem(world);

    expect(world.stores.position.x[first]).toBe(2);
    expect(world.stores.position.y[first]).toBe(3);
    expect(world.stores.position.x[second]).toBe(6);
    expect(world.stores.position.y[second]).toBe(-4);
  });

  describe('wall collision', () => {
    it('blocks movement into a wall', () => {
      const world = createTestWorld();
      world.floorMap = makeWalledMap();

      // Place entity at pixel (96, 96) = tile (3, 3), moving right into wall at x=5
      const eid = addEntity(world.ecs);
      addComponent(world.ecs, eid, set(Position, { x: 96, y: 96 }));
      addComponent(world.ecs, eid, set(Velocity, { x: 80, y: 0 })); // would land at pixel 176 = tile 5 (wall)

      movementSystem(world);

      // Should not have moved (target tile is wall)
      // But X-only should also be wall at x=5, so slide Y? Y stays same.
      // Since both newX,oldY and oldX,newY fail or succeed: newX,oldY → tile(5,3)=wall → fail
      // oldX,newY → tile(3,3)=floor → but velocity.y=0 so newY=oldY → stays at same position
      expect(world.stores.position.x[eid]).toBe(96);
      expect(world.stores.position.y[eid]).toBe(96);
    });

    it('allows sliding along walls', () => {
      const world = createTestWorld();
      world.floorMap = makeWalledMap();

      // Place entity at tile (4, 3) = pixel (128, 96), moving diagonally into wall
      const eid = addEntity(world.ecs);
      addComponent(world.ecs, eid, set(Position, { x: 128, y: 96 }));
      addComponent(world.ecs, eid, set(Velocity, { x: 32, y: 32 })); // target: tile (5, 4) = wall x=5

      movementSystem(world);

      // X blocked (wall at x=5), but Y should slide to tile (4, 4) which is floor
      expect(world.stores.position.x[eid]).toBe(128); // didn't move X
      expect(world.stores.position.y[eid]).toBe(128); // moved Y
    });

    it('allows unrestricted movement when no floorMap', () => {
      const world = createTestWorld();
      // No floorMap — legacy behavior
      const eid = addEntity(world.ecs);
      addComponent(world.ecs, eid, set(Position, { x: 100, y: 100 }));
      addComponent(world.ecs, eid, set(Velocity, { x: 50, y: -30 }));

      movementSystem(world);

      expect(world.stores.position.x[eid]).toBeCloseTo(150);
      expect(world.stores.position.y[eid]).toBeCloseTo(70);
    });

    it('allows movement on open floor tiles', () => {
      const world = createTestWorld();
      world.floorMap = makeWalledMap();

      // Move from tile (2,2) to tile (3,3) — both floor
      const eid = addEntity(world.ecs);
      addComponent(world.ecs, eid, set(Position, { x: 64, y: 64 }));
      addComponent(world.ecs, eid, set(Velocity, { x: 32, y: 32 }));

      movementSystem(world);

      expect(world.stores.position.x[eid]).toBeCloseTo(96);
      expect(world.stores.position.y[eid]).toBeCloseTo(96);
    });
  });
});
