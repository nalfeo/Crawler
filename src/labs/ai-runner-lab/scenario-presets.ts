import { addComponent, addEntity, query, removeEntity, set } from 'bitecs';
import {
  DoorState,
  DroppedItem,
  Enemy,
  Gold,
  Harvestable,
  Npc,
  Spawner,
  XpGem,
  clearEntityStores,
  spawnSpawner,
} from '../../core/index.js';
import { createBarrierRegistry, attachBarriersToFloorMap } from '../../core/barriers/index.js';
import { FloorMap } from '../../core/map/FloorMap.js';
import { RoomGraph } from '../../core/map/RoomGraph.js';
import { TileMap } from '../../core/map/TileMap.js';
import type { GameWorld } from '../../core/world.js';
import {
  BiomeType,
  RoomRole,
  TerrainType,
  TilePresets,
  type MapConfig,
} from '../../shared/map-types.js';
import { getWeaponDef } from '../../shared/weaponDefs.js';
import { getSpawnerArchetype, getSpawnerArchetypeIndex } from '../../game/spawners/registry.js';
import { equipStarterOrFallback } from '../../game/scenarios/starterWeaponEquip.js';

const RATS_NEST_INDEX = getSpawnerArchetypeIndex('rats-nest');
const RATS_NEST = getSpawnerArchetype('rats-nest');
const PRESET_STARTER_WEAPON_ID = 'sword';

/**
 * Default arena radius (ft) for the lab's spawner scenarios. Lab-only tuning
 * knob — the real game still uses each archetype's `arenaRadiusFt`. A 20 ft
 * radius (40 ft diameter) makes the open-fence ring wall fill the small lab
 * rooms so it's easy to eyeball the cage; it comfortably fits every spawner
 * slice (nearest wall ~26 ft) and stays clear of interior pillars.
 */
const LAB_SPAWNER_ARENA_RADIUS_FT = 20;

/**
 * Two-room sealed slice layout (shared by the sealable + unsealable presets).
 * The player spawns in a small side room and walks north through the doorway
 * into the larger arena room that holds the spawner. Entering the arena room
 * arms the arena (sealed-room path locks the door behind them; open-fence path
 * raises the ring once the player closes to arena radius).
 */
const SEALED_SLICE_SPAWNER_TILE = { x: 7, y: 7 } as const;
const SEALED_SLICE_PLAYER_TILE = { x: 7, y: 18 } as const;
const SEALED_SLICE_DOOR_TILE = { x: 7, y: 15 } as const;

export type AiRunnerScenarioPresetId =
  | 'floor1-default'
  | 'spawner-sealable-room'
  | 'spawner-unsealable-room'
  | 'spawner-cave'
  | 'terrain-wall-junctions';

export interface AiRunnerScenarioPreset {
  readonly id: AiRunnerScenarioPresetId;
  readonly label: string;
  readonly description: string;
  readonly defaultSeed: number;
  readonly configureWorld?: (world: GameWorld, playerEid: number) => void;
}

