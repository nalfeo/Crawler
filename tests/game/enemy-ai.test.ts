import { query, setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { EnemyBehavior, EnemyProjectile, Velocity } from '../../src/core/components.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import {
  movementSystem,
  spawnBehaviorEnemy,
  spawnEnemy,
  spawnPlayer,
} from '../../src/core/index.js';
import { AI_TYPE, enemyAISystem } from '../../src/game/index.js';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

function createOneRoomMapWithDoor(doorOpen: boolean): FloorMap {
  const config: MapConfig = {
    widthTiles: 8,
    heightTiles: 8,
    tileSizePx: 32,
    biome: BiomeType.DUNGEON,
    seed: 42,
    roomWidthRange: [4, 6],
    roomHeightRange: [4, 6],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(8, 8);
  tileMap.fill(TilePresets.FLOOR);
  tileMap.setFlags(3, 1, doorOpen ? TilePresets.DOOR_OPEN : TilePresets.DOOR_CLOSED);
  const roomGraph = new RoomGraph();
  roomGraph.add({ x: 1, y: 1, width: 5, height: 5 }, [{ x: 3, y: 1, connectsTo: -1 }], []);
  return new FloorMap(config, tileMap, roomGraph, new Uint8Array(64), { x: 2, y: 2 });
}

function createObstacleMap(): FloorMap {
  const config: MapConfig = {
    widthTiles: 12,
    heightTiles: 12,
    tileSizePx: 32,
    biome: BiomeType.DUNGEON,
    seed: 42,
    roomWidthRange: [4, 6],
    roomHeightRange: [4, 6],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(12, 12);
  tileMap.fill(TilePresets.FLOOR);
  // Vertical wall directly between enemy and player.
  for (let y = 1; y < 11; y += 1) {
    tileMap.setFlags(5, y, TilePresets.WALL);
  }
  return new FloorMap(config, tileMap, new RoomGraph(), new Uint8Array(144), { x: 2, y: 2 });
}

describe('enemyAISystem', () => {
  it('moves a chase enemy toward the player', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 10, 0, 20, AI_TYPE.CHASE, 2, 100, 0);

    enemyAISystem(world);
    movementSystem(world);

    expect(world.stores.position.x[enemy]).toBeLessThan(10);
    expect(world.stores.position.y[enemy]).toBeCloseTo(0);
  });

  it('sets chase enemy velocity toward the player', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 3, 4, 20, AI_TYPE.CHASE, 2.5, 100, 0);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeCloseTo(-1.5);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(-2);
  });

  it('moves a swarm enemy toward the player while separating from nearby swarmers', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 0);
    const swarmer = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.SWARM, 2, 200, 0);
    spawnBehaviorEnemy(world, 0, 10, 20, AI_TYPE.SWARM, 2, 200, 0);

    enemyAISystem(world);

    expect(world.stores.velocity.x[swarmer]).toBeGreaterThan(0);
    expect(world.stores.velocity.y[swarmer]).toBeLessThan(0);
  });

  it('ignores distant swarm neighbors outside the neighbor radius', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 0);
    const swarmer = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.SWARM, 2, 300, 0);
    spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.SWARM, 2, 300, 0);

    enemyAISystem(world);

    expect(world.stores.velocity.x[swarmer]).toBeCloseTo(2);
    expect(world.stores.velocity.y[swarmer]).toBeCloseTo(0);
  });

  it('makes ranged enemies back away when they are too close', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 50, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeGreaterThan(0);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(0);
  });

  it('stops ranged enemies from approaching once they are within attack range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 140, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeCloseTo(0);
    expect(Math.abs(world.stores.velocity.y[enemy] ?? 0)).toBeCloseTo(1.5);
  });

  it('moves ranged enemies toward the player while outside attack range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 170, 0, 20, AI_TYPE.RANGED, 2, 300, 150);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeCloseTo(-2);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(0);
  });

  it('affects only enemies with the EnemyBehavior component', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const plainEnemy = spawnEnemy(world, 50, 0, 20);

    setComponent(world.ecs, plainEnemy, Velocity, { x: 0.75, y: -0.25 });
    enemyAISystem(world);

    expect(world.stores.velocity.x[plainEnemy]).toBeCloseTo(0.75);
    expect(world.stores.velocity.y[plainEnemy]).toBeCloseTo(-0.25);
    expect(world.stores.enemyBehavior.type[plainEnemy]).toBe(0);
    expect(EnemyBehavior).toBeTypeOf('object');
  });

  it('stops all behavior enemies when no player exists', () => {
    const world = createTestWorld();
    const chaseEnemy = spawnBehaviorEnemy(world, 10, 0, 20, AI_TYPE.CHASE, 2, 100, 0);
    const swarmEnemy = spawnBehaviorEnemy(world, 20, 10, 20, AI_TYPE.SWARM, 2, 100, 0);

    setComponent(world.ecs, chaseEnemy, Velocity, { x: 1.25, y: -0.5 });
    setComponent(world.ecs, swarmEnemy, Velocity, { x: -0.75, y: 0.25 });

    enemyAISystem(world);

    expect(world.stores.velocity.x[chaseEnemy]).toBeCloseTo(0);
    expect(world.stores.velocity.y[chaseEnemy]).toBeCloseTo(0);
    expect(world.stores.velocity.x[swarmEnemy]).toBeCloseTo(0);
    expect(world.stores.velocity.y[swarmEnemy]).toBeCloseTo(0);
  });

  it('stops chase enemies when the player is outside aggro range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 150, 0, 20, AI_TYPE.CHASE, 2, 100, 0);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeCloseTo(0);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(0);
  });

  it('stops swarm enemies when the player is outside aggro range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 180, 0, 20, AI_TYPE.SWARM, 2, 100, 0);
    spawnBehaviorEnemy(world, 180, 10, 20, AI_TYPE.SWARM, 2, 100, 0);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeCloseTo(0);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(0);
  });

  it('ranged enemies do not detect player outside aggro range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 400, 0, 20, AI_TYPE.RANGED, 2, 100, 150);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeCloseTo(0);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(0);
  });

  it('keeps room enemies idle until their room door opens', () => {
    const world = createTestWorld();
    world.floorMap = createOneRoomMapWithDoor(false);
    spawnPlayer(world, 32, 32);
    const enemy = spawnBehaviorEnemy(world, 64, 64, 20, AI_TYPE.CHASE, 2, 200, 0);

    enemyAISystem(world);
    expect(world.stores.velocity.x[enemy]).toBeCloseTo(0);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(0);

    world.floorMap.tileMap.openDoor(3, 1);
    enemyAISystem(world);
    expect(world.stores.velocity.x[enemy]).not.toBeCloseTo(0);
  });

  it('steers around nearby wall obstacles instead of pushing straight into them', () => {
    const world = createTestWorld();
    world.floorMap = createObstacleMap();
    spawnPlayer(world, 8 * 32 + 16, 6 * 32 + 16);
    const enemy = spawnBehaviorEnemy(world, 4 * 32 + 28, 6 * 32 + 16, 20, AI_TYPE.CHASE, 2, 300, 0);

    enemyAISystem(world);

    // Direct path is blocked by the x=5 wall, so avoidance should introduce lateral steering.
    expect(world.stores.velocity.y[enemy]).not.toBeCloseTo(0);
  });

  it('falls back to chase behavior when ranged attack range is zero', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 120, 0, 20, AI_TYPE.RANGED, 2, 200, 0);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeCloseTo(-2);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(0);
  });

  it('does not fire projectiles at zero distance and remains stationary', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.RANGED, 2, 200, 150);

    enemyAISystem(world);

    expect(query(world.ecs, [EnemyProjectile])).toHaveLength(0);
    expect(world.stores.velocity.x[enemy]).toBeCloseTo(0);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(0);
  });

  it('respects ranged fire cooldown before firing again', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);

    world.elapsedMs = 1_000;
    world.stores.enemyBehavior.lastFireMs[enemy] = 900;
    world.stores.enemyBehavior.fireCooldownMs[enemy] = 200;

    enemyAISystem(world);

    expect(query(world.ecs, [EnemyProjectile])).toHaveLength(0);
    expect(world.stores.enemyBehavior.lastFireMs[enemy]).toBeCloseTo(900);
  });

  it('pushes overlapping enemies apart via separation', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 0);
    // Two chase enemies at the exact same position, within aggro range
    const enemyA = spawnBehaviorEnemy(world, 50, 0, 20, AI_TYPE.CHASE, 2, 200, 0);
    const enemyB = spawnBehaviorEnemy(world, 50, 0, 20, AI_TYPE.CHASE, 2, 200, 0);

    enemyAISystem(world);

    const vxA = world.stores.velocity.x[enemyA]!;
    const vyA = world.stores.velocity.y[enemyA]!;
    const vxB = world.stores.velocity.x[enemyB]!;
    const vyB = world.stores.velocity.y[enemyB]!;

    // They should have diverging velocities due to separation
    const divergesX = Math.sign(vxA) !== Math.sign(vxB) || vxA !== vxB;
    const divergesY = Math.sign(vyA) !== Math.sign(vyB) || vyA !== vyB;
    expect(divergesX || divergesY).toBe(true);

    // Velocities should be clamped to max speed (2)
    expect(Math.hypot(vxA, vyA)).toBeLessThanOrEqual(2 + 0.001);
    expect(Math.hypot(vxB, vyB)).toBeLessThanOrEqual(2 + 0.001);
  });

  it('does not apply separation to de-aggroed enemies', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Two chase enemies at same position but outside aggro range
    const enemyA = spawnBehaviorEnemy(world, 200, 0, 20, AI_TYPE.CHASE, 2, 50, 0);
    const enemyB = spawnBehaviorEnemy(world, 200, 0, 20, AI_TYPE.CHASE, 2, 50, 0);

    enemyAISystem(world);

    // De-aggroed enemies should remain stationary
    expect(world.stores.velocity.x[enemyA]).toBeCloseTo(0);
    expect(world.stores.velocity.y[enemyA]).toBeCloseTo(0);
    expect(world.stores.velocity.x[enemyB]).toBeCloseTo(0);
    expect(world.stores.velocity.y[enemyB]).toBeCloseTo(0);
  });
});
