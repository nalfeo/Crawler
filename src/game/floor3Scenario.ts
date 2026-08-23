import { addComponent, hasComponent, query, set, setComponent } from 'bitecs';
import {
  BroadcastScore,
  Health,
  Player,
  Position,
  Size,
  Sprite,
  Team,
  type GameWorld,
} from '../core/index.js';
import { attachBarriersToFloorMap } from '../core/barriers/index.js';
import { getGenerator } from '../core/map/generators/registry.js';
import { setEnemyAppearanceKey, spawnBehaviorEnemy } from '../core/spawners/combatants.js';
import { SHAPE_CIRCLE } from '../core/physics-defs.js';
import {
  getFloorEnemyPack,
  type EnemyArchetypeDef,
  type EnemyPackDef,
} from '../shared/enemy-packs.js';
import { getFloorManifest } from '../shared/floor-registry.js';
import {
  AFFINITY_RING,
  affinityMultiplier,
  type Affinity,
} from '../shared/data/floor3/affinity.js';
import { getPetSpecies, type PetSpeciesDef } from '../shared/data/floor3/species.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { SeededRandom as SeededRandomClass, hashStringToSeed } from '../shared/random.js';
import { BiomeType, RoomRole, TerrainType, type MapConfig } from '../shared/map-types.js';
import { TeamId } from '../shared/constants.js';
import {
  countDirectorEnemies,
  countEngagingEnemies,
  evictFurthestAmbient,
  getSpawnerState,
  pruneAmbientOutOfRange,
  resolveAmbientSpawnPoint,
  scaleAmbientSpawnStats,
  initializePlayerWeaponSkills,
} from './floorScenario.js';
import {
  mixSpawnZoneWeights,
  normalizeSpawnZoneWeights,
  pickFromSpawnZones,
  type SpawnZoneWeights,
  type SpawnZoneMix,
} from './spawn-zones.js';
import { _aiTypeForSpecies } from './floor3Recruiting.js';
import { restorePlayerCarryover } from './playerCarryover.js';
import { equipStarterOrFallback } from './scenarios/starterWeaponEquip.js';
import { AI_TYPE } from './enemyAISystem.js';
import { addStatModifier, removeStatModifiers } from './systems/statsSystem.js';
import { placePropsForFloor } from './systems/propPlacer.js';
import type { PlayerCarryoverSnapshot } from './playerCarryover.js';

export const FLOOR3_BIOME_MATCH_SPAWN_SHARE = 0.75;
export const FLOOR3_BIOME_NEUTRAL_SPAWN_SHARE = 0.25;
export const FLOOR3_WILD_TEAM_ID = TeamId.ENEMY;
export const FLOOR3_TIMEOUT_GOAL_ID = 'floor3-timeout';

function getFloor3WildPack(): EnemyPackDef {
  const pack = getFloorEnemyPack('floor3-wild');
  if (!pack) {
    throw new Error('Missing floor3-wild enemy pack');
  }
  return pack;
}

function addWeight(weights: Map<string, number>, archetypeId: string, weight: number): void {
  if (!(weight > 0) || !Number.isFinite(weight)) return;
  weights.set(archetypeId, (weights.get(archetypeId) ?? 0) + weight);
}

function resolveWildSpecies(archetype: EnemyArchetypeDef): PetSpeciesDef | undefined {
  return archetype.speciesId ? getPetSpecies(archetype.speciesId) : undefined;
}

function isNeutralAffinityForBiome(biomeAffinity: Affinity, speciesAffinity: Affinity): boolean {
  return (
    speciesAffinity !== biomeAffinity && affinityMultiplier(biomeAffinity, speciesAffinity) === 1
  );
}

function collectContainedBiomeAffinities(world: GameWorld, x: number, y: number): Affinity[] {
  const floorMap = world.floorMap;
  if (!floorMap) return [];
  const tile = floorMap.worldToTile(x, y);
  const affinities = world.floorExtendedState?.floor3BiomeAffinities ?? AFFINITY_RING;
  const territoryZones = floorMap.territoryZones ?? [];
  const active: Affinity[] = [];
  for (const zone of territoryZones) {
    const dx = tile.x - zone.centerX;
    const dy = tile.y - zone.centerY;
    if (dx * dx + dy * dy > zone.radius * zone.radius) continue;
    const affinity = affinities[zone.familyIndex];
    if (affinity) active.push(affinity);
  }
  if (active.length > 0) return active;

  let nearest: { affinity: Affinity; d2: number } | null = null;
  for (const zone of territoryZones) {
    const affinity = affinities[zone.familyIndex];
    if (!affinity) continue;
    const dx = tile.x - zone.centerX;
    const dy = tile.y - zone.centerY;
    const d2 = dx * dx + dy * dy;
    if (nearest === null || d2 < nearest.d2) {
      nearest = { affinity, d2 };
    }
  }
  return nearest ? [nearest.affinity] : [];
}