const SCENARIO_PRESETS: ReadonlyArray<AiRunnerScenarioPreset> = [
  {
    id: 'floor1-default',
    label: 'Default Floor 1',
    description: 'Real procedural Floor 1 (full map + authored objective flow).',
    defaultSeed: 42,
  },
  {
    id: 'spawner-sealable-room',
    label: 'Spawner: sealable room',
    description:
      'Small sealed-room slice with a lockable doorway entity. Arena should arm by locking the door.',
    defaultSeed: 4206,
    configureWorld: (world, playerEid) => {
      configureSpawnerSlice(world, playerEid, {
        floorMap: makeSealedRoomSliceMap(true),
        spawnDoorEntity: true,
        arenaRadiusFt: LAB_SPAWNER_ARENA_RADIUS_FT,
        spawnerTile: SEALED_SLICE_SPAWNER_TILE,
        playerTile: SEALED_SLICE_PLAYER_TILE,
        doorTile: SEALED_SLICE_DOOR_TILE,
      });
    },
  },
  {
    id: 'spawner-unsealable-room',
    label: 'Spawner: unsealable room',
    description:
      'Same two-room geometry but with no DoorState entity. Arena should enter the open-fence path when the player approaches.',
    defaultSeed: 4206,
    configureWorld: (world, playerEid) => {
      configureSpawnerSlice(world, playerEid, {
        floorMap: makeSealedRoomSliceMap(false),
        spawnDoorEntity: false,
        arenaRadiusFt: LAB_SPAWNER_ARENA_RADIUS_FT,
        spawnerTile: SEALED_SLICE_SPAWNER_TILE,
        playerTile: SEALED_SLICE_PLAYER_TILE,
        doorTile: SEALED_SLICE_DOOR_TILE,
      });
    },
  },
  {
    id: 'spawner-cave',
    label: 'Spawner: cave/open-fence',
    description:
      'Small open cave slice (no containing room graph). Arena should resolve as open-fence.',
    defaultSeed: 4208,
    configureWorld: (world, playerEid) => {
      configureSpawnerSlice(world, playerEid, {
        floorMap: makeCaveSliceMap(),
        spawnDoorEntity: false,
        arenaRadiusFt: LAB_SPAWNER_ARENA_RADIUS_FT,
      });
    },
  },
  {
    id: 'terrain-wall-junctions',
    label: 'Terrain: wall/door junctions',
    description:
      'Fully-lit inspection slice. Doors on all four wall orientations plus a stone/cave material seam, so wall-into-door junctions and both corner styles are visible without hunting a procedural floor.',
    defaultSeed: 4210,
    configureWorld: (world, playerEid) => {
      configureTerrainJunctionSlice(world, playerEid);
    },
  },
] as const;

export const AI_RUNNER_SCENARIO_PRESETS = SCENARIO_PRESETS;
export const DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID: AiRunnerScenarioPresetId = 'floor1-default';

export function getAiRunnerScenarioPreset(
  id: AiRunnerScenarioPresetId,
): AiRunnerScenarioPreset | undefined {
  return SCENARIO_PRESETS.find((preset) => preset.id === id);
}

interface SpawnerSliceOptions {
  readonly floorMap: FloorMap;
  readonly spawnDoorEntity: boolean;
  readonly arenaRadiusFt?: number;
  readonly spawnerTile?: { readonly x: number; readonly y: number };
  readonly playerTile?: { readonly x: number; readonly y: number };
  readonly doorTile?: { readonly x: number; readonly y: number };
}

/**
 * Shared world reset for every hand-authored lab slice: swap in the authored
 * map and clear the procedural-floor state that would otherwise leak in from
 * whatever the lab was running before (quest log, objective tick, arena
 * bookkeeping, stray entities).
 */
function resetSliceWorld(world: GameWorld, playerEid: number, floorMap: FloorMap): void {
  clearSliceEntities(world, playerEid);
  world.floorMap = floorMap;
  world.barriers = createBarrierRegistry();
  attachBarriersToFloorMap(world);
  world.spawnerArenaDoors.clear();
  world.spawnerArenaBarriers.clear();
  world.spawnerArenaEverArmed.clear();
  world.questLog.clear();
  world.questEvents.length = 0;
  world.floorObjectiveTick = null;
  world.floorScenario = null;
  // Lab presets have no floor objective, so hide the HUD countdown timer (it
  // would otherwise show a spurious FLOOR.MAX_DURATION_S fallback 5:00).
  world.hideFloorTimer = true;

  world.npcs.clear();
  world.doorLockConfigs.clear();
  world.goalFlags.clear();
}

