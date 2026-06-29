import {
  addComponent,
  entityExists,
  hasComponent,
  query,
  removeEntity,
  set,
  setComponent,
} from 'bitecs';
import {
  BiomeType,
  RoomRole,
  TerrainType,
  type MapConfig,
  type RoomBounds,
  type RoomData,
} from '../shared/map-types.js';
import type { FloorMap } from '../core/map/FloorMap.js';
import { findTilePath, type TilePoint } from '../core/map/pathfinding.js';
import { getGenerator } from '../core/map/generators/registry.js';
import { sealRoomPerimeter, sealSpecialRooms } from '../core/map/special-rooms.js';
import {
  Position,
  Rotation,
  Player,
  Health,
  BroadcastScore,
  Sprite,
  DoorState,
  Enemy,
  Spawner,
  Damage,
  DeathTimer,
  Npc,
} from '../core/components.js';
import type { GameWorld } from '../core/world.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { setActiveWeapon } from './weaponSystem.js';
import {
  clearEntityStores,
  spawnBehaviorEnemy,
  spawnNpc,
  createEntity,
  spawnDroppedItem,
  spawnHarvestableNode,
  spawnSpawner,
  setBloodColor,
  DEFAULT_BLOOD_COLOR,
} from '../core/helpers.js';
import { setGoalFlag, setDoorLockConfig } from '../core/door-lock.js';
import { AI_TYPE } from './enemyAISystem.js';
import { getItemById, getItemIndex } from '../shared/items.js';
import { GAME, PLAYER_SPEED } from '../shared/constants.js';
import { pxToFt } from '../shared/units.js';
import { addItem, hasItem, removeItem } from '../shared/inventory.js';
import { HARVESTABLE_DEFS } from '../shared/harvestableDefs.js';
import { equip, initializeBaseStats } from '../core/systems/equipmentSystem.js';
import {
  MERCHANTS_CHARM_COST,
  getEquipmentDefForItem,
  isEquippableItem,
} from '../shared/equipmentDefs.js';
import {
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_MEET_NPCS_QUEST_ID,
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_FIND_WELCOME_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
  FLOOR1_LEAVE_FLOOR_QUEST_ID,
  SHOPKEEPER_EQUIPMENT_ITEM_ID,
  SHOPKEEPER_FETCH_ITEM_ID,
  type ShopkeeperStage,
  type NpcQuestIndicatorState,
} from '../shared/quest-types.js';
import {
  FLOOR1_BOSS_REWARD_SPELL_IDS,
  DEFAULT_FLOOR1_BOSS_REWARD_SPELL_ID,
  type Floor1BossRewardSpellId,
} from '../shared/abilities.js';
import {
  acceptQuest,
  notifyQuestTalk,
  questSystem,
  setQuestCounter,
  setTrackedQuest,
} from '../core/systems/questSystem.js';
import { memorizeSpell } from './systems/abilitySystem.js';
import { evaluateAchievementUnlocksForPhase } from './systems/achievementSystem.js';
import { getAllSkillDefinitions } from './skills/registry.js';
import type { SkillState } from '../shared/skills.js';
import { floor1Config } from '../shared/floor-config.js';
import { floor1EnemyPack, pickEnemyArchetype } from '../shared/enemy-packs.js';
import { floor1Manifest } from '../shared/floor-manifest.js';
import type { NpcPlacementDef } from '../shared/npc-placements.js';
import { placePropsForFloor } from './systems/propPlacer.js';
import { getSpawnerArchetype, getSpawnerArchetypeIndex } from './spawners/registry.js';
import { hashStringToSeed, SeededRandom } from '../shared/random.js';

// Derived constants computed from config at module initialization.
// The camera/viewport is a render-pixel concept, so convert it to feet at this
// boundary (ADR 0023) before comparing against feet-space world positions.
const FLOOR_1_CAMERA_ZOOM = floor1Config.camera.zoom;
const FLOOR_1_VIEWPORT_WIDTH_FT = pxToFt(GAME.WIDTH / FLOOR_1_CAMERA_ZOOM);
const FLOOR_1_AMBIENT_SPAWN_MAX_DISTANCE_FT = FLOOR_1_VIEWPORT_WIDTH_FT * 2;
const FLOOR_1_SPAWN_RADIUS_MAX = FLOOR_1_AMBIENT_SPAWN_MAX_DISTANCE_FT;
/**
 * Minimum distance (ft) a pre-populated room-wave enemy must keep from the
 * player, so a wave reads as already occupying the room rather than spawning on
 * top of the player at the doorway.
 */
const FLOOR_1_ROOM_WAVE_MIN_PLAYER_DISTANCE_FT = 12;
const FLOOR_1_GOAL_PREFIX = 'floor1.objective';
const FLOOR_1_STATIC_SPAWNERS_PER_ARCHETYPE = 2;
const FLOOR_1_STATIC_SPAWNER_ARCHETYPE_IDS = ['slime-pool', 'rats-nest'] as const;
const FLOOR_1_MAX_STARTER_CHOICES = 3;
const FLOOR_1_FALLBACK_STARTER_WEAPON_IDS = ['sword', 'punch'] as const;

// Native footprint of the welcome-sign sprite (board + baked "WELCOME" + arrow),
// mirrored from the procedural texture in PhaserBridge (48x26 px) so the Sprite
// component carries matching dimensions in feet (px / PIXELS_PER_FOOT).
const WELCOME_SIGN_WIDTH = 6;
const WELCOME_SIGN_HEIGHT = 3.25;

/** Blood colours for Floor 1 enemy archetypes. */
const BLOOD_COLOR_RAT = DEFAULT_BLOOD_COLOR; // red — 0xcc0000
const BLOOD_COLOR_SLIME = 0x22aa44; // green ichor

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

/**
 * Seal the perimeter breaches of the room at `roomPos`. Thin wrapper around the
 * generic {@link sealRoomPerimeter} core utility: resolves the room from a world
 * (feet) position, then walls every non-door perimeter gap that can be walled without
 * stranding a spawn-reachable region, converting load-bearing gaps to doors.
 *
 * Exported for unit testing; production code seals via {@link sealSpecialRooms}.
 */
export function sealRoomPerimeterOpenings(
  world: GameWorld,
  roomPos: { x: number; y: number },
): void {
  const floorMap = world.floorMap;
  if (!floorMap) return;
  const tile = floorMap.worldToTile(roomPos.x, roomPos.y);
  const roomId = floorMap.roomGraph.getRoomAt(tile.x, tile.y);
  if (roomId < 0) return;
  const room = floorMap.roomGraph.get(roomId);
  if (!room) return;
  sealRoomPerimeter(floorMap, room);
}

function pruneAmbientOutOfRange(world: GameWorld, playerX: number, playerY: number): void {
  if (!world.floor1) {
    return;
  }
  const pack = floor1EnemyPack;
  const maxDistanceSq = pack.despawnDistanceFt * pack.despawnDistanceFt;
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

/**
 * Rooms whose one-time pre-population roll has already been resolved, keyed by
 * world. A room id is recorded the first time the player stands inside it,
 * whether or not a wave actually spawned, so re-entering never re-rolls. Uses a
 * WeakMap (mirroring {@link spawnerStateByWorld}) so scenario state and lab
 * initializers don't need to construct it.
 */
const populatedRoomsByWorld = new WeakMap<GameWorld, Set<number>>();

function getSpawnerState(world: GameWorld): Floor1SpawnerState {
  let state = spawnerStateByWorld.get(world);
  if (state === undefined) {
    state = { lastSpawnMs: Number.NEGATIVE_INFINITY };
    spawnerStateByWorld.set(world, state);
  }
  return state;
}

function getPopulatedRooms(world: GameWorld): Set<number> {
  let rooms = populatedRoomsByWorld.get(world);
  if (rooms === undefined) {
    rooms = new Set<number>();
    populatedRoomsByWorld.set(world, rooms);
  }
  return rooms;
}

function pickStarterChoices(world: GameWorld): string[] {
  const seenWeaponIds = new Set<string>();
  const pool: string[] = [];
  for (const weaponId of floor1Config.starterWeapons) {
    if (getWeaponDef(weaponId) === undefined || seenWeaponIds.has(weaponId)) {
      continue;
    }
    seenWeaponIds.add(weaponId);
    pool.push(weaponId);
  }
  if (pool.length > 0) {
    // Preserve the historical world RNG progression from the old 3-choice picker
    // so existing deterministic seed gates (headless/tests) stay stable.
    // Keep legacy RNG advancement (3 draws) so existing deterministic seed-based
    // headless/integration expectations remain stable after expanding choice count.
    // TODO(seed-contract): Remove this compatibility shim only when we intentionally
    // version and re-baseline deterministic seed expectations project-wide.
    for (let remaining = Math.min(pool.length, 3); remaining > 0; remaining -= 1) {
      world.rng.nextInt(0, remaining - 1);
    }

    const starterChoiceRng = new SeededRandom(
      hashStringToSeed(`${world.seed}:floor1-starter-choices`),
    );
    const selected: string[] = [];
    while (pool.length > 0 && selected.length < FLOOR_1_MAX_STARTER_CHOICES) {
      const idx = starterChoiceRng.nextInt(0, pool.length - 1);
      const id = pool.splice(idx, 1)[0];
      if (id !== undefined) {
        selected.push(id);
      }
    }
    return selected;
  }
  for (const weaponId of FLOOR_1_FALLBACK_STARTER_WEAPON_IDS) {
    // Return the first known-safe fallback weapon that still exists.
    const fallbackWeapon = getWeaponDef(weaponId);
    if (fallbackWeapon) {
      return [fallbackWeapon.id];
    }
  }
  return [];
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

/**
 * Resolve the world position for a room's logical centre.
 *
 * Returns the centre of the room's bounding box if that tile is passable.
 * When the center has been walled off (e.g. by an ellipse or L-shape
 * post-processing pass), spirals outward within the room's interior until a
 * passable tile is found, then returns its world position. This guarantees
 * that NPCs and items are never spawned inside walls.
 */
function resolvePassableRoomCenter(
  floorMap: NonNullable<GameWorld['floorMap']>,
  room: { bounds: RoomBounds },
): { x: number; y: number } {
  const center = centerOfRoom(room);
  if (floorMap.tileMap.isPassable(center.x, center.y)) {
    return floorMap.tileToWorld(center.x, center.y);
  }

  const { x: bx, y: by, width: bw, height: bh } = room.bounds;
  const ix = bx + 1;
  const iy = by + 1;
  const maxX = bx + bw - 2;
  const maxY = by + bh - 2;
  const maxRadius = Math.max(bw, bh);

  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const tx = center.x + dx;
        const ty = center.y + dy;
        if (
          tx >= ix &&
          tx <= maxX &&
          ty >= iy &&
          ty <= maxY &&
          floorMap.tileMap.isPassable(tx, ty)
        ) {
          return floorMap.tileToWorld(tx, ty);
        }
      }
    }
  }

  // Absolute fallback: return the bounding-box center point even if it's a wall.
  return floorMap.tileToWorld(center.x, center.y);
}

/**
 * Spawn harvestable resource nodes (mushrooms, flowers, lichens) across the
 * normal and spawn rooms of floor 1. Each def in HARVESTABLE_DEFS spawns up to
 * `def.maxPerFloor` nodes, placed at randomly selected passable tiles in rooms
 * with role NORMAL or SPAWN (i.e. not safe room, boss room, or stair room).
 * Uses `world.rng` for all randomness.
 */
