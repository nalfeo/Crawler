import {
  addComponent,
  entityExists,
  hasComponent,
  query,
  removeEntity,
  set,
  setComponent,
} from 'bitecs';
import { BiomeType, type MapConfig } from '../shared/map-types.js';
import { getGenerator } from '../core/map/generators/registry.js';
import {
  Position,
  Player,
  Health,
  BroadcastScore,
  Sprite,
  DoorState,
  Enemy,
  Damage,
} from '../core/components.js';
import type { GameWorld } from '../core/world.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { setActiveWeapon } from './weaponSystem.js';
import { clearEntityStores, spawnBehaviorEnemy, spawnNpc, createEntity } from '../core/helpers.js';
import { setGoalFlag, setDoorLockConfig } from '../core/door-lock.js';
import { AI_TYPE } from './enemyAISystem.js';
import { getItemById } from '../shared/items.js';
import { GAME, PLAYER_SPEED } from '../shared/constants.js';

const FLOOR_1_PROTAGONIST = 'Rhea Vale';
const FLOOR_1_STARTER_POOL = ['sword', 'knife', 'bow', 'pistol', 'throwing-knife'] as const;
const FLOOR_1_TIMER_MS = 300_000;
const FLOOR_1_REQUIRED_RATS = 6;
const FLOOR_1_REQUIRED_SLIMES = 4;
const FLOOR_1_REQUIRED_TOTAL_KILLS = 10;
const FLOOR_1_REQUIRED_GOLD = 15;
const FLOOR_1_REQUIRED_JUNK = 2;
const FLOOR_1_MARKER_RADIUS_PX = 64;
const FLOOR_1_STAIR_SPAWN_COUNTDOWN_MS = 30_000;

const FLOOR_1_MAP_CONFIG: MapConfig = {
  widthTiles: 120,
  heightTiles: 70,
  tileSizePx: 32,
  biome: BiomeType.DUNGEON,
  seed: 42,
  roomWidthRange: [6, 14],
  roomHeightRange: [5, 13],
  maxRooms: 45,
  floorDensity: 0.42,
};

const RAT_SPAWN_WEIGHT = 0.62;
const RAT_HP = 20;
const RAT_SPEED = 1.25;
const RAT_DETECT_RANGE = 420;
const SLIME_HP = 30;
const SLIME_SPEED = 0.9;
const SLIME_DETECT_RANGE = 320;
const SPRITE_TEX_ENEMY_RAT = 1;
const SPRITE_TEX_ENEMY_SLIME = 2;
const FLOOR_1_STAIR_BOSS_HP = 280;
const FLOOR_1_STAIR_BOSS_SPEED = 1.15;
const FLOOR_1_STAIR_BOSS_DETECT_RANGE = 540;
const FLOOR_1_STAIR_BOSS_SPAWN_RADIUS_MIN = 64;
const FLOOR_1_STAIR_BOSS_SPAWN_RADIUS_MAX = 110;
const FLOOR_1_STAIR_BOSS_SPRITE_WIDTH = 30;
const FLOOR_1_STAIR_BOSS_SPRITE_HEIGHT = 30;
const FLOOR_1_ENEMY_CAP = 14;
const FLOOR_1_SPAWN_INTERVAL_MS = 900;
const FLOOR_1_CAMERA_ZOOM = 2.0;
const FLOOR_1_VIEWPORT_WIDTH_PX = GAME.WIDTH / FLOOR_1_CAMERA_ZOOM;
const FLOOR_1_AMBIENT_SPAWN_MAX_DISTANCE_PX = FLOOR_1_VIEWPORT_WIDTH_PX * 2;
const FLOOR_1_AMBIENT_DESPAWN_DISTANCE_PX = FLOOR_1_VIEWPORT_WIDTH_PX * 3;
const FLOOR_1_SPAWN_RADIUS_MIN = 160;
const FLOOR_1_SPAWN_RADIUS_MAX = FLOOR_1_AMBIENT_SPAWN_MAX_DISTANCE_PX;
const FLOOR_1_PLAYER_HP_BONUS = 20;
const FLOOR_1_PLAYER_MOVE_SPEED_BONUS = 0.2;
const FLOOR_1_PLAYER_PICKUP_RANGE_BONUS = 8;
const FLOOR_1_GOAL_PREFIX = 'floor1.objective';

interface Floor1SpawnerState {
  lastSpawnMs: number;
}

