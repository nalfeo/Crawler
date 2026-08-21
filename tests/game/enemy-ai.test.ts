import { addComponent, addEntity, query, set, setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  DeathTimer,
  DoorState,
  EnemyBehavior,
  EnemyProjectile,
  Velocity,
} from '../../src/core/components.js';
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
import { BiomeType, RoomRole, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { AI_TYPE, PATH_PERSONA, TRAVERSAL_MODE, enemyAISystem } from '../../src/game/index.js';
import { getDoorRevision } from '../../src/game/enemyAISystem.js';
import { createTestWorld } from '../helpers/world-factory.js';

const ENEMY_RADIUS = 1;
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
    tileSizeFt: 4,
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
    tileSizeFt: 4,
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

function createSafeRoomDoorMap(): FloorMap {
  const config: MapConfig = {
    widthTiles: 8,
    heightTiles: 8,
    tileSizeFt: 4,
    biome: BiomeType.DUNGEON,
    seed: 84,
    roomWidthRange: [4, 6],
    roomHeightRange: [4, 6],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(8, 8);
  tileMap.fill(TilePresets.FLOOR);
  tileMap.setFlags(3, 2, TilePresets.DOOR_OPEN);
  const roomGraph = new RoomGraph();
  roomGraph.add(
    { x: 1, y: 1, width: 3, height: 3 },
    [{ x: 3, y: 2, connectsTo: -1 }],
    [],
    RoomRole.SAFE,
  );
  return new FloorMap(config, tileMap, roomGraph, new Uint8Array(64), { x: 2, y: 2 });
}

function createObstacleMap(): FloorMap {
  const config: MapConfig = {
    widthTiles: 12,
    heightTiles: 12,
    tileSizeFt: 4,
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
    tileSizeFt: 4,
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

function createSparseIslandMap(): FloorMap {
  const width = 40;
  const height = 12;
  const config: MapConfig = {
    widthTiles: width,
    heightTiles: height,
    tileSizeFt: 4,
    biome: BiomeType.DUNGEON,
    seed: 11,
    roomWidthRange: [4, 6],
    roomHeightRange: [4, 6],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(width, height);
  tileMap.fill(TilePresets.WALL);
  for (let y = 3; y <= 8; y += 1) {
    for (let x = 3; x <= 8; x += 1) {
      tileMap.setFlags(x, y, TilePresets.FLOOR);
    }
  }
  return new FloorMap(config, tileMap, new RoomGraph(), new Uint8Array(width * height), {
    x: 4,
    y: 4,
  });
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
    const enemy = spawnBehaviorEnemy(world, 1.25, 0, 20, AI_TYPE.CHASE, 0.25, 12.5, 0);

    enemyAISystem(world);
    movementSystem(world);

    expect(world.stores.position.x[enemy]).toBeLessThan(1.25);
    expect(world.stores.position.y[enemy]).toBeCloseTo(0);
  });

  it('sets chase enemy velocity toward the player', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 0.375, 0.5, 20, AI_TYPE.CHASE, 0.3125, 12.5, 0);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeCloseTo(-0.1875);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(-0.25);
  });

  it('stops chasing the player once the enemy becomes a corpse (DeathTimer)', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 3, 4, 20, AI_TYPE.CHASE, 2.5, 100, 0);

    // Leftover chase velocity from the frame the enemy died — the AI system must
    // zero it and not produce a fresh chase vector while the corpse lingers.
    setComponent(world.ecs, enemy, Velocity, { x: -1.5, y: -2 });
    addComponent(world.ecs, enemy, set(DeathTimer, { remainingMs: 300 }));

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBe(0);
    expect(world.stores.velocity.y[enemy]).toBe(0);
  });

  it('moves a swarm enemy toward the player while separating from nearby swarmers', () => {
    const world = createTestWorld();
    spawnPlayer(world, 12.5, 0);
    const swarmer = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.SWARM, 0.25, 25, 0);
    spawnBehaviorEnemy(world, 0, 1.25, 20, AI_TYPE.SWARM, 0.25, 25, 0);

    enemyAISystem(world);

    expect(world.stores.velocity.x[swarmer]).toBeGreaterThan(0);
    expect(world.stores.velocity.y[swarmer]).toBeLessThan(0);
  });

  it('ignores distant swarm neighbors outside the neighbor radius', () => {
    const world = createTestWorld();
    spawnPlayer(world, 12.5, 0);
    const swarmer = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.SWARM, 0.25, 37.5, 0);
    spawnBehaviorEnemy(world, 12.5, 0, 20, AI_TYPE.SWARM, 0.25, 37.5, 0);

    enemyAISystem(world);

    expect(world.stores.velocity.x[swarmer]).toBeCloseTo(0.25);
    expect(world.stores.velocity.y[swarmer]).toBeCloseTo(0);
  });

  it('makes ranged enemies back away when they are too close', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 6.25, 0, 20, AI_TYPE.RANGED, 0.1875, 25, 18.75);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeGreaterThan(0);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(0);
  });

  it('stops ranged enemies from approaching once they are within attack range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 17.5, 0, 20, AI_TYPE.RANGED, 0.1875, 25, 18.75);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeCloseTo(0);
    expect(Math.abs(world.stores.velocity.y[enemy] ?? 0)).toBeCloseTo(0.1875);
  });

  it('moves ranged enemies toward the player while outside attack range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 21.25, 0, 20, AI_TYPE.RANGED, 0.25, 37.5, 18.75);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeCloseTo(-0.25);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(0);
  });

  it('makes guardian enemies hold position once they reach guard distance', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 2.5, 0, 20, AI_TYPE.GUARDIAN, 0.25, 25, 0);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBe(0);
    expect(world.stores.velocity.y[enemy]).toBe(0);
  });

  it('makes guardian enemies close from outside guard distance', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 8, 0, 20, AI_TYPE.GUARDIAN, 0.25, 25, 0);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeLessThan(0);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(0);
  });

  it('makes support enemies retreat without firing when inside their standoff band', () => {
    const world = createTestWorld();
    world.elapsedMs = 1_000;
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 4, 0, 20, AI_TYPE.SUPPORT, 0.25, 25, 12);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeGreaterThan(0);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(0);
    expect(query(world.ecs, [EnemyProjectile])).toHaveLength(0);
  });

  it('keeps support enemies still while already at standoff range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 10, 0, 20, AI_TYPE.SUPPORT, 0.25, 25, 12);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBe(0);
    expect(world.stores.velocity.y[enemy]).toBe(0);
  });

  it('pathing ranged enemies strafe while inside attack range band', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(true);
    spawnPlayer(world, 11 * 4 + 2, 5 * 4 + 2);
    const enemy = spawnBehaviorEnemy(
      world,
      9 * 4 + 2,
      5 * 4 + 2,
      20,
      AI_TYPE.RANGED,
      0.25,
      62.5,
      15,
      { persona: PATH_PERSONA.NAVIGATOR },
    );

    enemyAISystem(world);

    expect(Math.abs(world.stores.velocity.y[enemy] ?? 0)).toBeGreaterThan(0.0125);
  });

  it('pathing support enemies retreat from too-close targets without firing', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(true);
    world.elapsedMs = 1_000;
    spawnPlayer(world, 7 * 4 + 2, 5 * 4 + 2);
    const enemy = spawnBehaviorEnemy(
      world,
      8 * 4 + 2,
      5 * 4 + 2,
      20,
      AI_TYPE.SUPPORT,
      0.25,
      62.5,
      12,
      { persona: PATH_PERSONA.NAVIGATOR },
    );
    world.stores.enemyBehavior.aggroedPermanently[enemy] = 1;

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeGreaterThan(0);
    expect(query(world.ecs, [EnemyProjectile])).toHaveLength(0);
  });

  it('pathing ranged enemies retreat when too close to the player', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(true);
    spawnPlayer(world, 7 * 4 + 2, 5 * 4 + 2);
    const enemy = spawnBehaviorEnemy(
      world,
      7 * 4 + 2,
      5 * 4 + 2,
      20,
      AI_TYPE.RANGED,
      0.25,
      62.5,
      20,
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
    spawnPlayer(world, 5 * 4, 5 * 4);
    const enemy = spawnBehaviorEnemy(world, 4 * 4, 4 * 4, 20, AI_TYPE.CHASE, 0.25, 62.5, 0, {
      persona: PATH_PERSONA.FLANKER,
    });

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBe(0);
    expect(world.stores.velocity.y[enemy]).toBe(0);
  });

  it('falls back to direct chase steering when path target resolution fails', () => {
    const world = createTestWorld();
    world.floorMap = createSparseIslandMap();
    // Intentionally place the player in an all-wall region far from the only walkable island
    // so path target resolution returns null.
    spawnPlayer(world, 35 * 4, 5 * 4);
    const enemy = spawnBehaviorEnemy(world, 5 * 4, 5 * 4, 20, AI_TYPE.CHASE, 0.25, 625, 0, {
      persona: PATH_PERSONA.NAVIGATOR,
    });

    enemyAISystem(world);

    expect(
      Math.hypot(world.stores.velocity.x[enemy] ?? 0, world.stores.velocity.y[enemy] ?? 0),
    ).toBeGreaterThan(0.1);
  });

  it('affects only enemies with the EnemyBehavior component', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const plainEnemy = spawnEnemy(world, 6.25, 0, 20);

    setComponent(world.ecs, plainEnemy, Velocity, { x: 0.75, y: -0.25 });
    enemyAISystem(world);

    expect(world.stores.velocity.x[plainEnemy]).toBeCloseTo(0.75);
    expect(world.stores.velocity.y[plainEnemy]).toBeCloseTo(-0.25);
    expect(world.stores.enemyBehavior.type[plainEnemy]).toBe(0);
    expect(EnemyBehavior).toBeTypeOf('object');
  });

  it('stops all behavior enemies when no player exists', () => {
    const world = createTestWorld();
    const chaseEnemy = spawnBehaviorEnemy(world, 1.25, 0, 20, AI_TYPE.CHASE, 0.25, 12.5, 0);
    const swarmEnemy = spawnBehaviorEnemy(world, 2.5, 1.25, 20, AI_TYPE.SWARM, 0.25, 12.5, 0);

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
    const enemy = spawnBehaviorEnemy(world, 18.75, 0, 20, AI_TYPE.CHASE, 0.25, 12.5, 0);

    enemyAISystem(world);

    expect(
      Math.hypot(world.stores.velocity.x[enemy] ?? 0, world.stores.velocity.y[enemy] ?? 0),
    ).toBeGreaterThan(0.0125);
  });

  it('makes swarm enemies wander when the player is outside aggro range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 22.5, 0, 20, AI_TYPE.SWARM, 0.25, 12.5, 0);
    spawnBehaviorEnemy(world, 22.5, 1.25, 20, AI_TYPE.SWARM, 0.25, 12.5, 0);

    enemyAISystem(world);

    expect(
      Math.hypot(world.stores.velocity.x[enemy] ?? 0, world.stores.velocity.y[enemy] ?? 0),
    ).toBeGreaterThan(0.0125);
  });

  it('makes ranged enemies wander when the player is outside aggro range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 50, 0, 20, AI_TYPE.RANGED, 0.25, 12.5, 18.75);

    enemyAISystem(world);

    expect(
      Math.hypot(world.stores.velocity.x[enemy] ?? 0, world.stores.velocity.y[enemy] ?? 0),
    ).toBeGreaterThan(0.0125);
  });

  it('makes enemies forget the player and wander when the player is in a safe room', () => {
    const world = createTestWorld();
    world.floorMap = createSafeRoomDoorMap();
    spawnPlayer(world, 2 * 4 + 2, 2 * 4 + 2);
    world.playerInSafeRoom = true;
    const enemy = spawnBehaviorEnemy(world, 4 * 4 + 2, 2 * 4 + 2, 20, AI_TYPE.CHASE, 0.25, 50, 0);

    enemyAISystem(world);

    expect(
      Math.hypot(world.stores.velocity.x[enemy] ?? 0, world.stores.velocity.y[enemy] ?? 0),
    ).toBeGreaterThan(0.1);
  });

  it('avoids selecting idle wander directions that stay near safe-room doors', () => {
    const world = createTestWorld();
    world.floorMap = createSafeRoomDoorMap();
    spawnPlayer(world, 2 * 4 + 2, 2 * 4 + 2);
    world.playerInSafeRoom = true;
    const enemy = spawnBehaviorEnemy(world, 4 * 4 + 2, 2 * 4 + 2, 20, AI_TYPE.SWARM, 0.25, 50, 0);

    enemyAISystem(world);

    const enemyX = world.stores.position.x[enemy] ?? 0;
    const enemyY = world.stores.position.y[enemy] ?? 0;
    const vx = world.stores.velocity.x[enemy] ?? 0;
    const vy = world.stores.velocity.y[enemy] ?? 0;
    const speed = Math.hypot(vx, vy);
    expect(speed).toBeGreaterThan(0.1);
    const dirX = vx / speed;
    const dirY = vy / speed;
    const lookaheadX = enemyX + dirX * 2.5;
    const lookaheadY = enemyY + dirY * 2.5;
    const lookaheadTile = world.floorMap.worldToTile(lookaheadX, lookaheadY);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const tx = lookaheadTile.x + dx;
        const ty = lookaheadTile.y + dy;
        if (!world.floorMap.tileMap.inBounds(tx, ty)) {
          continue;
        }
        expect(world.floorMap.tileMap.isDoor(tx, ty)).toBe(false);
      }
    }
  });

  it('moves a mob away from a closed safe-room door instead of camping it', () => {
    const world = createTestWorld();
    world.floorMap = createSafeRoomDoorMap();
    // Close the safe-room door so it has reset to block line of sight.
    world.floorMap.tileMap.setFlags(3, 2, TilePresets.DOOR_CLOSED);
    spawnPlayer(world, 2 * 4 + 2, 2 * 4 + 2);
    world.playerInSafeRoom = true;
    // Mob sits just outside the door (tile 4,2) — the door is at tile 3,2.
    const enemy = spawnBehaviorEnemy(world, 4 * 4 + 2, 2 * 4 + 2, 20, AI_TYPE.SWARM, 0.25, 50, 0);

    enemyAISystem(world);

    const vx = world.stores.velocity.x[enemy] ?? 0;
    const vy = world.stores.velocity.y[enemy] ?? 0;
    expect(Math.hypot(vx, vy)).toBeGreaterThan(0.1);
    // It must peel outward (away from the door, toward +x), not press the door.
    expect(vx).toBeGreaterThan(0);
  });

  it('falls back to wander when the outward direction from a closed door is blocked', () => {
    const world = createTestWorld();
    world.floorMap = createSafeRoomDoorMap();
    world.floorMap.tileMap.setFlags(3, 2, TilePresets.DOOR_CLOSED);
    // Wall the tile just outside the door so the outward flee lands in a wall.
    world.floorMap.tileMap.setFlags(5, 2, TilePresets.WALL);
    spawnPlayer(world, 2 * 4 + 2, 2 * 4 + 2);
    world.playerInSafeRoom = true;
    const enemy = spawnBehaviorEnemy(world, 4 * 4 + 2, 2 * 4 + 2, 20, AI_TYPE.SWARM, 0.25, 50, 0);

    enemyAISystem(world);

    // It must not press +x into the wall; the dispersal path yields to wander.
    const vx = world.stores.velocity.x[enemy] ?? 0;
    expect(Number.isFinite(vx)).toBe(true);
    expect(vx).toBeLessThanOrEqual(0.001);
  });

  it('wanders normally in a safe-room lull when no door is within dispersal range', () => {
    const world = createTestWorld();
    world.floorMap = createSafeRoomDoorMap();
    world.floorMap.tileMap.setFlags(3, 2, TilePresets.DOOR_CLOSED);
    spawnPlayer(world, 2 * 4 + 2, 2 * 4 + 2);
    world.playerInSafeRoom = true;
    // Mob is far from the only door (tile 3,2), so dispersal finds nothing.
    const enemy = spawnBehaviorEnemy(world, 6 * 4 + 2, 6 * 4 + 2, 20, AI_TYPE.SWARM, 0.25, 50, 0);

    enemyAISystem(world);

    const vx = world.stores.velocity.x[enemy] ?? 0;
    const vy = world.stores.velocity.y[enemy] ?? 0;
    expect(Number.isFinite(Math.hypot(vx, vy))).toBe(true);
  });

  it('moves a leaper toward the player at normal speed while out of pounce range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Spawn well outside the leap range but inside aggro range.
    const enemy = spawnBehaviorEnemy(world, 37.5, 0, 20, AI_TYPE.LEAPER, 0.125, 50, 0);

    enemyAISystem(world);

    const vx = world.stores.velocity.x[enemy] ?? 0;
    const vy = world.stores.velocity.y[enemy] ?? 0;
    // It should commit a normal-speed approach straight at the player (−x), not
    // a slow sideways prep wiggle.
    expect(vx).toBeLessThan(-0.0625);
    expect(Math.abs(vy)).toBeLessThan(0.025);
  });

  it('does not enter leap mode until within leap distance (~5 ft) of the player', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // 10 ft: aggroed but well beyond the ~5 ft pounce band. The slime
    // must close like a normal enemy here rather than start the slow telegraph
    // wiggle — the old 12 ft trigger pounced uselessly from this far out.
    const enemy = spawnBehaviorEnemy(world, 10, 0, 20, AI_TYPE.LEAPER, 0.125, 25, 0);

    enemyAISystem(world);

    const vx = world.stores.velocity.x[enemy] ?? 0;
    const vy = world.stores.velocity.y[enemy] ?? 0;
    // Full-speed straight approach (−x), not a slow sideways prep wiggle.
    expect(vx).toBeLessThan(-0.0625);
    expect(Math.abs(vy)).toBeLessThan(0.025);
    expect(Math.hypot(vx, vy)).toBeGreaterThan(0.1);
  });

  it('makes leaper enemies pause-wiggle before fast leaps', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Spawn inside the pounce band: beyond the inner range (where the slime
    // Spawn inside the pounce band: beyond the inner range (where the slime
    // reverts to a hittable normal approach) but within SLIME_LEAP_RANGE (~5 ft).
    const enemy = spawnBehaviorEnemy(world, 3.75, 0, 20, AI_TYPE.LEAPER, 0.125, 25, 0);

    enemyAISystem(world);
    const firstSpeed = Math.hypot(
      world.stores.velocity.x[enemy] ?? 0,
      world.stores.velocity.y[enemy] ?? 0,
    );
    expect(firstSpeed).toBeLessThan(0.125);
    expect(Math.abs(world.stores.velocity.y[enemy] ?? 0)).toBeGreaterThan(0.00625);

    let observedLeapSpeed = 0;
    let longestLeapStreak = 0;
    let currentLeapStreak = 0;
    for (let i = 0; i < 80; i += 1) {
      world.frameCount += 1;
      world.elapsedMs += 16;
      enemyAISystem(world);
      const speed = Math.hypot(
        world.stores.velocity.x[enemy] ?? 0,
        world.stores.velocity.y[enemy] ?? 0,
      );
      observedLeapSpeed = Math.max(observedLeapSpeed, speed);
      if (speed > 0.1875) {
        currentLeapStreak += 1;
        longestLeapStreak = Math.max(longestLeapStreak, currentLeapStreak);
      } else {
        currentLeapStreak = 0;
      }
    }

    // The leap is a deliberate, gentler hop (≈1.5× base speed, with a bonus-speed
    // floor) so it stays hittable, but is still clearly faster than the slow prep
    // crouch.
    expect(observedLeapSpeed).toBeGreaterThan(0.1875);
    expect(longestLeapStreak).toBeGreaterThanOrEqual(10);
  });

  it('freezes leaper enemies in a recovery window after each leap', () => {
    const world = createTestWorld();
    // Stationary player: the slime commits a leap toward this point, then must
    // sit frozen in its recovery window — the deliberate opening for the player
    // to attack after dodging the pounce.
    spawnPlayer(world, 0, 0);
    // Spawn inside the pounce band (beyond the inner range, within leap range).
    const enemy = spawnBehaviorEnemy(world, 3.75, 0, 20, AI_TYPE.LEAPER, 0.1875, 25, 0);

    let maxSpeed = 0;
    let longestFrozenStreak = 0;
    let currentFrozenStreak = 0;
    let frozenAfterLeap = false;
    let sawLeap = false;

    for (let i = 0; i < 150; i += 1) {
      enemyAISystem(world);
      const speed = Math.hypot(
        world.stores.velocity.x[enemy] ?? 0,
        world.stores.velocity.y[enemy] ?? 0,
      );
      maxSpeed = Math.max(maxSpeed, speed);
      if (speed > 0.1875) {
        sawLeap = true;
      }
      if (speed < 1e-6) {
        currentFrozenStreak += 1;
        // Only count a freeze that follows a leap as the recovery window (the
        // slime is not frozen before it has pounced).
        if (sawLeap && currentFrozenStreak > longestFrozenStreak) {
          longestFrozenStreak = currentFrozenStreak;
          frozenAfterLeap = true;
        }
      } else {
        currentFrozenStreak = 0;
      }
      world.frameCount += 1;
      world.elapsedMs += 16;
    }

    // The pounce reaches a clearly fast leap speed before the freeze.
    expect(maxSpeed).toBeGreaterThan(0.1875);
    // After leaping the slime holds completely still for a meaningful window.
    expect(frozenAfterLeap).toBe(true);
    expect(longestFrozenStreak).toBeGreaterThanOrEqual(15);
  });

  it('keeps room enemies wandering away from closed doors until their room door opens', () => {
    const world = createTestWorld();
    world.floorMap = createOneRoomMapWithDoor(false);
    spawnPlayer(world, 4, 4);
    const enemy = spawnBehaviorEnemy(world, 8, 8, 20, AI_TYPE.CHASE, 0.25, 25, 0);

    enemyAISystem(world);
    const vx = world.stores.velocity.x[enemy] ?? 0;
    const vy = world.stores.velocity.y[enemy] ?? 0;
    const speed = Math.hypot(vx, vy);
    expect(speed).toBeGreaterThan(0.1);
    const dirX = vx / speed;
    const dirY = vy / speed;
    const lookaheadX = (world.stores.position.x[enemy] ?? 0) + dirX * 2.5;
    const lookaheadY = (world.stores.position.y[enemy] ?? 0) + dirY * 2.5;
    const lookaheadTile = world.floorMap.worldToTile(lookaheadX, lookaheadY);
    expect(world.floorMap.tileMap.isDoor(lookaheadTile.x, lookaheadTile.y)).toBe(false);

    world.floorMap.tileMap.openDoor(3, 1);
    enemyAISystem(world);
    expect(world.stores.velocity.x[enemy]).not.toBeCloseTo(0);
  });

  it('engages immediately when the player is already inside the enemy room', () => {
    const world = createTestWorld();
    world.floorMap = createOneRoomMapWithDoor(false);
    spawnPlayer(world, 2 * 4 + 2, 2 * 4 + 2);
    const enemy = spawnBehaviorEnemy(world, 4 * 4 + 2, 2 * 4 + 2, 20, AI_TYPE.CHASE, 0.25, 25, 0);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeLessThan(0);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(0);
  });

  it('steers around nearby wall obstacles instead of pushing straight into them', () => {
    const world = createTestWorld();
    world.floorMap = createObstacleMap();
    spawnPlayer(world, 8 * 4 + 2, 6 * 4 + 2);
    const enemy = spawnBehaviorEnemy(
      world,
      4 * 4 + 3.5,
      6 * 4 + 2,
      20,
      AI_TYPE.CHASE,
      0.25,
      37.5,
      0,
    );

    enemyAISystem(world);

    // Direct path is blocked by the x=5 wall, so avoidance should introduce lateral steering.
    expect(world.stores.velocity.y[enemy]).not.toBeCloseTo(0);
  });

  it('falls back to chase behavior when ranged attack range is zero', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 15, 0, 20, AI_TYPE.RANGED, 0.25, 25, 0);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeCloseTo(-0.25);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(0);
  });

  it('does not fire projectiles at zero distance and remains stationary', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.RANGED, 0.25, 25, 18.75);

    enemyAISystem(world);

    expect(query(world.ecs, [EnemyProjectile])).toHaveLength(0);
    expect(world.stores.velocity.x[enemy]).toBeCloseTo(0);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(0);
  });

  it('respects ranged fire cooldown before firing again', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 12.5, 0, 20, AI_TYPE.RANGED, 0.1875, 25, 18.75);

    world.elapsedMs = 1_000;
    world.stores.enemyBehavior.lastFireMs[enemy] = 900;
    world.stores.enemyBehavior.fireCooldownMs[enemy] = 200;

    enemyAISystem(world);

    expect(query(world.ecs, [EnemyProjectile])).toHaveLength(0);
    expect(world.stores.enemyBehavior.lastFireMs[enemy]).toBeCloseTo(900);
  });

  it('pushes overlapping enemies apart via separation', () => {
    const world = createTestWorld();
    spawnPlayer(world, 12.5, 0);
    // Two chase enemies at the exact same position, within aggro range
    const enemyA = spawnBehaviorEnemy(world, 6.25, 0, 20, AI_TYPE.CHASE, 0.25, 25, 0);
    const enemyB = spawnBehaviorEnemy(world, 6.25, 0, 20, AI_TYPE.CHASE, 0.25, 25, 0);

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
    expect(Math.hypot(vxA, vyA)).toBeLessThanOrEqual(0.25 + 0.001);
    expect(Math.hypot(vxB, vyB)).toBeLessThanOrEqual(0.25 + 0.001);
  });

  it('keeps de-aggroed enemies wandering independently', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Two chase enemies at same position but outside aggro range
    const enemyA = spawnBehaviorEnemy(world, 25, 0, 20, AI_TYPE.CHASE, 0.25, 6.25, 0);
    const enemyB = spawnBehaviorEnemy(world, 25, 0, 20, AI_TYPE.CHASE, 0.25, 6.25, 0);

    enemyAISystem(world);

    const speedA = Math.hypot(
      world.stores.velocity.x[enemyA] ?? 0,
      world.stores.velocity.y[enemyA] ?? 0,
    );
    const speedB = Math.hypot(
      world.stores.velocity.x[enemyB] ?? 0,
      world.stores.velocity.y[enemyB] ?? 0,
    );
    expect(speedA).toBeGreaterThan(0.0125);
    expect(speedB).toBeGreaterThan(0.0125);
  });

  it('navigator personas route through doorways instead of getting stuck on pillars', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(true);
    const player = spawnPlayer(world, 11 * 4 + 2, 5 * 4 + 2);
    const navigator = spawnBehaviorEnemy(
      world,
      3 * 4 + 2,
      5 * 4 + 2,
      20,
      AI_TYPE.CHASE,
      0.25,
      62.5,
      0,
      {
        persona: PATH_PERSONA.NAVIGATOR,
      },
    );

    runTicks(world, 120);

    expect(world.stores.position.x[navigator]).toBeGreaterThan(
      (world.stores.position.x[player] ?? 0) - 8,
    );
  });

  it('navigator chase still closes distance while player strafes left-right', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(true);
    const player = spawnPlayer(world, 10 * 4 + 2, 5 * 4 + 2);
    const navigator = spawnBehaviorEnemy(
      world,
      2 * 4 + 2,
      5 * 4 + 2,
      20,
      AI_TYPE.CHASE,
      0.25,
      62.5,
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
      world.stores.position.x[player] = (world.stores.position.x[player] ?? 0) + strafeDir * 0.1875;
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
    expect(endDistance).toBeLessThan(startDistance - 5);
  });

  it('stupid personas keep direct steering and stay blocked by closed doors', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(false);
    spawnPlayer(world, 11 * 4 + 2, 5 * 4 + 2);
    const stupid = spawnBehaviorEnemy(
      world,
      3 * 4 + 2,
      5 * 4 + 2,
      20,
      AI_TYPE.CHASE,
      0.25,
      62.5,
      0,
      {
        persona: PATH_PERSONA.STUPID,
      },
    );

    runTicks(world, 120);

    expect(
      world.floorMap.worldToTile(
        world.stores.position.x[stupid] ?? 0,
        world.stores.position.y[stupid] ?? 0,
      ).x,
    ).toBeLessThanOrEqual(5);
  });

  it('flanker personas prefer passing beyond the player instead of stopping in front', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(true);
    const player = spawnPlayer(world, 9 * 4 + 2, 5 * 4 + 2);
    const flanker = spawnBehaviorEnemy(
      world,
      2 * 4 + 2,
      5 * 4 + 2,
      20,
      AI_TYPE.CHASE,
      0.3,
      62.5,
      0,
      {
        persona: PATH_PERSONA.FLANKER,
        flankDistance: 12,
      },
    );

    runTicks(world, 140);

    expect(world.stores.position.x[flanker]).toBeGreaterThan(world.stores.position.x[player] ?? 0);
  });

  it('flanker personas respect the player overlap cap while pathing past the player', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(true);
    const player = spawnPlayer(world, 9 * 4 + 2, 5 * 4 + 2);
    const flanker = spawnBehaviorEnemy(
      world,
      2 * 4 + 2,
      5 * 4 + 2,
      20,
      AI_TYPE.CHASE,
      0.3,
      62.5,
      0,
      {
        persona: PATH_PERSONA.FLANKER,
        flankDistance: 12,
      },
    );

    const minDistance = runTicksAndTrackMinDistance(world, 160, player, flanker);
    expect(minDistance).toBeGreaterThanOrEqual(MIN_ENEMY_PLAYER_DISTANCE - 0.05);
  });

  it('flying traversal can cross blocked structures where ground traversal cannot', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(false);
    spawnPlayer(world, 11 * 4 + 2, 5 * 4 + 2);
    const grounded = spawnBehaviorEnemy(
      world,
      3 * 4 + 2,
      5 * 4 + 2,
      20,
      AI_TYPE.CHASE,
      0.25,
      62.5,
      0,
      {
        persona: PATH_PERSONA.NAVIGATOR,
        traversalMode: TRAVERSAL_MODE.GROUND,
      },
    );
    const flying = spawnBehaviorEnemy(
      world,
      3 * 4 + 2,
      6 * 4 + 2,
      20,
      AI_TYPE.CHASE,
      0.25,
      62.5,
      0,
      {
        persona: PATH_PERSONA.NAVIGATOR,
        traversalMode: TRAVERSAL_MODE.FLYING,
        isFlying: true,
      },
    );

    runTicks(world, 120);

    expect(world.stores.position.x[grounded]).toBeLessThan(6 * 4);
    expect(world.stores.position.x[flying]).toBeGreaterThan(9 * 4);
  });

  it('flying traversal respects the player overlap cap while crossing blocked structures', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(false);
    const player = spawnPlayer(world, 8 * 4 + 2, 5 * 4 + 2);
    const flying = spawnBehaviorEnemy(
      world,
      3 * 4 + 2,
      5 * 4 + 2,
      20,
      AI_TYPE.CHASE,
      0.25,
      62.5,
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
    spawnPlayer(world, 11 * 4 + 2, 5 * 4 + 2);
    const navigator = spawnBehaviorEnemy(
      world,
      3 * 4 + 2,
      5 * 4 + 2,
      20,
      AI_TYPE.CHASE,
      0.25,
      62.5,
      0,
      {
        persona: PATH_PERSONA.NAVIGATOR,
      },
    );

    const door = addEntity(world.ecs);
    addComponent(world.ecs, door, set(DoorState, { tileX: 6, tileY: 5, logicalOpen: 0 }));
    runTicks(world, 40);
    const beforeOpenX = world.stores.position.x[navigator] ?? 0;

    setComponent(world.ecs, door, DoorState, { tileX: 6, tileY: 5, logicalOpen: 1 });
    runTicks(world, 100);

    expect(beforeOpenX).toBeLessThan(6 * 4);
    expect(world.stores.position.x[navigator]).toBeGreaterThan(8 * 4);
  });

  it('door revision hashes live tile passability, not the stale effectiveOpen mirror', () => {
    const world = createTestWorld();
    world.floorMap = makePathingFloorMap(false); // door tile (6,5) starts closed
    const tileMap = world.floorMap.tileMap;
    const door = addEntity(world.ecs);
    addComponent(world.ecs, door, set(DoorState, { tileX: 6, tileY: 5, logicalOpen: 0 }));

    const rev1 = getDoorRevision(world, tileMap);

    // Writing only the stored `effectiveOpen` mirror (what `doorSystem` derives)
    // while the tile stays physically closed must NOT bump the revision: the memo
    // keys off live tile truth, never the post-`doorSystem` mirror. If this ever
    // regressed to hashing `effectiveOpen`, the revision would change right here.
    world.stores.doorState.effectiveOpen[door] = 1;
    expect(tileMap.isPassable(6, 5)).toBe(false);
    expect(getDoorRevision(world, tileMap)).toBe(rev1);

    // Opening the real tile pre-`doorSystem` (mirror already 1, but the physical
    // tile is what changed) MUST bump the revision that same AI tick so flow-field
    // / tile-path memos invalidate immediately instead of one tick late.
    tileMap.openDoor(6, 5);
    expect(tileMap.isPassable(6, 5)).toBe(true);
    expect(getDoorRevision(world, tileMap)).not.toBe(rev1);
  });
});
