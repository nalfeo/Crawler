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
import { attachBarriersToFloorMap } from '../core/barriers/index.js';
import {
  restoreRoomInterior,
  sealRoomPerimeter,
  sealSpecialRooms,
} from '../core/map/special-rooms.js';
import {
  stampSetPiece,
  type StampedSetPiece,
  type StampedSetPieceNpc,
} from '../core/map/stampSetPiece.js';
import { applySolidProps } from '../core/map/applySolidProps.js';
import { carveConnectorToReachable, carveSetPieceRoom } from '../core/map/carveSetPieceRoom.js';
import {
  getSetPieceDef,
  getSetPieceFootprint,
  isStructuralSetPieceProp,
} from '../shared/set-piece-types.js';
import {
  Position,
  Rotation,
  Player,
  Health,
  Harvestable,
  BroadcastScore,
  Size,
  Sprite,
  DoorState,
  Enemy,
  Spawner,
  Damage,
  DeathTimer,
  Npc,
} from '../core/components.js';
import type { GameWorld } from '../core/world.js';
import { SHAPE_BOX, SHAPE_CIRCLE } from '../core/physics-defs.js';
import {
  getFloor1StarterWeaponPool,
  isFloor1ExperimentalStarterOptionsEnabled,
} from '../shared/floor1-starter-weapons.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { FLOOR1_BASE_LOADOUT_CHOICE_IDS } from './scenarios/floorLoadoutScenario.js';
import { equipStarterOrFallback } from './scenarios/starterWeaponEquip.js';
import {
  clearEntityStores,
  spawnBehaviorEnemy,
  spawnNpc,
  type SpawnNpcOptions,
  addSetPieceProp,
  createEntity,
  spawnDroppedItem,
  spawnHarvestableNode,
  spawnSpawner,
  setEnemyAppearanceKey,
  setBloodColor,
  DEFAULT_BLOOD_COLOR,
} from '../core/helpers.js';
import { setGoalFlag, setDoorLockConfig } from '../core/door-lock.js';
import { AI_TYPE } from './enemyAISystem.js';
import { activateHostileEncounter } from './hostile-encounter-lifecycle.js';
import { roomHopDistances } from './room-hops.js';
import { getItemById, getItemIndex } from '../shared/items.js';
import { GAME, PLAYER_SPEED } from '../shared/constants.js';
import { pxToFt } from '../shared/units.js';
import { addItem, hasItem, listStaticInventorySlots, removeItem } from '../shared/inventory.js';
import { FLOOR2_HARVESTABLE_START_INDEX, HARVESTABLE_DEFS } from '../shared/harvestableDefs.js';
import { equip, initializeBaseStats } from '../core/systems/equipmentSystem.js';
import {
  MERCHANTS_CHARM_COST,
  getEquipmentDefForItem,
  isEquippableItem,
  STARTER_WEAPON_ID_TO_ITEM_ID,
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
  FLOOR1_BOSS_REWARD_SPELL_OFFER_COUNT,
  FLOOR1_BOSS_REWARD_SPELL_IDS,
  DEFAULT_FLOOR1_BOSS_REWARD_SPELL_ID,
  type Floor1BossRewardSpellId,
} from '../shared/abilities.js';
import { getAbilityDefinition } from './abilities/registry.js';
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
import { floor1EnemyPack, getFloorEnemyPack, type EnemyPackDef } from '../shared/enemy-packs.js';
import { getWorldFloorManifest } from '../core/floor-behavior.js';
import { floor1Manifest } from '../shared/floor-manifest.js';
import type { NpcPlacementDef } from '../shared/npc-placements.js';
import { placePropsForFloor } from './systems/propPlacer.js';
import { getSpawnerArchetype, getSpawnerArchetypeIndex } from './spawners/registry.js';
import { hashStringToSeed, SeededRandom } from '../shared/random.js';
import { computeMobLevelScale } from '../shared/mob-scaling.js';
import { pickFromSpawnZones, type SpawnZoneWeights } from './spawn-zones.js';
import { selectBossSpawnPlacement } from './boss-spawn-placement.js';
import { ensureBossArenaInterior } from '../core/map/generators/dungeon/reachability.js';

// Derived constants computed from config at module initialization.
// The camera/viewport is a render-pixel concept, so convert it to feet at this
// boundary (ADR 0023) before comparing against feet-space world positions.
const FLOOR_1_CAMERA_ZOOM = floor1Config.camera.zoom;
const FLOOR_1_VIEWPORT_WIDTH_FT = pxToFt(GAME.WIDTH / FLOOR_1_CAMERA_ZOOM);
const FLOOR_1_AMBIENT_SPAWN_MAX_DISTANCE_FT = FLOOR_1_VIEWPORT_WIDTH_FT * 2;
const FLOOR_1_SPAWN_RADIUS_MAX = FLOOR_1_AMBIENT_SPAWN_MAX_DISTANCE_FT;
const UNBOUNDED_SPAWN_DISTANCE_SQ = Number.POSITIVE_INFINITY;
/** Tiles with ≤ 2 cardinal passable neighbors are treated as narrow chokepoints. */
const MAX_PASSABLE_NEIGHBORS_FOR_NARROW_SPAWN_TILE = 2;
/**
 * Minimum distance (ft) a pre-populated room-wave enemy must keep from the
 * player, so a wave reads as already occupying the room rather than spawning on
 * top of the player at the doorway.
 */
const FLOOR_1_ROOM_WAVE_MIN_PLAYER_DISTANCE_FT = 12;
const FLOOR_1_GOAL_PREFIX = 'floor1.objective';
// Floor 1 is intentionally spawner-free: its static-spawner spawn table is empty,
// so `spawnFloor1StaticSpawners` places no Spawner entities on Floor 1. The
// placement machinery below is fully config-driven off this table — repopulate
// this list (e.g. ['slime-pool', 'rats-nest']) to re-enable Floor 1 static
// spawners without touching the runtime pipelines.
const FLOOR_1_STATIC_SPAWNERS_PER_ARCHETYPE = 2;
const FLOOR_1_STATIC_SPAWNER_ARCHETYPE_IDS: readonly string[] = [];
const FLOOR_1_MAX_STARTER_CHOICES = 3;
const FLOOR_1_FALLBACK_STARTER_WEAPON_IDS = ['sword', 'punch'] as const;

// Native footprint of the welcome-sign sprite (board + baked "WELCOME" + arrow),
// mirrored from the procedural texture in PhaserBridge (48x26 px) so the Sprite
// component carries matching dimensions in feet (px / PIXELS_PER_FOOT).
const WELCOME_SIGN_WIDTH = 6;
const WELCOME_SIGN_HEIGHT = 3.25;
export const WELCOME_ROOM_SET_PIECE_ID = 'welcome-room';

/** Blood colours for Floor 1 enemy archetypes. */
const BLOOD_COLOR_RAT = DEFAULT_BLOOD_COLOR; // red — 0xcc0000
const BLOOD_COLOR_SLIME = 0x22aa44; // green ichor

interface Floor1SpawnerState {
  lastSpawnMs: number;
}

function getAmbientEnemyArchetypes(world: GameWorld): Map<number, string> | undefined {
  if (world.floorScenario) {
    return world.floorScenario.enemyArchetypes;
  }
  return world.floorExtendedState?.ambientEnemyArchetypes;
}