function spawnFloor1HarvestableNodes(world: GameWorld): void {
  const floorMap = world.floorMap;
  if (!floorMap) return;

  // Gather candidate tiles from all normal rooms.
  const normalRooms = floorMap.roomGraph
    .getAll()
    .filter((room) => room.role === RoomRole.NORMAL || room.role === RoomRole.SPAWN);

  if (normalRooms.length === 0) return;

  for (let defIndex = 0; defIndex < HARVESTABLE_DEFS.length; defIndex++) {
    const def = HARVESTABLE_DEFS[defIndex]!;
    // Randomly choose a count between 2 and maxPerFloor (inclusive).
    const count = 2 + world.rng.nextInt(0, def.maxPerFloor - 2);

    const placed: Array<{ x: number; y: number }> = [];

    // Attempt to place each node in a random room at a random passable tile.
    // We allow multiple attempts per node to avoid clustering.
    const maxAttempts = count * 12;
    for (let attempt = 0; attempt < maxAttempts && placed.length < count; attempt++) {
      const room = normalRooms[world.rng.nextInt(0, normalRooms.length - 1)]!;
      const { x: bx, y: by, width: bw, height: bh } = room.bounds;

      // Pick a random tile inside the room interior (1 tile margin from walls).
      const tx = bx + 1 + world.rng.nextInt(0, Math.max(0, bw - 3));
      const ty = by + 1 + world.rng.nextInt(0, Math.max(0, bh - 3));

      if (!floorMap.tileMap.isPassable(tx, ty)) continue;

      const pos = floorMap.tileToWorld(tx, ty);

      // Avoid placing two nodes of the same type too close together (≥ 3 ft apart).
      const tooClose = placed.some((p) => {
        const ddx = p.x - pos.x;
        const ddy = p.y - pos.y;
        return ddx * ddx + ddy * ddy < 9;
      });
      if (tooClose) continue;

      placed.push(pos);
      spawnHarvestableNode(world, pos.x, pos.y, defIndex);
    }
  }
}

function chooseObjectiveTiles(world: GameWorld): {
  welcomeOfficePos: { x: number; y: number };
  safeRoomPos: { x: number; y: number };
  staircasePos: { x: number; y: number };
  slimeRatRoomPos: { x: number; y: number };
  spellQuestGiverPos: { x: number; y: number };
  shopRoomPos: { x: number; y: number };
  questItemPos: { x: number; y: number };
} {
  const floorMap = world.floorMap;
  const fallbackWelcome = { x: 15, y: 15 };
  const fallbackStair = { x: floorMap?.widthFt ? floorMap.widthFt - 15 : 140, y: 70 };
  const fallbackSlimeRat = {
    x: floorMap?.widthFt ? floorMap.widthFt * 0.75 : 120,
    y: 65,
  };
  const fallbackShop = { x: floorMap?.widthFt ? floorMap.widthFt - 30 : 110, y: 42.5 };
  const fallbackItem = { x: floorMap?.widthFt ? floorMap.widthFt / 2 : 80, y: 42.5 };

  if (!floorMap) {
    return {
      welcomeOfficePos: fallbackWelcome,
      safeRoomPos: fallbackWelcome,
      staircasePos: fallbackStair,
      slimeRatRoomPos: fallbackSlimeRat,
      spellQuestGiverPos: fallbackItem,
      shopRoomPos: fallbackShop,
      questItemPos: fallbackItem,
    };
  }

  // Prefer role-tagged boss stair room for the end-of-floor encounter.
  const bossStairRoom = floorMap.bossStairRoom;
  let staircasePos: { x: number; y: number };
  if (bossStairRoom) {
    staircasePos = resolvePassableRoomCenter(floorMap, bossStairRoom);
  } else if (floorMap.rooms.length < 2) {
    staircasePos = fallbackStair;
  } else {
    const spawnTile = floorMap.playerSpawn;
    const scored = floorMap.rooms.map((room) => {
      const center = centerOfRoom(room);
      const dx = center.x - spawnTile.x;
      const dy = center.y - spawnTile.y;
      return { room, distanceSq: dx * dx + dy * dy };
    });
    scored.sort((a, b) => b.distanceSq - a.distanceSq);

    const staircaseRoom = scored[0]?.room ?? floorMap.rooms[floorMap.rooms.length - 1]!;
    staircasePos = resolvePassableRoomCenter(floorMap, staircaseRoom);
  }

  // Shop room: nearest non-special room to spawn (so the merchant is met early).
  // Quest item: a distinct, further room so the player has to go find it.
  const spawnTile = floorMap.playerSpawn;
  const reserved = new Set(
    [floorMap.spawnRoom, floorMap.safeRoom, floorMap.bossStairRoom].filter(
      (r): r is NonNullable<typeof r> => r != null,
    ),
  );

  // Rooms that are exclusively reachable through the boss staircase room must
  // never host quest items or NPCs that are required before the boss doors can
  // open — placing them there creates an unresolvable deadlock (e.g. seed 665790,
  // where the rat-tail fetch item ended up in a room whose only connection was
  // the locked boss-stair room). BFS from spawn treating boss-stair as a wall.
  const bossStairRoomId = floorMap.bossStairRoom?.id;
  // roomsReachableWithoutBossRoom: the set of rooms the player can visit without
  // ever entering the boss staircase room (which is locked until all quests finish).
  // Stays empty when the spawn room is not set — the fallback path below then uses
  // only the `!reserved.has(room)` guard, which preserves legacy behaviour on
  // degenerate maps that lack a tagged spawn room.
  const roomsReachableWithoutBossRoom = new Set<RoomData>();
  {
    const bfsQueue: number[] = [];
    const bfsVisited = new Set<number>();
    const startRoomId = floorMap.spawnRoom?.id;
    if (startRoomId !== undefined) {
      bfsQueue.push(startRoomId);
      bfsVisited.add(startRoomId);
      while (bfsQueue.length > 0) {
        const currId = bfsQueue.shift()!;
        const currRoom = floorMap.roomGraph.get(currId);
        if (currRoom) {
          roomsReachableWithoutBossRoom.add(currRoom);
          for (const neighborId of currRoom.neighbors) {
            if (!bfsVisited.has(neighborId) && neighborId !== bossStairRoomId) {
              bfsVisited.add(neighborId);
              bfsQueue.push(neighborId);
            }
          }
        }
      }
    }
  }

  const candidates = floorMap.rooms
    .filter(
      (room) =>
        !reserved.has(room) &&
        (roomsReachableWithoutBossRoom.size === 0 || roomsReachableWithoutBossRoom.has(room)),
    )
    .map((room) => {
      const center = centerOfRoom(room);
      const dx = center.x - spawnTile.x;
      const dy = center.y - spawnTile.y;
      return { room, center, distanceSq: dx * dx + dy * dy };
    })
    .sort((a, b) => a.distanceSq - b.distanceSq);

  const welcomeEntry = candidates[0];
  const shopEntry = candidates.length > 1 ? candidates[1] : candidates[0];
  const itemEntry = [...candidates]
    .reverse()
    .find((entry) => entry !== welcomeEntry && entry !== shopEntry);
  const welcomeOfficePos = welcomeEntry
    ? resolvePassableRoomCenter(floorMap, welcomeEntry.room)
    : fallbackWelcome;
  const shopRoomPos = shopEntry
    ? resolvePassableRoomCenter(floorMap, shopEntry.room)
    : fallbackShop;
  const questItemPos = itemEntry
    ? resolvePassableRoomCenter(floorMap, itemEntry.room)
    : fallbackItem;
  const safeRoomPos = welcomeOfficePos;
  const specialPoints = [welcomeOfficePos, staircasePos, shopRoomPos, questItemPos];
  const slimeRatEntry = candidates
    .filter((entry) => entry !== shopEntry && entry !== itemEntry)
    .sort((a, b) => {
      const aPos = resolvePassableRoomCenter(floorMap, a.room);
      const bPos = resolvePassableRoomCenter(floorMap, b.room);
      const aScore = Math.min(
        ...specialPoints.map((p) => {
          const dx = aPos.x - p.x;
          const dy = aPos.y - p.y;
          return dx * dx + dy * dy;
        }),
      );
      const bScore = Math.min(
        ...specialPoints.map((p) => {
          const dx = bPos.x - p.x;
          const dy = bPos.y - p.y;
          return dx * dx + dy * dy;
        }),
      );
      return bScore - aScore;
    })[0];
  const slimeRatRoomPos = slimeRatEntry
    ? resolvePassableRoomCenter(floorMap, slimeRatEntry.room)
    : questItemPos;
  // The Spell Broker gets a room of its own — explicitly NOT the room that holds
  // the merchant's gross fetch item (the rat tail). Pick the nearest unused
  // candidate so the broker is still discoverable; fall back to a room that is
  // guaranteed distinct from the fetch-item room on degenerate (tiny) maps.
  const usedEntries = new Set([welcomeEntry, shopEntry, itemEntry, slimeRatEntry]);
  const spellEntry = candidates.find((entry) => !usedEntries.has(entry));
  const spellFallbackPos =
    shopRoomPos.x !== questItemPos.x || shopRoomPos.y !== questItemPos.y
      ? shopRoomPos
      : welcomeOfficePos;
  const spellQuestGiverPos = spellEntry
    ? resolvePassableRoomCenter(floorMap, spellEntry.room)
    : spellFallbackPos;

  return {
    welcomeOfficePos,
    safeRoomPos,
    staircasePos,
    slimeRatRoomPos,
    spellQuestGiverPos,
    shopRoomPos,
    questItemPos,
  };
}

/** Tag the shop room as a safe room and repaint its floor tiles so it renders correctly. */
function tagRoomAsSafe(world: GameWorld, roomPos: { x: number; y: number }): void {
  const floorMap = world.floorMap;
  if (!floorMap) return;
  const tile = floorMap.worldToTile(roomPos.x, roomPos.y);
  const roomId = floorMap.roomGraph.getRoomAt(tile.x, tile.y);
  if (roomId < 0) return;
  floorMap.roomGraph.setRole(roomId, RoomRole.SAFE);
  const room = floorMap.roomGraph.get(roomId);
  if (!room) return;
  const { x: rx, y: ry, width, height } = room.bounds;
  const w = floorMap.config.widthTiles;
  for (let ty = ry; ty < ry + height; ty++) {
    for (let tx = rx; tx < rx + width; tx++) {
      if (floorMap.terrain[ty * w + tx] === TerrainType.STONE_FLOOR) {
        floorMap.terrain[ty * w + tx] = TerrainType.SAFE_ROOM_FLOOR;
      }
    }
  }
}

function spawnFloor1StaticSpawners(world: GameWorld): void {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return;
  }
  // Derive a deterministic, floor-local stream so static-spawner room assignment
  // is stable per seed but does not consume the shared gameplay RNG sequence.
  const spawnerRng = new SeededRandom(
    world.seed ^ (floorMap.config.widthTiles << 8) ^ floorMap.config.heightTiles ^ 0x5f3759df,
  );

  const candidateRooms = floorMap.roomGraph
    .getAll()
    .filter((room) => room.role === RoomRole.NORMAL);
  const requiredRoomCount =
    FLOOR_1_STATIC_SPAWNER_ARCHETYPE_IDS.length * FLOOR_1_STATIC_SPAWNERS_PER_ARCHETYPE;
  if (candidateRooms.length < requiredRoomCount) {
    throw new Error(
      `Floor 1 requires at least ${requiredRoomCount} normal rooms for static spawners; got ${candidateRooms.length}.`,
    );
  }
  spawnerRng.shuffle(candidateRooms);

  let roomCursor = 0;
  for (const archetypeId of FLOOR_1_STATIC_SPAWNER_ARCHETYPE_IDS) {
    const archetype = getSpawnerArchetype(archetypeId);
    const defIndex = getSpawnerArchetypeIndex(archetypeId);
    if (!archetype || defIndex < 0) {
      continue;
    }
    for (let i = 0; i < FLOOR_1_STATIC_SPAWNERS_PER_ARCHETYPE; i += 1) {
      const room = candidateRooms[roomCursor]!;
      roomCursor += 1;
      const spawnPos = resolvePassableRoomCenter(floorMap, room);
      spawnSpawner(world, spawnPos.x, spawnPos.y, archetype.hp, {
        defIndex,
        contactDamage: archetype.contactDamage,
        weight: archetype.weight,
        bloodColor: archetype.bloodColor,
        textureId: archetype.textureId,
        spriteWidth: archetype.spriteWidth,
        spriteHeight: archetype.spriteHeight,
      });
    }
  }
}