function collectFloor3AffinityWeights(
  affinities: readonly Affinity[],
  predicate: (biomeAffinity: Affinity, speciesAffinity: Affinity) => boolean,
): Map<string, number> {
  const weights = new Map<string, number>();
  const pack = getFloor3WildPack();
  for (const biomeAffinity of affinities) {
    for (const archetype of pack.archetypes) {
      const species = resolveWildSpecies(archetype);
      if (!species) continue;
      if (!predicate(biomeAffinity, species.affinity)) continue;
      addWeight(weights, archetype.id, archetype.spawnWeight);
    }
  }
  return weights;
}

export function resolveFloor3WildSpawnWeights(
  world: GameWorld,
  x: number,
  y: number,
): ReadonlyMap<string, number> {
  const affinities = collectContainedBiomeAffinities(world, x, y);
  const pack = getFloor3WildPack();
  if (affinities.length === 0) {
    const fallback = new Map<string, number>();
    for (const archetype of pack.archetypes) {
      addWeight(fallback, archetype.id, archetype.spawnWeight);
    }
    return normalizeSpawnZoneWeights(fallback);
  }

  const matching = collectFloor3AffinityWeights(
    affinities,
    (biomeAffinity, speciesAffinity) => speciesAffinity === biomeAffinity,
  );
  const neutral = collectFloor3AffinityWeights(affinities, isNeutralAffinityForBiome);
  const mix: SpawnZoneMix[] = [];
  if (matching.size > 0) {
    mix.push({ weights: matching, share: FLOOR3_BIOME_MATCH_SPAWN_SHARE });
  }
  if (neutral.size > 0) {
    mix.push({ weights: neutral, share: FLOOR3_BIOME_NEUTRAL_SPAWN_SHARE });
  }
  return mix.length > 0 ? mixSpawnZoneWeights(mix) : new Map<string, number>();
}

function pickFloor3WildArchetype(world: GameWorld, x: number, y: number): EnemyArchetypeDef {
  const pack = getFloor3WildPack();
  const weights = resolveFloor3WildSpawnWeights(world, x, y);
  const { pickedId } = pickFromSpawnZones(
    [weights] as const satisfies readonly SpawnZoneWeights[],
    () => world.rng.next(),
  );
  const picked = pickedId ? pack.archetypes.find((entry) => entry.id === pickedId) : undefined;
  if (picked) return picked;
  const fallback = pack.archetypes[0];
  if (!fallback) {
    throw new Error('No archetypes available in floor3-wild enemy pack');
  }
  return fallback;
}

function resolveFloor3ArchetypeAiType(archetype: EnemyArchetypeDef): number {
  const species = resolveWildSpecies(archetype);
  if (species) {
    return _aiTypeForSpecies(species);
  }
  switch (archetype.aiType) {
    case 'ranged':
      return AI_TYPE.RANGED;
    case 'leaper':
      return AI_TYPE.LEAPER;
    case 'guardian':
      return AI_TYPE.GUARDIAN;
    case 'support':
      return AI_TYPE.SUPPORT;
    default:
      return AI_TYPE.CHASE;
  }
}

function spawnFloor3WildArchetype(world: GameWorld, x: number, y: number): number {
  const archetype = pickFloor3WildArchetype(world, x, y);
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
    resolveFloor3ArchetypeAiType(archetype),
    speed,
    archetype.detectRange,
    archetype.aiType === 'ranged' || archetype.aiType === 'support'
      ? archetype.detectRange * 0.65
      : 0,
  );
  addComponent(world.ecs, eid, set(Team, { id: FLOOR3_WILD_TEAM_ID }));
  setComponent(world.ecs, eid, Sprite, {
    textureId: archetype.spriteTexture,
    width: archetype.spriteWidth,
    height: archetype.spriteHeight,
  });
  setComponent(world.ecs, eid, Size, {
    radius:
      archetype.collisionRadius ?? Math.max(archetype.spriteWidth, archetype.spriteHeight) * 0.5,
    halfWidth: 0,
    halfHeight: 0,
    shape: SHAPE_CIRCLE,
  });
  setEnemyAppearanceKey(world, eid, archetype.id);
  world.floorExtendedState?.ambientEnemyArchetypes?.set(eid, archetype.id);
  return eid;
}

function countFloor3CardinalPassableNeighbors(
  floorMap: NonNullable<GameWorld['floorMap']>,
  tx: number,
  ty: number,
): number {
  let count = 0;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    if (floorMap.tileMap.isPassable(tx + dx, ty + dy)) count += 1;
  }
  return count;
}