function pruneAmbientOverflow(
  world: GameWorld,
  playerX: number,
  playerY: number,
  overflowCount: number,
): void {
  if (!world.floor1 || overflowCount <= 0) {
    return;
  }
  const rankedAmbient = [...world.floor1.enemyArchetypes.keys()]
    .filter((eid) => entityExists(world.ecs, eid))
    .map((eid) => {
      const ex = world.stores.position.x[eid] ?? 0;
      const ey = world.stores.position.y[eid] ?? 0;
      const dx = ex - playerX;
      const dy = ey - playerY;
      return { eid, distanceSq: dx * dx + dy * dy };
    })
    .sort((a, b) => b.distanceSq - a.distanceSq);
  for (let i = 0; i < Math.min(overflowCount, rankedAmbient.length); i += 1) {
    const victim = rankedAmbient[i]?.eid;
    if (victim === undefined) {
      continue;
    }
    clearEntityStores(world, victim);
    removeEntity(world.ecs, victim);
    world.floor1.enemyArchetypes.delete(victim);
  }
}

function pruneAmbientOutOfRange(world: GameWorld, playerX: number, playerY: number): void {
  if (!world.floor1) {
    return;
  }
  const maxDistanceSq = FLOOR_1_AMBIENT_DESPAWN_DISTANCE_PX * FLOOR_1_AMBIENT_DESPAWN_DISTANCE_PX;
  for (const eid of [...world.floor1.enemyArchetypes.keys()]) {
    if (!entityExists(world.ecs, eid)) {
      world.floor1.enemyArchetypes.delete(eid);
      continue;
    }
    const ex = world.stores.position.x[eid] ?? 0;
    const ey = world.stores.position.y[eid] ?? 0;
    const dx = ex - playerX;
    const dy = ey - playerY;
    if (dx * dx + dy * dy <= maxDistanceSq) {
      continue;
    }
    clearEntityStores(world, eid);
    removeEntity(world.ecs, eid);
    world.floor1.enemyArchetypes.delete(eid);
  }
}

const spawnerStateByWorld = new WeakMap<GameWorld, Floor1SpawnerState>();
const playerBonusApplied = new WeakSet<GameWorld>();

function getSpawnerState(world: GameWorld): Floor1SpawnerState {
  let state = spawnerStateByWorld.get(world);
  if (state === undefined) {
    state = { lastSpawnMs: Number.NEGATIVE_INFINITY };
    spawnerStateByWorld.set(world, state);
  }
  return state;
}

function pickStarterChoices(world: GameWorld): string[] {
  const pool = [...FLOOR_1_STARTER_POOL];
  const selected: string[] = [];
  while (pool.length > 0 && selected.length < 3) {
    const idx = world.rng.nextInt(0, pool.length - 1);
    const id = pool.splice(idx, 1)[0];
    if (id !== undefined) {
      selected.push(id);
    }
  }
  return selected;
}

function centerOfRoom(room: { bounds: { x: number; y: number; width: number; height: number } }): {
  x: number;
  y: number;
} {
  return {
    x: Math.floor(room.bounds.x + room.bounds.width / 2),
    y: Math.floor(room.bounds.y + room.bounds.height / 2),
  };
}

function chooseObjectiveTiles(world: GameWorld): {
  safeRoomPos: { x: number; y: number };
  staircasePos: { x: number; y: number };
} {
  const floorMap = world.floorMap;
  const fallbackSafe = { x: floorMap?.widthPx ? floorMap.widthPx - 120 : 1120, y: 120 };
  const fallbackStair = { x: floorMap?.widthPx ? floorMap.widthPx - 120 : 1120, y: 560 };

  if (!floorMap) {
    return { safeRoomPos: fallbackSafe, staircasePos: fallbackStair };
  }

  // Prefer role-tagged rooms assigned by the generator
  const bossStairRoom = floorMap.bossStairRoom;
  const safeRoom = floorMap.safeRoom;

  if (bossStairRoom && safeRoom) {
    return {
      safeRoomPos: floorMap.tileToPixel(centerOfRoom(safeRoom).x, centerOfRoom(safeRoom).y),
      staircasePos: floorMap.tileToPixel(
        centerOfRoom(bossStairRoom).x,
        centerOfRoom(bossStairRoom).y,
      ),
    };
  }

  // Fallback: distance-based selection for biomes without role-tagged rooms
  if (floorMap.rooms.length < 2) {
    return { safeRoomPos: fallbackSafe, staircasePos: fallbackStair };
  }

  const spawnTile = floorMap.playerSpawn;
  const scored = floorMap.rooms.map((room) => {
    const center = centerOfRoom(room);
    const dx = center.x - spawnTile.x;
    const dy = center.y - spawnTile.y;
    return { room, distanceSq: dx * dx + dy * dy };
  });
  scored.sort((a, b) => b.distanceSq - a.distanceSq);

  const staircaseRoom = scored[0]?.room ?? floorMap.rooms[floorMap.rooms.length - 1]!;
  const safeRoomFallback =
    scored[1]?.room ?? floorMap.rooms[Math.max(0, floorMap.rooms.length - 2)]!;

  return {
    safeRoomPos: floorMap.tileToPixel(
      centerOfRoom(safeRoomFallback).x,
      centerOfRoom(safeRoomFallback).y,
    ),
    staircasePos: floorMap.tileToPixel(
      centerOfRoom(staircaseRoom).x,
      centerOfRoom(staircaseRoom).y,
    ),
  };
}