/** One room on the navigable path, with the door the player exits through next. */
export interface NavigableRoomStep {
  /** Room id on the path. */
  roomId: number;
  /**
   * The door tile the player should walk through to leave this room and make
   * progress toward the target. `null` only for the final room (the
   * destination), which has no onward door.
   */
  exitDoor: TilePoint | null;
}

/**
 * Derive the room-by-room route from `start` to `target` over the real
 * door-aware tile path, recording for each room the first door tile the player
 * crosses on the way out. That door is "the door to take to make progress",
 * which welcome signs point at.
 */
export function findNavigableRoomPathSteps(
  floorMap: FloorMap,
  start: TilePoint,
  target: TilePoint,
): NavigableRoomStep[] | null {
  const tilePath = findTilePath(floorMap, start, target, {
    isTilePassable: (x, y) => floorMap.tileMap.isPassable(x, y) || floorMap.tileMap.isDoor(x, y),
  });
  if (tilePath.length === 0) {
    return null;
  }
  const steps: NavigableRoomStep[] = [];
  let currentRoom = -1;
  for (const point of tilePath) {
    const roomId = floorMap.roomGraph.getRoomAt(point.x, point.y);
    if (roomId >= 0) {
      // Interior tile: open a new step the first time we enter each room.
      if (roomId !== currentRoom) {
        currentRoom = roomId;
        steps.push({ roomId, exitDoor: null });
      }
      continue;
    }
    // Corridor/perimeter tile: the first door crossed after a room's interior
    // is that room's exit door toward the goal. Later doors (the next room's
    // entry) are ignored because the slot is already filled.
    if (floorMap.tileMap.isDoor(point.x, point.y)) {
      const last = steps[steps.length - 1];
      if (last && last.exitDoor === null) {
        last.exitDoor = { x: point.x, y: point.y };
      }
    }
  }
  return steps.length > 0 ? steps : null;
}

/**
 * Plant the floor's welcome wayfinding signs: one sign in every room along the
 * door-aware path from the spawn room to the welcome office (the destination
 * room is excluded), each pointing at the door the player should walk through
 * next to make progress.
 *
 * Must run AFTER NPCs have spawned: each sign resolves to a passable interior
 * tile that is neither the player's spawn tile nor occupied by an NPC, so signs
 * never spawn on top of an NPC.
 */
function placeWelcomeSigns(world: GameWorld, welcomeOfficePos: { x: number; y: number }): void {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return;
  }
  const welcomeSignTextureId = floor1Config.sprites?.welcomeSign;
  if (welcomeSignTextureId === undefined || !floorMap.spawnRoom) {
    return;
  }
  const welcomeOfficeTile = floorMap.worldToTile(welcomeOfficePos.x, welcomeOfficePos.y);
  const welcomeGoonRoomId = floorMap.roomGraph.getRoomAt(welcomeOfficeTile.x, welcomeOfficeTile.y);
  if (welcomeGoonRoomId < 0) {
    return;
  }
  const steps = findNavigableRoomPathSteps(floorMap, floorMap.playerSpawn, welcomeOfficeTile);
  if (!steps || steps.length < 2) {
    return;
  }

  // Tiles a sign must never cover: the player's spawn tile and every NPC tile.
  const tileKey = (x: number, y: number): string => `${x},${y}`;
  const blockedTiles = new Set<string>();
  blockedTiles.add(tileKey(floorMap.playerSpawn.x, floorMap.playerSpawn.y));
  for (const npcEid of query(world.ecs, [Npc, Position])) {
    const npcTile = floorMap.worldToTile(
      world.stores.position.x[npcEid] ?? 0,
      world.stores.position.y[npcEid] ?? 0,
    );
    blockedTiles.add(tileKey(npcTile.x, npcTile.y));
  }

  // Resolve a passable interior tile for a room's sign, spiralling outward from
  // the room centre when the centre is a wall or already blocked (e.g. an NPC
  // standing on it). Returns null only if the whole interior is unavailable.
  const resolveSignTile = (room: RoomData): TilePoint | null => {
    const center = centerOfRoom(room);
    const { x: bx, y: by, width: bw, height: bh } = room.bounds;
    const minX = bx + 1;
    const minY = by + 1;
    const maxX = bx + bw - 2;
    const maxY = by + bh - 2;
    const isFree = (tx: number, ty: number): boolean =>
      floorMap.tileMap.isPassable(tx, ty) && !blockedTiles.has(tileKey(tx, ty));
    if (isFree(center.x, center.y)) {
      return { x: center.x, y: center.y };
    }
    const maxRadius = Math.max(bw, bh);
    for (let r = 1; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) {
            continue;
          }
          const tx = center.x + dx;
          const ty = center.y + dy;
          if (tx >= minX && tx <= maxX && ty >= minY && ty <= maxY && isFree(tx, ty)) {
            return { x: tx, y: ty };
          }
        }
      }
    }
    return null;
  };

  // Place a sign in `roomId` pointing at `targetTile` (the door to take next).
  // The angle is measured from the room centre so the arrow reads as "go this
  // way" even when the sign tile is nudged off-centre to dodge an NPC.
  const placeSign = (roomId: number, targetTile: TilePoint): void => {
    const room = floorMap.roomGraph.get(roomId);
    if (!room) {
      return;
    }
    const signTile = resolveSignTile(room);
    if (!signTile) {
      return;
    }
    blockedTiles.add(tileKey(signTile.x, signTile.y));
    const center = centerOfRoom(room);
    const angle = Math.atan2(targetTile.y - center.y, targetTile.x - center.x);
    const pos = floorMap.tileToWorld(signTile.x, signTile.y);
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Position, { x: pos.x, y: pos.y }));
    addComponent(world.ecs, eid, set(Rotation, { angle }));
    addComponent(
      world.ecs,
      eid,
      set(Sprite, {
        textureId: welcomeSignTextureId,
        width: WELCOME_SIGN_WIDTH,
        height: WELCOME_SIGN_HEIGHT,
      }),
    );
  };

  // Directional breadcrumb trail: one sign per room on the path (excluding the
  // destination), each aimed at the door leading onward.
  for (let i = 0; i < steps.length - 1; i++) {
    const step = steps[i]!;
    // Prefer the actual exit door; fall back to the next room's centre if a
    // door tile wasn't recorded (defensive — keeps a sign in every room).
    const nextRoom = floorMap.roomGraph.get(steps[i + 1]!.roomId);
    const targetTile = step.exitDoor ?? (nextRoom ? centerOfRoom(nextRoom) : null);
    if (!targetTile) {
      continue;
    }
    placeSign(step.roomId, targetTile);
  }
}

/**
 * Spawn an NPC based on its placement definition.
 * Resolves room role to actual position, then spawns the NPC entity.
 */
function spawnNpcFromPlacement(
  world: GameWorld,
  placement: NpcPlacementDef,
  objectiveTiles: {
    welcomeOfficePos: { x: number; y: number };
    safeRoomPos: { x: number; y: number };
    staircasePos: { x: number; y: number };
    slimeRatRoomPos: { x: number; y: number };
    spellQuestGiverPos: { x: number; y: number };
    shopRoomPos: { x: number; y: number };
    questItemPos: { x: number; y: number };
  },
): number {
  // Resolve position from room role or explicit position
  let x: number;
  let y: number;

  if (placement.position) {
    // Explicit position override
    x = placement.position.x;
    y = placement.position.y;
  } else if (placement.roomRole) {
    // Resolve from room role
    switch (placement.roomRole) {
      case 'spawn':
        x = objectiveTiles.welcomeOfficePos.x;
        y = objectiveTiles.welcomeOfficePos.y;
        break;
      case 'safe':
        x = objectiveTiles.safeRoomPos.x;
        y = objectiveTiles.safeRoomPos.y;
        break;
      case 'shop':
        x = objectiveTiles.shopRoomPos.x;
        y = objectiveTiles.shopRoomPos.y;
        break;
      case 'boss_stair':
        x = objectiveTiles.staircasePos.x;
        y = objectiveTiles.staircasePos.y;
        break;
      case 'any':
        // Spell Broker's dedicated room (distinct from the rat-tail fetch room).
        x = objectiveTiles.spellQuestGiverPos.x;
        y = objectiveTiles.spellQuestGiverPos.y;
        break;
      default:
        // Fallback to welcome office
        x = objectiveTiles.welcomeOfficePos.x;
        y = objectiveTiles.welcomeOfficePos.y;
    }
  } else {
    // No position or room role specified, fallback to spawn
    x = objectiveTiles.welcomeOfficePos.x;
    y = objectiveTiles.welcomeOfficePos.y;
  }

  // Spawn the NPC entity
  return spawnNpc(world, x, y, placement.npcTypeId);
}

/**
 * Called the first time the player talks to the Tutorial Goon (the reward for
 * finding the Welcome Office). Completes the opening "find the welcome room"
 * quest, accepts the level-2 grind quest, focuses the tracker, and unlocks
 * drops — gold, XP, and junk only start dropping once the Goon has explained
 * the rules. See `dropSystem` for the gate.
 */
export function meetTutorialGoon(world: GameWorld): void {
  // Completes the opening "find the welcome room" quest (talk objective).
  notifyQuestTalk(world, 'tutorial-goon');
  // The Goon's exposition hands off the level-2 grind as the gating quest.
  acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID);
  setTrackedQuest(world, FLOOR1_TUTORIAL_QUEST_ID);
  setGoalFlag(world, 'floor1-drops-unlocked', true);
  if (world.floor1) {
    world.floor1.objective.questAccepted = true;
  }
}

/**
 * Initialize weapon skill states for the player entity, seeding every registered
 * skill at level 0 so the skill system and HUD can track progress from the start.
 */
function initializePlayerWeaponSkills(world: GameWorld, playerEid: number): void {
  const allSkills = getAllSkillDefinitions();
  const skillMap = new Map<string, SkillState>();
  for (const skill of allSkills) {
    skillMap.set(skill.id, {
      level: 0,
      usage: 0,
      itemBonus: 0,
      triggeredMilestones: new Set(),
    });
  }
  // Merge into any existing v1 playerSkills map so pre-set entries are preserved.
  for (const [id, state] of skillMap) {
    if (!world.playerSkills.has(id)) {
      world.playerSkills.set(id, state);
    }
  }
  // v2 path: scope skills to the entity.
  if (!world.skillStatesByEntity.has(playerEid)) {
    world.skillStatesByEntity.set(playerEid, skillMap);
  } else {
    const existing = world.skillStatesByEntity.get(playerEid)!;
    for (const [id, state] of skillMap) {
      if (!existing.has(id)) {
        existing.set(id, state);
      }
    }
  }
}

