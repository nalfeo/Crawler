import { hasComponent, query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { getActiveWeaponDef } from '../../src/core/active-weapon.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  Companion,
  Enemy,
  Invincible,
  PartySlot,
  Position,
  Prop,
  Size,
  Sprite,
} from '../../src/core/index.js';
import {
  FLOOR3_TIMEOUT_GOAL_ID,
  _resolveFloor3AmbientSpawnPoint,
  _resolveFloor3WildSpawnWeights,
  floor3WildDirectorSystem,
  initializeFloor3Scenario,
  selectFloor3LoadoutOption,
} from '../../src/game/floor3Scenario.js';
import { getFloorEnemyPack } from '../../src/shared/enemy-packs.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import {
  AFFINITY_RING,
  affinityMultiplier,
  type Affinity,
} from '../../src/shared/data/floor3/affinity.js';
import { getPetSpecies } from '../../src/shared/data/floor3/species.js';
import { _STARTER_OFFER_SIZE } from '../../src/game/floor3Recruiting.js';
import { TeamId } from '../../src/shared/constants.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { safeRoomSystem } from '../../src/core/safe-space.js';
import { GAME } from '../../src/shared/constants.js';
import {
  BiomeType,
  RoomRole,
  TerrainType,
  TilePresets,
  type MapConfig,
} from '../../src/shared/map-types.js';
import { FLOOR3_COMPANION_PROFESSOR_NPC_ID } from '../../src/shared/npc-types.js';

function createFloor3World(seed: number) {
  const world = createTestWorld({ seed, floor: 3 });
  const playerEid = spawnPlayer(world, 0, 0);
  initializeFloor3Scenario(world, playerEid);
  // Confirm the starter-Companion pick (spec R5 §6.1) so the world lands in
  // 'playing' the way a real run does — `initializeFloor3Scenario` now pauses
  // on 'loadout' until a pick is made, mirroring Floor 1's weapon loadout.
  selectFloor3LoadoutOption(world, 0);
  return { world, playerEid };
}

function setSingleBiomeZone(world: ReturnType<typeof createTestWorld>, affinity: Affinity): void {
  const floorMap = world.floorMap;
  if (!floorMap) throw new Error('floor3 scenario must initialize a floor map');
  const spawn = floorMap.playerSpawn;
  (
    floorMap as unknown as {
      territoryZones: Array<{
        familyIndex: number;
        centerX: number;
        centerY: number;
        radius: number;
      }>;
    }
  ).territoryZones = [
    {
      familyIndex: AFFINITY_RING.indexOf(affinity),
      centerX: spawn.x,
      centerY: spawn.y,
      radius: Math.max(floorMap.width, floorMap.height),
    },
  ];
  if (world.floorExtendedState) {
    world.floorExtendedState.floor3BiomeAffinities = AFFINITY_RING.slice();
  }
}

function movePlayerToFirstTerritory(
  world: ReturnType<typeof createTestWorld>,
  playerEid: number,
): void {
  const floorMap = world.floorMap;
  const zone = floorMap?.territoryZones[0];
  if (!floorMap || !zone) throw new Error('floor3 scenario must expose at least one biome zone');
  const position = floorMap.tileToWorld(zone.centerX, zone.centerY);
  world.stores.position.x[playerEid] = position.x;
  world.stores.position.y[playerEid] = position.y;
}

function findReachableUnlabeledTile(world: ReturnType<typeof createTestWorld>): {
  x: number;
  y: number;
} {
  const floorMap = world.floorMap;
  if (!floorMap) throw new Error('floor3 scenario must initialize a floor map');
  for (let y = 1; y < floorMap.height - 1; y += 1) {
    for (let x = 1; x < floorMap.width - 1; x += 1) {
      if (!floorMap.tileMap.isPassable(x, y)) continue;
      if (floorMap.roomGraph.getRoomAt(x, y) >= 0) continue;
      return floorMap.tileToWorld(x, y);
    }
  }
  throw new Error('expected at least one unlabeled passable overworld tile');
}