export function pruneAmbientOverflow(
  world: GameWorld,
  playerX: number,
  playerY: number,
  overflowCount: number,
): void {
  const trackedAmbient = getAmbientEnemyArchetypes(world);
  if (!trackedAmbient || overflowCount <= 0) {
    return;
  }
  const rankedAmbient = [...trackedAmbient.keys()]
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
    trackedAmbient.delete(victim);
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

/**
 * Ambient enemy pack for the world's current floor, resolved from the floor
 * manifest (`enemyPackId`) rather than a hardcoded floor number.
 */
function getWorldAmbientEnemyPack(world: GameWorld): EnemyPackDef {
  const manifest = getWorldFloorManifest(world);
  if (!manifest) {
    return floor1EnemyPack;
  }
  const pack = getFloorEnemyPack(manifest.enemyPackId);
  if (!pack) {
    throw new Error(`Unknown enemy pack "${manifest.enemyPackId}" in floor manifest.`);
  }
  return pack;
}

export function pruneAmbientOutOfRange(world: GameWorld, playerX: number, playerY: number): void {
  const trackedAmbient = getAmbientEnemyArchetypes(world);
  if (!trackedAmbient) {
    return;
  }
  const pack = getWorldAmbientEnemyPack(world);
  const maxDistanceSq = pack.despawnDistanceFt * pack.despawnDistanceFt;
  for (const eid of [...trackedAmbient.keys()]) {
    if (!entityExists(world.ecs, eid)) {
      trackedAmbient.delete(eid);
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
    trackedAmbient.delete(eid);
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

export function getSpawnerState(world: GameWorld): Floor1SpawnerState {
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

function pickStarterChoices(world: GameWorld, starterWeaponPool: readonly string[]): string[] {
  const seenWeaponIds = new Set<string>();
  const pool: string[] = [];
  for (const weaponId of starterWeaponPool) {
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

function pickOfferedRewardSpellIds(world: GameWorld): Floor1BossRewardSpellId[] {
  const offerRng = new SeededRandom(hashStringToSeed(`${world.seed}:floor1-spell-reward-offer`));
  const pool = [...FLOOR1_BOSS_REWARD_SPELL_IDS];
  const selected: Floor1BossRewardSpellId[] = [];
  while (pool.length > 0 && selected.length < FLOOR1_BOSS_REWARD_SPELL_OFFER_COUNT) {
    const idx = offerRng.nextInt(0, pool.length - 1);
    const id = pool.splice(idx, 1)[0];
    if (id !== undefined) {
      selected.push(id);
    }
  }
  return selected;
}

export function getOfferedBossRewardSpellIds(world: GameWorld): readonly Floor1BossRewardSpellId[] {
  if (!world.floorScenario) {
    return FLOOR1_BOSS_REWARD_SPELL_IDS.slice(0, FLOOR1_BOSS_REWARD_SPELL_OFFER_COUNT);
  }
  if (
    !world.floorScenario.offeredRewardSpellIds ||
    world.floorScenario.offeredRewardSpellIds.length === 0
  ) {
    world.floorScenario.offeredRewardSpellIds = pickOfferedRewardSpellIds(world);
  }
  return world.floorScenario.offeredRewardSpellIds;
}

export function getBossRewardSpellOptions(world: GameWorld): Array<{
  id: Floor1BossRewardSpellId;
  label: string;
  description: string;
}> {
  return [...getOfferedBossRewardSpellIds(world)].map((spellId) => {
    const def = getAbilityDefinition(spellId);
    return {
      id: spellId,
      label: def?.name ?? spellId,
      description: def?.description ?? 'Learn a new spell.',
    };
  });
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

function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

function isTileWithinRoomBounds(room: RoomData, tx: number, ty: number): boolean {
  return (
    tx >= room.bounds.x &&
    tx < room.bounds.x + room.bounds.width &&
    ty >= room.bounds.y &&
    ty < room.bounds.y + room.bounds.height
  );
}

/**
 * Minimum Chebyshev tile distance between two NPCs placed in the same room. A
 * value of 3 leaves at least two empty tiles between any pair, so shared-room
 * hubs (e.g. the Floor 1 welcome bar) read as a scattered crowd instead of a
 * huddle. Relaxed automatically when a room is too small to honour it.
 */
const MIN_NPC_SPACING_TILES = 3;
const FLOOR1_CRITICAL_PROGRESS_NPC_IDS = new Set([
  'tutorial-goon',
  'shopkeeper',
  'spell-quest-giver',
]);

/** Chebyshev distance from (tx,ty) to the nearest already-occupied tile. */
function minChebyshevDistanceToOccupied(
  tx: number,
  ty: number,
  occupiedTiles: ReadonlySet<string>,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (const key of occupiedTiles) {
    const comma = key.indexOf(',');
    const ox = Number(key.slice(0, comma));
    const oy = Number(key.slice(comma + 1));
    const dist = Math.max(Math.abs(tx - ox), Math.abs(ty - oy));
    if (dist < best) {
      best = dist;
    }
  }
  return best;
}

/**
 * Pick a tile from `freeTiles` at random (seeded), preferring tiles that sit at
 * least `MIN_NPC_SPACING_TILES` from every occupied tile so co-located NPCs
 * scatter around their room. The spacing threshold relaxes one tile at a time
 * so a cramped room still yields a non-stacked tile instead of failing.
 * `freeTiles` must be non-empty and already exclude occupied tiles.
 */
function pickSpacedTile(
  freeTiles: readonly TilePoint[],
  occupiedTiles: ReadonlySet<string>,
  rng: SeededRandom,
): TilePoint {
  for (let spacing = MIN_NPC_SPACING_TILES; spacing >= 2; spacing -= 1) {
    const candidates = freeTiles.filter(
      (tile) => minChebyshevDistanceToOccupied(tile.x, tile.y, occupiedTiles) >= spacing,
    );
    if (candidates.length > 0) {
      return rng.pick(candidates);
    }
  }
  // No tile honours even a one-gap spacing (tiny or crowded room): fall back to
  // a random free tile so NPCs still never stack, even if they end up adjacent.
  return rng.pick(freeTiles);
}

function resolveFreeNpcTileInRoom(
  floorMap: FloorMap,
  room: RoomData,
  occupiedTiles: ReadonlySet<string>,
  rng: SeededRandom,
  isAllowed: ((tx: number, ty: number) => boolean) | null = null,
): TilePoint | null {
  const isFree = (tx: number, ty: number): boolean =>
    floorMap.tileMap.isPassable(tx, ty) &&
    !occupiedTiles.has(tileKey(tx, ty)) &&
    (isAllowed === null || isAllowed(tx, ty));

  if (room.interiorCells && room.interiorCells.length > 0) {
    const freeCells = room.interiorCells.filter((cell) => isFree(cell.x, cell.y));
    if (freeCells.length > 0) {
      return pickSpacedTile(freeCells, occupiedTiles, rng);
    }
    // Every interior cell is blocked or already claimed. Fall through to the
    // bounds scan below rather than returning null here: giving up early forces
    // the caller onto its preferred-tile fallback, which could hand back an
    // already-occupied tile and reintroduce NPC stacking in small/degenerate
    // rooms. The bounds scan may still find a passable, unclaimed tile the
    // interiorCells list didn't enumerate.
  }

  const { x: bx, y: by, width: bw, height: bh } = room.bounds;
  const minX = bx + 1;
  const minY = by + 1;
  const maxX = bx + bw - 2;
  const maxY = by + bh - 2;
  const freeBoundsTiles: TilePoint[] = [];
  for (let ty = minY; ty <= maxY; ty += 1) {
    for (let tx = minX; tx <= maxX; tx += 1) {
      if (isFree(tx, ty)) {
        freeBoundsTiles.push({ x: tx, y: ty });
      }
    }
  }
  if (freeBoundsTiles.length > 0) {
    return pickSpacedTile(freeBoundsTiles, occupiedTiles, rng);
  }

  return null;
}

function isCriticalProgressNpcType(npcTypeId: string): boolean {
  return FLOOR1_CRITICAL_PROGRESS_NPC_IDS.has(npcTypeId);
}

/**
 * Breadth-first tile travel distance from `start`, walking passable tiles plus
 * doors that are not in `blockedDoorTiles`. Returns tile counts per index, with
 * `-1` for tiles that cannot be reached at all. Unlike straight-line distance
 * this is the route the player actually walks, so it is what placement rules
 * should be scored against.
 */
function buildTravelDistanceField(
  floorMap: FloorMap,
  start: { x: number; y: number },
  blockedDoorTiles: ReadonlySet<string>,
): Int32Array {
  const width = floorMap.width;
  const height = floorMap.height;
  const distances = new Int32Array(width * height).fill(-1);
  if (!floorMap.tileMap.inBounds(start.x, start.y)) {
    return distances;
  }
  const startIndex = start.y * width + start.x;
  distances[startIndex] = 0;
  const queue = [startIndex];
  let head = 0;
  while (head < queue.length) {
    const index = queue[head++]!;
    const tx = index % width;
    const ty = (index - tx) / width;
    const nextDistance = distances[index]! + 1;
    for (const [nx, ny] of [
      [tx + 1, ty],
      [tx - 1, ty],
      [tx, ty + 1],
      [tx, ty - 1],
    ] as const) {
      if (!floorMap.tileMap.inBounds(nx, ny)) {
        continue;
      }
      const neighborIndex = ny * width + nx;
      if (distances[neighborIndex] !== -1) {
        continue;
      }
      const doorTile = floorMap.tileMap.isDoor(nx, ny);
      if (
        !floorMap.tileMap.isPassable(nx, ny) &&
        (!doorTile || blockedDoorTiles.has(tileKey(nx, ny)))
      ) {
        continue;
      }
      distances[neighborIndex] = nextDistance;
      queue.push(neighborIndex);
    }
  }
  return distances;
}

function buildReachableFromSpawnMask(
  floorMap: FloorMap,
  blockedDoorTiles: ReadonlySet<string>,
): Uint8Array {
  const distances = buildTravelDistanceField(floorMap, floorMap.playerSpawn, blockedDoorTiles);
  const mask = new Uint8Array(distances.length);
  for (let index = 0; index < distances.length; index += 1) {
    mask[index] = distances[index]! >= 0 ? 1 : 0;
  }
  return mask;
}

export function buildInitiallyLockedDoorTileSet(
  floorMap: FloorMap,
  lockedRoomCenters: ReadonlyArray<{ x: number; y: number }>,
): Set<string> {
  const blocked = new Set<string>();
  const seenRooms = new Set<number>();
  for (const center of lockedRoomCenters) {
    const centerTile = floorMap.worldToTile(center.x, center.y);
    const roomId = floorMap.roomGraph.getRoomAt(centerTile.x, centerTile.y);
    if (roomId < 0 || seenRooms.has(roomId)) {
      continue;
    }
    seenRooms.add(roomId);
    const room = floorMap.roomGraph.get(roomId);
    for (const door of room?.doors ?? []) {
      blocked.add(tileKey(door.x, door.y));
    }
  }
  return blocked;
}

interface ObjectiveRoomCandidate {
  readonly room: RoomData;
  readonly center: { x: number; y: number };
  readonly distanceSq: number;
}

function distanceFromFieldAtWorldPos(
  floorMap: FloorMap,
  field: Int32Array,
  pos: { x: number; y: number },
): number {
  const tile = floorMap.worldToTile(pos.x, pos.y);
  if (!floorMap.tileMap.inBounds(tile.x, tile.y)) {
    return -1;
  }
  return field[tile.y * floorMap.width + tile.x]!;
}

function buildObjectiveRoomCandidates(
  floorMap: FloorMap,
  roomIds: readonly number[],
): ObjectiveRoomCandidate[] {
  const spawnTile = floorMap.playerSpawn;
  return roomIds
    .map((roomId) => floorMap.roomGraph.get(roomId))
    .filter((room): room is RoomData => room != null)
    .map((room) => {
      const center = centerOfRoom(room);
      const dx = center.x - spawnTile.x;
      const dy = center.y - spawnTile.y;
      return { room, center, distanceSq: dx * dx + dy * dy };
    })
    .sort((a, b) => a.distanceSq - b.distanceSq);
}

function selectMerchantAnchoredQuestItemEntry(
  floorMap: FloorMap,
  candidates: readonly ObjectiveRoomCandidate[],
  preferredEntries: readonly ObjectiveRoomCandidate[],
  merchantPos: { x: number; y: number },
  lockedRoomCenters: ReadonlyArray<{ x: number; y: number }>,
  excludedRoomIds: ReadonlySet<number>,
): ObjectiveRoomCandidate | undefined {
  const blockedDoorTiles = buildInitiallyLockedDoorTileSet(floorMap, lockedRoomCenters);
  const merchantTile = floorMap.worldToTile(merchantPos.x, merchantPos.y);
  const travelFromMerchant = buildTravelDistanceField(floorMap, merchantTile, blockedDoorTiles);
  const travelFromSpawn = buildTravelDistanceField(
    floorMap,
    floorMap.playerSpawn,
    blockedDoorTiles,
  );
  const maxDistanceFromMerchant = floorMap.rooms.reduce((max, room) => {
    const pos = resolvePassableRoomCenter(floorMap, room);
    return Math.max(max, distanceFromFieldAtWorldPos(floorMap, travelFromMerchant, pos));
  }, 0);
  const targetDistance = maxDistanceFromMerchant * (2 / 3);
  const rankEntries = (entries: readonly ObjectiveRoomCandidate[]) =>
    entries
      .map((entry) => {
        const pos = resolvePassableRoomCenter(floorMap, entry.room);
        return {
          entry,
          distanceFromMerchant: distanceFromFieldAtWorldPos(floorMap, travelFromMerchant, pos),
          distanceFromSpawn: distanceFromFieldAtWorldPos(floorMap, travelFromSpawn, pos),
        };
      })
      .filter((scored) => scored.distanceFromMerchant > 0 && scored.distanceFromSpawn >= 0)
      .sort((a, b) => {
        const aDelta = Math.abs(a.distanceFromMerchant - targetDistance);
        const bDelta = Math.abs(b.distanceFromMerchant - targetDistance);
        if (aDelta !== bDelta) return aDelta - bDelta;
        return a.entry.room.id - b.entry.room.id;
      });
  const rankedPreferred = rankEntries(preferredEntries);
  if (rankedPreferred.length > 0) {
    return rankedPreferred[0]!.entry;
  }
  const rankedRelaxed = rankEntries(
    candidates.filter((entry) => !excludedRoomIds.has(entry.room.id)),
  );
  return rankedRelaxed[0]?.entry;
}

function isMerchantAnchoredQuestItemEntryReachable(
  floorMap: FloorMap,
  entry: ObjectiveRoomCandidate,
  merchantPos: { x: number; y: number },
  lockedRoomCenters: ReadonlyArray<{ x: number; y: number }>,
): boolean {
  const blockedDoorTiles = buildInitiallyLockedDoorTileSet(floorMap, lockedRoomCenters);
  const merchantTile = floorMap.worldToTile(merchantPos.x, merchantPos.y);
  const travelFromMerchant = buildTravelDistanceField(floorMap, merchantTile, blockedDoorTiles);
  const travelFromSpawn = buildTravelDistanceField(
    floorMap,
    floorMap.playerSpawn,
    blockedDoorTiles,
  );
  const pos = resolvePassableRoomCenter(floorMap, entry.room);
  const tile = floorMap.worldToTile(pos.x, pos.y);
  return (
    floorMap.tileMap.isPassable(tile.x, tile.y) &&
    distanceFromFieldAtWorldPos(floorMap, travelFromMerchant, pos) > 0 &&
    distanceFromFieldAtWorldPos(floorMap, travelFromSpawn, pos) >= 0
  );
}

function merchantAnchoredQuestItemFraction(
  floorMap: FloorMap,
  entry: ObjectiveRoomCandidate,
  merchantPos: { x: number; y: number },
  lockedRoomCenters: ReadonlyArray<{ x: number; y: number }>,
): number | null {
  const blockedDoorTiles = buildInitiallyLockedDoorTileSet(floorMap, lockedRoomCenters);
  const merchantTile = floorMap.worldToTile(merchantPos.x, merchantPos.y);
  const travelFromMerchant = buildTravelDistanceField(floorMap, merchantTile, blockedDoorTiles);
  const pos = resolvePassableRoomCenter(floorMap, entry.room);
  const distance = distanceFromFieldAtWorldPos(floorMap, travelFromMerchant, pos);
  if (distance <= 0) {
    return null;
  }
  const maxDistance = floorMap.rooms.reduce((max, room) => {
    const roomPos = resolvePassableRoomCenter(floorMap, room);
    return Math.max(max, distanceFromFieldAtWorldPos(floorMap, travelFromMerchant, roomPos));
  }, 0);
  return maxDistance > 0 ? distance / maxDistance : null;
}

function selectMerchantAnchoredQuestItemAndSlime(
  floorMap: FloorMap,
  candidates: readonly ObjectiveRoomCandidate[],
  itemCandidates: readonly ObjectiveRoomCandidate[],
  welcomeOfficePos: { x: number; y: number },
  shopRoomPos: { x: number; y: number },
  staircasePos: { x: number; y: number },
  merchantPos: { x: number; y: number },
  shopRoomId: number | null,
):
  | { itemEntry: ObjectiveRoomCandidate; slimeEntry: ObjectiveRoomCandidate | undefined }
  | undefined {
  const staircaseDoorTiles = buildInitiallyLockedDoorTileSet(floorMap, [staircasePos]);
  const merchantTile = floorMap.worldToTile(merchantPos.x, merchantPos.y);
  const travelToSlimeFromMerchant = buildTravelDistanceField(
    floorMap,
    merchantTile,
    staircaseDoorTiles,
  );
  const rankEntries = (entries: readonly ObjectiveRoomCandidate[]) =>
    entries
      .map((itemEntry) => {
        const questItemPos = resolvePassableRoomCenter(floorMap, itemEntry.room);
        const specialPointsForSlime = [welcomeOfficePos, staircasePos, shopRoomPos, questItemPos];
        const slimeEntry = candidates
          .filter((entry) => entry.room.id !== shopRoomId && entry.room.id !== itemEntry.room.id)
          .filter((entry) => {
            const slimePos = resolvePassableRoomCenter(floorMap, entry.room);
            return distanceFromFieldAtWorldPos(floorMap, travelToSlimeFromMerchant, slimePos) >= 0;
          })
          .sort((a, b) => {
            const aPos = resolvePassableRoomCenter(floorMap, a.room);
            const bPos = resolvePassableRoomCenter(floorMap, b.room);
            const aScore = Math.min(
              ...specialPointsForSlime.map((p) => {
                const dx = aPos.x - p.x;
                const dy = aPos.y - p.y;
                return dx * dx + dy * dy;
              }),
            );
            const bScore = Math.min(
              ...specialPointsForSlime.map((p) => {
                const dx = bPos.x - p.x;
                const dy = bPos.y - p.y;
                return dx * dx + dy * dy;
              }),
            );
            return bScore - aScore;
          })[0];
        const slimePos = slimeEntry
          ? resolvePassableRoomCenter(floorMap, slimeEntry.room)
          : questItemPos;
        const blockedDoorTiles = buildInitiallyLockedDoorTileSet(floorMap, [
          staircasePos,
          slimePos,
        ]);
        const travelFromMerchant = buildTravelDistanceField(
          floorMap,
          merchantTile,
          blockedDoorTiles,
        );
        const travelFromSpawn = buildTravelDistanceField(
          floorMap,
          floorMap.playerSpawn,
          blockedDoorTiles,
        );
        const distanceFromMerchant = distanceFromFieldAtWorldPos(
          floorMap,
          travelFromMerchant,
          questItemPos,
        );
        const distanceFromSpawn = distanceFromFieldAtWorldPos(
          floorMap,
          travelFromSpawn,
          questItemPos,
        );
        if (distanceFromMerchant <= 0 || distanceFromSpawn < 0) {
          return null;
        }
        const maxDistanceFromMerchant = floorMap.rooms.reduce((max, room) => {
          const pos = resolvePassableRoomCenter(floorMap, room);
          return Math.max(max, distanceFromFieldAtWorldPos(floorMap, travelFromMerchant, pos));
        }, 0);
        return {
          itemEntry,
          slimeEntry,
          delta: Math.abs(distanceFromMerchant - maxDistanceFromMerchant * (2 / 3)),
        };
      })
      .filter((scored): scored is NonNullable<typeof scored> => scored != null)
      .sort((a, b) => {
        if (a.delta !== b.delta) return a.delta - b.delta;
        return a.itemEntry.room.id - b.itemEntry.room.id;
      });
  const preferred = rankEntries(itemCandidates);
  if (preferred.length > 0) {
    return preferred[0];
  }
  const relaxed = rankEntries(candidates.filter((entry) => entry.room.id !== shopRoomId));
  return relaxed[0];
}

function isSpawnReachableTile(
  floorMap: FloorMap,
  reachableMask: Uint8Array,
  tx: number,
  ty: number,
): boolean {
  if (!floorMap.tileMap.inBounds(tx, ty)) {
    return false;
  }
  return reachableMask[ty * floorMap.width + tx] === 1;
}

function resolveNpcSpawnPosition(
  world: GameWorld,
  preferredPos: { x: number; y: number },
  occupiedTiles: Set<string>,
  rng: SeededRandom,
): { x: number; y: number } {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return preferredPos;
  }
  const preferredTile = floorMap.worldToTile(preferredPos.x, preferredPos.y);
  const roomId = floorMap.roomGraph.getRoomAt(preferredTile.x, preferredTile.y);
  const room = roomId >= 0 ? floorMap.roomGraph.get(roomId) : undefined;
  if (room) {
    const freeTile = resolveFreeNpcTileInRoom(floorMap, room, occupiedTiles, rng);
    if (freeTile) {
      occupiedTiles.add(tileKey(freeTile.x, freeTile.y));
      return floorMap.tileToWorld(freeTile.x, freeTile.y);
    }
  }

  if (
    floorMap.tileMap.isPassable(preferredTile.x, preferredTile.y) &&
    !occupiedTiles.has(tileKey(preferredTile.x, preferredTile.y))
  ) {
    occupiedTiles.add(tileKey(preferredTile.x, preferredTile.y));
    return floorMap.tileToWorld(preferredTile.x, preferredTile.y);
  }

  return preferredPos;
}

function resolveRoutableNpcSpawnPosition(
  world: GameWorld,
  preferredPos: { x: number; y: number },
  occupiedTiles: Set<string>,
  rng: SeededRandom,
  reachableMask: Uint8Array,
): { x: number; y: number } {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return preferredPos;
  }
  const preferredTile = floorMap.worldToTile(preferredPos.x, preferredPos.y);
  if (
    floorMap.tileMap.isPassable(preferredTile.x, preferredTile.y) &&
    isSpawnReachableTile(floorMap, reachableMask, preferredTile.x, preferredTile.y) &&
    !occupiedTiles.has(tileKey(preferredTile.x, preferredTile.y))
  ) {
    // Preserve an authored/stamped NPC tile when it is already valid; only
    // scatter within the room if that tile fails passable/routable/occupancy checks.
    occupiedTiles.add(tileKey(preferredTile.x, preferredTile.y));
    return floorMap.tileToWorld(preferredTile.x, preferredTile.y);
  }
  const roomId = floorMap.roomGraph.getRoomAt(preferredTile.x, preferredTile.y);
  const room = roomId >= 0 ? floorMap.roomGraph.get(roomId) : undefined;
  if (room) {
    const freeTile = resolveFreeNpcTileInRoom(floorMap, room, occupiedTiles, rng, (tx, ty) =>
      isSpawnReachableTile(floorMap, reachableMask, tx, ty),
    );
    if (freeTile) {
      occupiedTiles.add(tileKey(freeTile.x, freeTile.y));
      return floorMap.tileToWorld(freeTile.x, freeTile.y);
    }
  }
  if (
    floorMap.tileMap.isPassable(preferredTile.x, preferredTile.y) &&
    !occupiedTiles.has(tileKey(preferredTile.x, preferredTile.y)) &&
    isSpawnReachableTile(floorMap, reachableMask, preferredTile.x, preferredTile.y)
  ) {
    occupiedTiles.add(tileKey(preferredTile.x, preferredTile.y));
    return floorMap.tileToWorld(preferredTile.x, preferredTile.y);
  }

  let bestTile: TilePoint | null = null;
  let bestDistanceSq = Number.POSITIVE_INFINITY;
  let bestSpacing = -1;
  for (let ty = 0; ty < floorMap.height; ty += 1) {
    for (let tx = 0; tx < floorMap.width; tx += 1) {
      if (
        floorMap.tileMap.isPassable(tx, ty) &&
        !occupiedTiles.has(tileKey(tx, ty)) &&
        isSpawnReachableTile(floorMap, reachableMask, tx, ty)
      ) {
        const dx = tx - preferredTile.x;
        const dy = ty - preferredTile.y;
        const distanceSq = dx * dx + dy * dy;
        const spacing = minChebyshevDistanceToOccupied(tx, ty, occupiedTiles);
        const isBetter =
          distanceSq < bestDistanceSq ||
          (distanceSq === bestDistanceSq &&
            (spacing > bestSpacing ||
              (spacing === bestSpacing &&
                (bestTile === null || ty < bestTile.y || (ty === bestTile.y && tx < bestTile.x)))));
        if (isBetter) {
          bestTile = { x: tx, y: ty };
          bestDistanceSq = distanceSq;
          bestSpacing = spacing;
        }
      }
    }
  }
  if (bestTile !== null) {
    occupiedTiles.add(tileKey(bestTile.x, bestTile.y));
    return floorMap.tileToWorld(bestTile.x, bestTile.y);
  }

  return resolveNpcSpawnPosition(world, preferredPos, occupiedTiles, rng);
}

/**
 * Spawn harvestable resource nodes (mushrooms, flowers, lichens) across the
 * normal and spawn rooms of floor 1. Each def in HARVESTABLE_DEFS spawns up to
 * `def.maxPerFloor` nodes, placed at randomly selected passable tiles in rooms
 * with role NORMAL or SPAWN (i.e. not safe room, boss room, or stair room).
 * Uses `world.rng` for all randomness.
 *
 * Only iterates Floor 1 defs (indices 0–FLOOR2_HARVESTABLE_START_INDEX-1).
 * Floor 2+ defs are intentionally excluded — each floor's scenario spawns only
 * its own range to avoid cross-floor node contamination.
 */
function spawnFloor1HarvestableNodes(world: GameWorld): void {
  const floorMap = world.floorMap;
  if (!floorMap) return;

  // Gather candidate tiles from all normal rooms.
  const normalRooms = floorMap.roomGraph
    .getAll()
    .filter((room) => room.role === RoomRole.NORMAL || room.role === RoomRole.SPAWN);

  if (normalRooms.length === 0) return;

  // Cap loop at FLOOR2_HARVESTABLE_START_INDEX so Floor 2 ore/gem defs are
  // never spawned on Floor 1.
  for (let defIndex = 0; defIndex < FLOOR2_HARVESTABLE_START_INDEX; defIndex++) {
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

  const spawnRoom = floorMap.spawnRoom;
  if (!spawnRoom) {
    return;
  }
  const hasSpawnRoomHarvestable = Array.from(query(world.ecs, [Harvestable, Position])).some(
    (eid) => {
      const tile = floorMap.worldToTile(
        world.stores.position.x[eid] ?? 0,
        world.stores.position.y[eid] ?? 0,
      );
      return isTileWithinRoomBounds(spawnRoom, tile.x, tile.y);
    },
  );
  if (hasSpawnRoomHarvestable) {
    return;
  }

  const blockedTiles = new Set<string>();
  for (const eid of query(world.ecs, [Position])) {
    const tile = floorMap.worldToTile(
      world.stores.position.x[eid] ?? 0,
      world.stores.position.y[eid] ?? 0,
    );
    if (isTileWithinRoomBounds(spawnRoom, tile.x, tile.y)) {
      blockedTiles.add(tileKey(tile.x, tile.y));
    }
  }

  const minX = spawnRoom.bounds.x + 1;
  const minY = spawnRoom.bounds.y + 1;
  const maxX = spawnRoom.bounds.x + spawnRoom.bounds.width - 2;
  const maxY = spawnRoom.bounds.y + spawnRoom.bounds.height - 2;
  const isLegalSpawnRoomTile = (tx: number, ty: number): boolean =>
    tx >= minX &&
    tx <= maxX &&
    ty >= minY &&
    ty <= maxY &&
    floorMap.tileMap.isPassable(tx, ty) &&
    !blockedTiles.has(tileKey(tx, ty));
  const spawnTile = floorMap.playerSpawn;
  const doorTiles = spawnRoom.doors ?? [];
  let guaranteeTile: TilePoint | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestSpawnDistanceSq = Number.NEGATIVE_INFINITY;
  for (let ty = minY; ty <= maxY; ty += 1) {
    for (let tx = minX; tx <= maxX; tx += 1) {
      if (!isLegalSpawnRoomTile(tx, ty)) {
        continue;
      }
      const spawnDistanceSq = (tx - spawnTile.x) ** 2 + (ty - spawnTile.y) ** 2;
      const nearestDoorDistanceSq =
        doorTiles.length === 0
          ? Number.POSITIVE_INFINITY
          : Math.min(...doorTiles.map((door) => (tx - door.x) ** 2 + (ty - door.y) ** 2));
      const score = Math.min(spawnDistanceSq, nearestDoorDistanceSq);
      if (
        score > bestScore ||
        (score === bestScore && spawnDistanceSq > bestSpawnDistanceSq) ||
        (score === bestScore &&
          spawnDistanceSq === bestSpawnDistanceSq &&
          (guaranteeTile === null ||
            ty < guaranteeTile.y ||
            (ty === guaranteeTile.y && tx < guaranteeTile.x)))
      ) {
        guaranteeTile = { x: tx, y: ty };
        bestScore = score;
        bestSpawnDistanceSq = spawnDistanceSq;
      }
    }
  }
  if (!guaranteeTile) {
    return;
  }

  const guaranteePos = floorMap.tileToWorld(guaranteeTile.x, guaranteeTile.y);
  let relocatedEid: number | null = null;
  let farthestDistanceSq = Number.NEGATIVE_INFINITY;
  for (const eid of query(world.ecs, [Harvestable, Position])) {
    const tile = floorMap.worldToTile(
      world.stores.position.x[eid] ?? 0,
      world.stores.position.y[eid] ?? 0,
    );
    if (isTileWithinRoomBounds(spawnRoom, tile.x, tile.y)) {
      continue;
    }
    const distanceSq = (tile.x - spawnTile.x) ** 2 + (tile.y - spawnTile.y) ** 2;
    if (distanceSq > farthestDistanceSq) {
      farthestDistanceSq = distanceSq;
      relocatedEid = eid;
    }
  }
  if (relocatedEid === null) {
    return;
  }

  world.stores.position.x[relocatedEid] = guaranteePos.x;
  world.stores.position.y[relocatedEid] = guaranteePos.y;
}

function chooseObjectiveTiles(world: GameWorld): {
  welcomeOfficePos: { x: number; y: number };
  safeRoomPos: { x: number; y: number };
  staircasePos: { x: number; y: number };
  slimeRatRoomPos: { x: number; y: number };
  spellQuestGiverPos: { x: number; y: number };
  shopRoomPos: { x: number; y: number };
  questItemPos: { x: number; y: number };
  candidateRoomIds: number[];
  welcomeRoomId: number | null;
  shopRoomId: number | null;
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
      candidateRoomIds: [],
      welcomeRoomId: null,
      shopRoomId: null,
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
  // Hop distance from the spawn room to each reachable room (excluding the boss
  // stair path). Used to constrain welcome-room placement to 3–8 hops from spawn.
  const roomHopFromSpawn = roomHopDistances(
    floorMap.roomGraph,
    floorMap.spawnRoom?.id,
    bossStairRoomId,
  );
  for (const roomId of roomHopFromSpawn.keys()) {
    const room = floorMap.roomGraph.get(roomId);
    if (room) roomsReachableWithoutBossRoom.add(room);
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

  const welcomeRoomSetPiece = getSetPieceDef(WELCOME_ROOM_SET_PIECE_ID);
  const welcomeRoomFootprint = welcomeRoomSetPiece
    ? getSetPieceFootprint(welcomeRoomSetPiece)
    : null;
  const sizedWelcomeCandidates =
    welcomeRoomFootprint === null
      ? candidates
      : (() => {
          const fittingCandidates = candidates.filter(
            ({ room }) =>
              room.bounds.width >= welcomeRoomFootprint.width + 2 &&
              room.bounds.height >= welcomeRoomFootprint.height + 2,
          );
          return fittingCandidates.length > 0 ? fittingCandidates : candidates;
        })();

  // Welcome office: 3–8 room-graph hops from spawn, targeting ~5 hops.
  // Among rooms in the valid range, prefer the hop count closest to 5; break
  // ties with Euclidean distance (nearest wins, matching prior behaviour).
  // Falls back to the nearest Euclidean room when no room is in the hop range.
  const WELCOME_MIN_HOPS = 3;
  const WELCOME_MAX_HOPS = 8;
  const WELCOME_TARGET_HOPS = 5;
  const welcomeHopCandidates = sizedWelcomeCandidates.filter((e) => {
    const hops = roomHopFromSpawn.get(e.room.id);
    return hops !== undefined && hops >= WELCOME_MIN_HOPS && hops <= WELCOME_MAX_HOPS;
  });
  const welcomeEntry =
    welcomeHopCandidates.length > 0
      ? welcomeHopCandidates.reduce((best, entry) => {
          const bestHops = roomHopFromSpawn.get(best.room.id) ?? 0;
          const entryHops = roomHopFromSpawn.get(entry.room.id) ?? 0;
          const bestDelta = Math.abs(bestHops - WELCOME_TARGET_HOPS);
          const entryDelta = Math.abs(entryHops - WELCOME_TARGET_HOPS);
          if (entryDelta < bestDelta) return entry;
          if (entryDelta > bestDelta) return best;
          return entry.distanceSq < best.distanceSq ? entry : best;
        })
      : sizedWelcomeCandidates[0];
  // BFS hop distances from the welcome room — used to enforce the shop
  // placement constraint that the shop must be ≥ 3 hops from welcome.
  const roomHopFromWelcome = welcomeEntry
    ? roomHopDistances(floorMap.roomGraph, welcomeEntry.room.id)
    : new Map<number, number>();

  // Shop placement rules (applied in priority order, relaxed progressively):
  //   1. At least 3 room-graph hops from the welcome room — requires genuine
  //      exploration rather than backtracking to a nearby neighbour.
  //   2. Further from the spawn room than the welcome room — so the player
  //      reaches welcome before stumbling on the shop.
  // Constraints are relaxed one at a time when no qualifying room exists.
  const SHOP_MIN_HOPS_FROM_WELCOME = 3;
  const welcomeDistSq = welcomeEntry?.distanceSq ?? 0;
  const meetsShopHopConstraint = (e: (typeof candidates)[0]) =>
    (roomHopFromWelcome.get(e.room.id) ?? 0) >= SHOP_MIN_HOPS_FROM_WELCOME;
  const meetsShopDistanceConstraint = (e: (typeof candidates)[0]) => e.distanceSq > welcomeDistSq;

  const shopEntry =
    candidates.find(
      (e) => e !== welcomeEntry && meetsShopHopConstraint(e) && meetsShopDistanceConstraint(e),
    ) ??
    candidates.find((e) => e !== welcomeEntry && meetsShopHopConstraint(e)) ??
    candidates.find((e) => e !== welcomeEntry && meetsShopDistanceConstraint(e)) ??
    candidates.find((e) => e !== welcomeEntry) ??
    candidates[0];
  // BFS hop distances from the shop and from the boss-stair room. Both the
  // rat-tail fetch item and the slime-rat room are placed relative to these so
  // the *required* quest tour stays bounded instead of stretching to the map's
  // extremes (see the hop bands below).
  const roomHopFromShop = shopEntry
    ? roomHopDistances(floorMap.roomGraph, shopEntry.room.id, bossStairRoomId)
    : new Map<number, number>();

  // Hop counts are the structural constraint ("far enough to be a real detour");
  // squared tile distance is what actually costs the player time, so it drives
  // the ordering *within* a hop band.
  const shopCenter = shopEntry?.center ?? centerOfRoom(floorMap.rooms[0]!);
  const distSqBetween = (a: { x: number; y: number }, b: { x: number; y: number }): number => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  };
  const distSqToShop = (entry: (typeof candidates)[0]): number =>
    distSqBetween(entry.center, shopCenter);

  /**
   * Pick the entry whose hop distance from `hops` lies inside [min, max] and is
   * closest to `target`, breaking ties with `tieBreak` (lower wins). Falls back
   * to the whole eligible set — scored the same way but without the band — so
   * degenerate maps (tiny room counts, disconnected graphs) still resolve.
   */
  const pickInHopBand = (
    eligible: readonly ObjectiveRoomCandidate[],
    hops: Map<number, number>,
    min: number,
    max: number,
    target: number,
    tieBreak: (entry: (typeof candidates)[0]) => number,
  ): (typeof candidates)[0] | undefined => {
    if (eligible.length === 0) return undefined;
    const banded = eligible.filter((e) => {
      const h = hops.get(e.room.id);
      return h !== undefined && h >= min && h <= max;
    });
    const pool = banded.length > 0 ? banded : eligible;
    return pool.reduce((best, entry) => {
      const bestDelta = Math.abs((hops.get(best.room.id) ?? Number.MAX_SAFE_INTEGER) - target);
      const entryDelta = Math.abs((hops.get(entry.room.id) ?? Number.MAX_SAFE_INTEGER) - target);
      if (entryDelta !== bestDelta) return entryDelta < bestDelta ? entry : best;
      const bestTie = tieBreak(best);
      const entryTie = tieBreak(entry);
      if (entryTie !== bestTie) return entryTie < bestTie ? entry : best;
      return entry.room.id < best.room.id ? entry : best;
    });
  };

  const welcomeOfficePos = welcomeEntry
    ? resolvePassableRoomCenter(floorMap, welcomeEntry.room)
    : fallbackWelcome;
  const shopRoomPos = shopEntry
    ? resolvePassableRoomCenter(floorMap, shopEntry.room)
    : fallbackShop;
  const merchantPos = isCriticalProgressNpcType('shopkeeper') ? welcomeOfficePos : shopRoomPos;

  // Rat-tail fetch item: the merchant's errand is a *round trip* (merchant →
  // item → merchant), so every tile between them is walked twice.
  //
  // Two earlier rules both misjudged that trip. Placing the item in the room
  // farthest from spawn doubled the single longest leg on the map. Bounding it
  // to a hop band around the *shop room* then anchored on the wrong place
  // entirely: the shopkeeper is a critical-progress NPC, so it actually spawns
  // in the welcome hub (see FLOOR1_CRITICAL_PROGRESS_NPC_IDS), not in the shop
  // room the hop band measured from. Errand length was consequently erratic —
  // 0.07–0.96 of the reachable maximum across seeds.
  //
  // Anchor on the room the merchant really stands in and target a fixed
  // *fraction* of the longest walk available from it: a real expedition, never
  // a map-diameter round trip, and consistent seed to seed.
  // Legacy hop band, retained only as the provisional pre-geometry fallback.
  const ITEM_MIN_HOPS_FROM_SHOP = 2;
  const ITEM_MAX_HOPS_FROM_SHOP = 4;
  const ITEM_TARGET_HOPS_FROM_SHOP = 3;
  const itemEntry =
    selectMerchantAnchoredQuestItemEntry(
      floorMap,
      candidates,
      candidates.filter((entry) => entry !== welcomeEntry && entry !== shopEntry),
      merchantPos,
      [staircasePos],
      new Set([welcomeEntry?.room.id, shopEntry?.room.id].filter((id): id is number => id != null)),
    ) ??
    pickInHopBand(
      candidates.filter((entry) => entry !== welcomeEntry && entry !== shopEntry),
      roomHopFromShop,
      ITEM_MIN_HOPS_FROM_SHOP,
      ITEM_MAX_HOPS_FROM_SHOP,
      ITEM_TARGET_HOPS_FROM_SHOP,
      (entry) => distSqToShop(entry),
    );
  const questItemPos = itemEntry
    ? resolvePassableRoomCenter(floorMap, itemEntry.room)
    : fallbackItem;
  const safeRoomPos = welcomeOfficePos;
  const specialPointsForSlime = [welcomeOfficePos, staircasePos, shopRoomPos, questItemPos];
  const slimeRatEntry = candidates
    .filter((entry) => entry !== shopEntry && entry !== itemEntry)
    .sort((a, b) => {
      const aPos = resolvePassableRoomCenter(floorMap, a.room);
      const bPos = resolvePassableRoomCenter(floorMap, b.room);
      const aScore = Math.min(
        ...specialPointsForSlime.map((p) => {
          const dx = aPos.x - p.x;
          const dy = aPos.y - p.y;
          return dx * dx + dy * dy;
        }),
      );
      const bScore = Math.min(
        ...specialPointsForSlime.map((p) => {
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
    candidateRoomIds: candidates.map((entry) => entry.room.id),
    welcomeRoomId: welcomeEntry?.room.id ?? null,
    shopRoomId: shopEntry?.room.id ?? null,
  };
}

/** Tag a room as safe, restoring its full rectangular interior before repainting it. */
function tagRoomAsSafe(world: GameWorld, roomPos: { x: number; y: number }): void {
  const floorMap = world.floorMap;
  if (!floorMap) return;
  for (const safeRoom of floorMap.roomGraph.getRoomsByRole(RoomRole.SAFE)) {
    floorMap.roomGraph.setRole(safeRoom.id, RoomRole.NORMAL);
  }
  const tile = floorMap.worldToTile(roomPos.x, roomPos.y);
  const roomId = floorMap.roomGraph.getRoomAt(tile.x, tile.y);
  if (roomId < 0) return;
  floorMap.roomGraph.setRole(roomId, RoomRole.SAFE);
  const room = floorMap.roomGraph.get(roomId);
  if (!room) return;
  restoreRoomInterior(floorMap.tileMap.flags, floorMap.terrain, floorMap.width, room);
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
  // Config-driven no-op: with an empty static-spawner table Floor 1 places no
  // Spawner entities (see FLOOR_1_STATIC_SPAWNER_ARCHETYPE_IDS). Bail before
  // deriving the room stream so we do no wasted work.
  if (FLOOR_1_STATIC_SPAWNER_ARCHETYPE_IDS.length === 0) {
    return;
  }
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
      const spawnerEid = spawnSpawner(world, spawnPos.x, spawnPos.y, archetype.hp, {
        defIndex,
        contactDamage: archetype.contactDamage,
        weight: archetype.weight,
        bloodColor: archetype.bloodColor,
        textureId: archetype.textureId,
        spriteWidth: archetype.spriteWidth,
        spriteHeight: archetype.spriteHeight,
        arenaRadiusFt: archetype.arenaRadiusFt,
      });
      // Preserve stable visual identity so generated-art lookups can select
      // spawner-specific briefs (e.g. slime-pool-v1, rats-nest-v1) when present.
      setEnemyAppearanceKey(world, spawnerEid, archetypeId);
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
    addComponent(
      world.ecs,
      eid,
      set(Size, {
        radius: 0,
        halfWidth: WELCOME_SIGN_WIDTH * 0.5,
        halfHeight: WELCOME_SIGN_HEIGHT * 0.5,
        shape: SHAPE_BOX,
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
  occupiedTiles: Set<string>,
  rng: SeededRandom,
  requireRoutable: boolean,
  reachableMask: Uint8Array | null,
  spawnOptions: SpawnNpcOptions = {},
): number {
  // Resolve position from room role or explicit position
  let x: number;
  let y: number;

  if (placement.position) {
    // Explicit position override
    x = placement.position.x;
    y = placement.position.y;
  } else if (isCriticalProgressNpcType(placement.npcTypeId)) {
    // Floor-1 progression NPCs intentionally live in the welcome hub so the
    // entire questline remains discoverable without extra room-hunting variance.
    x = objectiveTiles.welcomeOfficePos.x;
    y = objectiveTiles.welcomeOfficePos.y;
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

  const spawnPos =
    requireRoutable && reachableMask !== null
      ? resolveRoutableNpcSpawnPosition(world, { x, y }, occupiedTiles, rng, reachableMask)
      : resolveNpcSpawnPosition(world, { x, y }, occupiedTiles, rng);
  return spawnNpc(world, spawnPos.x, spawnPos.y, placement.npcTypeId, spawnOptions);
}

/**
 * Stamp the authored `welcome-room` set piece into Floor 1's welcome-office hub
 * so the three quest NPCs land at fixed, spaced positions dressed with themed
 * props. The hub is the safe room 3–8 hops from the player's start where every
 * `roomRole: "spawn"` NPC lives (NOT the literal player-spawn room) — it is
 * resolved from the `welcomeOfficePos` objective tile so the stamp lands where
 * the NPCs actually spawn and the wayfinding-sign trail still runs deep into the
 * floor. Returns `null` (falling back to the scatter path) when the set piece or
 * hub room is unavailable. Read-only: computes placements without mutating
 * `world`.
 */
function computeWelcomeRoomStamp(
  world: GameWorld,
  welcomeOfficePos: { x: number; y: number },
  carved: boolean,
): StampedSetPiece | null {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return null;
  }
  const def = getSetPieceDef(WELCOME_ROOM_SET_PIECE_ID);
  if (!def) {
    return null;
  }
  const officeTile = floorMap.worldToTile(welcomeOfficePos.x, welcomeOfficePos.y);
  const roomId = floorMap.roomGraph.getRoomAt(officeTile.x, officeTile.y);
  const room = roomId >= 0 ? floorMap.roomGraph.get(roomId) : undefined;
  if (!room) {
    return null;
  }
  return stampSetPiece(def, {
    roomBounds: room.bounds,
    tileSizeFt: floorMap.config.tileSizeFt,
    // When the prefab was carved, the room's bounds ARE the footprint, so anchor
    // the def's (0,0) to the top-left corner: the authored wall ring coincides
    // with the carved perimeter walls and interior props/NPCs land inside. Without
    // a carve (rollback fallback) keep the historical interior-centred placement.
    anchor: carved ? 'bounds-topleft' : 'interior-center',
  });
}

/**
 * Carve the welcome-room prefab so it is authoritative for its room geometry:
 * resize the welcome-office hub room to the prefab footprint, wall its perimeter,
 * punch the declared door(s), and reconnect corridors — all as TILE WRITES, never
 * ECS entities (allocating entity ids for dressing would perturb the global RNG
 * and break headless↔rendered determinism; see world-objects.ts). Returns whether
 * the prefab was carved and, when fitted, the recentred hub tile (the new room's
 * interior centre) so downstream NPC/sign placement uses a tile guaranteed to lie
 * inside the resized room. `fitted: false` ⇒ nothing was mutated and the caller
 * keeps the legacy render-only stamp so Floor 1 stays winnable (rollback safety).
 */
function carveWelcomeRoomPrefab(
  world: GameWorld,
  welcomeOfficePos: { x: number; y: number },
): {
  fitted: boolean;
  recentredWelcomePos?: { x: number; y: number };
  welcomeRoomId?: number;
  /**
   * Re-runs `applySolidProps` for this carve. The welcome room is the ONLY
   * carved set piece that also goes through `tagRoomAsSafe`, whose
   * `restoreRoomInterior` call repaints every interior tile back to plain
   * floor — silently wiping the furniture collision the carve just wrote.
   * The caller must invoke this AFTER `tagRoomAsSafe` so the flags survive.
   * (Discovered by probing the running game: unit tests were green while the
   * feature was fully inert on a real floor.)
   */
  reapplySolidProps?: () => void;
} {
  const floorMap = world.floorMap;
  if (!floorMap) return { fitted: false };
  const def = getSetPieceDef(WELCOME_ROOM_SET_PIECE_ID);
  if (!def) return { fitted: false };
  const officeTile = floorMap.worldToTile(welcomeOfficePos.x, welcomeOfficePos.y);
  const roomId = floorMap.roomGraph.getRoomAt(officeTile.x, officeTile.y);
  const room = roomId >= 0 ? floorMap.roomGraph.get(roomId) : undefined;
  if (!room) return { fitted: false };
  // Carve paints the interior as plain STONE_FLOOR; the subsequent tagRoomAsSafe
  // upgrades it to SAFE_ROOM_FLOOR, keeping the safe-room tint logic in one place.
  const result = carveSetPieceRoom(floorMap, room, def);
  // Record the hub room id regardless of fit: carveSetPieceRoom resizes this same
  // room in place (id unchanged), and on no-fit it is still the room production
  // treats as the welcome office. The reachability gate resolves the room by this
  // id and then asserts bounds == footprint, so a no-fit is a hard gate failure
  // rather than a silently-shipped legacy room.
  if (!result.fitted || !result.bounds) {
    // Loud, structured degradation signal (parent-session pushback): a no-fit
    // falls back to the legacy render-only stamp so Floor 1 stays winnable, but
    // that is NOT an acceptable resting state — it means the prefab is not
    // authoritative for its room. Zero degradations is the expected steady state;
    // the reachability sweep also reports this as a first-class number and fails
    // hard on it. Emitting here makes it observable in game/headless logs too.
    // (console.warn touches no RNG/entity ids, so determinism is preserved.)
    console.warn(
      `[set-piece:degraded] welcome-room prefab did not carve (reason=${result.reason ?? 'unknown'}); ` +
        `shipping legacy render-only fallback for room ${room.id}. Carve tiers 1–2 under-powered.`,
    );
    return { fitted: false, welcomeRoomId: room.id };
  }
  const centreTileX = result.bounds.x + Math.floor(result.bounds.width / 2);
  const centreTileY = result.bounds.y + Math.floor(result.bounds.height / 2);
  const carvedBounds = result.bounds;
  const carvedDoors = result.doors ?? [];
  const originTileX = result.originTileX ?? carvedBounds.x;
  const originTileY = result.originTileY ?? carvedBounds.y;
  return {
    fitted: true,
    recentredWelcomePos: floorMap.tileToWorld(centreTileX, centreTileY),
    welcomeRoomId: room.id,
    reapplySolidProps: () =>
      applySolidProps(floorMap, def, originTileX, originTileY, carvedBounds, carvedDoors),
  };
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
  if (world.floorScenario) {
    world.floorScenario.objective.questAccepted = true;
  }
}

/**
 * Initialize weapon skill states for the player entity, seeding every registered
 * skill at level 0 so the skill system and HUD can track progress from the start.
 */
export function initializePlayerWeaponSkills(world: GameWorld, playerEid: number): void {
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
  attachBarriersToFloorMap(world);

  const spawn = floorMap.tileToWorld(floorMap.playerSpawn.x, floorMap.playerSpawn.y);
  if (hasComponent(world.ecs, playerEid, Position)) {
    setComponent(world.ecs, playerEid, Position, { x: spawn.x, y: spawn.y });
  }
  if (!hasComponent(world.ecs, playerEid, BroadcastScore)) {
    addComponent(world.ecs, playerEid, set(BroadcastScore, { current: 0 }));
  }

  const maxHp = (world.stores.health.max[playerEid] ?? 100) + floor1Config.player.hpBonus;
  setComponent(world.ecs, playerEid, Health, { current: maxHp, max: maxHp });

  const objectiveTiles = chooseObjectiveTiles(world);
  const { staircasePos, shopRoomPos, candidateRoomIds, welcomeRoomId, shopRoomId } = objectiveTiles;
  let slimeRatRoomPos = objectiveTiles.slimeRatRoomPos;
  let spellQuestGiverPos = objectiveTiles.spellQuestGiverPos;
  let questItemPos = objectiveTiles.questItemPos;
  // `welcomeOfficePos` and `safeRoomPos` are mutable: carving the welcome-room
  // prefab (below) resizes the hub room, so we recentre BOTH onto the carved
  // room's interior centre. They are the same hub room by construction
  // (chooseObjectiveTiles sets safeRoomPos = welcomeOfficePos), so a stale
  // safeRoomPos would key the safe-room proximity marker (safeRoomDiscovered)
  // and NPC placement off the pre-carve centre (plan-review concern #5).
  let welcomeOfficePos = objectiveTiles.welcomeOfficePos;
  let safeRoomPos = objectiveTiles.safeRoomPos;
  // Carve the welcome-room prefab so it OWNS its geometry: the hub room is resized
  // to the prefab footprint with a real impassable wall ring + a real door, all as
  // tile writes (never ECS entities → determinism preserved). Runs BEFORE
  // tagRoomAsSafe (so the safe tint/role lands on the carved geometry) and BEFORE
  // the spawn-reachability mask (so NPC routability sees the carved walls/doors).
  // On no-fit it mutates nothing and we keep the legacy render-only stamp.
  const welcomeCarve = carveWelcomeRoomPrefab(world, welcomeOfficePos);
  if (welcomeCarve.fitted && welcomeCarve.recentredWelcomePos) {
    welcomeOfficePos = welcomeCarve.recentredWelcomePos;
    safeRoomPos = welcomeCarve.recentredWelcomePos;
  }
  // The welcome room is the only safe room on Floor 1 — the bar/hub where all
  // three quest NPCs live. The shop and spell-broker rooms are regular rooms.
  tagRoomAsSafe(world, welcomeOfficePos);
  // MUST follow tagRoomAsSafe: its `restoreRoomInterior` repaints the whole
  // interior back to plain floor, wiping the furniture collision written during
  // the carve. Re-applying here is idempotent and keeps the revert-on-disconnect
  // guard in one place.
  welcomeCarve.reapplySolidProps?.();
  if (world.floorMap != null) {
    const candidateEntries = buildObjectiveRoomCandidates(world.floorMap, candidateRoomIds);
    const merchantPos = isCriticalProgressNpcType('shopkeeper') ? welcomeOfficePos : shopRoomPos;
    const alignedPair = selectMerchantAnchoredQuestItemAndSlime(
      world.floorMap,
      candidateEntries,
      candidateEntries.filter(
        (entry) => entry.room.id !== welcomeRoomId && entry.room.id !== shopRoomId,
      ),
      welcomeOfficePos,
      shopRoomPos,
      staircasePos,
      merchantPos,
      shopRoomId,
    );
    if (alignedPair != null) {
      questItemPos = resolvePassableRoomCenter(world.floorMap, alignedPair.itemEntry.room);
      slimeRatRoomPos = alignedPair.slimeEntry
        ? resolvePassableRoomCenter(world.floorMap, alignedPair.slimeEntry.room)
        : questItemPos;
    }
    const usedRoomIds = new Set(
      [
        welcomeRoomId,
        shopRoomId,
        roomAtPosition(world, questItemPos)?.id,
        roomAtPosition(world, slimeRatRoomPos)?.id,
      ].filter((id): id is number => id != null),
    );
    const spellEntry = candidateEntries.find((entry) => !usedRoomIds.has(entry.room.id));
    const spellFallbackPos =
      shopRoomPos.x !== questItemPos.x || shopRoomPos.y !== questItemPos.y
        ? shopRoomPos
        : welcomeOfficePos;
    spellQuestGiverPos = spellEntry
      ? resolvePassableRoomCenter(world.floorMap, spellEntry.room)
      : spellFallbackPos;
  }

  // Door-gate every special room. Corridors carved between room centres regularly
  // clip a room's bounding-box perimeter at non-door tiles, letting enemies tunnel
  // into rooms that are meant to be refuges or gated arenas (e.g. seed 42's shop
  // and spell-broker safe rooms, and the hub-shaped welcome office). Seal them
  // generically: every SAFE + BOSS_STAIR room plus the slime-rat quest room. Each
  // breach is walled unless walling it would strand a region, in which case it
  // becomes a door so the room stays enclosed without softlocking the floor.
  const slimeRatTile = floorMap.worldToTile(slimeRatRoomPos.x, slimeRatRoomPos.y);
  const slimeRatRoomId = floorMap.roomGraph.getRoomAt(slimeRatTile.x, slimeRatTile.y);
  const slimeRatEncounterRoom =
    slimeRatRoomId >= 0 ? (floorMap.roomGraph.get(slimeRatRoomId) ?? null) : null;
  const slimeRatRoomFloorTerrain =
    floorMap.terrain[slimeRatTile.y * floorMap.width + slimeRatTile.x] ?? TerrainType.STONE_FLOOR;
  sealSpecialRooms(floorMap, {
    extraRoomIds: slimeRatRoomId >= 0 ? [slimeRatRoomId] : [],
  });
  if (slimeRatEncounterRoom) {
    ensureBossArenaInterior(
      floorMap.tileMap,
      floorMap.terrain,
      floorMap.width,
      floorMap.height,
      slimeRatEncounterRoom,
      slimeRatRoomFloorTerrain,
    );
  }

  // Welcome wayfinding signs are planted further down, after NPCs spawn, so a
  // sign can detect and avoid landing on top of an NPC (see placeWelcomeSigns).

  // Place ambient props using the floor manifest config (if present).
  if (floor1Manifest.props !== undefined) {
    placePropsForFloor(world, floorMap, floor1Manifest.props, world.rng);
  }

  const starterWeaponPool = getFloor1StarterWeaponPool(floor1Config.starterWeapons, {
    enableExperimental: isFloor1ExperimentalStarterOptionsEnabled(
      typeof window !== 'undefined' ? window.location.search : undefined,
    ),
  });

  world.floorScenario = {
    protagonistName: world.playerName,
    starterWeaponPool,
    starterChoices: pickStarterChoices(world, starterWeaponPool),
    offeredRewardSpellIds: pickOfferedRewardSpellIds(world),
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
    welcomeRoomId: welcomeCarve.welcomeRoomId ?? null,
    welcomeRoomCarved: welcomeCarve.fitted,
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
      // NOTE: welcomeOfficePos/spellQuestGiverPos/shopRoomPos are SEEDED here to
      // the welcome-bar room center, but after NPC spawn all three are TIGHTENED
      // to each NPC's actual spawned tile (see the npc-placement loop below). Treat
      // them as "current NPC objective/target tiles", NOT stable room-center
      // anchors — shared-room hubs stay selectable and AI navigation targets the
      // real quest giver / merchant / goon tile.
      welcomeOfficePos,
      slimeRatRoomPos,
      spellQuestGiverPos: welcomeOfficePos,
      shopRoomPos: welcomeOfficePos,
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
  // Render-only set-piece props are appended (never keyed by world), so a
  // re-init on a reused world would otherwise accumulate duplicate instances
  // that stack and grow unbounded. Clear unconditionally so each floor starts
  // from an empty list — this also drops stale props when a later floor stamps
  // no set piece. Mutate in place to preserve the array reference PhaserBridge
  // reconciles by index.
  world.setPieceProps.length = 0;
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
  const floor1State = world.floorScenario;
  const npcPlacements = floor1Manifest.npcPlacements;
  const occupiedNpcTiles = new Set<string>();
  let spawnReachableMask =
    world.floorMap == null
      ? null
      : buildReachableFromSpawnMask(
          world.floorMap,
          buildInitiallyLockedDoorTileSet(world.floorMap, [staircasePos, slimeRatRoomPos]),
        );
  // Lock-aware welcome-hub reachability repair. The welcome room is the SAFE hub on
  // Floor 1's critical path and must be reachable in the LOCKED initial state
  // (before the player unlocks the staircase / slime-rat quest doors).
  // carveSetPieceRoom's connectivity backstop is intentionally lock-unaware — a pure
  // core module cannot know Floor 1's quest locks — so on some seeds the carved hub
  // ends up reachable only THROUGH an initially-locked door, stranding it (and its
  // quest NPCs) until unlock. NPC routability then scatters those NPCs outside the
  // room. Detect it here (the layer that owns the lock model) and carve a direct,
  // unlocked connector from the hub's door to the nearest lock-aware-reachable tile,
  // forbidding the tunnel from routing through the locked rooms' footprints so it can
  // never open a bypass into gated content (rule #12). Then rebuild the mask so NPC
  // placement below sees the new connection. Deterministic: BFS with a fixed
  // neighbour order, no RNG.
  if (
    welcomeCarve.fitted &&
    welcomeCarve.welcomeRoomId != null &&
    world.floorMap != null &&
    spawnReachableMask != null
  ) {
    const fm = world.floorMap;
    const welcomeRoom = fm.roomGraph.get(welcomeCarve.welcomeRoomId);
    const primaryDoor = welcomeRoom?.doors[0];
    if (welcomeRoom && primaryDoor) {
      const b = welcomeRoom.bounds;
      const interiorX = b.x + Math.floor(b.width / 2);
      const interiorY = b.y + Math.floor(b.height / 2);
      if (!isSpawnReachableTile(fm, spawnReachableMask, interiorX, interiorY)) {
        const avoid = new Set<number>();
        for (const center of [staircasePos, slimeRatRoomPos]) {
          const t = fm.worldToTile(center.x, center.y);
          const rid = fm.roomGraph.getRoomAt(t.x, t.y);
          const lockedRoom = rid >= 0 ? fm.roomGraph.get(rid) : undefined;
          if (!lockedRoom) continue;
          const lb = lockedRoom.bounds;
          for (let yy = lb.y; yy < lb.y + lb.height; yy += 1) {
            for (let xx = lb.x; xx < lb.x + lb.width; xx += 1) {
              avoid.add(yy * fm.width + xx);
            }
          }
        }
        for (const otherRoom of fm.roomGraph.getAll()) {
          if (otherRoom.id === welcomeRoom.id) continue;
          const ob = otherRoom.bounds;
          for (let yy = ob.y; yy < ob.y + ob.height; yy += 1) {
            for (let xx = ob.x; xx < ob.x + ob.width; xx += 1) {
              avoid.add(yy * fm.width + xx);
            }
          }
        }
        // Forbid the connector from carving the welcome room's OWN footprint
        // (interior + perimeter ring) — except the door it starts from. Without
        // this the BFS tunnels the shortest route through wall rock, which can
        // clip the room's own perimeter and open plain-floor breaches in the
        // prefab wall ring (observed on seed 21: 5 non-door breaches). The hub
        // already has a real door; the repair must only EXTEND that door outward
        // through exterior rock, never punch new holes in the shell.
        const primaryDoorIdx = primaryDoor.y * fm.width + primaryDoor.x;
        for (let yy = b.y; yy < b.y + b.height; yy += 1) {
          for (let xx = b.x; xx < b.x + b.width; xx += 1) {
            const idx = yy * fm.width + xx;
            if (idx !== primaryDoorIdx) avoid.add(idx);
          }
        }
        carveConnectorToReachable(fm, primaryDoor.x, primaryDoor.y, spawnReachableMask, avoid);
        spawnReachableMask = buildReachableFromSpawnMask(
          fm,
          buildInitiallyLockedDoorTileSet(fm, [staircasePos, slimeRatRoomPos]),
        );
      }
    }
  }
  if (world.floorMap != null) {
    const candidateEntries = buildObjectiveRoomCandidates(world.floorMap, candidateRoomIds);
    const merchantPos = isCriticalProgressNpcType('shopkeeper') ? welcomeOfficePos : shopRoomPos;
    const provisionalItemRoomId = roomAtPosition(world, questItemPos)?.id ?? null;
    const provisionalItemEntry =
      provisionalItemRoomId == null
        ? undefined
        : candidateEntries.find((entry) => entry.room.id === provisionalItemRoomId);
    const excludedRoomIds = new Set(
      [welcomeRoomId, shopRoomId, roomAtPosition(world, slimeRatRoomPos)?.id].filter(
        (id): id is number => id != null,
      ),
    );
    const lockedRoomCenters = [staircasePos, slimeRatRoomPos];
    const keepProvisionalItem =
      provisionalItemEntry !== undefined &&
      !excludedRoomIds.has(provisionalItemEntry.room.id) &&
      isMerchantAnchoredQuestItemEntryReachable(
        world.floorMap,
        provisionalItemEntry,
        merchantPos,
        lockedRoomCenters,
      ) &&
      (() => {
        const fraction = merchantAnchoredQuestItemFraction(
          world.floorMap!,
          provisionalItemEntry,
          merchantPos,
          lockedRoomCenters,
        );
        return fraction !== null && fraction > 0.3 && fraction < 0.9;
      })();
    const finalItemEntry = keepProvisionalItem
      ? provisionalItemEntry
      : selectMerchantAnchoredQuestItemEntry(
          world.floorMap,
          candidateEntries,
          candidateEntries.filter((entry) => !excludedRoomIds.has(entry.room.id)),
          merchantPos,
          lockedRoomCenters,
          new Set([welcomeRoomId, shopRoomId].filter((id): id is number => id != null)),
        );
    if (finalItemEntry == null) {
      throw new Error('Floor 1 could not place the rat tail in a lock-aware reachable room.');
    }
    questItemPos = resolvePassableRoomCenter(world.floorMap, finalItemEntry.room);
    const finalItemRoomId =
      roomAtPosition(world, questItemPos)?.id ?? finalItemEntry?.room.id ?? null;
    const usedRoomIds = new Set(
      [
        welcomeRoomId,
        shopRoomId,
        finalItemRoomId,
        roomAtPosition(world, slimeRatRoomPos)?.id,
      ].filter((id): id is number => id != null),
    );
    const spellEntry = candidateEntries.find((entry) => !usedRoomIds.has(entry.room.id));
    const spellFallbackPos =
      shopRoomPos.x !== questItemPos.x || shopRoomPos.y !== questItemPos.y
        ? shopRoomPos
        : welcomeOfficePos;
    spellQuestGiverPos = spellEntry
      ? resolvePassableRoomCenter(world.floorMap, spellEntry.room)
      : spellFallbackPos;
  }
  // Dedicated deterministic stream for NPC tile scatter so shared-room hubs (the
  // welcome bar) spread out per seed without consuming — or being perturbed by —
  // the shared gameplay RNG that drives enemies, loot, and props.
  const npcPlacementRng = new SeededRandom(hashStringToSeed(`${world.seed}:floor1-npc-placement`));
  const updateObjective = (patch: Partial<typeof floor1State.objective>): void => {
    floor1State.objective = {
      ...floor1State.objective,
      ...patch,
    };
  };
  updateObjective({ questItemPos, spellQuestGiverPos });
  // Stamp the authored welcome-room set piece into the welcome-office hub room:
  // it fixes the three quest NPCs at spaced positions and dresses the room with
  // themed props. When present it drives NPC placement (replacing the scatter
  // fallback); the objective anchors below then auto-follow each NPC's actual
  // spawned tile.
  const welcomeStamp = computeWelcomeRoomStamp(world, welcomeOfficePos, welcomeCarve.fitted);
  const stampedNpcByType = new Map<string, StampedSetPieceNpc>();
  if (welcomeStamp) {
    for (const npc of welcomeStamp.npcs) {
      stampedNpcByType.set(npc.npcTypeId, npc);
    }
  }
  if (npcPlacements && npcPlacements.length > 0) {
    // Data-driven NPC spawning
    for (const placement of npcPlacements) {
      const stamped = stampedNpcByType.get(placement.npcTypeId);
      const requireRoutable = isCriticalProgressNpcType(placement.npcTypeId);
      // Only honour the authored tile when it is actually passable. Most Floor 1
      // rooms are rectangular so the centred stamp always lands on floor, but a
      // hub-shaped room could clamp a far tile onto an interior wall — fall back
      // to the scatter resolver for that NPC so it never spawns unreachable.
      const stampedPassableAndRoutable =
        stamped !== undefined &&
        (world.floorMap?.tileMap.isPassable(stamped.tileX, stamped.tileY) ?? false) &&
        (!requireRoutable ||
          (world.floorMap != null &&
            spawnReachableMask !== null &&
            isSpawnReachableTile(
              world.floorMap,
              spawnReachableMask,
              stamped.tileX,
              stamped.tileY,
            )));
      const resolvedPlacement = stamped
        ? stampedPassableAndRoutable
          ? { ...placement, position: { x: stamped.x, y: stamped.y } }
          : { ...placement, position: welcomeOfficePos }
        : placement;
      const spawnOptions: SpawnNpcOptions =
        stamped !== undefined
          ? {
              ...(stamped.spriteOverride !== undefined
                ? { spriteOverride: stamped.spriteOverride }
                : {}),
              ...(stamped.widthFt !== undefined ? { widthFt: stamped.widthFt } : {}),
              ...(stamped.heightFt !== undefined ? { heightFt: stamped.heightFt } : {}),
              ...(stamped.flipX !== undefined ? { flipX: stamped.flipX } : {}),
              ...(stamped.flipY !== undefined ? { flipY: stamped.flipY } : {}),
              ...(stamped.rotationDeg !== undefined ? { rotationDeg: stamped.rotationDeg } : {}),
              ...(stamped.z !== undefined ? { z: stamped.z } : {}),
            }
          : {};
      const eid = spawnNpcFromPlacement(
        world,
        resolvedPlacement,
        {
          welcomeOfficePos,
          safeRoomPos,
          staircasePos,
          slimeRatRoomPos,
          spellQuestGiverPos,
          shopRoomPos,
          questItemPos,
        },
        occupiedNpcTiles,
        npcPlacementRng,
        requireRoutable,
        spawnReachableMask,
        spawnOptions,
      );

      // Store EIDs by NPC type and point each objective anchor at the NPC's
      // actual spawned tile. All three (including the goon's welcome anchor)
      // auto-follow the NPC so quest markers track where the NPC really stands.
      const npcX = world.stores.position.x[eid];
      const npcY = world.stores.position.y[eid];
      if (placement.npcTypeId === 'tutorial-goon') {
        world.floorScenario.guideNpcEid = eid;
        if (npcX !== undefined && npcY !== undefined) {
          updateObjective({ welcomeOfficePos: { x: npcX, y: npcY } });
        }
      } else if (placement.npcTypeId === 'spell-quest-giver') {
        world.floorScenario.spellQuestGiverNpcEid = eid;
        if (npcX !== undefined && npcY !== undefined) {
          updateObjective({ spellQuestGiverPos: { x: npcX, y: npcY } });
        }
      } else if (placement.npcTypeId === 'shopkeeper') {
        world.floorScenario.shopkeeperNpcEid = eid;
        if (npcX !== undefined && npcY !== undefined) {
          updateObjective({ shopRoomPos: { x: npcX, y: npcY } });
        }
      }
    }
  } else {
    // Fallback to hardcoded NPC spawning (backward compatibility)
    // Resolve all three NPCs against the ORIGINAL room center (the stable local
    // `welcomeOfficePos`), never `world.floorScenario.objective.welcomeOfficePos`:
    // the goon's `updateObjective` below mutates that field, so reading it for the
    // spell/shop resolvers would cluster them onto the goon's tile instead of
    // spreading them across the room.
    const guidePos = resolveNpcSpawnPosition(
      world,
      welcomeOfficePos,
      occupiedNpcTiles,
      npcPlacementRng,
    );
    world.floorScenario.guideNpcEid = spawnNpc(world, guidePos.x, guidePos.y, 'tutorial-goon');
    updateObjective({ welcomeOfficePos: guidePos });
    const spellPos = resolveNpcSpawnPosition(
      world,
      welcomeOfficePos,
      occupiedNpcTiles,
      npcPlacementRng,
    );
    world.floorScenario.spellQuestGiverNpcEid = spawnNpc(
      world,
      spellPos.x,
      spellPos.y,
      'spell-quest-giver',
    );
    updateObjective({ spellQuestGiverPos: spellPos });
    const shopPos = resolveNpcSpawnPosition(
      world,
      welcomeOfficePos,
      occupiedNpcTiles,
      npcPlacementRng,
    );
    world.floorScenario.shopkeeperNpcEid = spawnNpc(world, shopPos.x, shopPos.y, 'shopkeeper');
    updateObjective({ shopRoomPos: shopPos });
  }

  // Dress the welcome room with the authored set-piece props (rug, banner,
  // welcome desk, shop table, bookcase, clutter). These are render-only
  // instances on `world.setPieceProps` — NOT ECS entities — so they layer over
  // the baked terrain and around the NPCs without consuming entity ids or
  // entering the collision grid: no effect on collision, pathing, RNG, or
  // balance. Wall/door-kind props are SKIPPED via the shared
  // `isStructuralSetPieceProp` predicate: under the prefab-room model the carved
  // terrain layer is authoritative for walls/doors, so re-drawing them as sprites
  // would double-render/z-fight the baked tiles. Their role is purely to define
  // the shell in the def (composition gate + door-tile source of truth). The
  // predicate is shared with the Set Piece Lab so a preview cannot drift from
  // what actually ships.
  if (welcomeStamp) {
    const welcomeDef = getSetPieceDef(WELCOME_ROOM_SET_PIECE_ID);
    const structuralPropIds = new Set(
      (welcomeDef?.props ?? []).filter(isStructuralSetPieceProp).map((prop) => prop.id),
    );
    for (const stampedProp of welcomeStamp.props) {
      if (stampedProp.render.label && structuralPropIds.has(stampedProp.render.label)) {
        continue;
      }
      addSetPieceProp(world, stampedProp.x, stampedProp.y, stampedProp.render);
    }
  }

  // Plant the welcome wayfinding signs now that NPCs exist, so a sign never
  // lands on top of one.
  placeWelcomeSigns(world, welcomeOfficePos);

  // Spawn the merchant's fetch quest item
  world.floorScenario.questItemEid = spawnDroppedItem(
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
        set(DoorState, {
          tileX: door.x,
          tileY: door.y,
          logicalOpen: 0,
          isLocked: 1,
          wasUnlocked: 0,
        }),
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
      world.floorScenario.bossRoomDoorEids.get('staircase')!.push(doorEid);
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
        set(DoorState, {
          tileX: door.x,
          tileY: door.y,
          logicalOpen: 0,
          isLocked: 1,
          wasUnlocked: 0,
        }),
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
      world.floorScenario.bossRoomDoorEids.get('slime-rat')!.push(doorEid);
    }
  }

  world.state = 'loadout';
  world.floorId = 'floor1';
  world.floorObjectiveTick = floor1ObjectiveTick;

  // Ensure Floor 2 extended state is cleared so Floor 1 and Floor 2 are mutually exclusive
  world.floorExtendedState = null;

  // Spawn harvestable resource nodes after the map and all rooms are fully set up.
  spawnFloor1HarvestableNodes(world);
}

export function selectFloor1StarterWeapon(world: GameWorld, optionIndex: number): void {
  if (!world.floorScenario || world.state !== 'loadout') {
    return;
  }

  const weaponId = world.floorScenario.starterChoices[optionIndex];
  if (weaponId === undefined) {
    return;
  }

  const weaponDef = getWeaponDef(weaponId);
  if (weaponDef === undefined) {
    return;
  }

  world.floorScenario.selectedWeaponId = weaponId;
  world.floorScenario.selectedChoiceIndex = optionIndex;

  // Route the starter through the shared equip helper so the weapon lands in
  // the hand slot(s) — one-handed → mainHand, two-handed → mainHand + offHand —
  // and auto-fires from frame one, with a setActiveWeapon fallback if the
  // equipment path can't run. Shared with applyFloor1LoadoutChoice so both
  // loadout entry points keep identical eviction/equip/fallback semantics.
  equipStarterOrFallback(world, weaponId, weaponDef);
  world.state = 'playing';
}

function resolveSpawnPosition(
  world: GameWorld,
  playerX: number,
  playerY: number,
  maxRadius: number = FLOOR_1_SPAWN_RADIUS_MAX,
  pack = floor1EnemyPack,
): { x: number; y: number } {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return { x: playerX + pack.spawnRadiusMin, y: playerY };
  }
  const outerRadius = Math.max(pack.spawnRadiusMin, maxRadius);
  const minSpawnDistSq = pack.spawnRadiusMin * pack.spawnRadiusMin;
  const maxSpawnDistSq = outerRadius * outerRadius;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const angle = world.rng.next() * Math.PI * 2;
    const radius = pack.spawnRadiusMin + world.rng.next() * (outerRadius - pack.spawnRadiusMin);
    const x = playerX + Math.cos(angle) * radius;
    const y = playerY + Math.sin(angle) * radius;
    const tile = floorMap.worldToTile(x, y);
    if (
      isValidEnemySpawnTile(world, tile.x, tile.y, playerX, playerY, minSpawnDistSq, maxSpawnDistSq)
    ) {
      return floorMap.tileToWorld(tile.x, tile.y);
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
      if (isValidEnemySpawnTile(world, tx, ty, playerX, playerY, minSpawnDistSq, maxSpawnDistSq)) {
        return floorMap.tileToWorld(tx, ty);
      }
    }
  }
  const fallbackTile = floorMap.worldToTile(playerX + pack.spawnRadiusMin, playerY);
  const maxSearchRadiusTiles = Math.ceil(outerRadius / floorMap.config.tileSizeFt) + 1;
  for (let radius = 0; radius <= maxSearchRadiusTiles; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        // Only evaluate the current square ring perimeter to avoid re-checking
        // interior tiles from smaller radii.
        if (!isOnSquarePerimeter(dx, dy, radius)) {
          continue;
        }
        const tx = fallbackTile.x + dx;
        const ty = fallbackTile.y + dy;
        if (
          isValidEnemySpawnTile(world, tx, ty, playerX, playerY, minSpawnDistSq, maxSpawnDistSq)
        ) {
          return floorMap.tileToWorld(tx, ty);
        }
      }
    }
  }
  return floorMap.tileToWorld(fallbackTile.x, fallbackTile.y);
}

function resolveBossSpawnPosition(
  world: GameWorld,
  bossRoom: RoomData | null,
  stairX: number,
  stairY: number,
  playerX: number,
  playerY: number,
): { x: number; y: number } {
  const floorMap = world.floorMap;
  if (floorMap && bossRoom) {
    return selectBossSpawnPlacement(
      floorMap,
      bossRoom,
      { x: playerX, y: playerY },
      floor1Config.bossVariants!.ratSlime.spawnRadiusMin,
    ).position;
  }
  if (!floorMap) {
    return { x: stairX + floor1Config.bossVariants!.ratSlime.spawnRadiusMin, y: stairY };
  }
  const fallbackTile = floorMap.worldToTile(stairX, stairY);
  if (floorMap.isPassableAt(stairX, stairY)) {
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

function isInRoom(world: GameWorld, px: number, py: number, room: RoomData | null): boolean {
  if (!world.floorMap || !room) return false;
  const tile = world.floorMap.worldToTile(px, py);
  return world.floorMap.roomGraph.getRoomAt(tile.x, tile.y) === room.id;
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

function roomAtPosition(world: GameWorld, pos: { x: number; y: number }): RoomData | null {
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

function spawnFloor1StairBoss(world: GameWorld, playerX: number, playerY: number): number {
  const objective = world.floorScenario?.objective;
  if (!objective) {
    throw new Error('Cannot spawn stair boss without floor1 objective state.');
  }
  const bossRoom = world.floorMap?.bossStairRoom ?? null;
  const spawnPoint = resolveBossSpawnPosition(
    world,
    bossRoom,
    objective.staircasePos.x,
    objective.staircasePos.y,
    playerX,
    playerY,
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
  setComponent(world.ecs, eid, Size, {
    radius:
      Math.max(
        floor1Config.bossVariants!.ratSlime.spriteWidth,
        floor1Config.bossVariants!.ratSlime.spriteHeight,
      ) * 0.5,
    halfWidth: 0,
    halfHeight: 0,
    shape: SHAPE_CIRCLE,
  });
  setEnemyAppearanceKey(world, eid, 'rat-slime');

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

function spawnFloor1SlimeRatBoss(world: GameWorld, playerX: number, playerY: number): number {
  const objective = world.floorScenario?.objective;
  if (!objective) {
    throw new Error('Cannot spawn Slime Rat without floor1 objective state.');
  }
  const bossRoom = roomAtPosition(world, objective.slimeRatRoomPos);
  const spawnPoint = resolveBossSpawnPosition(
    world,
    bossRoom,
    objective.slimeRatRoomPos.x,
    objective.slimeRatRoomPos.y,
    playerX,
    playerY,
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
  setComponent(world.ecs, eid, Size, {
    radius:
      Math.max(
        floor1Config.bossVariants!.ratSlime.spriteWidth - 0.5,
        floor1Config.bossVariants!.ratSlime.spriteHeight - 0.5,
      ) * 0.5,
    halfWidth: 0,
    halfHeight: 0,
    shape: SHAPE_CIRCLE,
  });
  // slimeRat quest boss is primarily a slime creature.
  setBloodColor(world, eid, BLOOD_COLOR_SLIME);
  setComponent(world.ecs, eid, Damage, { amount: 8 });
  world.stores.enemyBehavior.aggroedPermanently[eid] = 1;
  world.stores.enemyBehavior.fireCooldownMs[eid] =
    floor1Config.bossVariants!.slimeRat.fireballCooldownMs;
  return eid;
}

function beginFloor1SlimeRatBattle(world: GameWorld, playerX: number, playerY: number): void {
  const floorScenario = world.floorScenario;
  const objective = floorScenario?.objective;
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
  if (floorScenario) {
    for (const doorEid of floorScenario.bossRoomDoorEids.get('slime-rat') ?? []) {
      world.stores.doorState.isLocked[doorEid] = 1;
      world.stores.doorState.logicalOpen[doorEid] = 0;
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
  slimeRatBattle.bossEid = spawnFloor1SlimeRatBoss(world, playerX, playerY);
  activateHostileEncounter(world);
}

function beginFloor1BossBattle(world: GameWorld, playerX: number, playerY: number): void {
  const floorScenario = world.floorScenario;
  const objective = floorScenario?.objective;
  const staircaseBattle = objective?.bossBattles.get('staircase');
  if (!floorScenario || !objective || !staircaseBattle || staircaseBattle.started) {
    return;
  }

  staircaseBattle.started = true;
  objective.staircaseLocked = true;
  objective.staircaseUnlocked = false;
  setGoalFlag(world, 'floor1-boss-active', true);

  staircaseBattle.bossEid = spawnFloor1StairBoss(world, playerX, playerY);
  const floorMap = world.floorMap;
  const bossRoom = floorMap?.bossStairRoom;
  if (bossRoom) {
    for (const door of bossRoom.doors) {
      floorMap!.tileMap.closeDoor(door.x, door.y);
    }
  }
  // Replace lock config: doors stay locked while boss is active, open once boss defeated.
  for (const doorEid of floorScenario.bossRoomDoorEids.get('staircase') ?? []) {
    world.stores.doorState.isLocked[doorEid] = 1;
    world.stores.doorState.logicalOpen[doorEid] = 0;
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
  activateHostileEncounter(world);
}

export function floor1PlayerStatSystem(world: GameWorld): void {
  if (!world.floorScenario) {
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
      100 + world.floorScenario.baseStatBonuses.maxHp,
    );
    setComponent(world.ecs, player, Health, { current: maxHp, max: maxHp });
    playerBonusApplied.add(world);
  }

  const speedScale = (PLAYER_SPEED + world.floorScenario.baseStatBonuses.moveSpeed) / PLAYER_SPEED;
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
export function countEngagingEnemies(
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

export function countDirectorEnemies(world: GameWorld): number {
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
export function evictFurthestAmbient(
  world: GameWorld,
  playerX: number,
  playerY: number,
  minDistSq: number,
  count: number,
): number {
  const trackedAmbient = getAmbientEnemyArchetypes(world);
  if (!trackedAmbient || count <= 0) {
    return 0;
  }
  const candidates = [...trackedAmbient.keys()]
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
    trackedAmbient.delete(victim);
  }
  return evictCount;
}

/**
 * Apply distance-from-spawn level scaling to an ambient archetype's base stats.
 *
 * Extracted and exported so the spawn wiring — that a mob spawned far from the
 * floor spawn tile actually receives boosted HP/speed — has assertion-level
 * coverage ({@link computeMobLevelScale} itself is unit-tested in
 * `tests/unit/mob-scaling.test.ts`). Pure given the spawn-tile world position.
 *
 * @param baseHp - Archetype base HP before scaling.
 * @param baseSpeed - Archetype base speed before scaling.
 * @param spawnX - Mob spawn X in world feet.
 * @param spawnY - Mob spawn Y in world feet.
 * @param spawnTileWorldX - Player spawn tile X in world feet.
 * @param spawnTileWorldY - Player spawn tile Y in world feet.
 * @returns Integer HP (clamped to ≥ 1) and scaled speed for the spawn.
 */
export function scaleAmbientSpawnStats(
  baseHp: number,
  baseSpeed: number,
  spawnX: number,
  spawnY: number,
  spawnTileWorldX: number,
  spawnTileWorldY: number,
): { hp: number; speed: number } {
  const dx = spawnX - spawnTileWorldX;
  const dy = spawnY - spawnTileWorldY;
  const distFt = Math.sqrt(dx * dx + dy * dy);
  const scale = computeMobLevelScale(distFt);
  return {
    hp: Math.max(1, Math.round(baseHp * scale.hpMult)),
    speed: baseSpeed * scale.speedMult,
  };
}

/**
 * Spawn one weighted ambient archetype at a world (feet) position, wiring its sprite,
 * blood colour, and ambient-tracking entry. Returns the new entity id.
 */
function spawnAmbientArchetype(world: GameWorld, x: number, y: number): number {
  const pack = floor1EnemyPack;
  const globalZoneWeights = new Map<string, number>();
  for (const entry of pack.archetypes) {
    globalZoneWeights.set(entry.id, entry.spawnWeight);
  }
  const { pickedId } = pickFromSpawnZones([globalZoneWeights as SpawnZoneWeights], () =>
    world.rng.next(),
  );
  const archetype =
    (pickedId ? pack.archetypes.find((entry) => entry.id === pickedId) : undefined) ??
    pack.archetypes[0];
  if (!archetype) {
    throw new Error('No archetypes available in floor1EnemyPack');
  }

  // Scale HP and speed based on distance from the player's starting tile so
  // enemies deeper in the dungeon feel progressively more dangerous.
  let hp = archetype.hp;
  let speed = archetype.speed;
  if (world.floorMap) {
    const spawnWorld = world.floorMap.tileToWorld(
      world.floorMap.playerSpawn.x,
      world.floorMap.playerSpawn.y,
    );
    const scaled = scaleAmbientSpawnStats(
      archetype.hp,
      archetype.speed,
      x,
      y,
      spawnWorld.x,
      spawnWorld.y,
    );
    hp = scaled.hp;
    speed = scaled.speed;
  }

  const eid = spawnBehaviorEnemy(
    world,
    x,
    y,
    hp,
    archetype.id === 'slime' ? AI_TYPE.LEAPER : AI_TYPE.CHASE,
    speed,
    archetype.detectRange,
    0,
  );
  setComponent(world.ecs, eid, Sprite, {
    textureId: archetype.spriteTexture,
    width: archetype.spriteWidth,
    height: archetype.spriteHeight,
  });
  setComponent(world.ecs, eid, Size, {
    radius: Math.max(archetype.spriteWidth, archetype.spriteHeight) * 0.5,
    halfWidth: 0,
    halfHeight: 0,
    shape: SHAPE_CIRCLE,
  });
  setEnemyAppearanceKey(world, eid, archetype.id);
  // Slimes bleed green, rats bleed red.
  setBloodColor(world, eid, archetype.id === 'slime' ? BLOOD_COLOR_SLIME : BLOOD_COLOR_RAT);
  world.floorScenario!.enemyArchetypes.set(eid, archetype.id);
  return eid;
}

/** Returns the number of cardinal-direction passable neighbors of tile (tx, ty). */
function countCardinalPassableNeighbors(
  floorMap: NonNullable<GameWorld['floorMap']>,
  tx: number,
  ty: number,
): number {
  let neighbors = 0;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const nx = tx + dx;
    const ny = ty + dy;
    if (floorMap.tileMap.isPassable(nx, ny)) {
      neighbors += 1;
    }
  }
  return neighbors;
}

function isNarrowSpawnTile(
  floorMap: NonNullable<GameWorld['floorMap']>,
  tx: number,
  ty: number,
): boolean {
  return (
    countCardinalPassableNeighbors(floorMap, tx, ty) <= MAX_PASSABLE_NEIGHBORS_FOR_NARROW_SPAWN_TILE
  );
}

function isOnSquarePerimeter(dx: number, dy: number, radius: number): boolean {
  return Math.abs(dx) === radius || Math.abs(dy) === radius;
}

/**
 * Returns true when tile (tx, ty) is a legal enemy spawn: in-bounds, passable,
 * not a door, not a corridor or narrow chokepoint, inside a normal room (not
 * SAFE or BOSS_STAIR), and within [minDistanceSq, maxDistanceSq] of the player.
 */
function isValidEnemySpawnTile(
  world: GameWorld,
  tx: number,
  ty: number,
  playerX: number,
  playerY: number,
  minDistanceSq: number,
  maxDistanceSq: number,
): boolean {
  const floorMap = world.floorMap;
  if (!floorMap || !floorMap.tileMap.inBounds(tx, ty)) {
    return false;
  }
  if (!floorMap.tileMap.isPassable(tx, ty) || floorMap.tileMap.isDoor(tx, ty)) {
    return false;
  }
  const roomId = floorMap.roomGraph.getRoomAt(tx, ty);
  if (roomId < 0) {
    return false;
  }
  const room = floorMap.roomGraph.get(roomId);
  if (!room || room.role === RoomRole.SAFE || room.role === RoomRole.BOSS_STAIR) {
    return false;
  }
  const terrain = floorMap.terrain[ty * floorMap.width + tx];
  if (terrain === TerrainType.CORRIDOR || isNarrowSpawnTile(floorMap, tx, ty)) {
    return false;
  }
  const candidate = floorMap.tileToWorld(tx, ty);
  const distanceSq = distSq(candidate.x, candidate.y, playerX, playerY);
  return distanceSq >= minDistanceSq && distanceSq <= maxDistanceSq;
}

function isInvalidAmbientSpawn(
  world: GameWorld,
  x: number,
  y: number,
  playerX: number,
  playerY: number,
  minDistanceSq: number,
  maxDistanceSq: number,
): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return true;
  }
  const tile = floorMap.worldToTile(x, y);
  return !isValidEnemySpawnTile(
    world,
    tile.x,
    tile.y,
    playerX,
    playerY,
    minDistanceSq,
    maxDistanceSq,
  );
}

/**
 * Resolve a near-player ambient spawn position. Sampling is biased into the
 * engagement ring (so spawns appear close, keeping combat constant) while the
 * absolute validity ceiling stays at the ambient max distance, with a
 * whole-map passable-tile fallback. Returns null when no valid tile is found.
 */
export function resolveAmbientSpawnPoint(
  world: GameWorld,
  playerX: number,
  playerY: number,
): { x: number; y: number } | null {
  const pack = getWorldAmbientEnemyPack(world);
  const minDistanceFt = pack.spawnRadiusMin;
  const minDistanceSq = minDistanceFt * minDistanceFt;
  const maxDistanceSq = pack.despawnDistanceFt * pack.despawnDistanceFt;
  const ringPoint = resolveSpawnPosition(world, playerX, playerY, pack.engageRadiusFt, pack);
  if (
    !isInvalidAmbientSpawn(
      world,
      ringPoint.x,
      ringPoint.y,
      playerX,
      playerY,
      minDistanceSq,
      maxDistanceSq,
    )
  ) {
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
      !isInvalidAmbientSpawn(
        world,
        candidate.x,
        candidate.y,
        playerX,
        playerY,
        minDistanceSq,
        maxDistanceSq,
      )
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
    if (
      !isValidEnemySpawnTile(
        world,
        tile.x,
        tile.y,
        playerX,
        playerY,
        minSpawnDistSq,
        UNBOUNDED_SPAWN_DISTANCE_SQ,
      )
    ) {
      continue;
    }
    if (floorMap.roomGraph.getRoomAt(tile.x, tile.y) !== roomId) {
      continue;
    }
    return floorMap.tileToWorld(tile.x, tile.y);
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
  if (!floorMap || !world.floorScenario) {
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
  if (!world.floorScenario || world.state !== 'playing') {
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
  for (const slot of listStaticInventorySlots(bag)) {
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
  if (!world.floorScenario || world.floorScenario.runSummary) {
    return;
  }
  const players = query(world.ecs, [Player]);
  const player = players[0];
  const broadcastScore =
    player === undefined
      ? 0
      : Math.max(0, Math.floor(world.stores.broadcastScore.current[player] ?? 0));
  world.floorScenario.runSummary = {
    outcome,
    viewsEarned: broadcastScore * 10 + world.playerGold,
    fansEarned: Math.floor(broadcastScore / 4),
  };
}

function floor1ObjectiveTick(world: GameWorld): void {
  if (!world.floorScenario || world.state !== 'playing') {
    return;
  }

  const players = query(world.ecs, [Player, Position]);
  const player = players[0];
  if (player === undefined) {
    return;
  }

  for (const [eid, archetype] of [...world.floorScenario.enemyArchetypes.entries()]) {
    if (entityExists(world.ecs, eid)) {
      continue;
    }
    if (archetype === 'rat') {
      world.floorScenario.objective.ratsKilled += 1;
    } else {
      world.floorScenario.objective.slimesKilled += 1;
    }
    world.floorScenario.enemyArchetypes.delete(eid);
  }

  world.floorScenario.objective.goldCollected = world.playerGold;
  world.floorScenario.objective.junkCollected = countJunkInInventory(world);

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
    world.floorScenario.objective.ratsKilled,
  );
  setQuestCounter(
    world,
    FLOOR1_BOSS_UNLOCK_QUEST_ID,
    'kill-slimes',
    world.floorScenario.objective.slimesKilled,
  );

  const playerX = world.stores.position.x[player] ?? 0;
  const playerY = world.stores.position.y[player] ?? 0;
  const safeDx = playerX - world.floorScenario.objective.safeRoomPos.x;
  const safeDy = playerY - world.floorScenario.objective.safeRoomPos.y;
  if (Math.hypot(safeDx, safeDy) <= world.floorScenario.objective.markerRadiusFt) {
    world.floorScenario.objective.safeRoomDiscovered = true;
  }

  const objective = world.floorScenario.objective;
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
    beginFloor1SlimeRatBattle(world, playerX, playerY);
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
    for (const doorEid of world.floorScenario.bossRoomDoorEids.get('slime-rat') ?? []) {
      world.stores.doorState.isLocked[doorEid] = 0;
      world.stores.doorState.logicalOpen[doorEid] = 1;
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
    beginFloor1BossBattle(world, playerX, playerY);
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
    for (const doorEid of world.floorScenario.bossRoomDoorEids.get('staircase') ?? []) {
      world.stores.doorState.isLocked[doorEid] = 0;
      world.stores.doorState.logicalOpen[doorEid] = 1;
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
    world.floorScenario.failReason = 'stair_timeout';
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
  const objective = world.floorScenario?.objective;
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

  const bossEntryPoint = resolvePassableRoomCenter(floorMap, bossRoom);
  setComponent(world.ecs, playerEid, Position, bossEntryPoint);
  world.stores.velocity.x[playerEid] = 0;
  world.stores.velocity.y[playerEid] = 0;

  beginFloor1BossBattle(world, bossEntryPoint.x, bossEntryPoint.y);
  return true;
}

export function confirmFloor1StairDescend(world: GameWorld, playerEid: number): boolean {
  if (!world.floorScenario || world.state !== 'playing') {
    return false;
  }
  const objective = world.floorScenario.objective;
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

const SHOPKEEPER_POST_QUEST_ITEM_COSTS: Readonly<Record<string, number>> = {
  'throwing-knife': 18,
  'iron-sword': 24,
  'bone-club': 20,
  'frost-bow': 26,
  'plasma-pistol': 30,
  fireball: 28,
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
  const hasEquippable = bag
    ? listStaticInventorySlots(bag).some((slot) => isEquippableItem(slot.itemId))
    : false;
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
  for (const weaponId of FLOOR1_BASE_LOADOUT_CHOICE_IDS) {
    if (
      seen.has(weaponId) ||
      getWeaponDef(weaponId) === undefined ||
      STARTER_WEAPON_ID_TO_ITEM_ID.get(weaponId) === undefined
    ) {
      continue;
    }
    seen.add(weaponId);
    starterPool.push(weaponId);
  }
  const selectedChoiceIndex = world.floorScenario?.selectedChoiceIndex;
  const selectedWeaponId =
    world.floorScenario?.selectedWeaponId ??
    (selectedChoiceIndex === null || selectedChoiceIndex === undefined
      ? undefined
      : world.floorScenario?.starterChoices[selectedChoiceIndex]);
  const remainingWeaponIds = starterPool.filter((weaponId) => weaponId !== selectedWeaponId);
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
    .map((weaponId) => STARTER_WEAPON_ID_TO_ITEM_ID.get(weaponId))
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
      const bossDefeated =
        world.floorScenario?.objective.bossBattles.get('slime-rat')?.defeated === true;
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
  const quest =
    world.questLog.get(FLOOR1_SHOP_QUEST_ID) ?? acceptQuest(world, FLOOR1_SHOP_QUEST_ID);
  notifyQuestTalk(world, 'shopkeeper');
  if (quest?.status === 'active' && getShopkeeperStage(world) === 'awaiting-prize') {
    setTrackedQuest(world, FLOOR1_SHOP_QUEST_ID);
  }
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
  if (world.floorScenario?.objective.bossBattles.get('slime-rat')?.defeated === true) {
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
 * Equip any purchased, equippable items from the bag. Iterates the full bag
 * so the charm still gets equipped when a purchased two-handed weapon (whose
 * `mainHand`/`offHand` slot may already be occupied by the starter) can't be
 * accepted; the AI would otherwise stall on the first blocking item and
 * never reach the charm. Removes each equipped item from the bag and returns
 * true when at least one item was equipped this call.
 */
export function equipPurchasedGear(world: GameWorld, playerEid: number): boolean {
  const bag = world.inventories.get(playerEid);
  if (!bag) {
    return false;
  }
  let equippedAny = false;
  // Snapshot the equippable slugs before mutation — `removeItem` may reshape
  // the underlying array while we iterate.
  const equippableItemIds = listStaticInventorySlots(bag)
    .filter((s) => isEquippableItem(s.itemId))
    .map((s) => s.itemId);
  for (const itemId of equippableItemIds) {
    const def = getEquipmentDefForItem(itemId);
    if (!def) continue;
    const result = equip(world, playerEid, def, { force: true });
    if (result.ok) {
      removeItem(bag, itemId, 1);
      equippedAny = true;
    }
  }
  return equippedAny;
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

/** Select a spell to equip. Returns true when the spell was successfully learned. */
export function selectSpellFromBossBattle(
  world: GameWorld,
  playerEid: number,
  spellId: string,
): boolean {
  const offeredSpellIds = getOfferedBossRewardSpellIds(world);

  // Verify the spell is one of the currently offered options
  if (!offeredSpellIds.includes(spellId as Floor1BossRewardSpellId)) {
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
  const fallbackSpellId = DEFAULT_FLOOR1_BOSS_REWARD_SPELL_ID;
  memorizeSpell(world, playerEid, fallbackSpellId);
  world.featureUnlocks.spells = true;
  return true;
}