function isValidFloor3AmbientSpawnTile(
  world: GameWorld,
  tx: number,
  ty: number,
  playerX: number,
  playerY: number,
  minDistanceSq: number,
  maxDistanceSq: number,
): boolean {
  const floorMap = world.floorMap;
  if (!floorMap || !floorMap.tileMap.inBounds(tx, ty)) return false;
  if (!floorMap.tileMap.isPassable(tx, ty) || floorMap.tileMap.isDoor(tx, ty)) return false;
  const roomId = floorMap.roomGraph.getRoomAt(tx, ty);
  if (roomId >= 0) {
    const room = floorMap.roomGraph.get(roomId);
    if (
      room &&
      (room.role === RoomRole.SAFE ||
        room.role === RoomRole.BOSS_STAIR ||
        room.role === RoomRole.SPAWN)
    ) {
      return false;
    }
  }
  const terrain = floorMap.terrain[ty * floorMap.width + tx];
  if (terrain === TerrainType.CORRIDOR) return false;
  if (countFloor3CardinalPassableNeighbors(floorMap, tx, ty) <= 1) return false;
  const candidate = floorMap.tileToWorld(tx, ty);
  const dx = candidate.x - playerX;
  const dy = candidate.y - playerY;
  const distanceSq = dx * dx + dy * dy;
  return distanceSq >= minDistanceSq && distanceSq <= maxDistanceSq;
}

function resolveFloor3AmbientSpawnPoint(
  world: GameWorld,
  playerX: number,
  playerY: number,
): { x: number; y: number } | null {
  const candidate = resolveAmbientSpawnPoint(world, playerX, playerY);
  if (candidate) return candidate;
  const floorMap = world.floorMap;
  const pack = getFloor3WildPack();
  if (!floorMap) return null;
  const minDistanceSq = pack.spawnRadiusMin * pack.spawnRadiusMin;
  const maxDistanceSq = pack.despawnDistanceFt * pack.despawnDistanceFt;
  for (let i = 0; i < 256; i += 1) {
    const tx = world.rng.nextInt(0, floorMap.width - 1);
    const ty = world.rng.nextInt(0, floorMap.height - 1);
    if (
      !isValidFloor3AmbientSpawnTile(world, tx, ty, playerX, playerY, minDistanceSq, maxDistanceSq)
    ) {
      continue;
    }
    return floorMap.tileToWorld(tx, ty);
  }
  return null;
}

export function floor3WildDirectorSystem(world: GameWorld): void {
  if (world.state !== 'playing') return;
  const player = query(world.ecs, [Player, Position])[0];
  if (player === undefined) return;

  const pack = getFloor3WildPack();
  const playerX = world.stores.position.x[player] ?? 0;
  const playerY = world.stores.position.y[player] ?? 0;
  pruneAmbientOutOfRange(world, playerX, playerY);
  const overflow = countDirectorEnemies(world) - pack.enemyCap;
  if (overflow > 0) {
    pruneAmbientOutOfRange(world, playerX, playerY);
    const engageRadiusSq = pack.engageRadiusFt * pack.engageRadiusFt;
    evictFurthestAmbient(world, playerX, playerY, engageRadiusSq, overflow);
  }

  const state = getSpawnerState(world);
  if (world.elapsedMs - state.lastSpawnMs < pack.spawnIntervalMs) {
    return;
  }
  const engageRadiusSq = pack.engageRadiusFt * pack.engageRadiusFt;
  const engaging = countEngagingEnemies(world, playerX, playerY, engageRadiusSq);
  if (engaging >= pack.engageTarget) return;

  const burst = Math.min(pack.engageTarget - engaging, pack.maxSpawnsPerTick);
  for (let i = 0; i < burst; i += 1) {
    if (countDirectorEnemies(world) >= pack.enemyCap) {
      if (evictFurthestAmbient(world, playerX, playerY, engageRadiusSq, 1) === 0) break;
    }
    const spawnPoint = resolveFloor3AmbientSpawnPoint(world, playerX, playerY);
    if (!spawnPoint) break;
    spawnFloor3WildArchetype(world, spawnPoint.x, spawnPoint.y);
  }
  state.lastSpawnMs = world.elapsedMs;
}

export function floor3ObjectiveTick(world: GameWorld): void {
  const manifest = getFloorManifest('floor3');
  if (manifest?.timer && world.elapsedMs >= manifest.timer.durationMs) {
    world.goalFlags.set(FLOOR3_TIMEOUT_GOAL_ID, true);
    world.state = 'game_over';
  }
}

