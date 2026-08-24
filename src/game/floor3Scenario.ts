import { addComponent, hasComponent, query, removeEntity, set, setComponent } from 'bitecs';
import {
  BroadcastScore,
  Companion,
  Enemy,
  Health,
  Player,
  Position,
  Size,
  Sprite,
  Team,
  type GameWorld,
} from '../core/index.js';
import { attachBarriersToFloorMap } from '../core/barriers/index.js';
import { carveSetPieceRoom } from '../core/map/carveSetPieceRoom.js';
import type { FloorMap } from '../core/map/FloorMap.js';
import { getGenerator } from '../core/map/generators/registry.js';
import { stampSetPiece } from '../core/map/stampSetPiece.js';
import { setEnemyAppearanceKey, spawnBehaviorEnemy } from '../core/spawners/combatants.js';
import { spawnRosterCompanion } from '../core/spawners/companions.js';
import { addSetPieceProp } from '../core/spawners/world-objects.js';
import { setGoalFlag } from '../core/door-lock.js';
import { _isEncounterTeamsWiped, _isPartyWiped } from '../core/systems/companionKOSystem.js';
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
import {
  formForLevel,
  getPetSpecies,
  speciesTokenForId,
  type PetSpeciesDef,
} from '../shared/data/floor3/species.js';
import {
  FLOOR3_FINAL_FOUR_SET_PIECE_ID,
  floor3SetPieceIdForStudio,
} from '../shared/data/floor3/set-pieces.js';
import { selectFloor3FinalFour, selectFloor3Studios } from '../shared/data/floor3/studios.js';
import { getSetPieceDef, isStructuralSetPieceProp } from '../shared/set-piece-types.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { SeededRandom as SeededRandomClass, hashStringToSeed } from '../shared/random.js';
import {
  BiomeType,
  RoomRole,
  TerrainType,
  type MapConfig,
  type RoomData,
} from '../shared/map-types.js';
import { TeamId } from '../shared/constants.js';
import type {
  Floor3EncounterState,
  Floor3PendingRosterSpawn,
  Floor3StudiosState,
} from '../shared/floor-types.js';
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

const FLOOR3_BIOME_MATCH_SPAWN_SHARE = 0.75;
const FLOOR3_BIOME_NEUTRAL_SPAWN_SHARE = 0.25;
const FLOOR3_WILD_TEAM_ID = TeamId.ENEMY;
export const FLOOR3_TIMEOUT_GOAL_ID = 'floor3-timeout';
export const FLOOR3_VICTORY_GOAL_ID = 'floor3-victory';
export const FLOOR3_STAIRS_POPPED_GOAL_ID = 'floor3-stairs-popped';
export const FLOOR3_STAIRS_DISCOVERED_GOAL_ID = 'floor3-stairs-discovered';
export const FLOOR3_FINAL_FOUR_UNLOCK_GOAL_ID = 'floor3-final-four-unlock';
/** First Team id used by Studio trainers — two per Studio, none overlap `TeamId`'s 0..2. */
const FLOOR3_STUDIO_TEAM_BASE = 10;
/** First Team id used by Final Four handlers — one per handler. */
const FLOOR3_FINAL_FOUR_TEAM_BASE = 30;
/**
 * Per-Studio unlock thresholds (`world.playerLevel.level`), one per selected
 * Studio slot in seeded-selection order (spec R6: "any-order soft-gated ...
 * requires the player's party to meet a floor-level threshold, not a fixed
 * sequence"). Since Studio selection order is already seed-shuffled
 * (`selectFloor3Studios`), assigning ascending thresholds by slot gives each
 * seed a different unlock-difficulty ordering without hard-coding which
 * Studio identity is "first" — the earliest-unlocked Studio is always
 * reachable at floor start (threshold 0).
 */
const FLOOR3_STUDIO_UNLOCK_LEVELS: readonly number[] = [0, 2, 4, 6, 8, 10];