function configureSpawnerSlice(
  world: GameWorld,
  playerEid: number,
  options: SpawnerSliceOptions,
): void {
  resetSliceWorld(world, playerEid, options.floorMap);

  const spawnerTile = options.spawnerTile ?? { x: 8, y: 8 };
  const playerTile = options.playerTile ?? { x: 9, y: 8 };
  const doorTile = options.doorTile ?? { x: 8, y: 6 };
  const spawnerPos = options.floorMap.tileToWorld(spawnerTile.x, spawnerTile.y);
  const playerPos = options.floorMap.tileToWorld(playerTile.x, playerTile.y);
  const spawnerEid = spawnSpawner(world, spawnerPos.x, spawnerPos.y, RATS_NEST?.hp ?? 80, {
    defIndex: RATS_NEST_INDEX,
    contactDamage: RATS_NEST?.contactDamage ?? 8,
    arenaRadiusFt: options.arenaRadiusFt ?? RATS_NEST?.arenaRadiusFt ?? 7,
  });

  world.stores.position.x[playerEid] = playerPos.x;
  world.stores.position.y[playerEid] = playerPos.y;
  world.stores.velocity.x[playerEid] = 0;
  world.stores.velocity.y[playerEid] = 0;
  world.stores.health.current[playerEid] = world.stores.health.max[playerEid] || 100;

  if (options.spawnDoorEntity) {
    const doorEid = addEntity(world.ecs);
    clearEntityStores(world, doorEid);
    addComponent(
      world.ecs,
      doorEid,
      set(DoorState, { tileX: doorTile.x, tileY: doorTile.y, logicalOpen: 1, isLocked: 0 }),
    );
  }

  const starterWeaponDef = getWeaponDef(PRESET_STARTER_WEAPON_ID);
  if (starterWeaponDef) {
    equipStarterOrFallback(world, PRESET_STARTER_WEAPON_ID, starterWeaponDef);
  }
  world.state = 'playing';
  world.stores.spawner.arenaState[spawnerEid] = 0;
}

function clearSliceEntities(world: GameWorld, playerEid: number): void {
  const doomed = new Set<number>();
  const collect = (eids: Iterable<number>): void => {
    for (const eid of eids) {
      if (eid !== playerEid) {
        doomed.add(eid);
      }
    }
  };
  collect(query(world.ecs, [Enemy]));
  collect(query(world.ecs, [DroppedItem]));
  collect(query(world.ecs, [XpGem]));
  collect(query(world.ecs, [Gold]));
  collect(query(world.ecs, [Harvestable]));
  collect(query(world.ecs, [Npc]));
  collect(query(world.ecs, [DoorState]));
  collect(query(world.ecs, [Spawner]));

  for (const eid of doomed) {
    clearEntityStores(world, eid);
    removeEntity(world.ecs, eid);
  }
}

