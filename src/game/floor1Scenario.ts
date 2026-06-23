import {
  addComponent,
  entityExists,
  hasComponent,
  query,
  removeEntity,
  set,
  setComponent,
} from 'bitecs';
import { BiomeType, RoomRole, TerrainType, type MapConfig } from '../shared/map-types.js';
import { getGenerator } from '../core/map/generators/registry.js';
import {
  Position,
  Rotation,
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
import {
  clearEntityStores,
  spawnBehaviorEnemy,
  spawnNpc,
  createEntity,
  spawnDroppedItem,
} from '../core/helpers.js';
import { setGoalFlag, setDoorLockConfig } from '../core/door-lock.js';
import { AI_TYPE } from './enemyAISystem.js';
import { getItemById, getItemIndex } from '../shared/items.js';
import { GAME, PLAYER_SPEED } from '../shared/constants.js';
import { addItem, hasItem, removeItem } from '../shared/inventory.js';
import { equip, initializeBaseStats } from '../core/systems/equipmentSystem.js';
import {
  MERCHANTS_CHARM_COST,
  getEquipmentDefForItem,
  isEquippableItem,
} from '../shared/equipmentDefs.js';
import {
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_FIND_WELCOME_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
  SHOPKEEPER_EQUIPMENT_ITEM_ID,
  SHOPKEEPER_FETCH_ITEM_ID,
  type ShopkeeperStage,
} from '../shared/quest-types.js';
import { FLOOR1_BOSS_REWARD_SPELL_IDS, type Floor1BossRewardSpellId } from '../shared/abilities.js';
import {
  acceptQuest,
  notifyQuestTalk,
  questSystem,
  setQuestCounter,
  setTrackedQuest,
} from '../core/systems/questSystem.js';
import { memorizeSpell } from './systems/abilitySystem.js';
import { getAllSkillDefinitions } from './skills/registry.js';
import type { SkillState } from '../shared/skills.js';
import { floor1Config } from '../shared/floor1-config.js';
import { floor1EnemyPack, pickEnemyArchetype } from '../shared/enemy-packs.js';
import { floor1Manifest } from '../shared/floor-manifest.js';
import type { NpcPlacementDef } from '../shared/npc-placements.js';

// Derived constants computed from config at module initialization
const FLOOR_1_CAMERA_ZOOM = floor1Config.camera.zoom;
const FLOOR_1_VIEWPORT_WIDTH_PX = GAME.WIDTH / FLOOR_1_CAMERA_ZOOM;
const FLOOR_1_AMBIENT_SPAWN_MAX_DISTANCE_PX = FLOOR_1_VIEWPORT_WIDTH_PX * 2;
const FLOOR_1_SPAWN_RADIUS_MAX = FLOOR_1_AMBIENT_SPAWN_MAX_DISTANCE_PX;
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
  const pack = floor1EnemyPack;
  const maxDistanceSq = pack.despawnDistancePx * pack.despawnDistancePx;
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
  const pool = [...floor1Config.starterWeapons];
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

/**
 * Resolve the pixel position for a room's logical centre.
 *
 * Returns the centre of the room's bounding box if that tile is passable.
 * When the centre has been walled off (e.g. by an ellipse or L-shape
 * post-processing pass), spirals outward within the room's interior until a
 * passable tile is found, then returns its pixel position. This guarantees
 * that NPCs and items are never spawned inside walls.
 */
function resolvePassableRoomCenter(
  floorMap: NonNullable<GameWorld['floorMap']>,
  room: { bounds: { x: number; y: number; width: number; height: number } },
): { x: number; y: number } {
  const center = centerOfRoom(room);
  if (floorMap.tileMap.isPassable(center.x, center.y)) {
    return floorMap.tileToPixel(center.x, center.y);
  }

  const { x: bx, y: by, width: bw, height: bh } = room.bounds;
  const ix = bx + 1;
  const iy = by + 1;
  const maxX = bx + bw - 2;
  const maxY = by + bh - 2;
  const maxR = Math.max(bw, bh);

  for (let r = 1; r <= maxR; r++) {
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
          return floorMap.tileToPixel(tx, ty);
        }
      }
    }
  }

  // Absolute fallback: return the bounding-box centre pixel even if it's a wall.
  return floorMap.tileToPixel(center.x, center.y);
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
  const fallbackWelcome = { x: 120, y: 120 };
  const fallbackStair = { x: floorMap?.widthPx ? floorMap.widthPx - 120 : 1120, y: 560 };
  const fallbackSlimeRat = {
    x: floorMap?.widthPx ? Math.floor(floorMap.widthPx * 0.75) : 960,
    y: 520,
  };
  const fallbackShop = { x: floorMap?.widthPx ? floorMap.widthPx - 240 : 880, y: 340 };
  const fallbackItem = { x: floorMap?.widthPx ? Math.floor(floorMap.widthPx / 2) : 640, y: 340 };

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
  const candidates = floorMap.rooms
    .filter((room) => !reserved.has(room))
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
  const tile = floorMap.pixelToTile(roomPos.x, roomPos.y);
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