export function initializeFloor1Scenario(world: GameWorld, playerEid: number): void {
  const config: MapConfig = {
    widthTiles: floor1Config.map.widthTiles,
    heightTiles: floor1Config.map.heightTiles,
    tileSizeFt: floor1Config.map.tileSizeFt,
    biome: BiomeType.BASIC_UNDERGROUND,
    seed: world.rng.nextInt(1, 2_000_000),
    roomWidthRange: floor1Config.map.roomWidthRange,
    roomHeightRange: floor1Config.map.roomHeightRange,
    maxRooms: floor1Config.map.maxRooms,
    floorDensity: floor1Config.map.floorDensity,
  };
  const floorMap = getGenerator(config.biome).generate(config, world.rng);
  world.floorMap = floorMap;

  const spawn = floorMap.tileToWorld(floorMap.playerSpawn.x, floorMap.playerSpawn.y);
  if (hasComponent(world.ecs, playerEid, Position)) {
    setComponent(world.ecs, playerEid, Position, { x: spawn.x, y: spawn.y });
  }
  if (!hasComponent(world.ecs, playerEid, BroadcastScore)) {
    addComponent(world.ecs, playerEid, set(BroadcastScore, { current: 0 }));
  }

  const maxHp = (world.stores.health.max[playerEid] ?? 100) + floor1Config.player.hpBonus;
  setComponent(world.ecs, playerEid, Health, { current: maxHp, max: maxHp });

  const {
    welcomeOfficePos,
    safeRoomPos,
    staircasePos,
    slimeRatRoomPos,
    spellQuestGiverPos,
    shopRoomPos,
    questItemPos,
  } = chooseObjectiveTiles(world);
  tagRoomAsSafe(world, welcomeOfficePos);
  tagRoomAsSafe(world, shopRoomPos);
  tagRoomAsSafe(world, spellQuestGiverPos);

  // Door-gate every special room. Corridors carved between room centres regularly
  // clip a room's bounding-box perimeter at non-door tiles, letting enemies tunnel
  // into rooms that are meant to be refuges or gated arenas (e.g. seed 42's shop
  // and spell-broker safe rooms, and the hub-shaped welcome office). Seal them
  // generically: every SAFE + BOSS_STAIR room plus the slime-rat quest room. Each
  // breach is walled unless walling it would strand a region, in which case it
  // becomes a door so the room stays enclosed without softlocking the floor.
  const slimeRatTile = floorMap.worldToTile(slimeRatRoomPos.x, slimeRatRoomPos.y);
  const slimeRatRoomId = floorMap.roomGraph.getRoomAt(slimeRatTile.x, slimeRatTile.y);
  sealSpecialRooms(floorMap, {
    extraRoomIds: slimeRatRoomId >= 0 ? [slimeRatRoomId] : [],
  });

  // Welcome wayfinding signs are planted further down, after NPCs spawn, so a
  // sign can detect and avoid landing on top of an NPC (see placeWelcomeSigns).

  // Place ambient props using the floor manifest config (if present).
  if (floor1Manifest.props !== undefined) {
    placePropsForFloor(world, floorMap, floor1Manifest.props, world.rng);
  }

  world.floor1 = {
    protagonistName: floor1Config.protagonist,
    starterWeaponPool: floor1Config.starterWeapons,
    starterChoices: pickStarterChoices(world),
    selectedWeaponId: null,
    selectedChoiceIndex: null,
    baseStatBonuses: {
      maxHp: floor1Config.player.hpBonus,
      moveSpeed: floor1Config.player.moveSpeedBonus,
      pickupRange: floor1Config.player.pickupRangeBonus,
    },
    enemyArchetypes: new Map(),
    guideNpcEid: null,
    spellQuestGiverNpcEid: null,
    shopkeeperNpcEid: null,
    questItemEid: null,
    bossRoomDoorEids: new Map([
      ['slime-rat', []],
      ['staircase', []],
    ]),
    objective: {
      requiredRats: floor1Config.objectives.requiredRats,
      requiredSlimes: floor1Config.objectives.requiredSlimes,
      requiredGold: floor1Config.objectives.requiredGold,
      requiredJunk: floor1Config.objectives.requiredJunk,
      deadlineMs: floor1Config.timer.durationMs,
      staircaseSpawnCountdownMs: floor1Config.timer.stairSpawnCountdownMs,
      safeRoomPos,
      staircasePos,
      welcomeOfficePos,
      slimeRatRoomPos,
      spellQuestGiverPos,
      shopRoomPos,
      questItemPos,
      markerRadiusFt: floor1Config.objectives.markerRadiusFt,
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
      // 'slime-rat' = spell-quest room boss (weaker); 'staircase' = end-of-floor boss (stronger).
      // JS Map iterates in insertion order, so 'slime-rat' is checked first by the
      // HUD boss bar (see resolveBossHealthBar), giving it priority when both
      // battles are active simultaneously.
      bossBattles: new Map([
        [
          'slime-rat',
          {
            started: false,
            bossEid: null,
            defeated: false,
            displayName: 'Slime Rat',
            lootTableId: 'boss_minor',
          },
        ],
        [
          'staircase',
          {
            started: false,
            bossEid: null,
            defeated: false,
            displayName: 'Rat Slime',
            lootTableId: 'boss',
          },
        ],
      ]),
    },
    failReason: null,
    runSummary: null,
  };
  // Clean slate for the per-world director state so a re-initialised floor (e.g.
  // a fresh run on a reused world) re-rolls room pre-population and resets the
  // spawn cadence rather than inheriting the previous floor's bookkeeping.
  populatedRoomsByWorld.delete(world);
  spawnerStateByWorld.delete(world);
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.safeRoomDiscovered`, false);
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.staircaseUnlocked`, false);
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.staircaseDiscovered`, false);
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.combatComplete`, false);
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.lootComplete`, false);
  setGoalFlag(world, 'floor1-reach-level-2', false);
  setGoalFlag(world, 'floor1-welcome-room-found', false);
  setGoalFlag(world, 'floor1-leveling-quest-complete', false);
  setGoalFlag(world, 'floor1-drops-unlocked', false);
  setGoalFlag(world, 'floor1-defeat-boss', false);
  setGoalFlag(world, 'floor1-boss-battle-active', false);
  setGoalFlag(world, 'floor1-boss-battle-complete', false);
  setGoalFlag(world, 'floor1-boss-spellbook-claimed', false);
  setGoalFlag(world, 'floor1-boss-active', false);
  setGoalFlag(world, 'floor1-shop-prize-returned', false);
  setGoalFlag(world, 'floor1-shop-quest-complete', false);
  // Slime Rat boss room stays locked until the player accepts the quest from the Spell Broker.
  setGoalFlag(world, 'floor1-slime-rat-quest-accepted', false);
  setGoalFlag(world, 'floor1-leave-floor-complete', false);

  // Spawn NPCs from placement definitions (if available in manifest)
  const npcPlacements = floor1Manifest.npcPlacements;
  if (npcPlacements && npcPlacements.length > 0) {
    // Data-driven NPC spawning
    for (const placement of npcPlacements) {
      const eid = spawnNpcFromPlacement(world, placement, {
        welcomeOfficePos,
        safeRoomPos,
        staircasePos,
        slimeRatRoomPos,
        spellQuestGiverPos,
        shopRoomPos,
        questItemPos,
      });

      // Store EIDs based on NPC type for backward compatibility
      if (placement.npcTypeId === 'tutorial-goon') {
        world.floor1.guideNpcEid = eid;
      } else if (placement.npcTypeId === 'spell-quest-giver') {
        world.floor1.spellQuestGiverNpcEid = eid;
      } else if (placement.npcTypeId === 'shopkeeper') {
        world.floor1.shopkeeperNpcEid = eid;
      }
    }
  } else {
    // Fallback to hardcoded NPC spawning (backward compatibility)
    world.floor1.guideNpcEid = spawnNpc(
      world,
      world.floor1.objective.welcomeOfficePos.x,
      world.floor1.objective.welcomeOfficePos.y,
      'tutorial-goon',
    );
    world.floor1.spellQuestGiverNpcEid = spawnNpc(
      world,
      world.floor1.objective.spellQuestGiverPos.x,
      world.floor1.objective.spellQuestGiverPos.y,
      'spell-quest-giver',
    );
    world.floor1.shopkeeperNpcEid = spawnNpc(world, shopRoomPos.x, shopRoomPos.y, 'shopkeeper');
  }

  // Plant the welcome wayfinding signs now that NPCs exist, so a sign never
  // lands on top of one.
  placeWelcomeSigns(world, welcomeOfficePos);

  // Spawn the merchant's fetch quest item
  world.floor1.questItemEid = spawnDroppedItem(
    world,
    questItemPos.x,
    questItemPos.y,
    getItemIndex(SHOPKEEPER_FETCH_ITEM_ID),
  );
  spawnFloor1StaticSpawners(world);

  // Give the player base stats so purchased equipment can be equipped.
  initializeBaseStats(world, playerEid);
  // Initialize weapon skill states for the player so HUD and skill system track progress.
  initializePlayerWeaponSkills(world, playerEid);

  // The opening quest is the only one the player starts with: find the Welcome
  // Office and talk to the Tutorial Goon. NPC-given quests (shopkeeper errand,
  // spell broker) and the level-2 grind quest are accepted on first meeting the
  // relevant NPC — see meetTutorialGoon / meetShopkeeper / meetSpellQuestGiver.
  acceptQuest(world, FLOOR1_FIND_WELCOME_QUEST_ID);
  setTrackedQuest(world, FLOOR1_FIND_WELCOME_QUEST_ID);

  // Keep the final boss-room doors locked until all three gating Floor 1 quests are
  // complete: the Goon's kill-grind (floor1-goon-quest-complete), the Merchant's
  // errand (floor1-shop-quest-complete), and the Spell Broker's Slime Rat
  // spell-unlock quest (floor1-boss-battle-complete).
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
          conditions: [
            { type: 'goal', goalId: 'floor1-goon-quest-complete' },
            { type: 'goal', goalId: 'floor1-shop-quest-complete' },
            { type: 'goal', goalId: 'floor1-boss-battle-complete' },
          ],
        },
      });
      world.floor1.bossRoomDoorEids.get('staircase')!.push(doorEid);
    }
  }
  const slimeRatRoom = roomAtPosition(world, slimeRatRoomPos);
  if (slimeRatRoom) {
    for (const door of slimeRatRoom.doors) {
      const doorEid = createEntity(world);
      // Room starts locked; it unlocks when the player takes the quest from the Spell Broker.
      // When the battle begins, beginFloor1SlimeRatBattle replaces this config with the
      // battle-active lock (re-locks until boss is defeated via floor1-boss-battle-complete).
      addComponent(
        world.ecs,
        doorEid,
        set(DoorState, { tileX: door.x, tileY: door.y, isOpen: 0, isLocked: 1, wasUnlocked: 0 }),
      );
      setDoorLockConfig(world, doorEid, {
        unlock: {
          operator: 'all',
          conditions: [{ type: 'goal', goalId: 'floor1-slime-rat-quest-accepted' }],
        },
        // Re-lock if the battle activates before the doorSystem can process the quest-accepted
        // unlock (defensive — beginFloor1SlimeRatBattle also sets isLocked directly).
        relock: {
          operator: 'all',
          conditions: [{ type: 'goal', goalId: 'floor1-boss-battle-active' }],
        },
      });
      world.floor1.bossRoomDoorEids.get('slime-rat')!.push(doorEid);
    }
  }

  world.state = 'loadout';
  world.floorObjectiveTick = floor1ObjectiveTick;

  // Spawn harvestable resource nodes after the map and all rooms are fully set up.
  spawnFloor1HarvestableNodes(world);
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
  maxRadius: number = FLOOR_1_SPAWN_RADIUS_MAX,
): { x: number; y: number } {
  const floorMap = world.floorMap;
  const pack = floor1EnemyPack;
  if (!floorMap) {
    return { x: playerX + pack.spawnRadiusMin, y: playerY };
  }
  const outerRadius = Math.max(pack.spawnRadiusMin, maxRadius);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const angle = world.rng.next() * Math.PI * 2;
    const radius = pack.spawnRadiusMin + world.rng.next() * (outerRadius - pack.spawnRadiusMin);
    const x = playerX + Math.cos(angle) * radius;
    const y = playerY + Math.sin(angle) * radius;
    if (floorMap.isPassableAt(x, y)) {
      const tile = floorMap.worldToTile(x, y);
      const candidate = floorMap.tileToWorld(tile.x, tile.y);
      if (isInAnyRoom(world, candidate.x, candidate.y)) {
        return candidate;
      }
    }
  }
  const viableRooms = floorMap.rooms.filter(
    (room) => room.role !== RoomRole.SAFE && room.role !== RoomRole.BOSS_STAIR,
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
      const candidate = floorMap.tileToWorld(tx, ty);
      if (floorMap.isPassableAt(candidate.x, candidate.y)) {
        return candidate;
      }
    }
  }
  const fallbackTile = floorMap.worldToTile(playerX + pack.spawnRadiusMin, playerY);
  return floorMap.tileToWorld(fallbackTile.x, fallbackTile.y);
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
      const candidate = floorMap.tileToWorld(tx, ty);
      if (floorMap.isPassableAt(candidate.x, candidate.y)) {
        return candidate;
      }
    }
    const centerCandidate = floorMap.tileToWorld(center.x, center.y);
    if (floorMap.isPassableAt(centerCandidate.x, centerCandidate.y)) {
      return centerCandidate;
    }
    // Full interior scan: iterate every interior tile and return the first passable
    // one found (early-exit). Handles seeds where variety post-processing leaves
    // only isolated passable tiles outside the center search area (e.g. seed 665790).
    const { x: bx, y: by, width: bw, height: bh } = bossRoom.bounds;
    for (let scanY = by + 1; scanY < by + bh - 1; scanY++) {
      for (let scanX = bx + 1; scanX < bx + bw - 1; scanX++) {
        const scanCandidate = floorMap.tileToWorld(scanX, scanY);
        if (floorMap.isPassableAt(scanCandidate.x, scanCandidate.y)) {
          return scanCandidate;
        }
      }
    }
  }
  if (!floorMap) {
    return { x: stairX + floor1Config.bossVariants!.ratSlime.spawnRadiusMin, y: stairY };
  }
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const angle = world.rng.next() * Math.PI * 2;
    const radius =
      floor1Config.bossVariants!.ratSlime.spawnRadiusMin +
      world.rng.next() *
        (floor1Config.bossVariants!.ratSlime.spawnRadiusMax -
          floor1Config.bossVariants!.ratSlime.spawnRadiusMin);
    const x = stairX + Math.cos(angle) * radius;
    const y = stairY + Math.sin(angle) * radius;
    if (floorMap.isPassableAt(x, y)) {
      const tile = floorMap.worldToTile(x, y);
      return floorMap.tileToWorld(tile.x, tile.y);
    }
  }
  const fallbackTile = floorMap.worldToTile(stairX, stairY);
  if (floorMap.tileMap.isPassable(fallbackTile.x, fallbackTile.y)) {
    return floorMap.tileToWorld(fallbackTile.x, fallbackTile.y);
  }
  const maxRadius = Math.max(floorMap.width, floorMap.height);
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const tx = fallbackTile.x + dx;
        const ty = fallbackTile.y + dy;
        if (tx < 0 || ty < 0 || tx >= floorMap.width || ty >= floorMap.height) continue;
        if (floorMap.tileMap.isPassable(tx, ty)) {
          return floorMap.tileToWorld(tx, ty);
        }
      }
    }
  }
  return floorMap.tileToWorld(fallbackTile.x, fallbackTile.y);
}

function isInRoom(
  world: GameWorld,
  px: number,
  py: number,
  room: { bounds: { x: number; y: number; width: number; height: number } } | null,
): boolean {
  if (!world.floorMap || !room) return false;
  const tile = world.floorMap.worldToTile(px, py);
  const { x, y, width, height } = room.bounds;
  return tile.x >= x && tile.x < x + width && tile.y >= y && tile.y < y + height;
}

function isFullyInsideBossRoom(world: GameWorld, px: number, py: number): boolean {
  const floorMap = world.floorMap;
  const bossRoom = floorMap?.bossStairRoom ?? null;
  if (!floorMap || !bossRoom || !isInRoom(world, px, py, bossRoom)) {
    return false;
  }
  const playerTile = floorMap.worldToTile(px, py);
  for (const door of bossRoom.doors) {
    if (playerTile.x === door.x && playerTile.y === door.y) {
      return false;
    }
  }
  return true;
}

function roomAtPosition(
  world: GameWorld,
  pos: { x: number; y: number },
): {
  bounds: { x: number; y: number; width: number; height: number };
  doors: readonly { x: number; y: number }[];
} | null {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return null;
  }
  const tile = floorMap.worldToTile(pos.x, pos.y);
  const roomId = floorMap.roomGraph.getRoomAt(tile.x, tile.y);
  if (roomId < 0) {
    return null;
  }
  return floorMap.roomGraph.get(roomId) ?? null;
}

function isFullyInsideObjectiveRoom(
  world: GameWorld,
  px: number,
  py: number,
  roomPos: { x: number; y: number },
): boolean {
  const floorMap = world.floorMap;
  const room = roomAtPosition(world, roomPos);
  if (!floorMap || !room || !isInRoom(world, px, py, room)) {
    return false;
  }
  const playerTile = floorMap.worldToTile(px, py);
  for (const door of room.doors) {
    if (playerTile.x === door.x && playerTile.y === door.y) {
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
  const tile = floorMap.worldToTile(px, py);
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
    floor1Config.bossVariants!.ratSlime.hp,
    AI_TYPE.CHASE,
    floor1Config.bossVariants!.ratSlime.speed,
    floor1Config.bossVariants!.ratSlime.detectRange,
    280,
  );
  setComponent(world.ecs, eid, Sprite, {
    textureId: floor1Config.enemies.slime.spriteTexture,
    width: floor1Config.bossVariants!.ratSlime.spriteWidth,
    height: floor1Config.bossVariants!.ratSlime.spriteHeight,
  });

  // ratSlime stair boss is primarily a slime creature.
  setBloodColor(world, eid, BLOOD_COLOR_SLIME);

  // Boss has melee contact damage for swipe attacks.
  setComponent(world.ecs, eid, Damage, { amount: 12 });

  // Keep boss aggro active during the locked-room fight.
  world.stores.enemyBehavior.aggroedPermanently[eid] = 1;

  // Boss fires acid projectiles every 5 seconds.
  world.stores.enemyBehavior.fireCooldownMs[eid] =
    floor1Config.bossVariants!.ratSlime.fireballCooldownMs;

  return eid;
}

function spawnFloor1SlimeRatBoss(world: GameWorld): number {
  const objective = world.floor1?.objective;
  if (!objective) {
    throw new Error('Cannot spawn Slime Rat without floor1 objective state.');
  }
  const bossRoom = roomAtPosition(world, objective.slimeRatRoomPos);
  const spawnPoint = resolveBossSpawnPosition(
    world,
    bossRoom,
    objective.slimeRatRoomPos.x,
    objective.slimeRatRoomPos.y,
  );
  const eid = spawnBehaviorEnemy(
    world,
    spawnPoint.x,
    spawnPoint.y,
    floor1Config.bossVariants!.slimeRat.hp,
    AI_TYPE.CHASE,
    floor1Config.bossVariants!.slimeRat.speed,
    floor1Config.bossVariants!.slimeRat.detectRange,
    220,
  );
  setComponent(world.ecs, eid, Sprite, {
    textureId: floor1Config.enemies.slime.spriteTexture,
    width: floor1Config.bossVariants!.ratSlime.spriteWidth - 0.5,
    height: floor1Config.bossVariants!.ratSlime.spriteHeight - 0.5,
  });
  // slimeRat quest boss is primarily a slime creature.
  setBloodColor(world, eid, BLOOD_COLOR_SLIME);
  setComponent(world.ecs, eid, Damage, { amount: 8 });
  world.stores.enemyBehavior.aggroedPermanently[eid] = 1;
  world.stores.enemyBehavior.fireCooldownMs[eid] =
    floor1Config.bossVariants!.slimeRat.fireballCooldownMs;
  return eid;
}

function beginFloor1SlimeRatBattle(world: GameWorld): void {
  const floor1 = world.floor1;
  const objective = floor1?.objective;
  const slimeRatBattle = objective?.bossBattles.get('slime-rat');
  if (
    !objective ||
    !slimeRatBattle ||
    slimeRatBattle.started ||
    !world.questLog.has(FLOOR1_BOSS_BATTLE_QUEST_ID)
  ) {
    return;
  }
  slimeRatBattle.started = true;
  setGoalFlag(world, 'floor1-boss-battle-active', true);
  const slimeRatRoom = roomAtPosition(world, objective.slimeRatRoomPos);
  if (slimeRatRoom) {
    for (const door of slimeRatRoom.doors) {
      world.floorMap?.tileMap.closeDoor(door.x, door.y);
    }
  }
  if (floor1) {
    for (const doorEid of floor1.bossRoomDoorEids.get('slime-rat') ?? []) {
      world.stores.doorState.isLocked[doorEid] = 1;
      world.stores.doorState.isOpen[doorEid] = 0;
      setDoorLockConfig(world, doorEid, {
        unlock: {
          operator: 'all',
          conditions: [{ type: 'goal', goalId: 'floor1-boss-battle-complete' }],
        },
        relock: {
          operator: 'all',
          conditions: [{ type: 'goal', goalId: 'floor1-boss-battle-active' }],
        },
      });
    }
  }
  slimeRatBattle.bossEid = spawnFloor1SlimeRatBoss(world);
}

function beginFloor1BossBattle(world: GameWorld): void {
  const floor1 = world.floor1;
  const objective = floor1?.objective;
  const staircaseBattle = objective?.bossBattles.get('staircase');
  if (!floor1 || !objective || !staircaseBattle || staircaseBattle.started) {
    return;
  }

  staircaseBattle.started = true;
  objective.staircaseLocked = true;
  objective.staircaseUnlocked = false;
  setGoalFlag(world, 'floor1-boss-active', true);

  staircaseBattle.bossEid = spawnFloor1StairBoss(world);
  const floorMap = world.floorMap;
  const bossRoom = floorMap?.bossStairRoom;
  if (bossRoom) {
    for (const door of bossRoom.doors) {
      floorMap!.tileMap.closeDoor(door.x, door.y);
    }
  }
  // Replace lock config: doors stay locked while boss is active, open once boss defeated.
  for (const doorEid of floor1.bossRoomDoorEids.get('staircase') ?? []) {
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

/** Squared distance between two points. */
function distSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/**
 * Count living enemies within `radiusSq` of the player — the "engaging" set the
 * director keeps topped up. Corpses in their death-linger window (health 0) are
 * excluded so a pile of fresh kills doesn't suppress replenishment.
 */
function countEngagingEnemies(
  world: GameWorld,
  playerX: number,
  playerY: number,
  radiusSq: number,
): number {
  const { position, health } = world.stores;
  let count = 0;
  for (const eid of query(world.ecs, [Enemy, Position])) {
    if (hasComponent(world.ecs, eid, Spawner)) {
      continue;
    }
    if ((health.current[eid] ?? 0) <= 0) {
      continue;
    }
    if (distSq(position.x[eid] ?? 0, position.y[eid] ?? 0, playerX, playerY) <= radiusSq) {
      count += 1;
    }
  }
  return count;
}

function countDirectorEnemies(world: GameWorld): number {
  let count = 0;
  for (const eid of query(world.ecs, [Enemy])) {
    if (hasComponent(world.ecs, eid, Spawner)) {
      continue;
    }
    count += 1;
  }
  return count;
}

/**
 * Recycle up to `count` ambient enemies that are well outside the engagement
 * ring (`minDistSq`), furthest first, to free global-cap budget for fresh spawns
 * closer to the player. Never evicts enemies inside the ring (the fight the
 * player is in) and only ever touches tracked ambient archetypes — bosses and
 * quest enemies are untouched. Returns the number actually evicted.
 */
function evictFurthestAmbient(
  world: GameWorld,
  playerX: number,
  playerY: number,
  minDistSq: number,
  count: number,
): number {
  if (!world.floor1 || count <= 0) {
    return 0;
  }
  const candidates = [...world.floor1.enemyArchetypes.keys()]
    .filter((eid) => entityExists(world.ecs, eid))
    .map((eid) => ({
      eid,
      distanceSq: distSq(
        world.stores.position.x[eid] ?? 0,
        world.stores.position.y[eid] ?? 0,
        playerX,
        playerY,
      ),
    }))
    .filter((c) => c.distanceSq > minDistSq)
    .sort((a, b) => b.distanceSq - a.distanceSq);
  const evictCount = Math.min(count, candidates.length);
  for (let i = 0; i < evictCount; i += 1) {
    const victim = candidates[i]!.eid;
    clearEntityStores(world, victim);
    removeEntity(world.ecs, victim);
    world.floor1.enemyArchetypes.delete(victim);
  }
  return evictCount;
}

/**
 * Spawn one weighted ambient archetype at a world (feet) position, wiring its sprite,
 * blood colour, and ambient-tracking entry. Returns the new entity id.
 */
function spawnAmbientArchetype(world: GameWorld, x: number, y: number): number {
  const pack = floor1EnemyPack;
  const archetype = pickEnemyArchetype(pack.archetypes, () => world.rng.next());
  const eid = spawnBehaviorEnemy(
    world,
    x,
    y,
    archetype.hp,
    archetype.id === 'slime' ? AI_TYPE.LEAPER : AI_TYPE.CHASE,
    archetype.speed,
    archetype.detectRange,
    0,
  );
  setComponent(world.ecs, eid, Sprite, {
    textureId: archetype.spriteTexture,
    width: archetype.spriteWidth,
    height: archetype.spriteHeight,
  });
  // Slimes bleed green, rats bleed red.
  setBloodColor(world, eid, archetype.id === 'slime' ? BLOOD_COLOR_SLIME : BLOOD_COLOR_RAT);
  world.floor1!.enemyArchetypes.set(eid, archetype.id);
  return eid;
}

/**
 * Whether an ambient spawn position is unusable: beyond `maxDistanceSq` of the
 * player, not inside any room, or inside the boss-stair / a safe room.
 */
function isInvalidAmbientSpawn(
  world: GameWorld,
  x: number,
  y: number,
  playerX: number,
  playerY: number,
  maxDistanceSq: number,
): boolean {
  return (
    distSq(x, y, playerX, playerY) > maxDistanceSq ||
    !isInAnyRoom(world, x, y) ||
    isInRoom(world, x, y, world.floorMap?.bossStairRoom ?? null) ||
    (world.floorMap?.roomGraph
      .getRoomsByRole(RoomRole.SAFE)
      .some((r) => isInRoom(world, x, y, r)) ??
      false)
  );
}

/**
 * Resolve a near-player ambient spawn position. Sampling is biased into the
 * engagement ring (so spawns appear close, keeping combat constant) while the
 * absolute validity ceiling stays at the ambient max distance, with a
 * whole-map passable-tile fallback. Returns null when no valid tile is found.
 */
function resolveAmbientSpawnPoint(
  world: GameWorld,
  playerX: number,
  playerY: number,
): { x: number; y: number } | null {
  const pack = floor1EnemyPack;
  const maxDistanceSq =
    FLOOR_1_AMBIENT_SPAWN_MAX_DISTANCE_FT * FLOOR_1_AMBIENT_SPAWN_MAX_DISTANCE_FT;
  const ringPoint = resolveSpawnPosition(world, playerX, playerY, pack.engageRadiusFt);
  if (!isInvalidAmbientSpawn(world, ringPoint.x, ringPoint.y, playerX, playerY, maxDistanceSq)) {
    return ringPoint;
  }
  const floorMap = world.floorMap;
  if (!floorMap) {
    return null;
  }
  for (let i = 0; i < 64; i += 1) {
    const tx = world.rng.nextInt(0, floorMap.width - 1);
    const ty = world.rng.nextInt(0, floorMap.height - 1);
    const candidate = floorMap.tileToWorld(tx, ty);
    if (
      floorMap.isPassableAt(candidate.x, candidate.y) &&
      !isInvalidAmbientSpawn(world, candidate.x, candidate.y, playerX, playerY, maxDistanceSq)
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Pick a passable interior tile of `roomId` for a pre-population spawn, kept a
 * little away from the player so the wave reads as already present rather than
 * materialising on top of them at the doorway. Returns null if none is found.
 */
function resolveRoomInteriorSpawn(
  world: GameWorld,
  roomId: number,
  playerX: number,
  playerY: number,
): { x: number; y: number } | null {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return null;
  }
  const minSpawnDistSq =
    FLOOR_1_ROOM_WAVE_MIN_PLAYER_DISTANCE_FT * FLOOR_1_ROOM_WAVE_MIN_PLAYER_DISTANCE_FT;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const tile = floorMap.roomGraph.getRandomInteriorTile(roomId, world.rng);
    if (!tile) {
      return null;
    }
    const candidate = floorMap.tileToWorld(tile.x, tile.y);
    if (!floorMap.isPassableAt(candidate.x, candidate.y)) {
      continue;
    }
    if (distSq(candidate.x, candidate.y, playerX, playerY) < minSpawnDistSq) {
      continue;
    }
    return candidate;
  }
  return null;
}

/**
 * The first time the player stands inside a NORMAL combat room, roll
 * `roomWaveChance` to pre-populate it with a wave already inside — so entering a
 * fresh room usually means walking into a fight. The room id is recorded on the
 * first visit regardless of the roll outcome, so leaving and re-entering never
 * re-rolls. SPAWN, SAFE, and BOSS_STAIR rooms are never seeded.
 */
function prepopulateEnteredRoom(world: GameWorld, playerX: number, playerY: number): void {
  const floorMap = world.floorMap;
  if (!floorMap || !world.floor1) {
    return;
  }
  const tile = floorMap.worldToTile(playerX, playerY);
  const roomId = floorMap.roomGraph.getRoomAt(tile.x, tile.y);
  if (roomId < 0) {
    return;
  }
  const populated = getPopulatedRooms(world);
  if (populated.has(roomId)) {
    return;
  }
  populated.add(roomId);
  const room = floorMap.roomGraph.get(roomId);
  if (!room || room.role !== RoomRole.NORMAL) {
    return;
  }
  const pack = floor1EnemyPack;
  if (world.rng.next() >= pack.roomWaveChance) {
    return;
  }
  const waveMax = Math.max(pack.roomWaveMin, pack.roomWaveMax);
  const waveSize = world.rng.nextInt(pack.roomWaveMin, waveMax);
  for (let i = 0; i < waveSize; i += 1) {
    if (countDirectorEnemies(world) >= pack.enemyCap) {
      break;
    }
    const pos = resolveRoomInteriorSpawn(world, roomId, playerX, playerY);
    if (pos) {
      spawnAmbientArchetype(world, pos.x, pos.y);
    }
  }
}

/**
 * Floor 1 enemy director — keeps the player in constant combat.
 *
 * Each tick it (1) recycles ambient mobs the player has left far behind and
 * enforces the global {@link EnemyPackDef.enemyCap}, (2) pre-populates a freshly
 * entered combat room with a wave, then (3) burst-spawns ambient enemies near
 * the player until the *engaging* count (within {@link EnemyPackDef.engageRadiusFt})
 * reaches {@link EnemyPackDef.engageTarget}. The engagement budget is separate
 * from the global cap: the cap fills distant rooms, while the target guarantees
 * a steady swarm around the player even when they outrun the field. When at the
 * cap, the furthest stragglers outside the engagement ring are recycled to make
 * room for closer spawns.
 */
export function floor1EnemyDirectorSystem(world: GameWorld): void {
  if (!world.floor1 || world.state !== 'playing') {
    return;
  }

  const players = query(world.ecs, [Player, Position]);
  const player = players[0];
  if (player === undefined) {
    return;
  }
  const pack = floor1EnemyPack;
  const playerX = world.stores.position.x[player] ?? 0;
  const playerY = world.stores.position.y[player] ?? 0;

  // Recycle mobs left far behind, then enforce the global ceiling. Both run
  // every tick so budget is freed promptly as the player moves.
  pruneAmbientOutOfRange(world, playerX, playerY);
  const overflow = countDirectorEnemies(world) - pack.enemyCap;
  if (overflow > 0) {
    pruneAmbientOverflow(world, playerX, playerY, overflow);
  }

  // High chance a freshly entered combat room already contains a wave. Runs
  // every tick (cheap set check) so it fires the instant the player walks in,
  // independent of the burst cadence below.
  prepopulateEnteredRoom(world, playerX, playerY);

  // Engagement top-up, throttled to one burst per spawn interval.
  const state = getSpawnerState(world);
  if (world.elapsedMs - state.lastSpawnMs < pack.spawnIntervalMs) {
    return;
  }
  const engageRadiusSq = pack.engageRadiusFt * pack.engageRadiusFt;
  const engaging = countEngagingEnemies(world, playerX, playerY, engageRadiusSq);
  if (engaging >= pack.engageTarget) {
    // Plenty of nearby threats; re-check next tick without burning the interval.
    return;
  }

  const burst = Math.min(pack.engageTarget - engaging, pack.maxSpawnsPerTick);
  for (let i = 0; i < burst; i += 1) {
    // At the global cap, make room near the player by recycling the furthest
    // straggler outside the engagement ring. If nothing can be freed, stop.
    if (countDirectorEnemies(world) >= pack.enemyCap) {
      if (evictFurthestAmbient(world, playerX, playerY, engageRadiusSq, 1) === 0) {
        break;
      }
    }
    const spawnPoint = resolveAmbientSpawnPoint(world, playerX, playerY);
    if (!spawnPoint) {
      break;
    }
    spawnAmbientArchetype(world, spawnPoint.x, spawnPoint.y);
  }
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

function floor1ObjectiveTick(world: GameWorld): void {
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

  const reachedLevel2 = world.playerLevel.level >= 2;
  setGoalFlag(world, 'floor1-reach-level-2', reachedLevel2);
  if (world.goalFlags.get('floor1-leveling-quest-complete') === true) {
    if (!world.questLog.has(FLOOR1_BOSS_UNLOCK_QUEST_ID)) {
      acceptQuest(world, FLOOR1_BOSS_UNLOCK_QUEST_ID);
      setTrackedQuest(world, FLOOR1_BOSS_UNLOCK_QUEST_ID);
    }
  }

  // Mirror kill tallies into the boss-unlock quest for the tracker HUD.
  setQuestCounter(
    world,
    FLOOR1_BOSS_UNLOCK_QUEST_ID,
    'kill-rats',
    world.floor1.objective.ratsKilled,
  );
  setQuestCounter(
    world,
    FLOOR1_BOSS_UNLOCK_QUEST_ID,
    'kill-slimes',
    world.floor1.objective.slimesKilled,
  );

  const playerX = world.stores.position.x[player] ?? 0;
  const playerY = world.stores.position.y[player] ?? 0;
  const safeDx = playerX - world.floor1.objective.safeRoomPos.x;
  const safeDy = playerY - world.floor1.objective.safeRoomPos.y;
  if (Math.hypot(safeDx, safeDy) <= world.floor1.objective.markerRadiusFt) {
    world.floor1.objective.safeRoomDiscovered = true;
  }

  const objective = world.floor1.objective;
  const totalKills = objective.ratsKilled + objective.slimesKilled;
  const bossUnlockQuestAccepted = world.questLog.has(FLOOR1_BOSS_UNLOCK_QUEST_ID);
  const meetsCombat =
    bossUnlockQuestAccepted &&
    totalKills >= floor1Config.objectives.requiredTotalKills &&
    objective.ratsKilled >= objective.requiredRats &&
    objective.slimesKilled >= objective.requiredSlimes;
  const meetsLoot =
    objective.goldCollected >= objective.requiredGold &&
    objective.junkCollected >= objective.requiredJunk;

  if (meetsCombat && !objective.questCompleted) {
    objective.questCompleted = true;
    setGoalFlag(world, 'floor1-goon-quest-complete', true);
  }

  // Auto-accept the "meet the other two NPCs" meta-quest once the Goon's
  // kill-grind is complete. This gives the player an explicit tracker entry
  // directing them to find the Sweaty Merchant and the Spell Broker.
  if (
    world.goalFlags.get('floor1-goon-quest-complete') === true &&
    !world.questLog.has(FLOOR1_MEET_NPCS_QUEST_ID)
  ) {
    acceptQuest(world, FLOOR1_MEET_NPCS_QUEST_ID);
    setTrackedQuest(world, FLOOR1_MEET_NPCS_QUEST_ID);
  }

  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.safeRoomDiscovered`, objective.safeRoomDiscovered);
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.combatComplete`, objective.questCompleted);
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.lootComplete`, meetsLoot);

  const slimeRatBattle = objective.bossBattles.get('slime-rat')!;
  const staircaseBattle = objective.bossBattles.get('staircase')!;

  // Accept the final "Leave the Floor" quest once all three prerequisite quests
  // are done: the Goon's kill-grind, the Merchant's errand, and the Spell
  // Broker's Slime Rat quest. This is when the boss-room door opens.
  const allGatesComplete =
    world.goalFlags.get('floor1-goon-quest-complete') === true &&
    world.goalFlags.get('floor1-shop-quest-complete') === true &&
    world.goalFlags.get('floor1-boss-battle-complete') === true;
  if (allGatesComplete && !world.questLog.has(FLOOR1_LEAVE_FLOOR_QUEST_ID)) {
    acceptQuest(world, FLOOR1_LEAVE_FLOOR_QUEST_ID);
    setTrackedQuest(world, FLOOR1_LEAVE_FLOOR_QUEST_ID);
  }

  // Slime Rat (weaker) battle starts in its dedicated boss room.
  if (
    world.questLog.has(FLOOR1_BOSS_BATTLE_QUEST_ID) &&
    isFullyInsideObjectiveRoom(world, playerX, playerY, objective.slimeRatRoomPos) &&
    !slimeRatBattle.started
  ) {
    beginFloor1SlimeRatBattle(world);
  }

  const slimeRatEid = slimeRatBattle.bossEid;
  const slimeRatAlive = slimeRatEid !== null && entityExists(world.ecs, slimeRatEid);
  if (slimeRatBattle.started && !slimeRatAlive && !slimeRatBattle.defeated) {
    slimeRatBattle.defeated = true;
    slimeRatBattle.bossEid = null;
    setGoalFlag(world, 'floor1-boss-battle-active', false);
    const slimeRatRoom = roomAtPosition(world, objective.slimeRatRoomPos);
    if (slimeRatRoom) {
      for (const door of slimeRatRoom.doors) {
        world.floorMap?.tileMap.openDoor(door.x, door.y);
      }
    }
    for (const doorEid of world.floor1.bossRoomDoorEids.get('slime-rat') ?? []) {
      world.stores.doorState.isLocked[doorEid] = 0;
      world.stores.doorState.isOpen[doorEid] = 1;
    }
    setQuestCounter(world, FLOOR1_BOSS_BATTLE_QUEST_ID, 'kill-slime-rat', 1);
    questSystem(world);
  }

  // Staircase Rat Slime (stronger) starts only after the Slime Rat is defeated.
  if (
    slimeRatBattle.defeated &&
    isFullyInsideBossRoom(world, playerX, playerY) &&
    !staircaseBattle.started
  ) {
    beginFloor1BossBattle(world);
  }

  const staircaseEid = staircaseBattle.bossEid;
  // Treat the boss as dead as soon as its HP reaches 0 (DeathTimer added by dropSystem),
  // so the stairs unlock during the death animation rather than after the body despawns.
  const staircaseAlive =
    staircaseEid !== null &&
    entityExists(world.ecs, staircaseEid) &&
    !hasComponent(world.ecs, staircaseEid, DeathTimer);
  if (staircaseBattle.started && !staircaseAlive && !objective.staircaseSpawned) {
    objective.staircaseSpawned = true;
    objective.staircaseLocked = false;
    objective.staircaseUnlocked = true;
    staircaseBattle.defeated = true;
    staircaseBattle.bossEid = null;
    setGoalFlag(world, 'floor1-boss-active', false);

    const floorMap = world.floorMap;
    if (floorMap?.bossStairRoom) {
      for (const door of floorMap.bossStairRoom.doors) {
        floorMap.tileMap.openDoor(door.x, door.y);
      }
    }
    for (const doorEid of world.floor1.bossRoomDoorEids.get('staircase') ?? []) {
      world.stores.doorState.isLocked[doorEid] = 0;
      world.stores.doorState.isOpen[doorEid] = 1;
    }
    setGoalFlag(world, 'floor1-defeat-boss', true);
  }
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.staircaseUnlocked`, objective.staircaseUnlocked);

  // Pause the floor-collapse deadline while the player is in a safe room.
  // Advancing deadlineMs by one tick's worth keeps the remaining time constant.
  if (world.playerInSafeRoom) {
    objective.deadlineMs += GAME.DELTA_MS;
  }

  if (world.elapsedMs >= objective.deadlineMs && !objective.staircaseDiscovered) {
    world.floor1.failReason = 'stair_timeout';
    world.state = 'game_over';
    finalizeRunSummary(world, 'failed_timeout');
    return;
  }
}

/**
 * Generic floor objective system.
 *
 * Each floor scenario registers its own tick function on
 * `world.floorObjectiveTick` during initialisation. This system calls that
 * function every frame so no floor needs its own named system slot in
 * `postSystems` — only `floorObjectiveSystem` needs to be wired up once.
 */
export function floorObjectiveSystem(world: GameWorld): void {
  world.floorObjectiveTick?.(world);
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
  acceptQuest(world, FLOOR1_BOSS_UNLOCK_QUEST_ID);
  objective.ratsKilled = Math.max(objective.ratsKilled, objective.requiredRats);
  objective.slimesKilled = Math.max(objective.slimesKilled, objective.requiredSlimes);
  objective.goldCollected = Math.max(objective.goldCollected, objective.requiredGold);
  objective.junkCollected = Math.max(objective.junkCollected, objective.requiredJunk);
  setQuestCounter(world, FLOOR1_BOSS_UNLOCK_QUEST_ID, 'kill-rats', objective.ratsKilled);
  setQuestCounter(world, FLOOR1_BOSS_UNLOCK_QUEST_ID, 'kill-slimes', objective.slimesKilled);
  setGoalFlag(world, 'floor1-drops-unlocked', true);
  setGoalFlag(world, 'floor1-reach-level-2', true);
  setGoalFlag(world, 'floor1-leveling-quest-complete', true);
  setGoalFlag(world, 'floor1-goon-quest-complete', true);
  const slimeRatSkip = objective.bossBattles.get('slime-rat')!;
  slimeRatSkip.started = true;
  slimeRatSkip.defeated = true;
  slimeRatSkip.bossEid = null;
  // Mark the quest as accepted so the slime rat room doors open (the initial door lock
  // condition uses this flag). The battle is already complete so the door should be open.
  setGoalFlag(world, 'floor1-slime-rat-quest-accepted', true);
  setQuestCounter(world, FLOOR1_BOSS_BATTLE_QUEST_ID, 'kill-slime-rat', 1);
  setGoalFlag(world, 'floor1-boss-spellbook-claimed', true);
  setGoalFlag(world, 'floor1-boss-battle-complete', true);
  questSystem(world);
  // Accept the final quest directly — the shortcut bypasses the three-gate door
  // check, so we accept it explicitly rather than relying on the auto-accept path.
  if (!world.questLog.has(FLOOR1_LEAVE_FLOOR_QUEST_ID)) {
    acceptQuest(world, FLOOR1_LEAVE_FLOOR_QUEST_ID);
    setTrackedQuest(world, FLOOR1_LEAVE_FLOOR_QUEST_ID);
  }
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.combatComplete`, true);
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.lootComplete`, true);

  const center = centerOfRoom(bossRoom);
  const bossEntryPoint = floorMap.tileToWorld(center.x, center.y);
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
  // Safety net: nobody should leave Floor 1 with the spell unlock flipped (or the
  // boss quest done) but no spell to cast. Idempotent + a no-op once a spell is
  // already learned (modal/AI pick), so it never overrides the player's choice
  // nor shifts the headless RNG trajectory.
  ensureBossBattleSpellReward(world, playerEid);
  objective.staircaseDiscovered = true;
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.staircaseDiscovered`, true);
  // Evaluate quests immediately so that the "Leave the Floor" objective for taking
  // the stairs is marked complete before the run summary is finalised and the
  // game loop breaks on victory.
  questSystem(world);
  world.state = 'safe_room';
  finalizeRunSummary(world, 'cleared_floor');
  evaluateAchievementUnlocksForPhase(world, 'run_end_clear');
  return true;
}

