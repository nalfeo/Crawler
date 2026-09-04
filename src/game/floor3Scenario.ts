import { addComponent, hasComponent, query, removeEntity, set, setComponent } from 'bitecs';
import {
  BroadcastScore,
  Companion,
  Enemy,
  Health,
  Invincible,
  Player,
  PartySlot,
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
import {
  _isPartyLocked,
  _partyMembers,
  _PARTY_MAX_SIZE,
  spawnRosterCompanion,
} from '../core/spawners/companions.js';
import { addSetPieceProp, spawnNpc } from '../core/spawners/world-objects.js';
import { setGoalFlag } from '../core/door-lock.js';
import { _isEncounterTeamsWiped, _isPartyWiped } from '../core/systems/companionKOSystem.js';
import { acceptQuest } from '../core/systems/questSystem.js';
import { SHAPE_CIRCLE } from '../core/physics-defs.js';
import {
  getFloorEnemyPack,
  type EnemyArchetypeDef,
  type EnemyPackDef,
} from '../shared/enemy-packs.js';
import { getFloorManifest } from '../shared/floor-registry.js';
import { hasFloorTimerExpired } from '../core/floor-timer.js';
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
import {
  floor3StudioDefeatGoalId,
  floor3StudioQuestId,
  selectFloor3FinalFour,
  selectFloor3Studios,
} from '../shared/data/floor3/studios.js';
import { getSetPieceDef, isStructuralSetPieceProp } from '../shared/set-piece-types.js';
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
  Floor3PoachOffer,
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
} from './floorScenario.js';
import {
  mixSpawnZoneWeights,
  normalizeSpawnZoneWeights,
  pickFromSpawnZones,
  type SpawnZoneWeights,
  type SpawnZoneMix,
} from './spawn-zones.js';
import {
  _aiTypeForSpecies,
  _generateStarterOffer,
  _generateTrainerPoachOffer,
  _recruitCompanion,
} from './floor3Recruiting.js';
import { awardFloor3CompanionDefeatRewards } from './floor3CompanionRewards.js';
import { restorePlayerCarryover } from './playerCarryover.js';
import { AI_TYPE } from './enemyAISystem.js';
import { addStatModifier, removeStatModifiers } from './systems/statsSystem.js';
import { placePropsForFloor } from './systems/propPlacer.js';
import type { PlayerCarryoverSnapshot } from './playerCarryover.js';
import { createLogger } from '../shared/logger.js';
import { FLOOR3_COMPANION_PROFESSOR_NPC_ID } from '../shared/npc-types.js';
import tuning from '../shared/data/tuning.json';

const logger = createLogger('game:floor3-scenario');

const FLOOR3_BIOME_MATCH_SPAWN_SHARE = 0.75;
const FLOOR3_BIOME_NEUTRAL_SPAWN_SHARE = 0.25;
const FLOOR3_WILD_TEAM_ID = TeamId.ENEMY;
/** World-unit offset (one map tile) so the starter Companion doesn't spawn stacked on the player. */
const FLOOR3_STARTER_COMPANION_SPAWN_OFFSET_TILES = 1;
const FLOOR3_COMPANION_PROFESSOR_OFFSET_TILES = 1;
/**
 * Floor-3-ONLY: initial level of the player's starter Companion (spec R5
 * §6.1), tunable via `tuning.floor3Companion.starterLevel` instead of a
 * hardcoded `1`. Raising this crosses into higher stat-scale forms
 * (`FORM_MIN_LEVELS`), giving the lone starter a fighting chance while the
 * party is still size-1 against multi-Companion Studio/wild encounters.
 * See `floor3-companion-lab` for the explorable knob.
 */
const FLOOR3_STARTER_COMPANION_LEVEL = tuning.floor3Companion.starterLevel;
/**
 * Floor-3-ONLY HP multiplier applied only to the player's own recruited
 * party Companions (`recruitFloor3PartyCompanion`, both the starter pick
 * and every Trainer poach), on top of the species/form `statScale` every
 * Companion already uses. Wild/Studio/Final-Four Companion HP is untouched.
 */