function findRoomPath(
  roomGraph: { get(id: number): { neighbors: Iterable<number> } | undefined },
  startId: number,
  targetId: number,
): number[] | null {
  const queue: number[] = [startId];
  const visited = new Set<number>([startId]);
  const parent = new Map<number, number>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === targetId) {
      break;
    }
    const room = roomGraph.get(current);
    if (!room) {
      continue;
    }
    for (const neighborId of room.neighbors) {
      if (visited.has(neighborId)) {
        continue;
      }
      visited.add(neighborId);
      parent.set(neighborId, current);
      queue.push(neighborId);
    }
  }

  if (!visited.has(targetId)) {
    return null;
  }

  const path: number[] = [];
  let current: number | undefined = targetId;
  while (current !== undefined) {
    path.push(current);
    if (current === startId) {
      break;
    }
    current = parent.get(current);
  }

  if (path[path.length - 1] !== startId) {
    return null;
  }

  path.reverse();
  return path;
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
    tileSizePx: floor1Config.map.tileSizePx,
    biome: BiomeType.BASIC_UNDERGROUND,
    seed: world.rng.nextInt(1, 2_000_000),
    roomWidthRange: floor1Config.map.roomWidthRange,
    roomHeightRange: floor1Config.map.roomHeightRange,
    maxRooms: floor1Config.map.maxRooms,
    floorDensity: floor1Config.map.floorDensity,
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

  const welcomeSignTextureId = floor1Config.sprites?.welcomeSign;
  if (welcomeSignTextureId !== undefined && floorMap.spawnRoom && floorMap.safeRoom) {
    const startId = floorMap.spawnRoom.id;
    const targetId = floorMap.safeRoom.id;
    const path = findRoomPath(floorMap.roomGraph, startId, targetId);

    const placeWelcomeSign = (fromRoomId: number, toRoomId: number): void => {
      const room = floorMap.roomGraph.get(fromRoomId);
      const nextRoom = floorMap.roomGraph.get(toRoomId);
      if (!room || !nextRoom) {
        return;
      }
      const c1 = centerOfRoom(room);
      const c2 = centerOfRoom(nextRoom);
      const pos = resolvePassableRoomCenter(floorMap, room);
      const angle = Math.atan2(c2.y - c1.y, c2.x - c1.x);

      // Never plant a sign directly under the player. If this room's sign tile
      // coincides with the player's spawn tile, push it one tile forward (toward
      // the next room) so it reads as a directional pointer the player walks up
      // to, rather than spawning on top of it.
      const signTile = floorMap.pixelToTile(pos.x, pos.y);
      let signX = pos.x;
      let signY = pos.y;
      if (signTile.x === floorMap.playerSpawn.x && signTile.y === floorMap.playerSpawn.y) {
        const step = floorMap.config.tileSizePx;
        signX += Math.cos(angle) * step;
        signY += Math.sin(angle) * step;
      }

      const eid = createEntity(world);
      addComponent(world.ecs, eid, set(Position, { x: signX, y: signY }));
      addComponent(world.ecs, eid, set(Rotation, { angle }));
      addComponent(
        world.ecs,
        eid,
        set(Sprite, {
          textureId: welcomeSignTextureId,
          width: 32,
          height: 16,
        }),
      );
    };

    if (path && path.length >= 2) {
      // Directional breadcrumb trail from the spawn room toward the safe room.
      // Starting at i = 0 guarantees a sign in the spawn room itself; every
      // other room along the path also gets one pointing to the next.
      for (let i = 0; i < path.length - 1; i += 2) {
        placeWelcomeSign(path[i]!, path[i + 1]!);
      }
    } else {
      // Spawn and safe aren't path-connected (rare). Still guarantee the
      // spawn-room welcome sign, oriented straight toward the safe room.
      placeWelcomeSign(startId, targetId);
    }
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
    bossDoorEids: [],
    slimeRatDoorEids: [],
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
      markerRadiusPx: floor1Config.objectives.markerRadiusPx,
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
      slimeRatBattleStarted: false,
      slimeRatBossEid: null,
      slimeRatBossDefeated: false,
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

  // Spawn the merchant's fetch quest item
  world.floor1.questItemEid = spawnDroppedItem(
    world,
    questItemPos.x,
    questItemPos.y,
    getItemIndex(SHOPKEEPER_FETCH_ITEM_ID),
  );

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

  // Keep the final boss-room doors locked until the gating Floor 1 quests are
  // complete: the Merchant's errand (floor1-shop-quest-complete) and the Spell
  // Broker's Slime Rat spell-unlock quest (floor1-boss-battle-complete).
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
            { type: 'goal', goalId: 'floor1-shop-quest-complete' },
            { type: 'goal', goalId: 'floor1-boss-battle-complete' },
          ],
        },
      });
      world.floor1.bossDoorEids.push(doorEid);
    }
  }
  const slimeRatRoom = roomAtPosition(world, slimeRatRoomPos);
  if (slimeRatRoom) {
    for (const door of slimeRatRoom.doors) {
      const doorEid = createEntity(world);
      addComponent(
        world.ecs,
        doorEid,
        set(DoorState, { tileX: door.x, tileY: door.y, isOpen: 1, isLocked: 0, wasUnlocked: 1 }),
      );
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
      world.floor1.slimeRatDoorEids.push(doorEid);
    }
  }

  world.state = 'loadout';
  world.floorObjectiveTick = floor1ObjectiveTick;
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
  const pack = floor1EnemyPack;
  if (!floorMap) {
    return { x: playerX + pack.spawnRadiusMin, y: playerY };
  }
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const angle = world.rng.next() * Math.PI * 2;
    const radius =
      pack.spawnRadiusMin + world.rng.next() * (FLOOR_1_SPAWN_RADIUS_MAX - pack.spawnRadiusMin);
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
      const candidate = floorMap.tileToPixel(tx, ty);
      if (floorMap.isPassableAt(candidate.x, candidate.y)) {
        return candidate;
      }
    }
  }
  const fallbackTile = floorMap.pixelToTile(playerX + pack.spawnRadiusMin, playerY);
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
      const tile = floorMap.pixelToTile(x, y);
      return floorMap.tileToPixel(tile.x, tile.y);
    }
  }
  const fallbackTile = floorMap.pixelToTile(
    stairX + floor1Config.bossVariants!.ratSlime.spawnRadiusMin,
    stairY,
  );
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
  const tile = floorMap.pixelToTile(pos.x, pos.y);
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
  const playerTile = floorMap.pixelToTile(px, py);
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
    width: floor1Config.bossVariants!.ratSlime.spriteWidth - 4,
    height: floor1Config.bossVariants!.ratSlime.spriteHeight - 4,
  });
  setComponent(world.ecs, eid, Damage, { amount: 8 });
  world.stores.enemyBehavior.aggroedPermanently[eid] = 1;
  world.stores.enemyBehavior.fireCooldownMs[eid] =
    floor1Config.bossVariants!.slimeRat.fireballCooldownMs;
  return eid;
}