function makeSealedRoomSliceMap(withDoor: boolean): FloorMap {
  const widthTiles = 16;
  const heightTiles = 22;
  // Divider row between the arena room (top) and the starter side room (bottom).
  const dividerY = SEALED_SLICE_DOOR_TILE.y;
  const doorX = SEALED_SLICE_DOOR_TILE.x;
  // Starter side-room interior spans this x-range on the bottom strip.
  const starterMinX = 5;
  const starterMaxX = 9;
  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizeFt: 4,
    biome: BiomeType.DUNGEON,
    seed: 1,
    roomWidthRange: [4, 14],
    roomHeightRange: [4, 16],
    maxRooms: 2,
    floorDensity: 0.5,
  };
  const idx = (x: number, y: number): number => y * widthTiles + x;
  const tileMap = new TileMap(widthTiles, heightTiles);
  tileMap.fill(TilePresets.FLOOR);
  const terrain = new Uint8Array(widthTiles * heightTiles);
  terrain.fill(TerrainType.STONE_FLOOR);

  const setWall = (x: number, y: number): void => {
    tileMap.flags[idx(x, y)] = TilePresets.WALL;
    terrain[idx(x, y)] = TerrainType.STONE_WALL;
  };

  // Outer border walls.
  for (let x = 0; x < widthTiles; x += 1) {
    setWall(x, 0);
    setWall(x, heightTiles - 1);
  }
  for (let y = 0; y < heightTiles; y += 1) {
    setWall(0, y);
    setWall(widthTiles - 1, y);
  }

  // Divider wall separating the arena room from the starter room, with a
  // single doorway gap the player walks through.
  for (let x = 1; x < widthTiles - 1; x += 1) {
    setWall(x, dividerY);
  }

  // Narrow the bottom strip into a small starter side room (interior x-range
  // starterMinX..starterMaxX); wall off the rest.
  for (let y = dividerY + 1; y < heightTiles - 1; y += 1) {
    for (let x = 1; x < widthTiles - 1; x += 1) {
      if (x < starterMinX || x > starterMaxX) {
        setWall(x, y);
      }
    }
  }

  // Carve the doorway gap. Sealable → a passable DOOR_OPEN tile the player
  // walks through; the arena seals + locks it shut on arming. Unsealable → a
  // plain open floor gap (no door to lock).
  if (withDoor) {
    tileMap.flags[idx(doorX, dividerY)] = TilePresets.DOOR_OPEN;
    terrain[idx(doorX, dividerY)] = TerrainType.DOOR;
  } else {
    tileMap.flags[idx(doorX, dividerY)] = TilePresets.FLOOR;
    terrain[idx(doorX, dividerY)] = TerrainType.STONE_FLOOR;
  }

  const graph = new RoomGraph();
  // Arena room (id 0): interior x 1..14, y 1..14 — contains the spawner. When
  // sealable, its doors list holds the doorway so the arena can lock it.
  graph.add(
    { x: 0, y: 0, width: widthTiles, height: dividerY + 1 },
    withDoor ? [{ x: doorX, y: dividerY, connectsTo: 1 }] : [],
    withDoor ? [1] : [],
    RoomRole.NORMAL,
  );
  // Starter side room (id 1): interior x 5..9, y 16..20 — the player spawns here.
  graph.add(
    {
      x: starterMinX - 1,
      y: dividerY,
      width: starterMaxX - starterMinX + 3,
      height: heightTiles - dividerY,
    },
    withDoor ? [{ x: doorX, y: dividerY, connectsTo: 0 }] : [],
    withDoor ? [0] : [],
    RoomRole.NORMAL,
  );
  return new FloorMap(config, tileMap, graph, terrain, { x: doorX, y: SEALED_SLICE_PLAYER_TILE.y });
}

function makeCaveSliceMap(): FloorMap {
  const widthTiles = 24;
  const heightTiles = 16;
  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizeFt: 4,
    biome: BiomeType.DUNGEON,
    seed: 1,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(widthTiles, heightTiles);
  tileMap.fill(TilePresets.FLOOR);
  for (let x = 0; x < widthTiles; x += 1) {
    tileMap.flags[x] = TilePresets.WALL;
    tileMap.flags[(heightTiles - 1) * widthTiles + x] = TilePresets.WALL;
  }
  for (let y = 0; y < heightTiles; y += 1) {
    tileMap.flags[y * widthTiles] = TilePresets.WALL;
    tileMap.flags[y * widthTiles + (widthTiles - 1)] = TilePresets.WALL;
  }
  tileMap.flags[5 * widthTiles + 10] = TilePresets.WALL;
  tileMap.flags[5 * widthTiles + 13] = TilePresets.WALL;
  tileMap.flags[10 * widthTiles + 10] = TilePresets.WALL;
  tileMap.flags[10 * widthTiles + 13] = TilePresets.WALL;
  const terrain = new Uint8Array(widthTiles * heightTiles);
  terrain.fill(TerrainType.CAVE_FLOOR);
  for (let x = 0; x < widthTiles; x += 1) {
    terrain[x] = TerrainType.CAVE_WALL;
    terrain[(heightTiles - 1) * widthTiles + x] = TerrainType.CAVE_WALL;
  }
  for (let y = 0; y < heightTiles; y += 1) {
    terrain[y * widthTiles] = TerrainType.CAVE_WALL;
    terrain[y * widthTiles + (widthTiles - 1)] = TerrainType.CAVE_WALL;
  }
  terrain[5 * widthTiles + 10] = TerrainType.CAVE_WALL;
  terrain[5 * widthTiles + 13] = TerrainType.CAVE_WALL;
  terrain[10 * widthTiles + 10] = TerrainType.CAVE_WALL;
  terrain[10 * widthTiles + 13] = TerrainType.CAVE_WALL;
  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 12, y: 8 });
}