// ---------------------------------------------------------------------------
// Shopkeeper errand flow
// ---------------------------------------------------------------------------

export interface ShopkeeperStockItem {
  readonly itemId: string;
  readonly cost: number;
}

const FLOOR_1_STARTER_WEAPON_TO_SHOP_ITEM_ID: Readonly<Record<string, string>> = {
  sword: 'iron-sword',
  bow: 'frost-bow',
  'baseball-bat': 'bone-club',
  pistol: 'plasma-pistol',
  'throwing-knife': 'rusty-shiv',
  fireball: 'crystal-wand',
};

const SHOPKEEPER_POST_QUEST_ITEM_COSTS: Readonly<Record<string, number>> = {
  'rusty-shiv': 18,
  'iron-sword': 24,
  'bone-club': 20,
  'frost-bow': 26,
  'plasma-pistol': 30,
  'crystal-wand': 28,
};

function findPlayerEid(world: GameWorld): number | undefined {
  return query(world.ecs, [Player])[0];
}

function playerBag(world: GameWorld) {
  const player = findPlayerEid(world);
  return player === undefined ? undefined : world.inventories.get(player);
}

/** Current stage of the merchant's errand, derived from world state. */
export function getShopkeeperStage(world: GameWorld): ShopkeeperStage {
  if (world.goalFlags.get('floor1-shop-quest-complete') === true) {
    return 'complete';
  }
  const bag = playerBag(world);
  const hasEquippable = bag ? bag.slots.some((s) => isEquippableItem(s.itemId)) : false;
  if (hasEquippable) {
    return 'awaiting-equip';
  }
  if (world.goalFlags.get('floor1-shop-prize-returned') === true) {
    return 'ready-to-buy';
  }
  const quest = world.questLog.get(FLOOR1_SHOP_QUEST_ID);
  if (!quest || quest.done['meet-merchant'] !== true) {
    return 'not-met';
  }
  return 'awaiting-prize';
}