function beginFloor1SlimeRatBattle(world: GameWorld): void {
  const floor1 = world.floor1;
  const objective = floor1?.objective;
  if (
    !objective ||
    objective.slimeRatBattleStarted ||
    !world.questLog.has(FLOOR1_BOSS_BATTLE_QUEST_ID)
  ) {
    return;
  }
  objective.slimeRatBattleStarted = true;
  setGoalFlag(world, 'floor1-boss-battle-active', true);
  const slimeRatRoom = roomAtPosition(world, objective.slimeRatRoomPos);
  if (slimeRatRoom) {
    for (const door of slimeRatRoom.doors) {
      world.floorMap?.tileMap.closeDoor(door.x, door.y);
    }
  }
  if (floor1) {
    for (const doorEid of floor1.slimeRatDoorEids) {
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
  objective.slimeRatBossEid = spawnFloor1SlimeRatBoss(world);
}

function beginFloor1BossBattle(world: GameWorld): void {
  const floor1 = world.floor1;
  const objective = floor1?.objective;
  if (!floor1 || !objective || objective.bossBattleStarted) {
    return;
  }

  objective.bossBattleStarted = true;
  objective.staircaseLocked = true;
  objective.staircaseUnlocked = false;
  setGoalFlag(world, 'floor1-boss-active', true);

  // Staircase boss is Rat Slime (stronger), separate from the Slime Rat spell-quest boss.
  objective.staircaseBossEid = spawnFloor1StairBoss(world);
  const floorMap = world.floorMap;
  const bossRoom = floorMap?.bossStairRoom;
  if (bossRoom) {
    for (const door of bossRoom.doors) {
      floorMap!.tileMap.closeDoor(door.x, door.y);
    }
  }
  // Replace lock config: doors stay locked while boss is active, open once boss defeated.
  for (const doorEid of floor1.bossDoorEids) {
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

  const pack = floor1EnemyPack;
  if (world.floor1.enemyArchetypes.size >= pack.enemyCap) {
    return;
  }

  const state = getSpawnerState(world);
  if (world.elapsedMs - state.lastSpawnMs < pack.spawnIntervalMs) {
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
  if (totalEnemies > pack.enemyCap) {
    pruneAmbientOverflow(world, playerX, playerY, totalEnemies - pack.enemyCap);
  }
  if (query(world.ecs, [Enemy]).length >= pack.enemyCap) {
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
      (world.floorMap?.roomGraph
        .getRoomsByRole(RoomRole.SAFE)
        .some((r) => isInRoom(world, x, y, r)) ??
        false)
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

  // Pick enemy archetype using weighted selection from pack
  const archetype = pickEnemyArchetype(pack.archetypes, () => world.rng.next());

  const eid = spawnBehaviorEnemy(
    world,
    spawnPoint.x,
    spawnPoint.y,
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

  world.floor1.enemyArchetypes.set(eid, archetype.id);
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
  if (Math.hypot(safeDx, safeDy) <= world.floor1.objective.markerRadiusPx) {
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

  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.safeRoomDiscovered`, objective.safeRoomDiscovered);
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.combatComplete`, objective.questCompleted);
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.lootComplete`, meetsLoot);

  // Slime Rat (weaker) battle starts in its dedicated boss room.
  if (
    world.questLog.has(FLOOR1_BOSS_BATTLE_QUEST_ID) &&
    isFullyInsideObjectiveRoom(world, playerX, playerY, objective.slimeRatRoomPos) &&
    !objective.slimeRatBattleStarted
  ) {
    beginFloor1SlimeRatBattle(world);
  }

  const slimeRatEid = objective.slimeRatBossEid;
  const slimeRatAlive = slimeRatEid !== null && entityExists(world.ecs, slimeRatEid);
  if (objective.slimeRatBattleStarted && !slimeRatAlive && !objective.slimeRatBossDefeated) {
    objective.slimeRatBossDefeated = true;
    objective.slimeRatBossEid = null;
    setGoalFlag(world, 'floor1-boss-battle-active', false);
    const slimeRatRoom = roomAtPosition(world, objective.slimeRatRoomPos);
    if (slimeRatRoom) {
      for (const door of slimeRatRoom.doors) {
        world.floorMap?.tileMap.openDoor(door.x, door.y);
      }
    }
    for (const doorEid of world.floor1.slimeRatDoorEids) {
      world.stores.doorState.isLocked[doorEid] = 0;
      world.stores.doorState.isOpen[doorEid] = 1;
    }
    setQuestCounter(world, FLOOR1_BOSS_BATTLE_QUEST_ID, 'kill-slime-rat', 1);
    questSystem(world);
  }

  // Staircase Rat Slime (stronger) starts only after the Slime Rat is defeated.
  if (
    objective.slimeRatBossDefeated &&
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
  objective.slimeRatBattleStarted = true;
  objective.slimeRatBossDefeated = true;
  objective.slimeRatBossEid = null;
  setQuestCounter(world, FLOOR1_BOSS_BATTLE_QUEST_ID, 'kill-slime-rat', 1);
  setGoalFlag(world, 'floor1-boss-spellbook-claimed', true);
  setGoalFlag(world, 'floor1-boss-battle-complete', true);
  questSystem(world);
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

export function confirmFloor1StairDescend(world: GameWorld, _playerEid: number): boolean {
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
  objective.staircaseDiscovered = true;
  setGoalFlag(world, `${FLOOR_1_GOAL_PREFIX}.staircaseDiscovered`, true);
  world.state = 'safe_room';
  finalizeRunSummary(world, 'cleared_floor');
  return true;
}

// ---------------------------------------------------------------------------
// Shopkeeper errand flow
// ---------------------------------------------------------------------------

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
  }
  if (world.floor1?.objective.slimeRatBossDefeated === true) {
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