/** Per-Studio goal flag latched true once that Studio's rosters are wiped. */
export function floor3StudioDefeatGoalId(studioId: string): string {
  return `floor3-studio-${studioId}-defeated`;
}

/** Per-Studio goal flag latched true once that Studio's unlock threshold is met and its roster has spawned. */
function floor3StudioUnlockGoalId(studioId: string): string {
  return `floor3-studio-${studioId}-unlocked`;
}

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

export function _resolveFloor3WildSpawnWeights(
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
  const weights = _resolveFloor3WildSpawnWeights(world, x, y);
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

/**
 * Resolves the wild-archetype whose base combat stats a roster Companion
 * should use: an exact `speciesId` match when the species is also an
 * ambient wild spawn, otherwise any archetype sharing its `fightingStyle`.
 * The fallback is safe because the wild pack authors identical hp/speed/
 * detect-range/aiType numbers for every affinity of one fighting style (see
 * `enemies.floor3.json` — e.g. `ember-charger`/`bloom-charger`/`stone-charger`
 * all share one stat block); a style-only lookup can never disagree with an
 * exact-match lookup, it just also covers species that never spawn in the
 * wild — namely the Final Four's `signature-*` companions (spec R8), which
 * intentionally have no wild-pack archetype of their own.
 */
function findFloor3ArchetypeForSpecies(
  pack: EnemyPackDef,
  species: PetSpeciesDef,
): EnemyArchetypeDef | undefined {
  return (
    pack.archetypes.find((a) => a.speciesId === species.speciesId) ??
    pack.archetypes.find((a) => a.id.endsWith(`-${species.fightingStyle}`))
  );
}

/**
 * Resolve a roster Companion's (Trainer/Studio/Final-Four) base combat stats
 * from the Floor 3 wild-archetype pack — the same authored hp/speed/detect
 * numbers wild spawns of that species (or, for wild-pack-absent species like
 * the Final Four's signatures, any species sharing its fighting style) use —
 * scaled by the species' form at the requested level
 * (`formForLevel().statScale`, R3's authored per-form growth curve) rather
 * than inventing new balance numbers. Levels here are a first playable pass;
 * slice 16 tunes them via the win-rate sweep.
 */
function spawnFloor3RosterCompanion(
  world: GameWorld,
  x: number,
  y: number,
  speciesId: string,
  level: number,
  teamId: number,
): number | undefined {
  const species = getPetSpecies(speciesId);
  if (!species) return undefined;
  const archetype = findFloor3ArchetypeForSpecies(getFloor3WildPack(), species);
  if (!archetype) return undefined;

  const form = formForLevel(species, level);
  const hp = Math.max(1, Math.round(archetype.hp * form.statScale));
  const aiType = resolveFloor3ArchetypeAiType(archetype);
  const attackRange =
    archetype.aiType === 'ranged' || archetype.aiType === 'support'
      ? archetype.detectRange * 0.65
      : 0;

  const eid = spawnRosterCompanion(world, {
    x,
    y,
    hp,
    aiType,
    speed: archetype.speed,
    aggroRange: archetype.detectRange,
    attackRange,
    speciesToken: speciesTokenForId(speciesId),
    level,
    ownerTeam: teamId,
    form: form.form,
  });
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
  return eid;
}

/**
 * Deterministic, distinct interior spawn tiles inside a room.
 *
 * A successful `carveSetPieceRoom` deliberately drops the room's
 * `interiorCells` mask (the carved prefab is a plain rectangle), so a
 * cells-only lookup would collapse to the room centre and stack every
 * Companion of that Studio on one tile. Fall back to a bounds-inset scan of
 * passable tiles so carved rooms still fan their roster out; only a room with
 * no passable interior at all degrades to the centre tile.
 */
function collectFloor3RosterSpawnTiles(
  floorMap: NonNullable<GameWorld['floorMap']>,
  room: RoomData,
): { x: number; y: number }[] {
  const tiles: { x: number; y: number }[] = [];
  const seen = new Set<string>();
  const push = (x: number, y: number): void => {
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    if (!floorMap.tileMap.isPassable(x, y)) return;
    seen.add(key);
    tiles.push({ x, y });
  };
  if (room.interiorCells) {
    for (const cell of room.interiorCells) push(cell.x, cell.y);
  }
  const { x: bx, y: by, width: bw, height: bh } = room.bounds;
  for (let ty = by + 1; ty <= by + bh - 2; ty += 1) {
    for (let tx = bx + 1; tx <= bx + bw - 2; tx += 1) push(tx, ty);
  }
  if (tiles.length === 0) {
    tiles.push({ x: bx + Math.floor(bw / 2), y: by + Math.floor(bh / 2) });
  }
  return tiles;
}

/** Deterministic interior spawn tile inside a room, spreading multiple spawns across cells. */
function pickFloor3RosterSpawnTile(
  tiles: readonly { x: number; y: number }[],
  index: number,
): { x: number; y: number } {
  return tiles[index % tiles.length]!;
}

function stampFloor3EncounterSetPiece(
  world: GameWorld,
  room: RoomData,
  setPieceId: string,
): { room: RoomData; carved: boolean } {
  const floorMap = world.floorMap;
  const def = getSetPieceDef(setPieceId);
  if (!floorMap || !def) return { room, carved: false };

  const carve = carveSetPieceRoom(floorMap, room, def);
  const stampedRoom = carve.fitted ? (floorMap.roomGraph.get(room.id) ?? room) : room;
  const stamp = stampSetPiece(def, {
    roomBounds: stampedRoom.bounds,
    tileSizeFt: floorMap.config.tileSizeFt,
    anchor: carve.fitted ? 'bounds-topleft' : 'interior-center',
  });
  const structuralPropIds = new Set(
    def.props.filter(isStructuralSetPieceProp).map((prop) => prop.id),
  );
  for (const stampedProp of stamp.props) {
    if (stampedProp.render.label && structuralPropIds.has(stampedProp.render.label)) continue;
    addSetPieceProp(world, stampedProp.x, stampedProp.y, stampedProp.render);
  }
  return { room: stampedRoom, carved: carve.fitted };
}

/**
 * Up to `count` distinct passable tiles near the map centre, collected via an
 * outward spiral scan — the Final Four's "arena" spawn points. The
 * floor3-biomes map generator (`cave-system.ts`) does not carve a dedicated
 * `RESOURCE_HEART` chamber the way the floor2-families layout does (that
 * physical set piece is spec slice 9's deliverable); this scan finds
 * guaranteed-passable points without requiring generator changes in this
 * slice. Fanning the roster across several tiles (rather than stacking every
 * Companion on one point) avoids overlapping spawns and gives the encounter
 * some spatial spread (plan-review finding, slice 8). Falls back to
 * repeating the last found tile (or the map centre) if fewer than `count`
 * passable tiles exist.
 */
function findFloor3ArenaTiles(
  floorMap: NonNullable<GameWorld['floorMap']>,
  count: number,
  avoidTileFn?: (x: number, y: number) => boolean,
): { x: number; y: number }[] {
  const cx = Math.floor(floorMap.width / 2);
  const cy = Math.floor(floorMap.height / 2);
  const isUsable = (x: number, y: number): boolean =>
    floorMap.tileMap.isPassable(x, y) && (avoidTileFn === undefined || !avoidTileFn(x, y));
  const found: { x: number; y: number }[] = [];
  if (isUsable(cx, cy)) found.push({ x: cx, y: cy });
  const maxRadius = Math.max(floorMap.width, floorMap.height);
  for (let radius = 1; radius <= maxRadius && found.length < count; radius += 1) {
    for (let dy = -radius; dy <= radius && found.length < count; dy += 1) {
      for (let dx = -radius; dx <= radius && found.length < count; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (!floorMap.tileMap.inBounds(x, y)) continue;
        if (isUsable(x, y)) found.push({ x, y });
      }
    }
  }
  if (found.length === 0) found.push({ x: cx, y: cy });
  while (found.length < count) found.push(found[found.length - 1]!);
  return found;
}

/**
 * Seeded Studio + Final Four selection and world placement (spec R6/R8,
 * slice 8). Each Studio's roster spawn is deferred (`pendingSpawns`) behind
 * its own per-Studio unlock threshold (`unlockLevel`) — spec R6's "any-order
 * soft-gated" contract — and only physically spawns once
 * `floor3ObjectiveTick` observes `world.playerLevel.level >= unlockLevel`.
 * The Final Four roster is deferred (`finalFourPendingSpawns`) the same way,
 * gated on the Studios-defeated counter instead of a level threshold.
 */
function initializeFloor3Studios(
  world: GameWorld,
  floorMap: NonNullable<GameWorld['floorMap']>,
): Floor3StudiosState {
  const rng = new SeededRandomClass(hashStringToSeed(`${world.seed}:floor3-studios`));
  const selectedStudios = selectFloor3Studios(rng);
  const selectedFinalFour = selectFloor3FinalFour(rng);

  const territoryRooms = rng.shuffle(
    floorMap.roomGraph.getAll().filter((room) => room.role === RoomRole.TERRITORY),
  );

  const studios: Floor3EncounterState[] = [];
  let nextStudioTeamId = FLOOR3_STUDIO_TEAM_BASE;
  selectedStudios.forEach((studio, studioIndex) => {
    const room =
      territoryRooms.length > 0 ? territoryRooms[studioIndex % territoryRooms.length] : undefined;
    const setPieceId = floor3SetPieceIdForStudio(studio);
    const placement = room ? stampFloor3EncounterSetPiece(world, room, setPieceId) : undefined;
    const placedRoom = placement?.room ?? room;
    const spawnTiles = placedRoom ? collectFloor3RosterSpawnTiles(floorMap, placedRoom) : undefined;
    // One team id shared by every Trainer's Companions in this Studio (not
    // one per Trainer) — see the `teamIds` doc comment on `Floor3EncounterState`.
    const teamId = nextStudioTeamId;
    nextStudioTeamId += 1;
    let cellIndex = 0;
    const pendingSpawns: Floor3PendingRosterSpawn[] = [];
    for (const trainer of studio.trainers) {
      for (const companion of trainer.companions) {
        if (!room || !spawnTiles) continue;
        const tile = pickFloor3RosterSpawnTile(spawnTiles, cellIndex);
        cellIndex += 1;
        const spawnPos = floorMap.tileToWorld(tile.x, tile.y);
        pendingSpawns.push({
          speciesId: companion.speciesId,
          level: companion.level,
          teamId,
          x: spawnPos.x,
          y: spawnPos.y,
        });
      }
    }
    studios.push({
      id: studio.studioId,
      name: studio.name,
      teamIds: [teamId],
      roomId: placedRoom ? placedRoom.id : -1,
      setPieceId,
      setPieceCarved: placement?.carved ?? false,
      defeated: false,
      unlockLevel:
        FLOOR3_STUDIO_UNLOCK_LEVELS[studioIndex % FLOOR3_STUDIO_UNLOCK_LEVELS.length] ?? 0,
      unlocked: false,
      pendingSpawns,
    });
  });

  // One team id shared by every Handler's Companions in the Final Four.
  const finalFourTeamId = FLOOR3_FINAL_FOUR_TEAM_BASE;
  const finalFourPendingSpawns: Floor3PendingRosterSpawn[] = [];
  const finalFourRoom = territoryRooms.find(
    (room) => !studios.some((studio) => studio.roomId === room.id),
  );
  const finalFourPlacement = finalFourRoom
    ? stampFloor3EncounterSetPiece(world, finalFourRoom, FLOOR3_FINAL_FOUR_SET_PIECE_ID)
    : undefined;
  let finalFourCellIndex = 0;
  const finalFourSpawnTiles = finalFourPlacement
    ? collectFloor3RosterSpawnTiles(floorMap, finalFourPlacement.room)
    : undefined;
  selectedFinalFour.forEach((handler) => {
    for (const companion of handler.companions) {
      const tile = finalFourSpawnTiles
        ? pickFloor3RosterSpawnTile(finalFourSpawnTiles, finalFourCellIndex)
        : undefined;
      finalFourCellIndex += 1;
      const spawnPos = tile ? floorMap.tileToWorld(tile.x, tile.y) : undefined;
      finalFourPendingSpawns.push({
        speciesId: companion.speciesId,
        level: companion.level,
        teamId: finalFourTeamId,
        ...(spawnPos ? { x: spawnPos.x, y: spawnPos.y } : {}),
      });
    }
  });

  for (const studio of studios) {
    setGoalFlag(world, floor3StudioDefeatGoalId(studio.id), false);
    setGoalFlag(world, floor3StudioUnlockGoalId(studio.id), false);
  }
  setGoalFlag(world, FLOOR3_FINAL_FOUR_UNLOCK_GOAL_ID, false);
  setGoalFlag(world, FLOOR3_VICTORY_GOAL_ID, false);
  setGoalFlag(world, FLOOR3_STAIRS_POPPED_GOAL_ID, false);
  setGoalFlag(world, FLOOR3_STAIRS_DISCOVERED_GOAL_ID, false);

  return {
    studios,
    finalFour: {
      id: 'final-four',
      name: 'The Final Four',
      teamIds: [finalFourTeamId],
      roomId: finalFourPlacement?.room.id ?? -1,
      setPieceId: FLOOR3_FINAL_FOUR_SET_PIECE_ID,
      setPieceCarved: finalFourPlacement?.carved ?? false,
      defeated: false,
      unlockLevel: 0,
      unlocked: false,
      pendingSpawns: [],
    },
    finalFourPendingSpawns,
    studiosDefeatedCount: 0,
  };
}

/** Spawns the deferred Final Four roster fanned across arena tiles and clears the pending list. */
function spawnFloor3FinalFourRoster(world: GameWorld, studiosState: Floor3StudiosState): void {
  const floorMap = world.floorMap;
  if (!floorMap || studiosState.finalFourPendingSpawns.length === 0) return;
  // Avoid spawning directly on top of the player — the Final Four arena is
  // an unlabeled point found by spiral-scanning the map centre (no dedicated
  // room geometry exists yet, spec slice 9), so it could otherwise coincide
  // with wherever the player happens to be standing when the gate unlocks
  // (plan-review finding, slice 8).
  const player = query(world.ecs, [Player, Position])[0];
  const avoidPlayerTile =
    player === undefined
      ? undefined
      : (() => {
          const playerTile = floorMap.worldToTile(
            world.stores.position.x[player] ?? 0,
            world.stores.position.y[player] ?? 0,
          );
          return (x: number, y: number): boolean => x === playerTile.x && y === playerTile.y;
        })();
  const arenaTiles = findFloor3ArenaTiles(
    floorMap,
    studiosState.finalFourPendingSpawns.length,
    avoidPlayerTile,
  );
  studiosState.finalFourPendingSpawns.forEach((pending, index) => {
    const tile = arenaTiles[index % arenaTiles.length]!;
    const arenaPos =
      pending.x !== undefined && pending.y !== undefined
        ? { x: pending.x, y: pending.y }
        : floorMap.tileToWorld(tile.x, tile.y);
    const eid = spawnFloor3RosterCompanion(
      world,
      arenaPos.x,
      arenaPos.y,
      pending.speciesId,
      pending.level,
      pending.teamId,
    );
    if (eid === undefined) {
      throw new Error(
        `floor3: Final Four failed to spawn Companion "${pending.speciesId}" ` +
          '(no wild archetype resolvable for its fighting style) — the floor would be ' +
          'permanently unwinnable. Fix the data before shipping.',
      );
    }
  });
  studiosState.finalFourPendingSpawns = [];
}

/**
 * Spawns a Studio's deferred roster at its pre-resolved den tiles and clears
 * its `pendingSpawns` list. Called once `floor3ObjectiveTick` observes
 * `world.playerLevel.level >= studio.unlockLevel` (spec R6 soft-gate).
 */
function spawnFloor3StudioRoster(world: GameWorld, studio: Floor3EncounterState): void {
  if (studio.pendingSpawns.length === 0) return;
  for (const pending of studio.pendingSpawns) {
    const eid = spawnFloor3RosterCompanion(
      world,
      pending.x ?? 0,
      pending.y ?? 0,
      pending.speciesId,
      pending.level,
      pending.teamId,
    );
    if (eid === undefined) {
      throw new Error(
        `floor3: Studio "${studio.id}" failed to spawn Companion "${pending.speciesId}" ` +
          '(no wild archetype resolvable for its fighting style) — the Studio would be ' +
          'permanently unwinnable. Fix the data before shipping.',
      );
    }
  }
  studio.pendingSpawns = [];
}

/** Pops the exit staircase at the player's spawn point (spec R6 win path). */
function popFloor3ExitStairs(world: GameWorld): void {
  const studiosState = world.floorExtendedState?.floor3Studios;
  const floorMap = world.floorMap;
  if (!studiosState || !floorMap) return;
  if (world.goalFlags.get(FLOOR3_STAIRS_POPPED_GOAL_ID) === true) return;

  studiosState.staircasePos = floorMap.tileToWorld(floorMap.playerSpawn.x, floorMap.playerSpawn.y);
  studiosState.staircaseSpawned = true;
  studiosState.staircaseUnlocked = true;
  setGoalFlag(world, FLOOR3_STAIRS_POPPED_GOAL_ID, true);
}

function latchFloor3Victory(world: GameWorld): void {
  setGoalFlag(world, FLOOR3_VICTORY_GOAL_ID, true);
  popFloor3ExitStairs(world);
}

/**
 * Called when the player confirms exit descent on Floor 3.
 * Sets `staircaseDiscovered` and transitions `world.state` to `'safe_room'`.
 * Returns `true` on success, `false` if preconditions not met.
 */
export function confirmFloor3StairDescend(world: GameWorld, _playerEid: number): boolean {
  const studiosState = world.floorExtendedState?.floor3Studios;
  if (!studiosState || world.state !== 'playing') return false;
  if (!studiosState.staircaseSpawned || !studiosState.staircaseUnlocked) return false;
  if (studiosState.staircaseDiscovered) return false;
  studiosState.staircaseDiscovered = true;
  setGoalFlag(world, FLOOR3_STAIRS_DISCOVERED_GOAL_ID, true);
  world.state = 'safe_room';
  return true;
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
  if (world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID) === true) return;
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

/**
 * Permanently removes every ECS Companion entity on `teamIds` once an
 * encounter (a Studio or the Final Four) is latched `defeated`. Without this,
 * `companionKOSystem`'s generic per-team engagement-end revival (spec R11) —
 * which is not scoped to the player's party — would resurrect a "defeated"
 * roster to full health once the player walks away, contradicting the
 * permanent latch (plan-review finding, slice 8).
 */
function despawnFloor3EncounterRoster(world: GameWorld, teamIds: readonly number[]): void {
  const companions = query(world.ecs, [Enemy, Companion, Team]);
  for (const eid of companions) {
    if (!teamIds.includes(world.stores.team.id[eid] ?? -1)) continue;
    removeEntity(world.ecs, eid);
  }
}

export function floor3ObjectiveTick(world: GameWorld): void {
  // Stop ticking a non-playing world first: after a victory descent
  // (`'safe_room'`) or any loss (`'game_over'`) the objective tick must not run
  // again and re-transition state.
  if (world.state !== 'playing') return;

  // Timeout loss — suppressed once victory is latched. `latchFloor3Victory`
  // sets `FLOOR3_VICTORY_GOAL_ID` while the world is still `'playing'` (the
  // player must still walk to and confirm the exit stairs). A timer expiry in
  // that window must not overwrite the latched win with `'game_over'`, which
  // would permanently block `confirmFloor3StairDescend` (it requires
  // `world.state === 'playing'`).
  const manifest = getFloorManifest('floor3');
  if (
    world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID) !== true &&
    manifest?.timer &&
    world.elapsedMs >= manifest.timer.durationMs
  ) {
    world.goalFlags.set(FLOOR3_TIMEOUT_GOAL_ID, true);
    world.state = 'game_over';
    return;
  }

  const studiosState = world.floorExtendedState?.floor3Studios;
  if (!studiosState) return;

  if (world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID) !== true) {
    for (const studio of studiosState.studios) {
      if (studio.defeated) continue;
      if (!studio.unlocked) {
        if (world.playerLevel.level < studio.unlockLevel) continue;
        studio.unlocked = true;
        setGoalFlag(world, floor3StudioUnlockGoalId(studio.id), true);
        spawnFloor3StudioRoster(world, studio);
      }
      if (!_isEncounterTeamsWiped(world, studio.teamIds)) continue;
      studio.defeated = true;
      studiosState.studiosDefeatedCount += 1;
      setGoalFlag(world, floor3StudioDefeatGoalId(studio.id), true);
      despawnFloor3EncounterRoster(world, studio.teamIds);
    }

    if (
      studiosState.studios.length > 0 &&
      studiosState.studiosDefeatedCount >= studiosState.studios.length &&
      world.goalFlags.get(FLOOR3_FINAL_FOUR_UNLOCK_GOAL_ID) !== true
    ) {
      setGoalFlag(world, FLOOR3_FINAL_FOUR_UNLOCK_GOAL_ID, true);
      spawnFloor3FinalFourRoster(world, studiosState);
    }

    if (
      !studiosState.finalFour.defeated &&
      studiosState.finalFourPendingSpawns.length === 0 &&
      world.goalFlags.get(FLOOR3_FINAL_FOUR_UNLOCK_GOAL_ID) === true &&
      _isEncounterTeamsWiped(world, studiosState.finalFour.teamIds)
    ) {
      studiosState.finalFour.defeated = true;
      despawnFloor3EncounterRoster(world, studiosState.finalFour.teamIds);
      latchFloor3Victory(world);
    }

    if (world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID) !== true && _isPartyWiped(world)) {
      world.state = 'game_over';
      return;
    }
  }
}

export function initializeFloor3Scenario(
  world: GameWorld,
  playerEid: number,
  options?: {
    readonly playerCarryover?: PlayerCarryoverSnapshot;
    readonly floorMapOverride?: FloorMap;
  },
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

  let floorMap: FloorMap;
  if (options?.floorMapOverride) {
    floorMap = options.floorMapOverride;
  } else {
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
    floorMap = getGenerator(mapConfig.biome).generate(mapConfig, world.rng);
  }
  world.floorMap = floorMap;
  world.setPieceProps.length = 0;
  attachBarriersToFloorMap(world);
  world.floor = 3;
  world.floorId = 'floor3';
  world.floorScenario = null;
  world.floorExtendedState = {
    floor3BiomeAffinities: AFFINITY_RING.slice(),
    ambientEnemyArchetypes: new Map<number, string>(),
    floor3Studios: initializeFloor3Studios(world, floorMap),
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