/** Deterministic post-quest merchant inventory (2 extra starter-weapon options). */
export function getShopkeeperPostQuestStock(world: GameWorld): ShopkeeperStockItem[] {
  const seen = new Set<string>();
  const starterPool: string[] = [];
  for (const weaponId of floor1Config.starterWeapons) {
    if (
      seen.has(weaponId) ||
      getWeaponDef(weaponId) === undefined ||
      FLOOR_1_STARTER_WEAPON_TO_SHOP_ITEM_ID[weaponId] === undefined
    ) {
      continue;
    }
    seen.add(weaponId);
    starterPool.push(weaponId);
  }
  const selectedAtStart = new Set(world.floor1?.starterChoices ?? []);
  const remainingWeaponIds = starterPool.filter((weaponId) => !selectedAtStart.has(weaponId));
  const stockRng = new SeededRandom(
    hashStringToSeed(`${world.seed}:floor1-shopkeeper-post-quest-stock`),
  );
  stockRng.shuffle(remainingWeaponIds);

  const pickedWeaponIds = remainingWeaponIds.slice(0, 2);
  if (pickedWeaponIds.length < 2) {
    const fallbackWeaponIds = starterPool.filter((weaponId) => !pickedWeaponIds.includes(weaponId));
    stockRng.shuffle(fallbackWeaponIds);
    for (const weaponId of fallbackWeaponIds) {
      if (pickedWeaponIds.length >= 2) {
        break;
      }
      pickedWeaponIds.push(weaponId);
    }
  }
  return pickedWeaponIds
    .map((weaponId) => FLOOR_1_STARTER_WEAPON_TO_SHOP_ITEM_ID[weaponId])
    .filter((itemId): itemId is string => itemId !== undefined)
    .slice(0, 2)
    .map((itemId) => ({
      itemId,
      cost: SHOPKEEPER_POST_QUEST_ITEM_COSTS[itemId] ?? 20,
    }));
}

