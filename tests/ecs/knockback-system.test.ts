import { describe, expect, it } from 'vitest';
import { addComponent, hasComponent, set } from 'bitecs';
import { knockbackSystem } from '../../src/core/systems/knockbackSystem.js';
import { Knockback } from '../../src/core/components.js';
import { spawnEnemy } from '../../src/core/helpers.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

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
      tileMap.flags[idx] =
        x === 0 || x === 9 || y === 0 || y === 9 || x === 5 ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }

  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 3, y: 3 });
}

describe('knockbackSystem', () => {
  it('removes the Knockback component immediately when speed is zero', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 10);
    addComponent(world.ecs, eid, set(Knockback, { dirX: 1, dirY: 0, remaining: 10, speed: 0 }));

    knockbackSystem(world);

    expect(hasComponent(world.ecs, eid, Knockback)).toBe(false);
  });

  it('removes the Knockback component when no distance remains', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 10);
    addComponent(world.ecs, eid, set(Knockback, { dirX: 1, dirY: 0, remaining: 0, speed: 5 }));

    knockbackSystem(world);

    expect(hasComponent(world.ecs, eid, Knockback)).toBe(false);
  });

  it('displaces the entity by one step and clears the component once exhausted', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 100, 100, 10);
    // remaining < speed so a single step exhausts the knockback.
    addComponent(world.ecs, eid, set(Knockback, { dirX: 1, dirY: 0, remaining: 4, speed: 10 }));

    knockbackSystem(world);

    // step = min(speed, remaining) = 4 -> moves +4 on x.
    expect(world.stores.position.x[eid]).toBeCloseTo(104);
    expect(hasComponent(world.ecs, eid, Knockback)).toBe(false);
  });

  it('keeps the component while distance remains across multiple frames', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 10);
    addComponent(world.ecs, eid, set(Knockback, { dirX: 0, dirY: 1, remaining: 10, speed: 4 }));

    knockbackSystem(world);
    expect(world.stores.position.y[eid]).toBeCloseTo(4);
    expect(hasComponent(world.ecs, eid, Knockback)).toBe(true);

    knockbackSystem(world);
    expect(world.stores.position.y[eid]).toBeCloseTo(8);
    expect(hasComponent(world.ecs, eid, Knockback)).toBe(true);

    knockbackSystem(world);
    expect(world.stores.position.y[eid]).toBeCloseTo(10);
    expect(hasComponent(world.ecs, eid, Knockback)).toBe(false);
  });

  it('blocks knockback that would partially push a large enemy into a wall', () => {
    const world = createTestWorld();
    world.floorMap = makeWalledMap();
    const eid = spawnEnemy(world, 144, 112, 10);
    world.stores.sprite.width[eid] = 30;
    world.stores.sprite.height[eid] = 30;
    addComponent(world.ecs, eid, set(Knockback, { dirX: 1, dirY: 0, remaining: 2, speed: 2 }));

    knockbackSystem(world);

    expect(world.stores.position.x[eid]).toBeCloseTo(145);
    expect(world.stores.position.y[eid]).toBeCloseTo(112);
    expect(hasComponent(world.ecs, eid, Knockback)).toBe(false);
  });
});