const FLOOR3_PLAYER_COMPANION_HP_MULTIPLIER = tuning.floor3Companion.playerCompanionHpMultiplier;
export const FLOOR3_TIMEOUT_GOAL_ID = 'floor3-timeout';
export const FLOOR3_VICTORY_GOAL_ID = 'floor3-victory';
export const FLOOR3_STAIRS_POPPED_GOAL_ID = 'floor3-stairs-popped';
export const FLOOR3_STAIRS_DISCOVERED_GOAL_ID = 'floor3-stairs-discovered';
export const FLOOR3_FINAL_FOUR_UNLOCK_GOAL_ID = 'floor3-final-four-unlock';
// Re-exported for existing callers/tests — definition lives in the shared
// data layer so `src/core/systems/questWaypoints.ts` can resolve it too
// without violating the core → game layer boundary.
export { floor3StudioDefeatGoalId };
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
 *
 * The mask stays authoritative when it exists: an irregular cave room's
 * bounding box can also contain passable tiles belonging to a neighbouring
 * room or corridor, so the bounds scan runs only when the mask yields no
 * usable tile (which is exactly the carved-room case).
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
  if (tiles.length === 0) {
    for (let ty = by + 1; ty <= by + bh - 2; ty += 1) {
      for (let tx = bx + 1; tx <= bx + bw - 2; tx += 1) push(tx, ty);
    }
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
 * The nearest passable tile to `origin` that is neither the player's tile nor
 * already claimed by another roster spawn, found via a deterministic outward
 * ring scan. Used when a pre-resolved arena spawn point happens to be the tile
 * the player is standing on at unlock time, so a Final Four Companion never
 * materialises on top of the player. Returns `origin` only if the map offers
 * no alternative at all.
 */
function findFloor3RelocatedSpawnTile(
  floorMap: NonNullable<GameWorld['floorMap']>,
  origin: { x: number; y: number },
  isPlayerTile: (tile: { x: number; y: number }) => boolean,
  claimedTiles: ReadonlySet<string>,
): { x: number; y: number } {
  const maxRadius = Math.max(floorMap.width, floorMap.height);
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const tile = { x: origin.x + dx, y: origin.y + dy };
        if (!floorMap.tileMap.inBounds(tile.x, tile.y)) continue;
        if (!floorMap.tileMap.isPassable(tile.x, tile.y)) continue;
        if (isPlayerTile(tile)) continue;
        if (claimedTiles.has(`${tile.x},${tile.y}`)) continue;
        return tile;
      }
    }
  }
  return origin;
}