/** Character level required before the merchant / spell-broker quests unlock. */
export const FLOOR1_QUEST_UNLOCK_LEVEL = 2;

/**
 * Whether the contestant has completed the Tutorial Goon's opening quest
 * ("Trial by XP" — reach level 2). The merchant and Spell Broker refuse to
 * start their own quests until this is done; until then they send the player
 * back to the Goon. Drops are locked until the Goon is met, so completing this
 * quest also guarantees the player has actually spoken to him.
 */
export function hasCompletedWelcomeGoonQuest(world: GameWorld): boolean {
  return world.goalFlags.get('floor1-leveling-quest-complete') === true;
}

function hasActiveQuest(world: GameWorld, questId: string): boolean {
  return world.questLog.get(questId)?.status === 'active';
}

/**
 * Resolve the current quest-indicator state for a Floor 1 NPC.
 *
 * - `actionable`: talking now can accept or advance a quest
 * - `accepted`: the NPC owns an active accepted quest but has nothing new right now
 * - `none`: no quest affordance should be shown
 */
export function getNpcQuestIndicatorState(world: GameWorld, npcId: string): NpcQuestIndicatorState {
  switch (npcId) {
    case 'tutorial-goon':
      if (hasActiveQuest(world, FLOOR1_FIND_WELCOME_QUEST_ID)) {
        return 'actionable';
      }
      if (
        hasActiveQuest(world, FLOOR1_TUTORIAL_QUEST_ID) ||
        hasActiveQuest(world, FLOOR1_BOSS_UNLOCK_QUEST_ID) ||
        hasActiveQuest(world, FLOOR1_MEET_NPCS_QUEST_ID) ||
        hasActiveQuest(world, FLOOR1_LEAVE_FLOOR_QUEST_ID)
      ) {
        return 'accepted';
      }
      return 'none';
    case 'shopkeeper': {
      if (!hasCompletedWelcomeGoonQuest(world)) {
        return 'none';
      }
      const quest = world.questLog.get(FLOOR1_SHOP_QUEST_ID);
      if (!quest) {
        return 'actionable';
      }
      if (quest.status !== 'active') {
        return 'none';
      }
      const stage = getShopkeeperStage(world);
      if (stage === 'ready-to-buy') {
        return 'actionable';
      }
      if (
        stage === 'awaiting-prize' &&
        playerBag(world) &&
        hasItem(playerBag(world)!, SHOPKEEPER_FETCH_ITEM_ID)
      ) {
        return 'actionable';
      }
      if (stage === 'awaiting-prize' || stage === 'awaiting-equip') {
        return 'accepted';
      }
      return 'none';
    }
    case 'spell-quest-giver': {
      if (!hasCompletedWelcomeGoonQuest(world)) {
        return 'none';
      }
      const quest = world.questLog.get(FLOOR1_BOSS_BATTLE_QUEST_ID);
      if (!quest) {
        return 'actionable';
      }
      if (quest.status !== 'active') {
        return 'none';
      }
      const bossDefeated = world.floor1?.objective.bossBattles.get('slime-rat')?.defeated === true;
      if (bossDefeated && world.goalFlags.get('floor1-boss-spellbook-claimed') !== true) {
        return 'actionable';
      }
      return 'accepted';
    }
    default:
      return 'none';
  }
}