export function initializeFloor1Scenario(world: GameWorld, playerEid: number): void {
  const config: MapConfig = {
    ...FLOOR_1_MAP_CONFIG,
    seed: world.rng.nextInt(1, 2_000_000),
  };
  const floorMap = getGenerator(config.biome).generate(config, world.rng);
  world.floorMap = floorMap;

  const spawn = floorMap.tileToPixel(floorMap.playerSpawn.x, floorMap.playerSpawn.y);
  if (hasComponent(world.ecs, playerEid, Position)) {
    setComponent(world.ecs, playerEid, Position, { x: spawn.x, y: spawn.y });
  }
  if (!hasComponent(world.ecs, playerEid, BroadcastScore)) {
    addComponent(world.ecs, playerEid, set(BroadcastScore, { current: 0 }));
  }

  const maxHp = (world.stores.health.max[playerEid] ?? 100) + FLOOR_1_PLAYER_HP_BONUS;
  setComponent(world.ecs, playerEid, Health, { current: maxHp, max: maxHp });

  const { safeRoomPos, staircasePos } = chooseObjectiveTiles(world);
  world.floor1 = {
    protagonistName: FLOOR_1_PROTAGONIST,
    starterWeaponPool: FLOOR_1_STARTER_POOL,
    starterChoices: pickStarterChoices(world),
    selectedWeaponId: null,
    selectedChoiceIndex: null,
    baseStatBonuses: {
      maxHp: FLOOR_1_PLAYER_HP_BONUS,
      moveSpeed: FLOOR_1_PLAYER_MOVE_SPEED_BONUS,
      pickupRange: FLOOR_1_PLAYER_PICKUP_RANGE_BONUS,
    },
    enemyArchetypes: new Map(),
    guideNpcEid: null,
    bossDoorEids: [],
    objective: {
      requiredRats: FLOOR_1_REQUIRED_RATS,
      requiredSlimes: FLOOR_1_REQUIRED_SLIMES,
      requiredGold: FLOOR_1_REQUIRED_GOLD,
      requiredJunk: FLOOR_1_REQUIRED_JUNK,
      deadlineMs: FLOOR_1_TIMER_MS,
      staircaseSpawnCountdownMs: FLOOR_1_STAIR_SPAWN_COUNTDOWN_MS,
      safeRoomPos,
      staircasePos,
      welcomeOfficePos: safeRoomPos,
      markerRadiusPx: FLOOR_1_MARKER_RADIUS_PX,
      questAccepted: false,
      questCompleted: false,
      ratsKilled: 0,
      slimesKilled: 0,
      goldCollected: 0,
      junkCollected: 0,
      safeRoomDiscovered: false,
      staircaseSpawnStartedMs: null,
      staircaseSpawnRemainingMs: null,
      staircaseSpawned: false,
      staircaseLocked: true,
      staircaseUnlocked: false,
      staircaseDiscovered: false,
      bossBattleStarted: false,
      staircaseBossEid: null,
      staircaseBossDefeated: false,
    },
    failReason: null,
    runSummary: null,
  };
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.safeRoomDiscovered`, false);
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.staircaseUnlocked`, false);
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.staircaseDiscovered`, false);
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.combatComplete`, false);
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.lootComplete`, false);
  setGoalFlag(world, 'floor1-defeat-boss', false);
  setGoalFlag(world, 'floor1-boss-active', false);

  // Spawn the tutorial guide NPC near the player's starting position.
  world.floor1.guideNpcEid = spawnNpc(
    world,
    world.floor1.objective.welcomeOfficePos.x,
    world.floor1.objective.welcomeOfficePos.y,
    'tutorial-goon',
  );

  // Keep boss-room doors locked until the Tutorial Goon quest is completed.
  setGoalFlag(world, 'floor1-goon-quest-complete', false);
  const bossStairRoom = floorMap.bossStairRoom;
  if (bossStairRoom) {
    for (const door of bossStairRoom.doors) {
      const doorEid = createEntity(world);
      addComponent(
        world.ecs,
        doorEid,
        set(DoorState, { tileX: door.x, tileY: door.y, isOpen: 0, isLocked: 1, wasUnlocked: 0 }),
      );
      setDoorLockConfig(world, doorEid, {
        unlock: {
          operator: 'all',
          conditions: [{ type: 'goal', goalId: 'floor1-goon-quest-complete' }],
        },
      });
      world.floor1.bossDoorEids.push(doorEid);
    }
  }

  world.state = 'loadout';
}

export function selectFloor1StarterWeapon(world: GameWorld, optionIndex: number): void {
  if (!world.floor1 || world.state !== 'loadout') {
    return;
  }

  const weaponId = world.floor1.starterChoices[optionIndex];
  if (weaponId === undefined) {
    return;
  }

  const weaponDef = getWeaponDef(weaponId);
  if (weaponDef === undefined) {
    return;
  }

  world.floor1.selectedWeaponId = weaponId;
  world.floor1.selectedChoiceIndex = optionIndex;
  setActiveWeapon(world, weaponDef);
  world.state = 'playing';
}

function resolveSpawnPosition(
  world: GameWorld,
  playerX: number,
  playerY: number,
): { x: number; y: number } {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return { x: playerX + FLOOR_1_SPAWN_RADIUS_MIN, y: playerY };
  }
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const angle = world.rng.next() * Math.PI * 2;
    const radius =
      FLOOR_1_SPAWN_RADIUS_MIN +
      world.rng.next() * (FLOOR_1_SPAWN_RADIUS_MAX - FLOOR_1_SPAWN_RADIUS_MIN);
    const x = playerX + Math.cos(angle) * radius;
    const y = playerY + Math.sin(angle) * radius;
    if (floorMap.isPassableAt(x, y)) {
      const tile = floorMap.pixelToTile(x, y);
      const candidate = floorMap.tileToPixel(tile.x, tile.y);
      if (isInAnyRoom(world, candidate.x, candidate.y)) {
        return candidate;
      }
    }
  }
  const viableRooms = floorMap.rooms.filter(
    (room) => room !== floorMap.safeRoom && room !== floorMap.bossStairRoom,
  );
  if (viableRooms.length > 0) {
    for (let i = 0; i < 32; i += 1) {
      const room = viableRooms[world.rng.nextInt(0, viableRooms.length - 1)]!;
      const minX = room.bounds.x + 1;
      const maxX = Math.max(minX, room.bounds.x + room.bounds.width - 2);
      const minY = room.bounds.y + 1;
      const maxY = Math.max(minY, room.bounds.y + room.bounds.height - 2);
      const tx = world.rng.nextInt(minX, maxX);
      const ty = world.rng.nextInt(minY, maxY);
      const candidate = floorMap.tileToPixel(tx, ty);
      if (floorMap.isPassableAt(candidate.x, candidate.y)) {
        return candidate;
      }
    }
  }
  const fallbackTile = floorMap.pixelToTile(playerX + FLOOR_1_SPAWN_RADIUS_MIN, playerY);
  return floorMap.tileToPixel(fallbackTile.x, fallbackTile.y);
}

function resolveBossSpawnPosition(
  world: GameWorld,
  bossRoom: { bounds: { x: number; y: number; width: number; height: number } } | null,
  stairX: number,
  stairY: number,
): { x: number; y: number } {
  const floorMap = world.floorMap;
  if (floorMap && bossRoom) {
    const center = centerOfRoom(bossRoom);
    const minX = Math.max(bossRoom.bounds.x + 2, center.x - 2);
    const maxX = Math.min(bossRoom.bounds.x + bossRoom.bounds.width - 3, center.x + 2);
    const minY = Math.max(bossRoom.bounds.y + 2, center.y - 2);
    const maxY = Math.min(bossRoom.bounds.y + bossRoom.bounds.height - 3, center.y + 2);
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const tx = world.rng.nextInt(minX, maxX);
      const ty = world.rng.nextInt(minY, maxY);
      const candidate = floorMap.tileToPixel(tx, ty);
      if (floorMap.isPassableAt(candidate.x, candidate.y)) {
        return candidate;
      }
    }
    const centerCandidate = floorMap.tileToPixel(center.x, center.y);
    if (floorMap.isPassableAt(centerCandidate.x, centerCandidate.y)) {
      return centerCandidate;
    }
  }
  if (!floorMap) {
    return { x: stairX + FLOOR_1_STAIR_BOSS_SPAWN_RADIUS_MIN, y: stairY };
  }
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const angle = world.rng.next() * Math.PI * 2;
    const radius =
      FLOOR_1_STAIR_BOSS_SPAWN_RADIUS_MIN +
      world.rng.next() *
        (FLOOR_1_STAIR_BOSS_SPAWN_RADIUS_MAX - FLOOR_1_STAIR_BOSS_SPAWN_RADIUS_MIN);
    const x = stairX + Math.cos(angle) * radius;
    const y = stairY + Math.sin(angle) * radius;
    if (floorMap.isPassableAt(x, y)) {
      const tile = floorMap.pixelToTile(x, y);
      return floorMap.tileToPixel(tile.x, tile.y);
    }
  }
  const fallbackTile = floorMap.pixelToTile(stairX + FLOOR_1_STAIR_BOSS_SPAWN_RADIUS_MIN, stairY);
  return floorMap.tileToPixel(fallbackTile.x, fallbackTile.y);
}

function isInRoom(
  world: GameWorld,
  px: number,
  py: number,
  room: { bounds: { x: number; y: number; width: number; height: number } } | null,
): boolean {
  if (!world.floorMap || !room) return false;
  const tile = world.floorMap.pixelToTile(px, py);
  const { x, y, width, height } = room.bounds;
  return tile.x >= x && tile.x < x + width && tile.y >= y && tile.y < y + height;
}

function isFullyInsideBossRoom(world: GameWorld, px: number, py: number): boolean {
  const floorMap = world.floorMap;
  const bossRoom = floorMap?.bossStairRoom ?? null;
  if (!floorMap || !bossRoom || !isInRoom(world, px, py, bossRoom)) {
    return false;
  }
  const playerTile = floorMap.pixelToTile(px, py);
  for (const door of bossRoom.doors) {
    const distance = Math.max(Math.abs(playerTile.x - door.x), Math.abs(playerTile.y - door.y));
    if (distance <= 2) {
      return false;
    }
  }
  return true;
}

function isInAnyRoom(world: GameWorld, px: number, py: number): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return false;
  }
  const tile = floorMap.pixelToTile(px, py);
  for (const room of floorMap.rooms) {
    const { x, y, width, height } = room.bounds;
    if (tile.x >= x && tile.x < x + width && tile.y >= y && tile.y < y + height) {
      return true;
    }
  }
  return false;
}

function spawnFloor1StairBoss(world: GameWorld): number {
  const objective = world.floor1?.objective;
  if (!objective) {
    throw new Error('Cannot spawn stair boss without floor1 objective state.');
  }
  const bossRoom = world.floorMap?.bossStairRoom ?? null;
  const spawnPoint = resolveBossSpawnPosition(
    world,
    bossRoom,
    objective.staircasePos.x,
    objective.staircasePos.y,
  );
  // Boss uses chaser movement and fires independently via attackRange + cooldown.
  const eid = spawnBehaviorEnemy(
    world,
    spawnPoint.x,
    spawnPoint.y,
    FLOOR_1_STAIR_BOSS_HP,
    AI_TYPE.CHASE,
    FLOOR_1_STAIR_BOSS_SPEED,
    FLOOR_1_STAIR_BOSS_DETECT_RANGE,
    280,
  );
  setComponent(world.ecs, eid, Sprite, {
    textureId: SPRITE_TEX_ENEMY_SLIME,
    width: FLOOR_1_STAIR_BOSS_SPRITE_WIDTH,
    height: FLOOR_1_STAIR_BOSS_SPRITE_HEIGHT,
  });

  // Boss has melee contact damage for swipe attacks.
  setComponent(world.ecs, eid, Damage, { amount: 12 });

  // Keep boss aggro active during the locked-room fight.
  world.stores.enemyBehavior.aggroedPermanently[eid] = 1;

  // Boss fires projectiles every 5 seconds.
  world.stores.enemyBehavior.fireCooldownMs[eid] = 5000;

  return eid;
}

function beginFloor1BossBattle(world: GameWorld): void {
  const objective = world.floor1?.objective;
  if (!objective || objective.bossBattleStarted) {
    return;
  }

  objective.bossBattleStarted = true;
  objective.staircaseLocked = true;
  objective.staircaseUnlocked = false;
  setGoalFlag(world, 'floor1-boss-active', true);
  objective.staircaseBossEid = spawnFloor1StairBoss(world);
  const floorMap = world.floorMap;
  const bossRoom = floorMap?.bossStairRoom;
  if (bossRoom) {
    for (const door of bossRoom.doors) {
      floorMap!.tileMap.closeDoor(door.x, door.y);
    }
  }
  // Replace lock config: doors stay locked while boss is active, open once boss defeated.
  for (const doorEid of world.floor1.bossDoorEids) {
    world.stores.doorState.isLocked[doorEid] = 1;
    world.stores.doorState.isOpen[doorEid] = 0;
    setDoorLockConfig(world, doorEid, {
      unlock: {
        operator: 'all',
        conditions: [{ type: 'goal', goalId: 'floor1-defeat-boss' }],
      },
      relock: {
        operator: 'all',
        conditions: [{ type: 'goal', goalId: 'floor1-boss-active' }],
      },
    });
  }
}

export function floor1PlayerStatSystem(world: GameWorld): void {
  if (!world.floor1) {
    return;
  }
  const players = query(world.ecs, [Player, Position, Health]);
  const player = players[0];
  if (player === undefined) {
    return;
  }

  if (!playerBonusApplied.has(world)) {
    const maxHp = Math.max(
      world.stores.health.max[player] ?? 100,
      100 + world.floor1.baseStatBonuses.maxHp,
    );
    setComponent(world.ecs, player, Health, { current: maxHp, max: maxHp });
    playerBonusApplied.add(world);
  }

  const speedScale = (PLAYER_SPEED + world.floor1.baseStatBonuses.moveSpeed) / PLAYER_SPEED;
  world.stores.velocity.x[player] = (world.stores.velocity.x[player] ?? 0) * speedScale;
  world.stores.velocity.y[player] = (world.stores.velocity.y[player] ?? 0) * speedScale;
}

export function floor1EnemyDirectorSystem(world: GameWorld): void {
  if (!world.floor1 || world.state !== 'playing') {
    return;
  }

  if (world.floor1.enemyArchetypes.size >= FLOOR_1_ENEMY_CAP) {
    return;
  }

  const state = getSpawnerState(world);
  if (world.elapsedMs - state.lastSpawnMs < FLOOR_1_SPAWN_INTERVAL_MS) {
    return;
  }

  const players = query(world.ecs, [Player, Position]);
  const player = players[0];
  if (player === undefined) {
    return;
  }

  const playerX = world.stores.position.x[player] ?? 0;
  const playerY = world.stores.position.y[player] ?? 0;
  pruneAmbientOutOfRange(world, playerX, playerY);
  const totalEnemies = query(world.ecs, [Enemy]).length;
  if (totalEnemies > FLOOR_1_ENEMY_CAP) {
    pruneAmbientOverflow(world, playerX, playerY, totalEnemies - FLOOR_1_ENEMY_CAP);
  }
  if (query(world.ecs, [Enemy]).length >= FLOOR_1_ENEMY_CAP) {
    return;
  }
  const spawnMaxDistanceSq =
    FLOOR_1_AMBIENT_SPAWN_MAX_DISTANCE_PX * FLOOR_1_AMBIENT_SPAWN_MAX_DISTANCE_PX;
  let spawnPoint = resolveSpawnPosition(world, playerX, playerY);
  const isInvalidSpawn = (x: number, y: number): boolean => {
    const dx = x - playerX;
    const dy = y - playerY;
    return (
      dx * dx + dy * dy > spawnMaxDistanceSq ||
      !isInAnyRoom(world, x, y) ||
      isInRoom(world, x, y, world.floorMap?.bossStairRoom ?? null) ||
      isInRoom(world, x, y, world.floorMap?.safeRoom ?? null)
    );
  };
  if (isInvalidSpawn(spawnPoint.x, spawnPoint.y)) {
    const floorMap = world.floorMap;
    if (!floorMap) {
      return;
    }
    let found = false;
    for (let i = 0; i < 64; i += 1) {
      const tx = world.rng.nextInt(0, floorMap.width - 1);
      const ty = world.rng.nextInt(0, floorMap.height - 1);
      const candidate = floorMap.tileToPixel(tx, ty);
      if (
        !floorMap.isPassableAt(candidate.x, candidate.y) ||
        isInvalidSpawn(candidate.x, candidate.y)
      ) {
        continue;
      }
      spawnPoint = candidate;
      found = true;
      break;
    }
    if (!found) {
      return;
    }
  }
  if (isInvalidSpawn(spawnPoint.x, spawnPoint.y)) {
    return;
  }
  const archetype: 'rat' | 'slime' = world.rng.next() < RAT_SPAWN_WEIGHT ? 'rat' : 'slime';
  const hp = archetype === 'rat' ? RAT_HP : SLIME_HP;
  const speed = archetype === 'rat' ? RAT_SPEED : SLIME_SPEED;
  const detectRange = archetype === 'rat' ? RAT_DETECT_RANGE : SLIME_DETECT_RANGE;
  const eid = spawnBehaviorEnemy(
    world,
    spawnPoint.x,
    spawnPoint.y,
    hp,
    AI_TYPE.CHASE,
    speed,
    detectRange,
    0,
  );
  setComponent(world.ecs, eid, Sprite, {
    textureId: archetype === 'rat' ? SPRITE_TEX_ENEMY_RAT : SPRITE_TEX_ENEMY_SLIME,
    width: 16,
    height: 16,
  });

  world.floor1.enemyArchetypes.set(eid, archetype);
  state.lastSpawnMs = world.elapsedMs;
}

function countJunkInInventory(world: GameWorld): number {
  const players = query(world.ecs, [Player]);
  const player = players[0];
  if (player === undefined) {
    return 0;
  }
  const bag = world.inventories.get(player);
  if (!bag) {
    return 0;
  }

  let total = 0;
  for (const slot of bag.slots) {
    const item = getItemById(slot.itemId);
    if (!item) {
      continue;
    }
    if (
      item.tags.includes('Misc') ||
      slot.itemId === 'bone-shard' ||
      slot.itemId === 'rusted-scrap'
    ) {
      total += slot.quantity;
    }
  }
  return total;
}

function finalizeRunSummary(world: GameWorld, outcome: 'failed_timeout' | 'cleared_floor'): void {
  if (!world.floor1 || world.floor1.runSummary) {
    return;
  }
  const players = query(world.ecs, [Player]);
  const player = players[0];
  const broadcastScore =
    player === undefined
      ? 0
      : Math.max(0, Math.floor(world.stores.broadcastScore.current[player] ?? 0));
  world.floor1.runSummary = {
    outcome,
    viewsEarned: broadcastScore * 10 + world.playerGold,
    fansEarned: Math.floor(broadcastScore / 4),
  };
}

export function floor1ObjectiveSystem(world: GameWorld): void {
  if (!world.floor1 || world.state !== 'playing') {
    return;
  }

  const players = query(world.ecs, [Player, Position]);
  const player = players[0];
  if (player === undefined) {
    return;
  }

  for (const [eid, archetype] of [...world.floor1.enemyArchetypes.entries()]) {
    if (entityExists(world.ecs, eid)) {
      continue;
    }
    if (archetype === 'rat') {
      world.floor1.objective.ratsKilled += 1;
    } else {
      world.floor1.objective.slimesKilled += 1;
    }
    world.floor1.enemyArchetypes.delete(eid);
  }

  world.floor1.objective.goldCollected = world.playerGold;
  world.floor1.objective.junkCollected = countJunkInInventory(world);

  const playerX = world.stores.position.x[player] ?? 0;
  const playerY = world.stores.position.y[player] ?? 0;
  const safeDx = playerX - world.floor1.objective.safeRoomPos.x;
  const safeDy = playerY - world.floor1.objective.safeRoomPos.y;
  if (Math.hypot(safeDx, safeDy) <= world.floor1.objective.markerRadiusPx) {
    world.floor1.objective.safeRoomDiscovered = true;
  }

  const objective = world.floor1.objective;
  const totalKills = objective.ratsKilled + objective.slimesKilled;
  const meetsCombat =
    objective.questAccepted &&
    totalKills >= FLOOR_1_REQUIRED_TOTAL_KILLS &&
    objective.ratsKilled >= objective.requiredRats &&
    objective.slimesKilled >= objective.requiredSlimes;
  const meetsLoot =
    objective.goldCollected >= objective.requiredGold &&
    objective.junkCollected >= objective.requiredJunk;

  if (meetsCombat && !objective.questCompleted) {
    objective.questCompleted = true;
    setGoalFlag(world, 'floor1-goon-quest-complete', true);
  }

  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.safeRoomDiscovered`, objective.safeRoomDiscovered);
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.combatComplete`, objective.questCompleted);
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.lootComplete`, meetsLoot);

  // Boss battle starts only after the player fully enters the boss room.
  if (
    objective.questCompleted &&
    isFullyInsideBossRoom(world, playerX, playerY) &&
    !objective.bossBattleStarted
  ) {
    beginFloor1BossBattle(world);
  }

  const bossEid = objective.staircaseBossEid;
  const bossAlive = bossEid !== null && entityExists(world.ecs, bossEid);
  if (objective.bossBattleStarted && !bossAlive && !objective.staircaseSpawned) {
    objective.staircaseSpawned = true;
    objective.staircaseLocked = false;
    objective.staircaseUnlocked = true;
    objective.staircaseBossDefeated = true;
    objective.staircaseBossEid = null;
    setGoalFlag(world, 'floor1-boss-active', false);
    const floorMap = world.floorMap;
    if (floorMap?.bossStairRoom) {
      for (const door of floorMap.bossStairRoom.doors) {
        floorMap.tileMap.openDoor(door.x, door.y);
      }
    }
    for (const doorEid of world.floor1.bossDoorEids) {
      world.stores.doorState.isLocked[doorEid] = 0;
      world.stores.doorState.isOpen[doorEid] = 1;
    }
    setGoalFlag(world, 'floor1-defeat-boss', true);
  }
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.staircaseUnlocked`, objective.staircaseUnlocked);

  if (world.elapsedMs >= objective.deadlineMs && !objective.staircaseDiscovered) {
    world.floor1.failReason = 'stair_timeout';
    world.state = 'game_over';
    finalizeRunSummary(world, 'failed_timeout');
    return;
  }
}

export function startFloor1BossEncounter(world: GameWorld, playerEid: number): boolean {
  const objective = world.floor1?.objective;
  const floorMap = world.floorMap;
  const bossRoom = floorMap?.bossStairRoom;
  if (!objective || !floorMap || !bossRoom || !entityExists(world.ecs, playerEid)) {
    return false;
  }

  objective.questAccepted = true;
  objective.questCompleted = true;
  objective.ratsKilled = Math.max(objective.ratsKilled, objective.requiredRats);
  objective.slimesKilled = Math.max(objective.slimesKilled, objective.requiredSlimes);
  objective.goldCollected = Math.max(objective.goldCollected, objective.requiredGold);
  objective.junkCollected = Math.max(objective.junkCollected, objective.requiredJunk);
  setGoalFlag(world, 'floor1-goon-quest-complete', true);
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.combatComplete`, true);
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.lootComplete`, true);

  const center = centerOfRoom(bossRoom);
  const bossEntryPoint = floorMap.tileToPixel(center.x, center.y);
  setComponent(world.ecs, playerEid, Position, bossEntryPoint);
  world.stores.velocity.x[playerEid] = 0;
  world.stores.velocity.y[playerEid] = 0;

  beginFloor1BossBattle(world);
  return true;
}

export function confirmFloor1StairDescend(world: GameWorld, playerEid: number): boolean {
  if (!world.floor1 || world.state !== 'playing') {
    return false;
  }
  const objective = world.floor1.objective;
  if (
    !objective.staircaseSpawned ||
    !objective.staircaseUnlocked ||
    objective.staircaseDiscovered
  ) {
    return false;
  }
  const playerX = world.stores.position.x[playerEid] ?? 0;
  const playerY = world.stores.position.y[playerEid] ?? 0;
  const stairDx = playerX - objective.staircasePos.x;
  const stairDy = playerY - objective.staircasePos.y;
  if (Math.hypot(stairDx, stairDy) > objective.markerRadiusPx) {
    return false;
  }
  objective.staircaseDiscovered = true;
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.staircaseDiscovered`, true);
  world.state = 'safe_room';
  finalizeRunSummary(world, 'cleared_floor');
  return true;
}
