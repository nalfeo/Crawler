import { addComponent, addEntity, query, set, setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { DoorState, EnemyBehavior, EnemyProjectile, Velocity } from '../../src/core/components.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import {
  doorSystem,
  movementSystem,
  spawnBehaviorEnemy,
  spawnEnemy,
  spawnPlayer,
} from '../../src/core/index.js';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { AI_TYPE, PATH_PERSONA, TRAVERSAL_MODE, enemyAISystem } from '../../src/game/index.js';
import { createTestWorld } from '../helpers/world-factory.js';

const ENEMY_RADIUS = 8;
const MAX_OVERLAP_FRACTION = 0.25;
const MIN_ENEMY_PLAYER_DISTANCE = ENEMY_RADIUS * 2 * (1 - MAX_OVERLAP_FRACTION);

function makePathingFloorMap(doorOpen = true): FloorMap {
  const width = 14;
  const height = 10;
  const tileMap = new TileMap(width, height);
  const terrain = new Uint8Array(width * height);

  const config: MapConfig = {
    widthTiles: width,
    heightTiles: height,
    tileSizePx: 32,
    biome: BiomeType.DUNGEON,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const isBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      const isPillar = x === 6 && y >= 1 && y <= height - 2 && y !== 5;
      tileMap.flags[idx] = isBorder || isPillar ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }

  tileMap.flags[5 * width + 6] = doorOpen ? TilePresets.DOOR_OPEN : TilePresets.DOOR_CLOSED;
  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 2, y: 5 });
}

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
  for (let y = 1; y < 11; y += 1) {
    tileMap.setFlags(5, y, TilePresets.WALL);
  }
  return new FloorMap(config, tileMap, new RoomGraph(), new Uint8Array(144), { x: 2, y: 2 });
}