/**
 * Mark the merchant as met (advances the first quest step). The errand only
 * unlocks once the contestant has finished the Tutorial Goon's opening quest —
 * before then the merchant just sends them back to the Goon.
 */
export function meetShopkeeper(world: GameWorld): void {
  if (!hasCompletedWelcomeGoonQuest(world)) {
    return;
  }
  if (!world.questLog.has(FLOOR1_SHOP_QUEST_ID)) {
    acceptQuest(world, FLOOR1_SHOP_QUEST_ID);
    setTrackedQuest(world, FLOOR1_SHOP_QUEST_ID);
  }
  notifyQuestTalk(world, 'shopkeeper');
}

/**
 * Mark the spell quest giver as met and accept the Slime Rat quest. Like the
 * merchant, the Spell Broker only offers the quest once the player has finished
 * the Tutorial Goon's opening quest.
 */
export function meetSpellQuestGiver(world: GameWorld): void {
  if (!hasCompletedWelcomeGoonQuest(world)) {
    return;
  }
  if (!world.questLog.has(FLOOR1_BOSS_BATTLE_QUEST_ID)) {
    acceptQuest(world, FLOOR1_BOSS_BATTLE_QUEST_ID);
    setTrackedQuest(world, FLOOR1_BOSS_BATTLE_QUEST_ID);
    // Unlock the Slime Rat boss room so the player can enter.
    setGoalFlag(world, 'floor1-slime-rat-quest-accepted', true);
  }
  if (world.floor1?.objective.bossBattles.get('slime-rat')?.defeated === true) {
    setGoalFlag(world, 'floor1-boss-spellbook-claimed', true);
  }
  notifyQuestTalk(world, 'spell-quest-giver');
}

/**
 * Hand the gross rat tail to the merchant. Consumes the fetch item and unlocks
 * his shop. Returns true when the prize was actually turned in.
 */
export function returnShopkeeperPrize(world: GameWorld, playerEid: number): boolean {
  const bag = world.inventories.get(playerEid);
  if (!bag || !hasItem(bag, SHOPKEEPER_FETCH_ITEM_ID)) {
    return false;
  }
  if (world.goalFlags.get('floor1-shop-prize-returned') === true) {
    return false;
  }
  removeItem(bag, SHOPKEEPER_FETCH_ITEM_ID, 1);
  setGoalFlag(world, 'floor1-shop-prize-returned', true);
  return true;
}

/** Cost of the merchant's wares. */
export const SHOPKEEPER_EQUIPMENT_COST = MERCHANTS_CHARM_COST;

/**
 * Buy the merchant's charm with gold. Adds the (equippable) item to the bag.
 * Returns true on a successful purchase.
 */
export function purchaseShopkeeperEquipment(world: GameWorld, playerEid: number): boolean {
  const bag = world.inventories.get(playerEid);
  if (!bag) {
    return false;
  }
  if (world.goalFlags.get('floor1-shop-prize-returned') !== true) {
    return false;
  }
  if (world.goalFlags.get('floor1-shop-quest-complete') === true) {
    return false;
  }
  if (hasItem(bag, SHOPKEEPER_EQUIPMENT_ITEM_ID)) {
    return false;
  }
  if (world.playerGold < SHOPKEEPER_EQUIPMENT_COST) {
    return false;
  }
  world.playerGold -= SHOPKEEPER_EQUIPMENT_COST;
  addItem(bag, SHOPKEEPER_EQUIPMENT_ITEM_ID, 1);
  return true;
}

/** Buy one item from the post-quest merchant stock. */
export function purchaseShopkeeperPostQuestItem(
  world: GameWorld,
  playerEid: number,
  itemId: string,
): boolean {
  if (world.goalFlags.get('floor1-shop-quest-complete') !== true) {
    return false;
  }
  const bag = world.inventories.get(playerEid);
  if (!bag) {
    return false;
  }
  if (hasItem(bag, itemId)) {
    return false;
  }
  const stockEntry = getShopkeeperPostQuestStock(world).find((entry) => entry.itemId === itemId);
  if (!stockEntry || !getItemById(itemId)) {
    return false;
  }
  if (world.playerGold < stockEntry.cost) {
    return false;
  }
  world.playerGold -= stockEntry.cost;
  addItem(bag, itemId, 1);
  return true;
}

/**
 * Equip a purchased, equippable item from the bag. Removes it from the bag once
 * worn. Returns true when something was equipped.
 */
export function equipPurchasedGear(world: GameWorld, playerEid: number): boolean {
  const bag = world.inventories.get(playerEid);
  if (!bag) {
    return false;
  }
  const slot = bag.slots.find((s) => isEquippableItem(s.itemId));
  if (!slot) {
    return false;
  }
  const def = getEquipmentDefForItem(slot.itemId);
  if (!def) {
    return false;
  }
  const result = equip(world, playerEid, def, { force: true });
  if (!result.ok) {
    return false;
  }
  removeItem(bag, slot.itemId, 1);
  return true;
}

// ---------------------------------------------------------------------------
// Boss battle spell selection flow
// ---------------------------------------------------------------------------

/** Check if the boss battle quest is available for selection. */
export function shouldShowSpellSelector(world: GameWorld): boolean {
  // Show the spell selector if the boss battle quest just completed
  return (
    world.goalFlags.get('floor1-boss-battle-complete') === true &&
    world.featureUnlocks.spells === false
  );
}

/** Show the spell selector modal with available spells. */
export function showSpellSelector(world: GameWorld, showModal: (spellIds: string[]) => void): void {
  if (!shouldShowSpellSelector(world)) {
    return;
  }
  // The showModal callback receives the list of available spell IDs to display
  showModal(Array.from(FLOOR1_BOSS_REWARD_SPELL_IDS));
}

/** Select a spell to equip. Returns true when the spell was successfully learned. */
export function selectSpellFromBossBattle(
  world: GameWorld,
  playerEid: number,
  spellId: string,
): boolean {
  // Verify the spell is one of the allowed options
  if (!FLOOR1_BOSS_REWARD_SPELL_IDS.includes(spellId as Floor1BossRewardSpellId)) {
    return false;
  }

  // Verify the quest completion goal flag is set
  if (world.goalFlags.get('floor1-boss-battle-complete') !== true) {
    return false;
  }

  // Verify the feature unlock hasn't already been triggered
  if (world.featureUnlocks.spells === true) {
    return false;
  }

  // Equip the selected spell
  memorizeSpell(world, playerEid, spellId);

  // Unlock the spells feature (MP bar + ability system)
  world.featureUnlocks.spells = true;

  return true;
}

/**
 * Hardening invariant for the boss-battle spell reward.
 *
 * Completing the Slime Rat quest (goal flag `floor1-boss-battle-complete`) must
 * always leave the player with a concrete learned spell AND
 * `featureUnlocks.spells === true` — even when no engine modal or AI
 * auto-progression ran to pick one. Without this, a path that flips the unlock
 * flag (or completes the quest) without granting a spell would show the MP bar
 * over an empty spellbook, with nothing to cast.
 *
 * Behaviour (idempotent, deterministic — no RNG, no modal):
 *   - Nothing to do until the quest is complete OR the flag is already set.
 *   - If a spell is already learned (modal/AI picked one), just latch the flag
 *     true and exit — preserving the player's / AI's choice.
 *   - Otherwise grant the deterministic {@link DEFAULT_FLOOR1_BOSS_REWARD_SPELL_ID}
 *     and flip the flag. This is the "safe default-grant fallback".
 *
 * Returns true when this call granted the default spell, false otherwise.
 *
 * Note: this is a *safety net*, not the primary path. The visual game still
 * offers the choice modal, and the headless AI still claims the spell via
 * auto-progression — both run before the player can leave the floor, so this
 * only fires in degenerate cases (e.g. a direct flag set), which keeps it from
 * robbing the player's pick or shifting the headless RNG trajectory.
 */
export function ensureBossBattleSpellReward(world: GameWorld, playerEid: number): boolean {
  const questComplete = world.goalFlags.get('floor1-boss-battle-complete') === true;
  if (!questComplete && world.featureUnlocks.spells !== true) {
    return false;
  }

  const state = world.abilityStatesByEntity.get(playerEid);
  const hasLearnedSpell = state !== undefined && state.learnedSpellIds.length > 0;
  if (hasLearnedSpell) {
    // A spell was already chosen — just make sure the unlock flag is latched.
    if (world.featureUnlocks.spells !== true) {
      world.featureUnlocks.spells = true;
    }
    return false;
  }

  // No spell learned yet: grant the deterministic default reward + unlock.
  memorizeSpell(world, playerEid, DEFAULT_FLOOR1_BOSS_REWARD_SPELL_ID);
  world.featureUnlocks.spells = true;
  return true;
}