/**
 * Hand-authored geometry for the `terrain-wall-junctions` inspection slice.
 *
 * Exists because the wall silhouette defects this scene exists to catch —
 * walls that stop short of a door, and cave-style rounded corners on cut-stone
 * architecture — are only observable at specific tile adjacencies. On a real
 * procedural floor those adjacencies exist but must be *hunted* for, and the
 * hunt is what makes "observe before done" expensive and unreliable: fog,
 * terrain streaming and camera framing all fight you. Here every junction the
 * renderer can produce is placed at a known tile, in one screen, fully lit.
 *
 * The chamber walls carry a doorway on all four orientations (doors in a
 * horizontal wall run exercise the N/S junction; doors in a vertical run
 * exercise E/W), and the vertical material seam at `materialSeamX` puts a
 * square-cornered stone cell directly beside a rounded cave cell along the same
 * continuous wall run — the cross-pack seam that ADR 0078 scopes validation to.
 */
const TERRAIN_JUNCTION_SLICE = {
  widthTiles: 24,
  heightTiles: 20,
  /** Chamber wall runs (inclusive bounds of the wall itself, not the interior). */
  roomMinX: 7,
  roomMaxX: 16,
  roomMinY: 6,
  roomMaxY: 13,
  /** Tiles with `x >= materialSeamX` use cave terrain; the rest use stone. */
  materialSeamX: 12,
  /**
   * One door per wall orientation, plus a second north door on the cave side of
   * the seam so the door junction is covered in BOTH packs rather than only the
   * dungeon pack whose bug prompted the scene.
   */
  doors: [
    { x: 10, y: 6 }, // north wall, stone side
    { x: 14, y: 6 }, // north wall, cave side
    { x: 11, y: 13 }, // south wall, stone side
    { x: 7, y: 10 }, // west wall, stone side
    { x: 16, y: 10 }, // east wall, cave side
  ],
  /**
   * Free-standing stubs. Elbows (L-shaped, two orthogonal neighbours) expose
   * CONVEX corners, which is the adjacency where `rounded`/`square` styles
   * differ most visibly. T-junctions (degree-3 cluster, three orthogonal
   * neighbours) exercise the three-neighbour silhouette case that the convex
   * corner alone misses. One elbow and one T-junction per material pack so
   * both corner styles are covered for each terrain type.
   */
  stubs: [
    // Elbows (convex corners): stone side, upper-left
    { x: 4, y: 3 },
    { x: 5, y: 3 },
    { x: 4, y: 4 },
    // Elbows (convex corners): cave side, upper-right
    { x: 19, y: 3 },
    { x: 20, y: 3 },
    { x: 19, y: 4 },
    // T-junction: stone side, lower-left — (5,16) has three wall neighbours
    { x: 4, y: 16 },
    { x: 5, y: 16 },
    { x: 6, y: 16 },
    { x: 5, y: 17 },
    // T-junction: cave side, lower-right — (20,16) has three wall neighbours
    { x: 19, y: 16 },
    { x: 20, y: 16 },
    { x: 21, y: 16 },
    { x: 20, y: 17 },
  ],
  /** Centre of the chamber, facing the north wall's two doors and the seam. */
  playerTile: { x: 11, y: 10 },
} as const;

/**
 * Terrain-only inspection scene: no spawner, no enemies, no objective. The
 * player is parked in the middle of the chamber so the north wall (two doors +
 * the material seam) fills the view on load.
 */
