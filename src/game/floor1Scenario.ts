import { addComponent, entityExists, hasComponent, query, set, setComponent } from 'bitecs';
import { BiomeType, type MapConfig } from '../shared/map-types.js';
import { getGenerator } from '../core/map/generators/registry.js';
import { Position, Player, Health, BroadcastScore, Sprite } from '../core/components.js';
import type { GameWorld } from '../core/world.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { setActiveWeapon } from './weaponSystem.js';
import { spawnBehaviorEnemy } from '../core/helpers.js';
import { AI_TYPE } from './enemyAISystem.js';
import { getItemById } from '../shared/items.js';
import { PLAYER_SPEED } from '../shared/constants.js';

const FLOOR_1_PROTAGONIST = 'Rhea Vale';
const FLOOR_1_STARTER_POOL = ['sword', 'knife', 'bow', 'pistol', 'throwing-knife'] as const;
const FLOOR_1_TIMER_MS = 300_000;
const FLOOR_1_REQUIRED_RATS = 6;
const FLOOR_1_REQUIRED_SLIMES = 4;
const FLOOR_1_REQUIRED_GOLD = 15;
const FLOOR_1_REQUIRED_JUNK = 2;
const FLOOR_1_MARKER_RADIUS_PX = 24;

const FLOOR_1_MAP_CONFIG: MapConfig = {
  widthTiles: 40,
  heightTiles: 23,
  tileSizePx: 32,
  biome: BiomeType.DUNGEON,
  seed: 42,
  roomWidthRange: [5, 11],
  roomHeightRange: [5, 11],
  maxRooms: 16,
  floorDensity: 0.42,
};

const RAT_SPAWN_WEIGHT = 0.62;
const RAT_HP = 20;
const RAT_SPEED = 1.6;
const RAT_DETECT_RANGE = 220;
const SLIME_HP = 30;
const SLIME_SPEED = 1.1;
const SLIME_DETECT_RANGE = 180;
const SPRITE_TEX_ENEMY_RAT = 1;
const SPRITE_TEX_ENEMY_SLIME = 2;
const FLOOR_1_MAX_ENEMIES = 18;
const FLOOR_1_SPAWN_INTERVAL_MS = 850;
const FLOOR_1_SPAWN_RADIUS_MIN = 200;
const FLOOR_1_SPAWN_RADIUS_MAX = 320;
const FLOOR_1_PLAYER_HP_BONUS = 20;
const FLOOR_1_PLAYER_MOVE_SPEED_BONUS = 0.2;
const FLOOR_1_PLAYER_PICKUP_RANGE_BONUS = 8;

interface Floor1SpawnerState {
  lastSpawnMs: number;
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
  if (!floorMap || floorMap.rooms.length < 2) {
    return {
      safeRoomPos: { x: floorMap?.widthPx ? floorMap.widthPx - 120 : 1120, y: 120 },
      staircasePos: { x: floorMap?.widthPx ? floorMap.widthPx - 120 : 1120, y: 560 },
    };
  }

  const spawnTile = floorMap.playerSpawn;
  const scored = floorMap.rooms.map((room) => {
    const center = centerOfRoom(room);
    const dx = center.x - spawnTile.x;
    const dy = center.y - spawnTile.y;
    return { room, distanceSq: dx * dx + dy * dy };
  });
  scored.sort((a, b) => b.distanceSq - a.distanceSq);

  const safeRoom = scored[0]?.room ?? floorMap.rooms[floorMap.rooms.length - 1]!;
  const staircaseRoom = scored[1]?.room ?? floorMap.rooms[Math.max(0, floorMap.rooms.length - 2)]!;

  const safeTile = centerOfRoom(safeRoom);
  const staircaseTile = centerOfRoom(staircaseRoom);

  return {
    safeRoomPos: floorMap.tileToPixel(safeTile.x, safeTile.y),
    staircasePos: floorMap.tileToPixel(staircaseTile.x, staircaseTile.y),
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
    objective: {
      requiredRats: FLOOR_1_REQUIRED_RATS,
      requiredSlimes: FLOOR_1_REQUIRED_SLIMES,
      requiredGold: FLOOR_1_REQUIRED_GOLD,
      requiredJunk: FLOOR_1_REQUIRED_JUNK,
      deadlineMs: FLOOR_1_TIMER_MS,
      safeRoomPos,
      staircasePos,
      markerRadiusPx: FLOOR_1_MARKER_RADIUS_PX,
      ratsKilled: 0,
      slimesKilled: 0,
      goldCollected: 0,
      junkCollected: 0,
      safeRoomDiscovered: false,
      staircaseUnlocked: false,
      staircaseDiscovered: false,
    },
    failReason: null,
    runSummary: null,
  };
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
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const angle = world.rng.next() * Math.PI * 2;
    const radius =
      FLOOR_1_SPAWN_RADIUS_MIN +
      world.rng.next() * (FLOOR_1_SPAWN_RADIUS_MAX - FLOOR_1_SPAWN_RADIUS_MIN);
    const x = playerX + Math.cos(angle) * radius;
    const y = playerY + Math.sin(angle) * radius;
    if (world.floorMap && world.floorMap.isPassableAt(x, y)) {
      return { x, y };
    }
  }
  return { x: playerX + FLOOR_1_SPAWN_RADIUS_MIN, y: playerY };
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

  for (const eid of [...world.floor1.enemyArchetypes.keys()]) {
    if (!entityExists(world.ecs, eid)) {
      world.floor1.enemyArchetypes.delete(eid);
    }
  }

  if (world.floor1.enemyArchetypes.size >= FLOOR_1_MAX_ENEMIES) {
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
  const spawnPoint = resolveSpawnPosition(world, playerX, playerY);
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
  const meetsCombat =
    objective.ratsKilled >= objective.requiredRats &&
    objective.slimesKilled >= objective.requiredSlimes;
  const meetsLoot =
    objective.goldCollected >= objective.requiredGold &&
    objective.junkCollected >= objective.requiredJunk;
  objective.staircaseUnlocked = objective.safeRoomDiscovered && meetsCombat && meetsLoot;

  if (world.elapsedMs >= objective.deadlineMs && !objective.staircaseDiscovered) {
    world.floor1.failReason = 'stair_timeout';
    world.state = 'game_over';
    finalizeRunSummary(world, 'failed_timeout');
    return;
  }

  if (objective.staircaseUnlocked) {
    const stairDx = playerX - objective.staircasePos.x;
    const stairDy = playerY - objective.staircasePos.y;
    if (Math.hypot(stairDx, stairDy) <= objective.markerRadiusPx) {
      objective.staircaseDiscovered = true;
      world.state = 'safe_room';
      finalizeRunSummary(world, 'cleared_floor');
    }
  }
}