function makeSpawnOnlyFloor3Map(): FloorMap {
  const widthTiles = 30;
  const heightTiles = 30;
  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizeFt: 4,
    biome: BiomeType.CAVE_SYSTEM_BIOMES,
    seed: 1,
    roomWidthRange: [8, 8],
    roomHeightRange: [8, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(widthTiles, heightTiles);
  tileMap.fill(TilePresets.WALL);
  const terrain = new Uint8Array(widthTiles * heightTiles).fill(TerrainType.CAVE_WALL);
  const graph = new RoomGraph();
  const roomId = graph.add({ x: 10, y: 10, width: 8, height: 8 }, [], [], RoomRole.SPAWN);
  const room = graph.get(roomId)!;
  for (let y = room.bounds.y + 1; y < room.bounds.y + room.bounds.height - 1; y += 1) {
    for (let x = room.bounds.x + 1; x < room.bounds.x + room.bounds.width - 1; x += 1) {
      tileMap.setFlags(x, y, TilePresets.FLOOR);
      terrain[y * widthTiles + x] = TerrainType.CAVE_FLOOR;
    }
  }
  return new FloorMap(config, tileMap, graph, terrain, { x: 12, y: 12 });
}

describe('Floor 3 overworld + wild spawns', () => {
  it('reserves 75% affinity-matched mass and 25% neutral mass in one biome', () => {
    const { world, playerEid } = createFloor3World(301);
    const biomeAffinity: Affinity = 'ember';
    setSingleBiomeZone(world, biomeAffinity);
    const playerX = world.stores.position.x[playerEid] ?? 0;
    const playerY = world.stores.position.y[playerEid] ?? 0;
    const weights = _resolveFloor3WildSpawnWeights(world, playerX, playerY);
    const pack = getFloorEnemyPack('floor3-wild');
    expect(pack).toBeDefined();

    let matchingMass = 0;
    let neutralMass = 0;
    let offBiomeMass = 0;
    for (const archetype of pack?.archetypes ?? []) {
      const species = archetype.speciesId ? getPetSpecies(archetype.speciesId) : undefined;
      const probability = weights.get(archetype.id) ?? 0;
      if (!species) {
        offBiomeMass += probability;
        continue;
      }
      if (species.affinity === biomeAffinity) {
        matchingMass += probability;
      } else if (affinityMultiplier(biomeAffinity, species.affinity) === 1) {
        neutralMass += probability;
      } else {
        offBiomeMass += probability;
      }
    }

    expect(matchingMass).toBeCloseTo(0.75, 6);
    expect(neutralMass).toBeCloseTo(0.25, 6);
    expect(offBiomeMass).toBeCloseTo(0, 6);
  });

  it('keeps the same seed deterministic for biome zones and the first wild spawn roll', () => {
    const left = createFloor3World(777);
    const right = createFloor3World(777);
    movePlayerToFirstTerritory(left.world, left.playerEid);
    movePlayerToFirstTerritory(right.world, right.playerEid);

    expect(left.world.floorMap?.territoryZones).toEqual(right.world.floorMap?.territoryZones);
    expect(left.world.floorMap?.playerSpawn).toEqual(right.world.floorMap?.playerSpawn);

    let leftAmbient: string[] = [];
    let rightAmbient: string[] = [];
    for (let i = 0; i < 8 && leftAmbient.length === 0; i += 1) {
      left.world.elapsedMs += 1_000;
      right.world.elapsedMs += 1_000;
      floor3WildDirectorSystem(left.world);
      floor3WildDirectorSystem(right.world);
      leftAmbient = Array.from(
        left.world.floorExtendedState?.ambientEnemyArchetypes?.values() ?? [],
      );
      rightAmbient = Array.from(
        right.world.floorExtendedState?.ambientEnemyArchetypes?.values() ?? [],
      );
    }

    expect(leftAmbient.length).toBeGreaterThan(0);
    expect(leftAmbient).toEqual(rightAmbient);
  });

  it('makes the Floor 3 Wrangler invincible and unarmed', () => {
    const { world, playerEid } = createFloor3World(555);
    expect(hasComponent(world.ecs, playerEid, Invincible)).toBe(true);
    expect(getActiveWeaponDef(world)).toBeUndefined();
  });

  it('places props from the floor3 manifest during scenario initialization', () => {
    const { world } = createFloor3World(556);
    expect(query(world.ecs, [Prop]).length).toBeGreaterThan(0);
  });

  it('times out when the Floor 3 manifest countdown expires', () => {
    const { world } = createFloor3World(557);
    const manifest = getFloorManifest('floor3');
    expect(manifest).toBeDefined();
    world.elapsedMs = (manifest?.timer.durationMs ?? 0) + 1;
    world.floorObjectiveTick?.(world);
    expect(world.goalFlags.get(FLOOR3_TIMEOUT_GOAL_ID)).toBe(true);
    expect(world.state).toBe('game_over');
  });

  it('stops the countdown while the player stands in the Floor 3 entrance safe room', () => {
    // Issue #3674: after Floor 1 the entrance room is a time-stopping safe room,
    // so its credit must push the manifest deadline out by the time spent there.
    const { world, playerEid } = createFloor3World(558);
    const durationMs = getFloorManifest('floor3')?.timer.durationMs ?? 0;
    const spawnRoom = world.floorMap?.spawnRoom;
    expect(spawnRoom).toBeTruthy();

    const center = world.floorMap!.tileToWorld(
      spawnRoom!.bounds.x + Math.floor(spawnRoom!.bounds.width / 2),
      spawnRoom!.bounds.y + Math.floor(spawnRoom!.bounds.height / 2),
    );
    world.stores.position.x[playerEid] = center.x;
    world.stores.position.y[playerEid] = center.y;

    const creditedFrames = 10;
    for (let i = 0; i < creditedFrames; i += 1) {
      safeRoomSystem(world);
    }
    expect(world.playerInTimeStoppingSafeRoom).toBe(true);
    expect(world.safeRoomTimerCreditMs).toBeCloseTo(creditedFrames * GAME.DELTA_MS, 6);

    // The raw manifest wall alone no longer ends the floor...
    world.elapsedMs = durationMs + 1;
    world.floorObjectiveTick?.(world);
    expect(world.goalFlags.get(FLOOR3_TIMEOUT_GOAL_ID)).not.toBe(true);
    expect(world.state).toBe('playing');

    // ...but the credited deadline still does.
    world.elapsedMs = durationMs + world.safeRoomTimerCreditMs + 1;
    world.floorObjectiveTick?.(world);
    expect(world.goalFlags.get(FLOOR3_TIMEOUT_GOAL_ID)).toBe(true);
    expect(world.state).toBe('game_over');
  });

  it('rejects shared ambient candidates inside the Floor 3 safe entrance room', () => {
    const world = createTestWorld({ seed: 42, floor: 3 });
    world.floorId = 'floor3';
    world.floorMap = makeSpawnOnlyFloor3Map();
    const player = spawnPlayer(world, 0, 0);
    const playerX = world.stores.position.x[player] ?? 0;
    const playerY = world.stores.position.y[player] ?? 0;

    const spawnPoint = _resolveFloor3AmbientSpawnPoint(world, playerX, playerY);

    expect(spawnPoint).toBeNull();
  });

  it('still spawns ambient wilds when the player stands on an unlabeled overworld tile', () => {
    const { world, playerEid } = createFloor3World(1203);
    const unlabeled = findReachableUnlabeledTile(world);
    world.stores.position.x[playerEid] = unlabeled.x;
    world.stores.position.y[playerEid] = unlabeled.y;

    let ambientIds: number[] = [];
    for (let i = 0; i < 12 && ambientIds.length === 0; i += 1) {
      world.elapsedMs += 1_000;
      floor3WildDirectorSystem(world);
      ambientIds = Array.from(world.floorExtendedState?.ambientEnemyArchetypes?.keys() ?? []);
    }
    expect(ambientIds.length).toBeGreaterThan(0);
  });

  it('spawns wild creatures on the enemy team without Companion or PartySlot tags', () => {
    const { world, playerEid } = createFloor3World(902);
    movePlayerToFirstTerritory(world, playerEid);
    let ambientIds: number[] = [];
    for (let i = 0; i < 8 && ambientIds.length === 0; i += 1) {
      world.elapsedMs += 1_000;
      floor3WildDirectorSystem(world);
      ambientIds = Array.from(world.floorExtendedState?.ambientEnemyArchetypes?.keys() ?? []);
    }
    expect(ambientIds.length).toBeGreaterThan(0);
    for (const eid of ambientIds) {
      expect(hasComponent(world.ecs, eid, Enemy)).toBe(true);
      expect(hasComponent(world.ecs, eid, Companion)).toBe(false);
      expect(hasComponent(world.ecs, eid, PartySlot)).toBe(false);
      expect(world.stores.team.id[eid]).toBe(TeamId.ENEMY);
    }
    // The starter Companion (spec R5 §6.1, picked via `createFloor3World`) is
    // the only Companion+PartySlot entity — wild ambient spawns above must
    // never also carry that combo.
    expect(query(world.ecs, [Companion, PartySlot]).length).toBe(1);
  });
});

describe('Floor 3 starter Companion pick (spec R5 §6.1)', () => {
  it('pauses on loadout with a distinct-species starter offer until a pick is confirmed', () => {
    const world = createTestWorld({ seed: 1301, floor: 3 });
    const playerEid = spawnPlayer(world, 0, 0);
    initializeFloor3Scenario(world, playerEid);

    expect(world.state).toBe('loadout');
    const offer = world.floorExtendedState?.floor3StarterOffer ?? [];
    expect(offer.length).toBe(_STARTER_OFFER_SIZE);
    expect(new Set(offer).size).toBe(offer.length);
    expect(query(world.ecs, [Companion, PartySlot]).length).toBe(0);
    const professorEid = world.floorExtendedState?.floor3CompanionProfessorNpcEid;
    expect(professorEid).toBeGreaterThan(0);
    expect(world.npcs.get(professorEid!)?.defId).toBe(FLOOR3_COMPANION_PROFESSOR_NPC_ID);
    expect(hasComponent(world.ecs, professorEid!, Position)).toBe(true);
    expect({
      x: world.stores.position.x[professorEid!],
      y: world.stores.position.y[professorEid!],
    }).not.toEqual({
      x: world.stores.position.x[playerEid],
      y: world.stores.position.y[playerEid],
    });
  });

  it('recruits the picked species into the party and resumes play', () => {
    const world = createTestWorld({ seed: 1302, floor: 3 });
    const playerEid = spawnPlayer(world, 0, 0);
    initializeFloor3Scenario(world, playerEid);
    const offer = world.floorExtendedState?.floor3StarterOffer ?? [];
    expect(offer.length).toBeGreaterThan(0);

    selectFloor3LoadoutOption(world, 0);

    expect(world.state).toBe('playing');
    expect(world.floorExtendedState?.floor3StarterOffer ?? []).toEqual([]);
    const companions = query(world.ecs, [Companion, PartySlot]);
    expect(companions.length).toBe(1);
    const starterEid = companions[0]!;
    expect(world.stores.team.id[starterEid]).toBe(TeamId.PLAYER);
    const selectedSpecies = getPetSpecies(offer[0]!);
    expect(selectedSpecies).toBeDefined();
    const expectedArchetype = getFloorEnemyPack('floor3-wild')?.archetypes.find((archetype) => {
      const species = archetype.speciesId ? getPetSpecies(archetype.speciesId) : undefined;
      return (
        species?.speciesId === selectedSpecies?.speciesId ||
        archetype.id.endsWith(`-${selectedSpecies?.fightingStyle}`)
      );
    });
    expect(expectedArchetype).toBeDefined();
    expect(hasComponent(world.ecs, starterEid, Sprite)).toBe(true);
    expect(hasComponent(world.ecs, starterEid, Size)).toBe(true);
    expect(world.stores.sprite.textureId[starterEid]).toBe(expectedArchetype!.spriteTexture);
    expect(world.stores.size.radius[starterEid]).toBeCloseTo(
      expectedArchetype!.collisionRadius ??
        Math.max(expectedArchetype!.spriteWidth, expectedArchetype!.spriteHeight) * 0.5,
      6,
    );
    expect(world.enemyAppearanceKeys.get(starterEid)).toBe(expectedArchetype!.id);
  });

  it('falls back to the first offer option for an out-of-range index instead of stranding the pause', () => {
    const world = createTestWorld({ seed: 1303, floor: 3 });
    const playerEid = spawnPlayer(world, 0, 0);
    initializeFloor3Scenario(world, playerEid);

    selectFloor3LoadoutOption(world, 999);

    expect(world.state).toBe('playing');
    expect(query(world.ecs, [Companion, PartySlot]).length).toBe(1);
  });

  it('resumes play when loadout is active but the starter offer is missing', () => {
    const world = createTestWorld({ seed: 1305, floor: 3 });
    const playerEid = spawnPlayer(world, 0, 0);
    initializeFloor3Scenario(world, playerEid);
    world.floorExtendedState = { ...world.floorExtendedState, floor3StarterOffer: [] };
    world.state = 'loadout';

    selectFloor3LoadoutOption(world, 0);

    expect(world.state).toBe('playing');
    expect(query(world.ecs, [Companion, PartySlot]).length).toBe(0);
  });

  it('is a no-op once play has already resumed', () => {
    const world = createTestWorld({ seed: 1304, floor: 3 });
    const playerEid = spawnPlayer(world, 0, 0);
    initializeFloor3Scenario(world, playerEid);
    selectFloor3LoadoutOption(world, 0);
    expect(world.state).toBe('playing');

    selectFloor3LoadoutOption(world, 1);

    expect(world.state).toBe('playing');
    expect(query(world.ecs, [Companion, PartySlot]).length).toBe(1);
  });
});