function configureTerrainJunctionSlice(world: GameWorld, playerEid: number): void {
  const floorMap = makeTerrainJunctionSliceMap();
  resetSliceWorld(world, playerEid, floorMap);

  const playerPos = floorMap.tileToWorld(
    TERRAIN_JUNCTION_SLICE.playerTile.x,
    TERRAIN_JUNCTION_SLICE.playerTile.y,
  );
  world.stores.position.x[playerEid] = playerPos.x;
  world.stores.position.y[playerEid] = playerPos.y;
  world.stores.velocity.x[playerEid] = 0;
  world.stores.velocity.y[playerEid] = 0;
  world.stores.health.current[playerEid] = world.stores.health.max[playerEid] || 100;

  const starterWeaponDef = getWeaponDef(PRESET_STARTER_WEAPON_ID);
  if (starterWeaponDef) {
    equipStarterOrFallback(world, PRESET_STARTER_WEAPON_ID, starterWeaponDef);
  }
  world.state = 'playing';
}

function makeTerrainJunctionSliceMap(): FloorMap {
  const {
    widthTiles,
    heightTiles,
    roomMinX,
    roomMaxX,
    roomMinY,
    roomMaxY,
    materialSeamX,
    doors,
    stubs,
    playerTile,
  } = TERRAIN_JUNCTION_SLICE;

  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizeFt: 4,
    biome: BiomeType.DUNGEON,
    seed: 1,
    roomWidthRange: [4, 12],
    roomHeightRange: [4, 12],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const idx = (x: number, y: number): number => y * widthTiles + x;
  const isCaveSide = (x: number): boolean => x >= materialSeamX;

  const tileMap = new TileMap(widthTiles, heightTiles);
  tileMap.fill(TilePresets.FLOOR);
  const terrain = new Uint8Array(widthTiles * heightTiles);
  for (let y = 0; y < heightTiles; y += 1) {
    for (let x = 0; x < widthTiles; x += 1) {
      terrain[idx(x, y)] = isCaveSide(x) ? TerrainType.CAVE_FLOOR : TerrainType.STONE_FLOOR;
    }
  }

  const setWall = (x: number, y: number): void => {
    tileMap.flags[idx(x, y)] = TilePresets.WALL;
    terrain[idx(x, y)] = isCaveSide(x) ? TerrainType.CAVE_WALL : TerrainType.STONE_WALL;
  };

  // Outer border.
  for (let x = 0; x < widthTiles; x += 1) {
    setWall(x, 0);
    setWall(x, heightTiles - 1);
  }
  for (let y = 0; y < heightTiles; y += 1) {
    setWall(0, y);
    setWall(widthTiles - 1, y);
  }

  // Central chamber walls — a closed rectangle, doors punched in below.
  for (let x = roomMinX; x <= roomMaxX; x += 1) {
    setWall(x, roomMinY);
    setWall(x, roomMaxY);
  }
  for (let y = roomMinY; y <= roomMaxY; y += 1) {
    setWall(roomMinX, y);
    setWall(roomMaxX, y);
  }

  for (const stub of stubs) {
    setWall(stub.x, stub.y);
  }

  // Doors are punched AFTER the wall runs so a door always sits in a wall and
  // the flanking cells are guaranteed to be wall — which is precisely the
  // junction under inspection.
  for (const door of doors) {
    tileMap.flags[idx(door.x, door.y)] = TilePresets.DOOR_OPEN;
    terrain[idx(door.x, door.y)] = TerrainType.DOOR;
  }

  return new FloorMap(config, tileMap, new RoomGraph(), terrain, {
    x: playerTile.x,
    y: playerTile.y,
  });
}

export const AI_RUNNER_SCENARIO_PRESET_TEST_HOOKS = {
  makeSealedRoomSliceMap,
  makeCaveSliceMap,
  makeTerrainJunctionSliceMap,
  TERRAIN_JUNCTION_SLICE,
} as const;