export function initializeFloor3Scenario(
  world: GameWorld,
  playerEid: number,
  options?: { readonly playerCarryover?: PlayerCarryoverSnapshot },
): void {
  const manifest = getFloorManifest('floor3');
  if (!manifest) {
    throw new Error('Missing floor3 manifest');
  }
  const biomeRegionCount = manifest.floor3?.biomeRegionCount ?? AFFINITY_RING.length;
  if (biomeRegionCount !== AFFINITY_RING.length) {
    throw new Error(
      `floor3 manifest misconfigured: biomeRegionCount=${biomeRegionCount} must equal ${AFFINITY_RING.length}`,
    );
  }

  const mapConfig: MapConfig = {
    widthTiles: manifest.map.widthTiles,
    heightTiles: manifest.map.heightTiles,
    tileSizeFt: manifest.map.tileSizeFt,
    biome: manifest.map.biome ?? BiomeType.CAVE_SYSTEM_BIOMES,
    seed: world.rng.nextInt(1, 2_000_000),
    roomWidthRange: manifest.map.roomWidthRange,
    roomHeightRange: manifest.map.roomHeightRange,
    maxRooms: manifest.map.maxRooms,
    floorDensity: manifest.map.floorDensity,
    caveSystem: {
      presentCount: biomeRegionCount,
      layout: 'floor3-biomes',
    },
  };
  const floorMap = getGenerator(mapConfig.biome).generate(mapConfig, world.rng);
  world.floorMap = floorMap;
  attachBarriersToFloorMap(world);
  world.floor = 3;
  world.floorId = 'floor3';
  world.floorScenario = null;
  world.floorExtendedState = {
    floor3BiomeAffinities: AFFINITY_RING.slice(),
    ambientEnemyArchetypes: new Map<number, string>(),
  };

  const spawn = floorMap.tileToWorld(floorMap.playerSpawn.x, floorMap.playerSpawn.y);
  if (hasComponent(world.ecs, playerEid, Position)) {
    setComponent(world.ecs, playerEid, Position, { x: spawn.x, y: spawn.y });
  }
  if (!hasComponent(world.ecs, playerEid, BroadcastScore)) {
    addComponent(world.ecs, playerEid, set(BroadcastScore, { current: 0 }));
  }

  removeStatModifiers(world, 'floor', 'floor3-manifest-player');
  if (manifest.player.moveSpeedBonus > 0) {
    addStatModifier(world, {
      sourceType: 'floor',
      sourceId: 'floor3-manifest-player',
      stat: 'moveSpeed',
      op: 'add',
      value: manifest.player.moveSpeedBonus,
    });
  }
  if (manifest.player.pickupRangeBonus > 0) {
    addStatModifier(world, {
      sourceType: 'floor',
      sourceId: 'floor3-manifest-player',
      stat: 'pickupRange',
      op: 'add',
      value: manifest.player.pickupRangeBonus,
    });
  }
  if (!options?.playerCarryover && hasComponent(world.ecs, playerEid, Health)) {
    const maxHp = (world.stores.health.max[playerEid] ?? 100) + manifest.player.hpBonus;
    setComponent(world.ecs, playerEid, Health, { current: maxHp, max: maxHp });
  }
  if (options?.playerCarryover) {
    restorePlayerCarryover(world, playerEid, options.playerCarryover);
    initializePlayerWeaponSkills(world, playerEid);
  } else {
    const starterWeaponPool = manifest.starterWeapons;
    if (starterWeaponPool.length > 0) {
      const weaponRng = new SeededRandomClass(
        hashStringToSeed(`${world.seed}:floor3-starter-weapon`),
      );
      const picked = starterWeaponPool[weaponRng.nextInt(0, starterWeaponPool.length - 1)];
      if (picked) {
        const weaponDef = getWeaponDef(picked);
        if (weaponDef) {
          equipStarterOrFallback(world, weaponDef.id, weaponDef);
          initializePlayerWeaponSkills(world, playerEid);
        } else {
          const fallbackId = starterWeaponPool[0];
          if (fallbackId) {
            const fallbackDef = getWeaponDef(fallbackId);
            if (fallbackDef) {
              equipStarterOrFallback(world, fallbackDef.id, fallbackDef);
              initializePlayerWeaponSkills(world, playerEid);
            }
          }
        }
      }
    }
  }
  if (manifest.props !== undefined) {
    const propsRng = new SeededRandomClass(hashStringToSeed(`${world.seed}:floor3-props`));
    placePropsForFloor(world, world.floorMap!, manifest.props, propsRng);
  }

  world.featureUnlocks.inventory = true;
  world.featureUnlocks.equipment = true;
  world.featureUnlocks.spells = true;
  world.state = 'playing';
  world.goalFlags.set(FLOOR3_TIMEOUT_GOAL_ID, false);
  world.floorObjectiveTick = floor3ObjectiveTick;
}