function createFullyBlockedMap(): FloorMap {
  const config: MapConfig = {
    widthTiles: 10,
    heightTiles: 10,
    tileSizePx: 32,
    biome: BiomeType.DUNGEON,
    seed: 7,
    roomWidthRange: [4, 6],
    roomHeightRange: [4, 6],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(10, 10);
  tileMap.fill(TilePresets.WALL);
  return new FloorMap(config, tileMap, new RoomGraph(), new Uint8Array(100), { x: 1, y: 1 });
}

function runTicks(world: ReturnType<typeof createTestWorld>, ticks: number): void {
  for (let i = 0; i < ticks; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += 16;
    doorSystem(world);
    enemyAISystem(world);
    movementSystem(world);
  }
}

function runTicksAndTrackMinDistance(
  world: ReturnType<typeof createTestWorld>,
  ticks: number,
  player: number,
  enemy: number,
): number {
  let minDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < ticks; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += 16;
    doorSystem(world);
    enemyAISystem(world);
    movementSystem(world);

    const dx = (world.stores.position.x[player] ?? 0) - (world.stores.position.x[enemy] ?? 0);
    const dy = (world.stores.position.y[player] ?? 0) - (world.stores.position.y[enemy] ?? 0);
    minDistance = Math.min(minDistance, Math.hypot(dx, dy));
  }

  return minDistance;
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

  it('pathing ranged enemies strafe while inside attack range band', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(true);
    spawnPlayer(world, 11 * 32 + 16, 5 * 32 + 16);
    const enemy = spawnBehaviorEnemy(
      world,
      9 * 32 + 16,
      5 * 32 + 16,
      20,
      AI_TYPE.RANGED,
      2,
      500,
      120,
      { persona: PATH_PERSONA.NAVIGATOR },
    );

    enemyAISystem(world);

    expect(Math.abs(world.stores.velocity.y[enemy] ?? 0)).toBeGreaterThan(0.1);
  });

  it('pathing ranged enemies retreat when too close to the player', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(true);
    spawnPlayer(world, 7 * 32 + 16, 5 * 32 + 16);
    const enemy = spawnBehaviorEnemy(
      world,
      7 * 32 + 16,
      5 * 32 + 16,
      20,
      AI_TYPE.RANGED,
      2,
      500,
      160,
      { persona: PATH_PERSONA.NAVIGATOR },
    );

    enemyAISystem(world);

    expect(
      Math.hypot(world.stores.velocity.x[enemy] ?? 0, world.stores.velocity.y[enemy] ?? 0),
    ).toBe(0);
  });

  it('keeps pathing flanker enemies idle when no traversable target tile exists', () => {
    const world = createTestWorld();
    world.floorMap = createFullyBlockedMap();
    spawnPlayer(world, 5 * 32, 5 * 32);
    const enemy = spawnBehaviorEnemy(world, 4 * 32, 4 * 32, 20, AI_TYPE.CHASE, 2, 500, 0, {
      persona: PATH_PERSONA.FLANKER,
    });

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBe(0);
    expect(world.stores.velocity.y[enemy]).toBe(0);
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

  it('makes chase enemies wander when the player is outside aggro range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 150, 0, 20, AI_TYPE.CHASE, 2, 100, 0);

    enemyAISystem(world);

    expect(
      Math.hypot(world.stores.velocity.x[enemy] ?? 0, world.stores.velocity.y[enemy] ?? 0),
    ).toBeGreaterThan(0.1);
  });

  it('makes swarm enemies wander when the player is outside aggro range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 180, 0, 20, AI_TYPE.SWARM, 2, 100, 0);
    spawnBehaviorEnemy(world, 180, 10, 20, AI_TYPE.SWARM, 2, 100, 0);

    enemyAISystem(world);

    expect(
      Math.hypot(world.stores.velocity.x[enemy] ?? 0, world.stores.velocity.y[enemy] ?? 0),
    ).toBeGreaterThan(0.1);
  });

  it('makes ranged enemies wander when the player is outside aggro range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 400, 0, 20, AI_TYPE.RANGED, 2, 100, 150);

    enemyAISystem(world);

    expect(
      Math.hypot(world.stores.velocity.x[enemy] ?? 0, world.stores.velocity.y[enemy] ?? 0),
    ).toBeGreaterThan(0.1);
  });

  it('moves a leaper toward the player at normal speed while out of pounce range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Spawn well outside the leap range but inside aggro range.
    const enemy = spawnBehaviorEnemy(world, 300, 0, 20, AI_TYPE.LEAPER, 1, 400, 0);

    enemyAISystem(world);

    const vx = world.stores.velocity.x[enemy] ?? 0;
    const vy = world.stores.velocity.y[enemy] ?? 0;
    // It should commit a normal-speed approach straight at the player (−x), not
    // a slow sideways prep wiggle.
    expect(vx).toBeLessThan(-0.5);
    expect(Math.abs(vy)).toBeLessThan(0.2);
  });

  it('makes leaper enemies pause-wiggle before fast leaps', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Spawn inside the pounce band: beyond the inner range (where the slime
    // reverts to a hittable normal approach) but within SLIME_LEAP_RANGE.
    const enemy = spawnBehaviorEnemy(world, 80, 0, 20, AI_TYPE.LEAPER, 1, 200, 0);

    enemyAISystem(world);
    const firstSpeed = Math.hypot(
      world.stores.velocity.x[enemy] ?? 0,
      world.stores.velocity.y[enemy] ?? 0,
    );
    expect(firstSpeed).toBeLessThan(1);
    expect(Math.abs(world.stores.velocity.y[enemy] ?? 0)).toBeGreaterThan(0.05);

    let observedLeapSpeed = 0;
    for (let i = 0; i < 80; i += 1) {
      world.frameCount += 1;
      world.elapsedMs += 16;
      enemyAISystem(world);
      observedLeapSpeed = Math.max(
        observedLeapSpeed,
        Math.hypot(world.stores.velocity.x[enemy] ?? 0, world.stores.velocity.y[enemy] ?? 0),
      );
    }

    // The leap is a deliberate, gentler hop (≈1.5× base speed, with a bonus-speed
    // floor) so it stays hittable, but is still clearly faster than the slow prep
    // crouch.
    expect(observedLeapSpeed).toBeGreaterThan(1.5);
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

  it('keeps de-aggroed enemies wandering independently', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Two chase enemies at same position but outside aggro range
    const enemyA = spawnBehaviorEnemy(world, 200, 0, 20, AI_TYPE.CHASE, 2, 50, 0);
    const enemyB = spawnBehaviorEnemy(world, 200, 0, 20, AI_TYPE.CHASE, 2, 50, 0);

    enemyAISystem(world);

    const speedA = Math.hypot(
      world.stores.velocity.x[enemyA] ?? 0,
      world.stores.velocity.y[enemyA] ?? 0,
    );
    const speedB = Math.hypot(
      world.stores.velocity.x[enemyB] ?? 0,
      world.stores.velocity.y[enemyB] ?? 0,
    );
    expect(speedA).toBeGreaterThan(0.1);
    expect(speedB).toBeGreaterThan(0.1);
  });

  it('navigator personas route through doorways instead of getting stuck on pillars', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(true);
    const player = spawnPlayer(world, 11 * 32 + 16, 5 * 32 + 16);
    const navigator = spawnBehaviorEnemy(
      world,
      3 * 32 + 16,
      5 * 32 + 16,
      20,
      AI_TYPE.CHASE,
      2,
      500,
      0,
      {
        persona: PATH_PERSONA.NAVIGATOR,
      },
    );

    runTicks(world, 120);

    expect(world.stores.position.x[navigator]).toBeGreaterThan(
      (world.stores.position.x[player] ?? 0) - 64,
    );
  });

  it('navigator chase still closes distance while player strafes left-right', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(true);
    const player = spawnPlayer(world, 10 * 32 + 16, 5 * 32 + 16);
    const navigator = spawnBehaviorEnemy(
      world,
      2 * 32 + 16,
      5 * 32 + 16,
      20,
      AI_TYPE.CHASE,
      2,
      500,
      0,
      {
        persona: PATH_PERSONA.NAVIGATOR,
      },
    );

    const startDx =
      (world.stores.position.x[player] ?? 0) - (world.stores.position.x[navigator] ?? 0);
    const startDy =
      (world.stores.position.y[player] ?? 0) - (world.stores.position.y[navigator] ?? 0);
    const startDistance = Math.hypot(startDx, startDy);

    for (let i = 0; i < 120; i += 1) {
      const strafeDir = i % 20 < 10 ? -1 : 1;
      world.stores.position.x[player] = (world.stores.position.x[player] ?? 0) + strafeDir * 1.5;
      world.frameCount += 1;
      world.elapsedMs += 16;
      doorSystem(world);
      enemyAISystem(world);
      movementSystem(world);
    }

    const endDx =
      (world.stores.position.x[player] ?? 0) - (world.stores.position.x[navigator] ?? 0);
    const endDy =
      (world.stores.position.y[player] ?? 0) - (world.stores.position.y[navigator] ?? 0);
    const endDistance = Math.hypot(endDx, endDy);
    expect(endDistance).toBeLessThan(startDistance - 40);
  });

  it('stupid personas keep direct steering and stay blocked by closed doors', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(false);
    spawnPlayer(world, 11 * 32 + 16, 5 * 32 + 16);
    const stupid = spawnBehaviorEnemy(
      world,
      3 * 32 + 16,
      5 * 32 + 16,
      20,
      AI_TYPE.CHASE,
      2,
      500,
      0,
      {
        persona: PATH_PERSONA.STUPID,
      },
    );

    runTicks(world, 120);

    expect(
      world.floorMap.pixelToTile(
        world.stores.position.x[stupid] ?? 0,
        world.stores.position.y[stupid] ?? 0,
      ).x,
    ).toBeLessThanOrEqual(5);
  });

  it('flanker personas prefer passing beyond the player instead of stopping in front', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(true);
    const player = spawnPlayer(world, 9 * 32 + 16, 5 * 32 + 16);
    const flanker = spawnBehaviorEnemy(
      world,
      2 * 32 + 16,
      5 * 32 + 16,
      20,
      AI_TYPE.CHASE,
      2.4,
      500,
      0,
      {
        persona: PATH_PERSONA.FLANKER,
        flankDistance: 96,
      },
    );

    runTicks(world, 140);

    expect(world.stores.position.x[flanker]).toBeGreaterThan(world.stores.position.x[player] ?? 0);
  });

  it('flanker personas respect the player overlap cap while pathing past the player', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(true);
    const player = spawnPlayer(world, 9 * 32 + 16, 5 * 32 + 16);
    const flanker = spawnBehaviorEnemy(
      world,
      2 * 32 + 16,
      5 * 32 + 16,
      20,
      AI_TYPE.CHASE,
      2.4,
      500,
      0,
      {
        persona: PATH_PERSONA.FLANKER,
        flankDistance: 96,
      },
    );

    const minDistance = runTicksAndTrackMinDistance(world, 160, player, flanker);
    expect(minDistance).toBeGreaterThanOrEqual(MIN_ENEMY_PLAYER_DISTANCE - 0.05);
  });

  it('flying traversal can cross blocked structures where ground traversal cannot', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(false);
    spawnPlayer(world, 11 * 32 + 16, 5 * 32 + 16);
    const grounded = spawnBehaviorEnemy(
      world,
      3 * 32 + 16,
      5 * 32 + 16,
      20,
      AI_TYPE.CHASE,
      2,
      500,
      0,
      {
        persona: PATH_PERSONA.NAVIGATOR,
        traversalMode: TRAVERSAL_MODE.GROUND,
      },
    );
    const flying = spawnBehaviorEnemy(
      world,
      3 * 32 + 16,
      6 * 32 + 16,
      20,
      AI_TYPE.CHASE,
      2,
      500,
      0,
      {
        persona: PATH_PERSONA.NAVIGATOR,
        traversalMode: TRAVERSAL_MODE.FLYING,
        isFlying: true,
      },
    );

    runTicks(world, 120);

    expect(world.stores.position.x[grounded]).toBeLessThan(6 * 32);
    expect(world.stores.position.x[flying]).toBeGreaterThan(9 * 32);
  });

  it('flying traversal respects the player overlap cap while crossing blocked structures', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(false);
    const player = spawnPlayer(world, 8 * 32 + 16, 5 * 32 + 16);
    const flying = spawnBehaviorEnemy(
      world,
      3 * 32 + 16,
      5 * 32 + 16,
      20,
      AI_TYPE.CHASE,
      2,
      500,
      0,
      {
        persona: PATH_PERSONA.NAVIGATOR,
        traversalMode: TRAVERSAL_MODE.FLYING,
        isFlying: true,
      },
    );

    const minDistance = runTicksAndTrackMinDistance(world, 140, player, flying);
    expect(minDistance).toBeGreaterThanOrEqual(MIN_ENEMY_PLAYER_DISTANCE - 0.05);
  });

  it('door state changes trigger re-pathing without trapping navigators in rooms', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(false);
    spawnPlayer(world, 11 * 32 + 16, 5 * 32 + 16);
    const navigator = spawnBehaviorEnemy(
      world,
      3 * 32 + 16,
      5 * 32 + 16,
      20,
      AI_TYPE.CHASE,
      2,
      500,
      0,
      {
        persona: PATH_PERSONA.NAVIGATOR,
      },
    );

    const door = addEntity(world.ecs);
    addComponent(world.ecs, door, set(DoorState, { tileX: 6, tileY: 5, isOpen: 0 }));
    runTicks(world, 40);
    const beforeOpenX = world.stores.position.x[navigator] ?? 0;

    setComponent(world.ecs, door, DoorState, { tileX: 6, tileY: 5, isOpen: 1 });
    runTicks(world, 100);

    expect(beforeOpenX).toBeLessThan(6 * 32);
    expect(world.stores.position.x[navigator]).toBeGreaterThan(8 * 32);
  });
});