/**
 * Seeded Studio + Final Four selection and world placement (spec R6/R8,
 * slice 8). Each Studio's roster spawn is deferred (`pendingSpawns`) behind
 * its own per-Studio unlock threshold (`unlockLevel`) — spec R6's "any-order
 * soft-gated" contract — and only physically spawns once
 * `floor3ObjectiveTick` observes `world.playerLevel.level >= unlockLevel`.
 * The four Final Four rosters are deferred as ordered rounds, gated on the
 * Studios-defeated counter instead of a level threshold.
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
      // Retained past spawning (unlike `pendingSpawns`, which the unlock clears)
      // so the poach picker can still offer this roster after the Studio is
      // defeated and its entities are despawned (spec §6.2, UX surface #3).
      poachRoster: studio.trainers.flatMap((trainer) =>
        trainer.companions.map((companion) => ({
          speciesId: companion.speciesId,
          level: companion.level,
        })),
      ),
      poachOffered: false,
    });
  });

  // One team id shared by every Handler's Companions in the Final Four.
  const finalFourTeamId = FLOOR3_FINAL_FOUR_TEAM_BASE;
  const finalFourRounds: Floor3StudiosState['finalFourRounds'] = [];
  const finalFourRoom =
    floorMap.roomGraph
      .getAll()
      .find(
        (room) => room.role === RoomRole.BOSS_STAIR && room.label === 'floor3_final_four_arena',
      ) ?? territoryRooms.find((room) => !studios.some((studio) => studio.roomId === room.id));
  const finalFourPlacement = finalFourRoom
    ? stampFloor3EncounterSetPiece(world, finalFourRoom, FLOOR3_FINAL_FOUR_SET_PIECE_ID)
    : undefined;
  let finalFourCellIndex = 0;
  const finalFourSpawnTiles = finalFourPlacement
    ? collectFloor3RosterSpawnTiles(floorMap, finalFourPlacement.room)
    : undefined;
  selectedFinalFour.forEach((handler) => {
    const pendingSpawns: Floor3PendingRosterSpawn[] = [];
    for (const companion of handler.companions) {
      const tile = finalFourSpawnTiles
        ? pickFloor3RosterSpawnTile(finalFourSpawnTiles, finalFourCellIndex)
        : undefined;
      finalFourCellIndex += 1;
      const spawnPos = tile ? floorMap.tileToWorld(tile.x, tile.y) : undefined;
      pendingSpawns.push({
        speciesId: companion.speciesId,
        level: companion.level,
        teamId: finalFourTeamId,
        ...(spawnPos ? { x: spawnPos.x, y: spawnPos.y } : {}),
      });
    }
    finalFourRounds.push({
      handlerId: handler.handlerId,
      handlerName: handler.name,
      pendingSpawns,
      defeated: false,
    });
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
      // The Final Four is never poachable — beating it ends the floor (§12.2).
      poachRoster: [],
      poachOffered: true,
    },
    finalFourRounds,
    finalFourRoundIndex: 0,
    studiosDefeatedCount: 0,
  };
}

/** Spawns only the active Final Four handler roster and clears that round's pending list. */
function spawnFloor3FinalFourRoster(world: GameWorld, studiosState: Floor3StudiosState): void {
  const floorMap = world.floorMap;
  const round = studiosState.finalFourRounds[studiosState.finalFourRoundIndex];
  if (!floorMap || !round || round.pendingSpawns.length === 0) return;
  // Production Floor 3 maps pre-resolve the roster's positions from the
  // dedicated arena chamber at floor build time, and map overrides used by
  // focused tests fall back to a centre scan. Either way the player can be
  // standing on a target tile when the last Studio falls, so both paths run
  // through the same player-tile relocation below.
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
  const arenaTiles = findFloor3ArenaTiles(floorMap, round.pendingSpawns.length, avoidPlayerTile);
  const plannedTiles = round.pendingSpawns.map((pending, index) =>
    pending.x !== undefined && pending.y !== undefined
      ? floorMap.worldToTile(pending.x, pending.y)
      : arenaTiles[index % arenaTiles.length]!,
  );
  const tileKey = (tile: { x: number; y: number }): string => `${tile.x},${tile.y}`;
  const onPlayerTile = (tile: { x: number; y: number }): boolean =>
    avoidPlayerTile !== undefined && avoidPlayerTile(tile.x, tile.y);
  const claimedTiles = new Set(plannedTiles.filter((tile) => !onPlayerTile(tile)).map(tileKey));
  const spawnTiles = plannedTiles.map((tile) => {
    if (!onPlayerTile(tile)) return tile;
    const relocated = findFloor3RelocatedSpawnTile(floorMap, tile, onPlayerTile, claimedTiles);
    claimedTiles.add(tileKey(relocated));
    return relocated;
  });
  round.pendingSpawns.forEach((pending, index) => {
    const tile = spawnTiles[index]!;
    const arenaPos = floorMap.tileToWorld(tile.x, tile.y);
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
  round.pendingSpawns = [];
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

/** Deterministically selects the first valid party Companion through the public scenario callback. */
export function autoDefaultFloor3KeptCompanion(world: GameWorld): boolean {
  const studiosState = world.floorExtendedState?.floor3Studios;
  if (
    !studiosState ||
    world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID) !== true ||
    studiosState.keptCompanionEid !== undefined
  ) {
    return false;
  }
  const party = [..._partyMembers(world, TeamId.PLAYER)]
    .filter((eid) => hasValidFloor3KeptCompanion(world, eid))
    .sort((a, b) => (world.stores.partySlot.slot[a] ?? 0) - (world.stores.partySlot.slot[b] ?? 0));
  const firstEid = party[0];
  if (firstEid === undefined) return false;
  return selectFloor3KeptCompanion(world, firstEid);
}

function latchFloor3Victory(world: GameWorld): void {
  setGoalFlag(world, FLOOR3_VICTORY_GOAL_ID, true);
  popFloor3ExitStairs(world);
}

/**
 * End-of-floor picker hook (spec R7 §9.3, slice 11): lets the player select any
 * of their own live party Companions before floor-transition carryover is captured
 * (`capturePlayerCarryover` resolves `studiosState.keptCompanionEid` into the
 * persisted `KeptCompanionContract`). The actual picker UI is a separate,
 * later slice (14) — this only wires the underlying selection.
 *
 * Returns `false` (no-op) if Floor 3 hasn't latched victory yet, or if
 * `partyEid` isn't a live Companion on the player's own party.
 */
export function selectFloor3KeptCompanion(world: GameWorld, partyEid: number): boolean {
  const studiosState = world.floorExtendedState?.floor3Studios;
  if (!studiosState || world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID) !== true) return false;
  if (!hasValidFloor3KeptCompanion(world, partyEid)) return false;
  studiosState.keptCompanionEid = partyEid;
  return true;
}

function hasValidFloor3KeptCompanion(world: GameWorld, partyEid: number | undefined): boolean {
  return (
    partyEid !== undefined &&
    hasComponent(world.ecs, partyEid, Companion) &&
    hasComponent(world.ecs, partyEid, PartySlot) &&
    hasComponent(world.ecs, partyEid, Team) &&
    (world.stores.team.id[partyEid] ?? -1) === TeamId.PLAYER &&
    (world.stores.companion.knockedOut[partyEid] ?? 0) !== 1
  );
}

/**
 * The Floor 3 kept-companion half of the descend gate, shared with the stair
 * marker so the prompt and the confirmation can never disagree (a marker that
 * reports `locked: false` while the descend is rejected offers the player an
 * exit the game refuses).
 *
 * A party wipe after victory is deliberately NOT a loss here (the objective
 * tick suppresses `game_over` once the win is latched), and lingering ambient
 * wilds can knock out the last party Companion after the win — so the player
 * can legitimately reach the stairs with nothing keepable left. Requiring a
 * valid pick in that state would strand the run forever with the exit visibly
 * unlocked, so the gate is skipped on a wiped party; `keptCompanion` is already
 * optional in the carryover contract.
 */
export function floor3KeptCompanionDescendGateSatisfied(world: GameWorld): boolean {
  const studiosState = world.floorExtendedState?.floor3Studios;
  if (!studiosState) return false;
  return hasValidFloor3KeptCompanion(world, studiosState.keptCompanionEid) || _isPartyWiped(world);
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
  if (!floor3KeptCompanionDescendGateSatisfied(world)) return false;
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
  const floorMap = world.floorMap;
  const pack = getFloor3WildPack();
  if (!floorMap) return null;
  const minDistanceSq = pack.spawnRadiusMin * pack.spawnRadiusMin;
  const maxDistanceSq = pack.despawnDistanceFt * pack.despawnDistanceFt;
  const candidate = resolveAmbientSpawnPoint(world, playerX, playerY);
  if (candidate) {
    const tile = floorMap.worldToTile(candidate.x, candidate.y);
    if (
      isValidFloor3AmbientSpawnTile(
        world,
        tile.x,
        tile.y,
        playerX,
        playerY,
        minDistanceSq,
        maxDistanceSq,
      )
    ) {
      return candidate;
    }
  }
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

export const _resolveFloor3AmbientSpawnPoint = resolveFloor3AmbientSpawnPoint;

function resolveFloor3CompanionProfessorPosition(
  floorMap: FloorMap,
): { x: number; y: number } | null {
  const spawnTile = floorMap.playerSpawn;
  const spawnRoom = floorMap.spawnRoom;
  const candidates = [
    { x: spawnTile.x + FLOOR3_COMPANION_PROFESSOR_OFFSET_TILES, y: spawnTile.y },
    { x: spawnTile.x, y: spawnTile.y + FLOOR3_COMPANION_PROFESSOR_OFFSET_TILES },
    { x: spawnTile.x - FLOOR3_COMPANION_PROFESSOR_OFFSET_TILES, y: spawnTile.y },
    { x: spawnTile.x, y: spawnTile.y - FLOOR3_COMPANION_PROFESSOR_OFFSET_TILES },
  ];
  for (const tile of candidates) {
    if (
      !floorMap.tileMap.inBounds(tile.x, tile.y) ||
      !floorMap.tileMap.isPassable(tile.x, tile.y)
    ) {
      continue;
    }
    if (spawnRoom && floorMap.roomGraph.getRoomAt(tile.x, tile.y) !== spawnRoom.id) {
      continue;
    }
    return floorMap.tileToWorld(tile.x, tile.y);
  }
  for (let radius = 1; radius <= 6; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.abs(dx) + Math.abs(dy) !== radius) {
          continue;
        }
        const tile = { x: spawnTile.x + dx, y: spawnTile.y + dy };
        if (tile.x === spawnTile.x && tile.y === spawnTile.y) {
          continue;
        }
        if (
          !floorMap.tileMap.inBounds(tile.x, tile.y) ||
          !floorMap.tileMap.isPassable(tile.x, tile.y)
        ) {
          continue;
        }
        if (spawnRoom && floorMap.roomGraph.getRoomAt(tile.x, tile.y) !== spawnRoom.id) {
          continue;
        }
        return floorMap.tileToWorld(tile.x, tile.y);
      }
    }
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

  // Persistent player reward track (spec R7, slice 10). Runs FIRST so the KOs
  // that complete an encounter this frame still pay out before the wipe check
  // below despawns that roster.
  awardFloor3CompanionDefeatRewards(world);

  // Timeout loss — suppressed once victory is latched. `latchFloor3Victory`
  // sets `FLOOR3_VICTORY_GOAL_ID` while the world is still `'playing'` (the
  // player must still walk to and confirm the exit stairs). A timer expiry in
  // that window must not overwrite the latched win with `'game_over'`, which
  // would permanently block `confirmFloor3StairDescend` (it requires
  // `world.state === 'playing'`). The deadline is safe-room-credited, so the
  // Green Room entrance stops the countdown while the player is inside it.
  if (
    world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID) !== true &&
    hasFloorTimerExpired(world, 'floor3')
  ) {
    world.goalFlags.set(FLOOR3_TIMEOUT_GOAL_ID, true);
    world.state = 'game_over';
    return;
  }

  const studiosState = world.floorExtendedState?.floor3Studios;
  if (!studiosState) return;

  // Trainer-poach offer (spec R5 §6.2, UX surface #3). Checked at the top of a
  // fresh `'playing'` tick rather than inline in the defeat loop below so that
  // latching a Studio and pausing for the pick are never the same tick: the
  // defeat loop always runs to completion (Final Four unlock, victory latch,
  // party-wipe predicate) before any pause, and at most one offer is ever
  // pending. Two Studios wiped on the same tick therefore yield two offers on
  // two consecutive ticks, in `studios` order, instead of one overwriting the
  // other.
  if (
    world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID) !== true &&
    world.floorExtendedState?.floor3PoachOffer === undefined
  ) {
    for (const studio of studiosState.studios) {
      if (!studio.defeated || studio.poachOffered) continue;
      studio.poachOffered = true;
      const offer = buildFloor3PoachOffer(world, studio);
      if (offer === undefined) continue;
      world.floorExtendedState = { ...world.floorExtendedState, floor3PoachOffer: offer };
      world.state = 'loadout';
      return;
    }
  }

  if (world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID) !== true) {
    for (const studio of studiosState.studios) {
      if (studio.defeated) continue;
      if (!studio.unlocked) {
        if (world.playerLevel.level < studio.unlockLevel) continue;
        studio.unlocked = true;
        setGoalFlag(world, floor3StudioUnlockGoalId(studio.id), true);
        acceptQuest(world, floor3StudioQuestId(studio.id));
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
      studiosState.finalFour.unlocked = true;
      spawnFloor3FinalFourRoster(world, studiosState);
    }

    if (
      !studiosState.finalFour.defeated &&
      world.goalFlags.get(FLOOR3_FINAL_FOUR_UNLOCK_GOAL_ID) === true &&
      studiosState.finalFourRoundIndex < studiosState.finalFourRounds.length &&
      _isEncounterTeamsWiped(world, studiosState.finalFour.teamIds)
    ) {
      despawnFloor3EncounterRoster(world, studiosState.finalFour.teamIds);
      const completedRound = studiosState.finalFourRounds[studiosState.finalFourRoundIndex]!;
      completedRound.defeated = true;
      studiosState.finalFourRoundIndex += 1;
      if (studiosState.finalFourRoundIndex >= studiosState.finalFourRounds.length) {
        studiosState.finalFour.defeated = true;
        latchFloor3Victory(world);
      } else {
        spawnFloor3FinalFourRoster(world, studiosState);
      }
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
  // Starter offer (spec R5 §6.1): 4 seeded species, distinct from the map/prop
  // seeds so re-rolling the map layout can never change who's on offer (and
  // vice versa). `initializeFloor3Scenario` never re-enters mid-run, so a
  // fresh offer here always means a fresh floor entry.
  const starterOfferRng = new SeededRandomClass(hashStringToSeed(`${world.seed}:floor3-starter`));
  const starterOffer = _generateStarterOffer(starterOfferRng).map((species) => species.speciesId);
  world.floorExtendedState = {
    floor3BiomeAffinities: AFFINITY_RING.slice(),
    ambientEnemyArchetypes: new Map<number, string>(),
    floor3Studios: initializeFloor3Studios(world, floorMap),
    floor3StarterOffer: starterOffer,
  };

  const spawn = floorMap.tileToWorld(floorMap.playerSpawn.x, floorMap.playerSpawn.y);
  if (hasComponent(world.ecs, playerEid, Position)) {
    setComponent(world.ecs, playerEid, Position, { x: spawn.x, y: spawn.y });
  }
  if (!hasComponent(world.ecs, playerEid, BroadcastScore)) {
    addComponent(world.ecs, playerEid, set(BroadcastScore, { current: 0 }));
  }
  const professorPos = resolveFloor3CompanionProfessorPosition(floorMap);
  if (professorPos) {
    const professorEid = spawnNpc(
      world,
      professorPos.x,
      professorPos.y,
      FLOOR3_COMPANION_PROFESSOR_NPC_ID,
    );
    if (professorEid >= 0 && world.floorExtendedState) {
      world.floorExtendedState = {
        ...world.floorExtendedState,
        floor3CompanionProfessorNpcEid: professorEid,
      };
    }
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
  }
  addComponent(world.ecs, playerEid, Invincible);
  if (manifest.props !== undefined) {
    const propsRng = new SeededRandomClass(hashStringToSeed(`${world.seed}:floor3-props`));
    placePropsForFloor(world, world.floorMap!, manifest.props, propsRng);
  }

  world.featureUnlocks.inventory = true;
  world.featureUnlocks.equipment = true;
  world.featureUnlocks.spells = true;
  // Pause on the starter-Companion pick (spec R5 §6.1) until
  // `selectFloor3StarterCompanion` resumes play, mirroring Floor 1's
  // weapon-loadout pause. Falls through to 'playing' only if the offer is
  // somehow empty (species roster misconfiguration), so a broken offer can
  // never permanently strand the player on an un-resumable pause.
  world.state = starterOffer.length > 0 ? 'loadout' : 'playing';
  world.goalFlags.set(FLOOR3_TIMEOUT_GOAL_ID, false);
  world.floorObjectiveTick = floor3ObjectiveTick;
}

/**
 * Confirms the player's Floor 3 starter-Companion pick (spec R5 §6.1),
 * resolving the picked species' base combat stats the same way every other
 * roster Companion is resolved (`findFloor3ArchetypeForSpecies` +
 * `formForLevel`'s level-1 scale) so the starter is never a bespoke balance
 * number. Mirrors `selectFloor1StarterWeapon`: a no-op outside `'loadout'`,
 * and always resumes play on `'playing'` even if the pick itself failed (an
 * out-of-range index, an unknown species, or an already-locked party — none
 * of which should be reachable from the real offer/UI, but must never strand
 * the player on an un-resumable pause).
 */
function selectFloor3StarterCompanion(world: GameWorld, optionIndex: number): void {
  if (world.state !== 'loadout') return;
  const offer = world.floorExtendedState?.floor3StarterOffer;
  if (!offer || offer.length === 0) {
    world.state = 'playing';
    return;
  }

  const speciesId = offer[optionIndex] ?? offer[0];
  let species = speciesId !== undefined ? getPetSpecies(speciesId) : undefined;
  if (species === undefined) {
    // Loud, structured degradation signal (plan-review finding): an unknown
    // speciesId in the offer should never happen (the offer is built from
    // `getPetSpecies` results in the first place), but if it does, fall back
    // to scanning the rest of the offer for a resolvable species rather than
    // silently starting Floor 3 with no Companion at all.
    logger.warn(
      `[floor3:starter-degraded] offer entry ${speciesId ?? 'undefined'} did not resolve to a ` +
        `known species; scanning the rest of the offer for a valid fallback.`,
    );
    species = offer.map((id) => getPetSpecies(id)).find((resolved) => resolved !== undefined);
    if (species === undefined) {
      logger.warn(
        '[floor3:starter-degraded] no offer entry resolved to a known species; ' +
          'resuming play with no starter Companion.',
      );
    }
  }
  if (species !== undefined) {
    recruitFloor3PartyCompanion(world, species, FLOOR3_STARTER_COMPANION_LEVEL);
  }

  if (world.floorExtendedState) {
    world.floorExtendedState = { ...world.floorExtendedState, floor3StarterOffer: [] };
  }
  world.state = 'playing';
}

/**
 * Spawns `species` into the player's party beside the player at `level`,
 * resolving its combat stats and appearance the same way every other roster
 * Companion is resolved (`findFloor3ArchetypeForSpecies` + the form's
 * `statScale`) so a recruit is never a bespoke balance number. Shared by the
 * starter pick (spec §6.1) and the Trainer poach (§6.2). Returns the new
 * entity id, or `undefined` when the party has already locked.
 */
function recruitFloor3PartyCompanion(
  world: GameWorld,
  species: PetSpeciesDef,
  level: number,
): number | undefined {
  const playerEid = query(world.ecs, [Player])[0];
  const playerX = playerEid !== undefined ? (world.stores.position.x[playerEid] ?? 0) : 0;
  const playerY = playerEid !== undefined ? (world.stores.position.y[playerEid] ?? 0) : 0;
  const tileSizeFt = world.floorMap?.config.tileSizeFt ?? 4;
  const spawnOffset = tileSizeFt * FLOOR3_STARTER_COMPANION_SPAWN_OFFSET_TILES;

  const archetype = findFloor3ArchetypeForSpecies(getFloor3WildPack(), species);
  const form = formForLevel(species, level);
  // Floor-3-ONLY companion buff (human-authorized, session 2026-09-03):
  // the player's own recruited party Companions get an HP multiplier on top
  // of the shared species/form statScale, compensating for the party's
  // numbers disadvantage against multi-Companion Studio/Final-Four rosters.
  // Wild and rival roster Companions (spawnRosterCompanion) never pass
  // through this function, so they are unaffected.
  const hp = archetype
    ? Math.max(1, Math.round(archetype.hp * form.statScale * FLOOR3_PLAYER_COMPANION_HP_MULTIPLIER))
    : 1;
  const attackRange =
    archetype && (archetype.aiType === 'ranged' || archetype.aiType === 'support')
      ? archetype.detectRange * 0.65
      : 0;

  const eid = _recruitCompanion(world, species.speciesId, {
    x: playerX + spawnOffset,
    y: playerY,
    hp,
    speed: archetype?.speed ?? 0.1,
    aggroRange: archetype?.detectRange ?? 200,
    attackRange,
    level,
    ownerTeam: TeamId.PLAYER,
  });
  if (eid !== undefined && archetype) {
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
  }
  return eid;
}

/**
 * Builds the seeded poach offer for a defeated Trainer roster (spec §6.2):
 * the Trainer's complete surviving-on-paper roster in a seeded presentation
 * order, plus the recruit slots the player has left. Returns `undefined` when
 * the party has already locked (post-lock defeats yield loot + XP only,
 * §6.3) or when the roster resolves to no known species.
 */
function buildFloor3PoachOffer(
  world: GameWorld,
  encounter: Floor3EncounterState,
): Floor3PoachOffer | undefined {
  if (encounter.poachRoster.length === 0) return undefined;
  if (_isPartyLocked(world, TeamId.PLAYER)) return undefined;
  const slotsRemaining = _PARTY_MAX_SIZE - _partyMembers(world, TeamId.PLAYER).length;
  if (slotsRemaining <= 0) return undefined;

  // Highest-level entry wins when a Trainer fields the same species twice, so
  // the seeded species ordering below can never silently downgrade an offer.
  const levelBySpecies = new Map<string, number>();
  for (const candidate of encounter.poachRoster) {
    const existing = levelBySpecies.get(candidate.speciesId);
    if (existing === undefined || candidate.level > existing) {
      levelBySpecies.set(candidate.speciesId, candidate.level);
    }
  }
  const rng = new SeededRandomClass(hashStringToSeed(`${world.seed}:floor3-poach:${encounter.id}`));
  const candidates = _generateTrainerPoachOffer(rng, [...levelBySpecies.keys()]).map((species) => ({
    speciesId: species.speciesId,
    level: levelBySpecies.get(species.speciesId) ?? 1,
  }));
  if (candidates.length === 0) return undefined;

  return {
    encounterId: encounter.id,
    encounterName: encounter.name,
    candidates,
    slotsRemaining,
  };
}

/**
 * Confirms the player's Trainer-poach pick (spec §6.2, UX surface #3).
 * Mirrors {@link selectFloor3StarterCompanion}: a no-op outside `'loadout'`,
 * clamps an out-of-range index to the first candidate, and always resumes
 * `'playing'` — even if the recruit itself failed — so a bad pick can never
 * strand the player on an un-resumable pause.
 */
function selectFloor3PoachCompanion(world: GameWorld, optionIndex: number): void {
  if (world.state !== 'loadout') return;
  const offer = world.floorExtendedState?.floor3PoachOffer;
  if (!offer) {
    world.state = 'playing';
    return;
  }

  const candidate = offer.candidates[optionIndex] ?? offer.candidates[0];
  const species = candidate !== undefined ? getPetSpecies(candidate.speciesId) : undefined;
  if (species !== undefined && candidate !== undefined) {
    recruitFloor3PartyCompanion(world, species, candidate.level);
  } else {
    logger.warn(
      `[floor3:poach-degraded] offer entry ${candidate?.speciesId ?? 'undefined'} did not ` +
        'resolve to a known species; resuming play with no poached Companion.',
    );
  }

  if (world.floorExtendedState) {
    const { floor3PoachOffer: _consumed, ...rest } = world.floorExtendedState;
    world.floorExtendedState = rest;
  }
  world.state = 'playing';
}

/**
 * Floor 3's single `'loadout'` pause resolver (`ScenarioDefinition.selectLoadoutOption`).
 * The floor pauses on `'loadout'` twice: the starter pick at floor entry and
 * every Trainer poach mid-run. A pending poach offer always wins, since the
 * starter offer is cleared the moment it is resolved and only a poach can
 * re-enter `'loadout'` afterwards.
 */
export function selectFloor3LoadoutOption(world: GameWorld, optionIndex: number): void {
  if (world.floorExtendedState?.floor3PoachOffer !== undefined) {
    selectFloor3PoachCompanion(world, optionIndex);
    return;
  }
  selectFloor3StarterCompanion(world, optionIndex);
}
