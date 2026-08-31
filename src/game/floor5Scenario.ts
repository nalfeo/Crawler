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
  attachBarriersToFloorMap,
  createPolyBarrier,
  dropBarrier,
} from '../core/barriers/index.js';
import { setGoalFlag } from '../core/door-lock.js';
import {
  applyDamage,
  BroadcastScore,
  Damage,
  Health,
  Immovable,
  Position,
  SiegeHero,
  SiegeMinion,
  SiegeRam,
  SiegeRouteMarker,
  SiegeStructure,
  Size,
  Sprite,
  Team,
  Velocity,
  Weight,
  activateMobAbilityEncounter,
  createEntity,
  registerMobAbility,
  setMobAbilitiesEnabled,
  type GameWorld,
} from '../core/index.js';
import { clearEntityStores } from '../core/helpers.js';
import { setEnemyAppearanceKey } from '../core/spawners/combatants.js';
import { clearMobAbility } from '../core/mob-abilities/runtime.js';
import {
  computeSiegeCastleLayout,
  siegeCastleOptionsFromConfig,
  type SiegeCastleLayout,
} from '../core/map/generators/SiegeCastleGenerator.js';
import { getGenerator } from '../core/map/generators/registry.js';
import { findTilePath } from '../core/map/pathfinding.js';
import { PHYSICS_BODIES, SHAPE_CIRCLE } from '../core/physics-defs.js';
import { getFloorManifest } from '../shared/floor-registry.js';
import { BiomeType, type MapConfig } from '../shared/map-types.js';
import { SeededRandom as SeededRandomClass, hashStringToSeed } from '../shared/random.js';
import { TeamId } from '../shared/constants.js';
import type {
  Floor5FieldHeroCardEntry,
  Floor5FieldHeroRole,
  Floor5RamComponentClass,
  Floor5RamRouteLandmark,
  Floor5RamRouteMarkerState,
  Floor5RamState,
  Floor5RatingsRamState,
  Floor5RequisitionMilestone,
  Floor5SiegeCheckpointOwner,
  Floor5SiegePhase,
  Floor5SiegePhaseTraceEntry,
  Floor5SiegeRunStats,
  Floor5SiegeState,
  Floor5SiegeStructureId,
  Floor5SiegeStructureState,
  Floor5SiegeTeam,
  Floor5SiegeWaveManifestEntry,
} from '../shared/floor-types.js';
import { FLOOR5_FIELD_HERO_ROSTER, buildFloor5FieldHeroCard } from '../shared/floor5-heroes.js';
import {
  createFloor5HeroAbilityDefinition,
  floor5HeroArchetypeKey,
} from './floor5HeroAbilities.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { initializePlayerWeaponSkills } from './floorScenario.js';
import type { PlayerCarryoverSnapshot } from './playerCarryover.js';
import { restorePlayerCarryover } from './playerCarryover.js';
import { equipStarterOrFallback } from './scenarios/starterWeaponEquip.js';
import { addStatModifier, removeStatModifiers } from './systems/statsSystem.js';
import { acceptQuest, setTrackedQuest } from '../core/systems/questSystem.js';

const FLOOR5_PLAYER_STAT_SOURCE_ID = 'floor5-manifest-player';
const FLOOR5_TEAM_CODE: Record<Floor5SiegeTeam, number> = {
  allied: TeamId.SIEGE_ALLIED,
  enemy: TeamId.SIEGE_ENEMY,
};
const FLOOR5_SIEGE_MARKER_TEAM: Record<Floor5SiegeTeam, number> = {
  allied: 1,
  enemy: 2,
};
const FLOOR5_STRUCTURE_KIND: Record<Floor5SiegeStructureId, number> = {
  'command-post': 1,
  'allied-checkpoint': 2,
  'enemy-checkpoint': 3,
  'outer-wall': 4,
};
const FLOOR5_MINION_LIVE_CAP = 4;
const FLOOR5_MINION_HP = 24;
const FLOOR5_MINION_DAMAGE = 6;
const FLOOR5_MINION_COOLDOWN_MS = 500;
const FLOOR5_MINION_SPEED_FT_PER_FRAME = 0.85;
const FLOOR5_MINION_ATTACK_RANGE_FT = 2.5;
const FLOOR5_CHECKPOINT_RADIUS_FT = 8;
const FLOOR5_PATH_STALL_FRAMES = 90;
/**
 * Encoded {@link Floor5FieldHeroRole} stored on the `SiegeHero` marker so ECS
 * consumers (tests, labs, future slices) can read a Hero's single declared role
 * straight off the entity without going through the sidecar state.
 */
const FLOOR5_HERO_ROLE_CODE: Record<Floor5FieldHeroRole, number> = {
  'counter-push': 1,
  'checkpoint-defense': 2,
  'engine-disruption': 3,
  'minion-support': 4,
  artillery: 5,
};
/** Feet of slack allowed around a role anchor before the Hero re-centres. */
const FLOOR5_HERO_ANCHOR_SLACK_FT = 2;
const FLOOR5_STRUCTURE_HEALTH: Record<Floor5SiegeStructureId, number> = {
  'command-post': 90,
  'allied-checkpoint': 36,
  'enemy-checkpoint': 36,
  'outer-wall': 140,
};

interface Floor5WaveEntryWithIndex {
  readonly entry: Floor5SiegeWaveManifestEntry;
  readonly manifestIndex: number;
}

const FLOOR5_RAM_BUILD_REQUIRED_MS = 3_000;
const FLOOR5_RAM_COMPONENT_CLASSES = [
  'chassis',
  'plating',
  'broadcast-array',
] as const satisfies readonly Floor5RamComponentClass[];
const FLOOR5_REQUISITION_MILESTONES = [
  'opening-push',
  'siege-yard',
  'components',
  'checkpoint',
] as const satisfies readonly Floor5RequisitionMilestone[];

const FLOOR5_SIEGE_GOAL_IDS = {
  openingPushRepelled: 'floor5.siege.openingPushRepelled',
  yardSecured: 'floor5.siege.yardSecured',
  componentsReady: 'floor5.siege.componentsReady',
  ramBuilt: 'floor5.siege.ramBuilt',
  checkpointCleared: 'floor5.siege.checkpointCleared',
  wallBreached: 'floor5.siege.wallBreached',
  courtyardCleared: 'floor5.siege.courtyardCleared',
  regentDefeated: 'floor5.siege.regentDefeated',
  castleCaptured: 'floor5.siege.castleCaptured',
} as const;

const FLOOR5_SLICE3_QUEST_IDS = [
  'floor5-hold-the-line',
  'floor5-secure-synergy',
  'floor5-recover-components',
  'floor5-clear-checkpoint',
  'floor5-build-ratings-ram',
] as const;

export type Floor5FieldTaskId = 'openingPush' | 'siegeYard' | 'checkpoint';

function getFloor5Manifest() {
  const manifest = getFloorManifest('floor5');
  if (!manifest) {
    throw new Error('Missing floor5 manifest');
  }
  return manifest;
}

function getFloor5Config() {
  const floor5 = getFloor5Manifest().floor5;
  if (!floor5) {
    throw new Error('Missing floor5 geometry/phase config');
  }
  return floor5;
}

function buildFloor5MapConfig(): MapConfig {
  const manifest = getFloor5Manifest();
  const geometry = manifest.floor5;
  return {
    widthTiles: manifest.map.widthTiles,
    heightTiles: manifest.map.heightTiles,
    tileSizeFt: manifest.map.tileSizeFt,
    biome: manifest.map.biome ?? BiomeType.SIEGE_CASTLE,
    seed: manifest.map.seed,
    roomWidthRange: manifest.map.roomWidthRange,
    roomHeightRange: manifest.map.roomHeightRange,
    maxRooms: manifest.map.maxRooms,
    floorDensity: manifest.map.floorDensity,
    siegeCastle: geometry
      ? {
          commandPostWidthTiles: geometry.commandPost.widthTiles,
          commandPostHeightTiles: geometry.commandPost.heightTiles,
          siegeYardWidthTiles: geometry.siegeYard.widthTiles,
          siegeYardHeightTiles: geometry.siegeYard.heightTiles,
          pocketWidthTiles: geometry.flankPockets.widthTiles,
          pocketHeightTiles: geometry.flankPockets.heightTiles,
          laneLengthTiles: geometry.lane.lengthTiles,
          laneWidthTiles: geometry.lane.widthTiles,
          outerWallThicknessTiles: geometry.outerWall.thicknessTiles,
          breachWidthTiles: geometry.outerWall.breachWidthTiles,
          courtyardWidthTiles: geometry.courtyard.widthTiles,
          courtyardHeightTiles: geometry.courtyard.heightTiles,
          throneRoomWidthTiles: geometry.throneRoom.widthTiles,
          throneRoomHeightTiles: geometry.throneRoom.heightTiles,
          balconyWidthTiles: geometry.winnersBalcony.widthTiles,
          balconyHeightTiles: geometry.winnersBalcony.heightTiles,
          borderThicknessTiles: geometry.borderThicknessTiles,
        }
      : undefined,
  };
}

function centerOf(bounds: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}) {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

function tileCenterToWorld(
  layout: SiegeCastleLayout,
  id: Floor5SiegeStructureId | 'allied-spawn' | 'enemy-spawn',
  tileSizeFt: number,
): { x: number; y: number } {
  const checkpoint = centerOf(layout.checkpointPocket);
  const center =
    id === 'command-post'
      ? centerOf(layout.commandPost)
      : id === 'allied-checkpoint'
        ? { x: checkpoint.x - 1, y: checkpoint.y }
        : id === 'enemy-checkpoint'
          ? { x: checkpoint.x + 1, y: checkpoint.y }
          : id === 'outer-wall'
            ? centerOf(layout.breachSite)
            : id === 'allied-spawn'
              ? {
                  x: layout.commandPost.x + layout.commandPost.width + 1,
                  y: layout.primaryLane.y + layout.primaryLane.height / 2,
                }
              : // The enemy garrison sorties from the LANE side of its own outer
                // wall (mirroring the allied spawn's offset from the Command
                // Post). The breach site is sealed by a barrier until the
                // Ratings Ram lands (`sealFloor5BreachIngress`), so a
                // courtyard-side muster would leave every defender — and the
                // field Hero — permanently walled out of the lane war they
                // exist to fight. Derived from the authored layout, never
                // hardcoded.
                {
                  x: layout.breachSite.x - 2,
                  y: layout.primaryLane.y + layout.primaryLane.height / 2,
                };
  return {
    x: center.x * tileSizeFt + tileSizeFt / 2,
    y: center.y * tileSizeFt + tileSizeFt / 2,
  };
}

function buildFloor5WaveManifest(streamKey: string): readonly Floor5SiegeWaveManifestEntry[] {
  const rng = new SeededRandomClass(hashStringToSeed(streamKey));
  const alliedCount = 2 + rng.nextInt(0, 1);
  const enemyCount = 1 + rng.nextInt(0, 1);
  return Object.freeze([
    Object.freeze({ id: 'wave-0-allied', team: 'allied', releaseFrame: 1, count: alliedCount }),
    Object.freeze({ id: 'wave-0-enemy', team: 'enemy', releaseFrame: 1, count: enemyCount }),
  ] satisfies Floor5SiegeWaveManifestEntry[]);
}

function clonePhase(phase: Floor5SiegePhase): Floor5SiegePhase {
  return { ...phase };
}

function cloneTraceEntry(entry: Floor5SiegePhaseTraceEntry): Floor5SiegePhaseTraceEntry {
  return { ...entry, phase: clonePhase(entry.phase) };
}

function cloneStructure(entry: Floor5SiegeStructureState): Floor5SiegeStructureState {
  return { ...entry };
}

function hasAllFloor5RamComponents(state: Floor5SiegeState): boolean {
  return FLOOR5_RAM_COMPONENT_CLASSES.every((componentClass) =>
    state.tasks.recoveredComponents.includes(componentClass),
  );
}

function hasFloor5RamPrerequisites(state: Floor5SiegeState): boolean {
  return (
    state.tasks.openingPushRepelled &&
    state.tasks.yardSecured &&
    hasAllFloor5RamComponents(state) &&
    state.tasks.checkpointCleared
  );
}

function latchFloor5RequisitionMilestone(
  state: Floor5SiegeState,
  milestone: Floor5RequisitionMilestone,
): void {
  if (!state.requisitionMilestones.includes(milestone)) {
    state.requisitionMilestones.push(milestone);
  }
}

function getFloor5HeroConfig() {
  return getFloor5Config().heroes;
}

function createFloor5HeroSlotState(streamKey: string): Floor5SiegeState['heroes'] {
  return {
    card: buildFloor5FieldHeroCard(FLOOR5_FIELD_HERO_ROSTER, streamKey),
    status: 'pending',
    cursor: -1,
    eid: 0,
    health: 0,
    maxHealth: 0,
    targetEid: 0,
    spawnedFrame: null,
    defeatedFrame: null,
    respawnFrame: null,
    fieldedHeroIds: [],
    spawns: 0,
    defeats: 0,
    abilityCasts: 0,
    buildStallMs: 0,
  };
}

/**
 * Project the typed field-Hero slot onto the flat `heroState` trace/display
 * string. Derived only — `state.heroes` stays the single source of truth.
 */
function floor5HeroStateLabel(heroes: Floor5SiegeState['heroes']): string {
  const card = heroes.cursor >= 0 ? heroes.card[heroes.cursor] : undefined;
  switch (heroes.status) {
    case 'active':
      return card ? `ACTIVE:${card.heroId}` : 'ACTIVE';
    case 'down':
      return card ? `DOWN:${card.heroId}@${heroes.respawnFrame ?? -1}` : 'DOWN';
    case 'retired':
      return 'RETIRED';
    default:
      return 'PENDING';
  }
}

/**
 * Resolve one semantic escort landmark to its authored TILE. Positions are
 * always derived from {@link SiegeCastleLayout} — never authored as world
 * coordinates — so re-authoring the castle geometry moves the escort route
 * with it and can never desync from the walkable lane (spec `FR5.2`).
 */
function floor5RamLandmarkTile(
  layout: SiegeCastleLayout,
  landmark: Floor5RamRouteLandmark,
): { tileX: number; tileY: number } {
  const laneCenterY = Math.floor(layout.primaryLane.y + layout.primaryLane.height / 2);
  switch (landmark) {
    case 'build-site':
      // One tile INSIDE the lane, in front of the Command Post: the staging
      // yard. Deliberately not the Command Post centre — a field Hero anchored
      // on the Command Post would otherwise permanently sit inside the ram's
      // protection bubble and stall the escort before it ever rolled.
      return { tileX: layout.primaryLane.x + 1, tileY: laneCenterY };
    case 'siege-yard-junction':
      return { tileX: Math.floor(centerOf(layout.siegeYard).x), tileY: laneCenterY };
    case 'checkpoint-junction':
      return { tileX: Math.floor(centerOf(layout.checkpointPocket).x), tileY: laneCenterY };
    case 'breach-approach':
      // The traversable LANE-SIDE attack anchor: the last open lane tile before
      // the outer wall. The wall's own tiles are barriered at init, so the ram
      // must never path onto them.
      return { tileX: layout.outerWall.x - 1, tileY: laneCenterY };
  }
}

/** Derive the ordered, positioned escort route from the manifest landmarks. */
function buildFloor5RamRoute(
  layout: SiegeCastleLayout,
  landmarks: readonly Floor5RamRouteLandmark[],
  tileSizeFt: number,
): Floor5RamRouteMarkerState[] {
  return landmarks.map((landmark, index) => {
    const { tileX, tileY } = floor5RamLandmarkTile(layout, landmark);
    return {
      landmark,
      index,
      tileX,
      tileY,
      x: tileX * tileSizeFt + tileSizeFt / 2,
      y: tileY * tileSizeFt + tileSizeFt / 2,
      eid: 0,
      reachedFrame: null,
    };
  });
}

function createFloor5RamState(
  world: GameWorld,
  config: ReturnType<typeof getFloor5Config>,
): Floor5RamState {
  const manifest = getFloor5Manifest();
  const layout = computeSiegeCastleLayout(siegeCastleOptionsFromConfig(buildFloor5MapConfig()));
  void world;
  return {
    eid: 0,
    health: config.ram.health,
    maxHealth: config.ram.health,
    routeIndex: 0,
    route: buildFloor5RamRoute(layout, config.ram.routeLandmarks, manifest.map.tileSizeFt),
    protectionMet: false,
    escorts: 0,
    threats: 0,
    strikes: 0,
    lastStrikeMs: 0,
    spawnedFrame: null,
    destroyedFrame: null,
    rebuildAvailableFrame: null,
    builds: 0,
    destructions: 0,
    wallDamageDealt: 0,
    counterDamageTaken: 0,
    wallAuthorizedHealth: FLOOR5_STRUCTURE_HEALTH['outer-wall'],
    rejectedWallDamage: 0,
    advanceFrames: 0,
    holdFrames: 0,
    stateTrace: [],
  };
}

function createFloor5SiegeState(world: GameWorld): Floor5SiegeState {
  const config = getFloor5Config();
  const rngStreamKeys = Object.fromEntries(
    config.rngStreams.map((label) => [label, `${world.seed}:floor5:${label}`]),
  ) as Floor5SiegeState['rngStreamKeys'];
  const waveManifest = buildFloor5WaveManifest(rngStreamKeys.waves);
  return {
    phase: { kind: config.phase.initial },
    lastWorldElapsedMs: world.elapsedMs,
    commandPostHealth: config.commandPost.health,
    engineState: 'LOCKED',
    breachState: 'SEALED',
    ram: createFloor5RamState(world, config),
    breach: {
      latched: false,
      committedFrame: null,
      barrierId: null,
      frontFrozen: false,
      commitAttempts: 0,
      cleanup: {
        ramRetired: false,
        markersRetired: 0,
        wallRetired: false,
        heroesCleared: 0,
        minionsCleared: 0,
        waveDebtCleared: 0,
      },
    },
    heroState: 'PENDING',
    heroes: createFloor5HeroSlotState(rngStreamKeys.heroes),
    tasks: {
      openingPushRepelled: false,
      yardSecured: false,
      recoveredComponents: [],
      checkpointCleared: false,
    },
    requisitionMilestones: [],
    construction: {
      progressMs: 0,
      requiredMs: FLOOR5_RAM_BUILD_REQUIRED_MS,
      lastProgressWorldElapsedMs: world.elapsedMs,
      buildSiteUnderAttack: false,
      pausedMs: 0,
      attempts: 0,
      deniedAttempts: 0,
      startedFrame: null,
      completedFrame: null,
    },
    rngStreamKeys,
    trace: [],
    structures: {
      'command-post': {
        id: 'command-post',
        team: 'allied',
        eid: 0,
        health: config.commandPost.health,
        maxHealth: config.commandPost.health,
      },
      'allied-checkpoint': {
        id: 'allied-checkpoint',
        team: 'allied',
        eid: 0,
        health: FLOOR5_STRUCTURE_HEALTH['allied-checkpoint'],
        maxHealth: FLOOR5_STRUCTURE_HEALTH['allied-checkpoint'],
      },
      'enemy-checkpoint': {
        id: 'enemy-checkpoint',
        team: 'enemy',
        eid: 0,
        health: FLOOR5_STRUCTURE_HEALTH['enemy-checkpoint'],
        maxHealth: FLOOR5_STRUCTURE_HEALTH['enemy-checkpoint'],
      },
      'outer-wall': {
        id: 'outer-wall',
        team: 'enemy',
        eid: 0,
        health: FLOOR5_STRUCTURE_HEALTH['outer-wall'],
        maxHealth: FLOOR5_STRUCTURE_HEALTH['outer-wall'],
      },
    },
    waveManifest,
    waveCursor: { allied: 0, enemy: 0 },
    waveRemainder: { allied: 0, enemy: 0 },
    spawnDebt: { allied: 0, enemy: 0 },
    spawnDebtManifestQueue: { allied: [], enemy: [] },
    liveMinions: { allied: 0, enemy: 0 },
    checkpointOwner: 'enemy',
    laneTelemetry: {
      waveCyclesCompleted: 0,
      checkpointContests: 0,
      legalDamageEvents: 0,
      illegalDamageEvents: 0,
      pathStalls: 0,
      spawned: { allied: 0, enemy: 0 },
      spawnDebtPeak: { allied: 0, enemy: 0 },
    },
    combatEventCursor: 0,
  };
}

function floor5SiegeState(world: GameWorld): Floor5SiegeState | undefined {
  return world.floorExtendedState?.floor5Siege;
}

function opposingTeam(team: Floor5SiegeTeam): Floor5SiegeTeam {
  return team === 'allied' ? 'enemy' : 'allied';
}

function floor5StructureMatchesEntity(
  world: GameWorld,
  structure: Floor5SiegeStructureState,
): boolean {
  const eid = structure.eid;
  return (
    eid > 0 &&
    entityExists(world.ecs, eid) &&
    hasComponent(world.ecs, eid, SiegeStructure) &&
    hasComponent(world.ecs, eid, Team) &&
    hasComponent(world.ecs, eid, Health) &&
    (world.stores.siegeStructure.kind[eid] ?? 0) === FLOOR5_STRUCTURE_KIND[structure.id] &&
    (world.stores.siegeStructure.team[eid] ?? 0) === FLOOR5_SIEGE_MARKER_TEAM[structure.team] &&
    (world.stores.team.id[eid] ?? 0) === FLOOR5_TEAM_CODE[structure.team]
  );
}

function structureIsAlive(world: GameWorld, structure: Floor5SiegeStructureState): boolean {
  return (
    floor5StructureMatchesEntity(world, structure) &&
    (world.stores.health.current[structure.eid] ?? 0) > 0
  );
}

function syncFloor5StructureHealth(world: GameWorld, state: Floor5SiegeState): void {
  for (const structure of Object.values(state.structures)) {
    if (floor5StructureMatchesEntity(world, structure)) {
      structure.health = Math.max(0, world.stores.health.current[structure.eid] ?? 0);
      structure.maxHealth = Math.max(
        structure.maxHealth,
        world.stores.health.max[structure.eid] ?? 0,
      );
    } else {
      structure.health = 0;
      structure.eid = 0;
    }
  }
  state.commandPostHealth = state.structures['command-post'].health;
}

function spawnFloor5Structure(
  world: GameWorld,
  state: Floor5SiegeState,
  id: Floor5SiegeStructureId,
  x: number,
  y: number,
): number {
  const structure = state.structures[id];
  const eid = createEntity(world);
  const body = PHYSICS_BODIES['spawner-structure'];
  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
  addComponent(
    world.ecs,
    eid,
    set(Health, { current: structure.maxHealth, max: structure.maxHealth }),
  );
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 3, height: 3 }));
  addComponent(world.ecs, eid, set(Team, { id: FLOOR5_TEAM_CODE[structure.team] }));
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      radius: body.radius,
      halfWidth: body.halfWidth,
      halfHeight: body.halfHeight,
      shape: body.shape,
    }),
  );
  addComponent(world.ecs, eid, set(Weight, { value: body.weight }));
  addComponent(world.ecs, eid, Immovable);
  addComponent(
    world.ecs,
    eid,
    set(SiegeStructure, {
      team: FLOOR5_SIEGE_MARKER_TEAM[structure.team],
      kind: FLOOR5_STRUCTURE_KIND[id],
    }),
  );
  structure.eid = eid;
  structure.health = structure.maxHealth;
  return eid;
}

function spawnFloor5Structures(
  world: GameWorld,
  state: Floor5SiegeState,
  layout: SiegeCastleLayout,
  tileSizeFt: number,
): void {
  for (const id of Object.keys(state.structures) as Floor5SiegeStructureId[]) {
    const position = tileCenterToWorld(layout, id, tileSizeFt);
    spawnFloor5Structure(world, state, id, position.x, position.y);
  }
  syncFloor5StructureHealth(world, state);
}

function countLiveFloor5Minions(world: GameWorld, team: Floor5SiegeTeam): number {
  let count = 0;
  const markerTeam = FLOOR5_SIEGE_MARKER_TEAM[team];
  for (const eid of query(world.ecs, [SiegeMinion, Health])) {
    if (
      (world.stores.siegeMinion.team[eid] ?? 0) === markerTeam &&
      (world.stores.health.current[eid] ?? 0) > 0
    ) {
      count += 1;
    }
  }
  return count;
}

function floor5WaveEntriesForTeam(
  state: Floor5SiegeState,
  team: Floor5SiegeTeam,
): readonly Floor5WaveEntryWithIndex[] {
  return state.waveManifest
    .map((entry, manifestIndex) => ({ entry, manifestIndex }))
    .filter(({ entry }) => entry.team === team);
}

function spawnFloor5Minion(
  world: GameWorld,
  state: Floor5SiegeState,
  team: Floor5SiegeTeam,
  manifestIndex: number,
): number {
  const layout = computeSiegeCastleLayout(siegeCastleOptionsFromConfig(buildFloor5MapConfig()));
  const spawn = tileCenterToWorld(
    layout,
    team === 'allied' ? 'allied-spawn' : 'enemy-spawn',
    world.floorMap?.config.tileSizeFt ?? buildFloor5MapConfig().tileSizeFt,
  );
  const eid = createEntity(world);
  const body = PHYSICS_BODIES['mob-baseline'];
  addComponent(world.ecs, eid, set(Position, spawn));
  addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
  addComponent(world.ecs, eid, set(Health, { current: FLOOR5_MINION_HP, max: FLOOR5_MINION_HP }));
  addComponent(
    world.ecs,
    eid,
    set(Damage, {
      amount: FLOOR5_MINION_DAMAGE,
      cooldownMs: FLOOR5_MINION_COOLDOWN_MS,
      lastFireMs: -FLOOR5_MINION_COOLDOWN_MS,
    }),
  );
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 2, height: 2 }));
  addComponent(world.ecs, eid, set(Team, { id: FLOOR5_TEAM_CODE[team] }));
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      radius: body.radius,
      halfWidth: 0,
      halfHeight: 0,
      shape: SHAPE_CIRCLE,
    }),
  );
  addComponent(world.ecs, eid, set(Weight, { value: body.weight }));
  addComponent(
    world.ecs,
    eid,
    set(SiegeMinion, {
      team: FLOOR5_SIEGE_MARKER_TEAM[team],
      manifestIndex,
      targetEid: 0,
      lastX: spawn.x,
      lastY: spawn.y,
      stillFrames: 0,
    }),
  );
  state.laneTelemetry.spawned[team] += 1;
  return eid;
}

function liveFloor5Minions(world: GameWorld, team?: Floor5SiegeTeam): number[] {
  const markerTeam = team ? FLOOR5_SIEGE_MARKER_TEAM[team] : undefined;
  return Array.from(query(world.ecs, [SiegeMinion, Position, Health]))
    .filter(
      (eid) =>
        (world.stores.health.current[eid] ?? 0) > 0 &&
        (markerTeam === undefined || (world.stores.siegeMinion.team[eid] ?? 0) === markerTeam),
    )
    .sort((a, b) => a - b);
}

function distanceBetween(world: GameWorld, a: number, b: number): number {
  return Math.hypot(
    (world.stores.position.x[a] ?? 0) - (world.stores.position.x[b] ?? 0),
    (world.stores.position.y[a] ?? 0) - (world.stores.position.y[b] ?? 0),
  );
}

function selectFloor5Target(
  world: GameWorld,
  state: Floor5SiegeState,
  eid: number,
  team: Floor5SiegeTeam,
): number | null {
  const enemyTeam = opposingTeam(team);
  const opposingMinion = liveFloor5Minions(world, enemyTeam)
    .map((candidate) => ({ eid: candidate, distance: distanceBetween(world, eid, candidate) }))
    .filter((candidate) => candidate.distance <= FLOOR5_MINION_ATTACK_RANGE_FT)
    .sort((a, b) => a.distance - b.distance || a.eid - b.eid)[0];
  if (opposingMinion) {
    return opposingMinion.eid;
  }

  // Spec `FR5.5`: the outer wall is RAM-ONLY. It is deliberately absent from
  // every minion priority list — chaff must never be able to prioritise (or,
  // via `applyFloor5MinionAttacks`, damage) the wall, otherwise the escort
  // objective could be trivially bypassed by lane attrition.
  const priorities: readonly Floor5SiegeStructureId[] =
    team === 'allied'
      ? state.checkpointOwner === 'allied'
        ? []
        : ['enemy-checkpoint']
      : state.checkpointOwner === 'enemy'
        ? ['command-post']
        : ['allied-checkpoint', 'command-post'];
  for (const structureId of priorities) {
    const structure = state.structures[structureId];
    if (structure.team !== team && structureIsAlive(world, structure)) {
      return structure.eid;
    }
  }

  // Last resort only. The active field Hero is a legal target for the opposing
  // side, but it sits BEHIND the lane objective on purpose: a boss-strength
  // named defender parked on the lane would otherwise soak every allied minion
  // indefinitely and stall the Slice-2 push contract. Allied minions engage a
  // Hero only when that Hero becomes an immediate threat to the ram.
  const heroEid = state.heroes.eid;
  if (team === 'allied' && floor5HeroEntityIsAlive(world, heroEid)) {
    // Spec `FR5.3` escort precedence: while the Ratings Ram is on the field an
    // allied minion only engages the Hero when the Hero is actually inside the
    // ram's protection bubble (i.e. it is a THREAT to the escort). Otherwise it
    // returns `null` so `steerFloor5Minion` rallies it back onto the ram.
    // Without this the whole allied wave beelines a boss-strength Hero across
    // the lane, dies, and leaves the ram unscreened for the rest of the run.
    if (
      floor5RamIsOnField(world, state) &&
      distanceBetween(world, heroEid, state.ram.eid) > getFloor5Config().ram.protection.radiusFt
    ) {
      return null;
    }
    return heroEid;
  }
  return null;
}

/**
 * Shared deterministic steering: walk `eid` one step toward `(tx, ty)` using the
 * same tile pathfinder every Floor 5 actor uses. Reused by minions and Heroes so
 * there is exactly one navigation implementation on this floor.
 */
function stepFloor5Movement(
  world: GameWorld,
  eid: number,
  tx: number,
  ty: number,
  speedFtPerFrame: number,
): void {
  const floorMap = world.floorMap;
  const sx = world.stores.position.x[eid] ?? 0;
  const sy = world.stores.position.y[eid] ?? 0;
  if (!floorMap) {
    const len = Math.hypot(tx - sx, ty - sy);
    setComponent(world.ecs, eid, Velocity, {
      x: len > 0 ? ((tx - sx) / len) * speedFtPerFrame : 0,
      y: len > 0 ? ((ty - sy) / len) * speedFtPerFrame : 0,
    });
    return;
  }

  const start = floorMap.worldToTile(sx, sy);
  const goal = floorMap.worldToTile(tx, ty);
  const path = findTilePath(floorMap, start, goal);
  if (path.length < 2) {
    setComponent(world.ecs, eid, Velocity, { x: 0, y: 0 });
    return;
  }
  const next = floorMap.tileToWorld(path[1]!.x, path[1]!.y);
  const dx = next.x - sx;
  const dy = next.y - sy;
  const len = Math.hypot(dx, dy);
  setComponent(world.ecs, eid, Velocity, {
    x: len > 0 ? (dx / len) * speedFtPerFrame : 0,
    y: len > 0 ? (dy / len) * speedFtPerFrame : 0,
  });
}

function steerFloor5Minion(world: GameWorld, state: Floor5SiegeState, eid: number): void {
  const team =
    (world.stores.siegeMinion.team[eid] ?? 0) === FLOOR5_SIEGE_MARKER_TEAM.allied
      ? 'allied'
      : 'enemy';
  const target = selectFloor5Target(world, state, eid, team);
  world.stores.siegeMinion.targetEid[eid] = target ?? 0;
  if (target === null) {
    // Spec `FR5.3`: an idle allied minion rallies to the Ratings Ram so the
    // escort bubble is actually screened. This only ever moves the minion —
    // escort headcount never gates the advance (see `evaluateFloor5RamProtection`).
    if (team === 'allied' && floor5RamIsOnField(world, state)) {
      const ramEid = state.ram.eid;
      const distance = distanceBetween(world, eid, ramEid);
      const escortStandoffFt = getFloor5Config().ram.protection.radiusFt / 2;
      if (distance > escortStandoffFt) {
        stepFloor5Movement(
          world,
          eid,
          world.stores.position.x[ramEid] ?? 0,
          world.stores.position.y[ramEid] ?? 0,
          FLOOR5_MINION_SPEED_FT_PER_FRAME,
        );
        return;
      }
    }
    setComponent(world.ecs, eid, Velocity, { x: 0, y: 0 });
    return;
  }
  if (distanceBetween(world, eid, target) <= FLOOR5_MINION_ATTACK_RANGE_FT) {
    setComponent(world.ecs, eid, Velocity, { x: 0, y: 0 });
    return;
  }
  stepFloor5Movement(
    world,
    eid,
    world.stores.position.x[target] ?? world.stores.position.x[eid] ?? 0,
    world.stores.position.y[target] ?? world.stores.position.y[eid] ?? 0,
    FLOOR5_MINION_SPEED_FT_PER_FRAME,
  );
}

// ---------------------------------------------------------------------------
// Field Heroes (spec R6)
// ---------------------------------------------------------------------------

function floor5HeroEntityIsAlive(world: GameWorld, eid: number): boolean {
  return (
    eid > 0 &&
    entityExists(world.ecs, eid) &&
    hasComponent(world.ecs, eid, SiegeHero) &&
    hasComponent(world.ecs, eid, Health) &&
    (world.stores.health.current[eid] ?? 0) > 0
  );
}

function floor5HeroRosterEntry(card: Floor5FieldHeroCardEntry) {
  const entry = FLOOR5_FIELD_HERO_ROSTER.find((candidate) => candidate.heroId === card.heroId);
  if (!entry) {
    throw new Error(`Floor 5 field-Hero roster is missing "${card.heroId}"`);
  }
  return entry;
}

function floor5StructurePosition(
  world: GameWorld,
  state: Floor5SiegeState,
  id: Floor5SiegeStructureId,
): { x: number; y: number } | null {
  const structure = state.structures[id];
  if (!floor5StructureMatchesEntity(world, structure)) {
    return null;
  }
  return {
    x: world.stores.position.x[structure.eid] ?? 0,
    y: world.stores.position.y[structure.eid] ?? 0,
  };
}

/** True once the Ratings Ram is being built or moved (spec `FR6.3` latch read). */
function floor5EngineEngaged(state: Floor5SiegeState): boolean {
  return (
    state.phase.kind === 'BUILD' ||
    state.phase.kind === 'ESCORT' ||
    state.engineState === 'BUILDING' ||
    state.engineState === 'READY' ||
    state.engineState === 'ADVANCING' ||
    state.engineState === 'ATTACKING'
  );
}

/**
 * The world-space point a Hero's declared role holds. This is the whole of a
 * Hero's "stance": each role has exactly one anchor rule for its whole
 * lifetime, so a headless test can assert observed position against the role
 * (spec `FR6.2`).
 */
function floor5HeroAnchor(
  world: GameWorld,
  state: Floor5SiegeState,
  role: Floor5FieldHeroRole,
): { x: number; y: number } | null {
  const enemyCheckpoint = floor5StructurePosition(world, state, 'enemy-checkpoint');
  switch (role) {
    case 'counter-push':
      // Push onto the ground the castle lost: the allied-held checkpoint.
      return floor5StructurePosition(world, state, 'allied-checkpoint') ?? enemyCheckpoint;
    case 'engine-disruption': {
      // Task/build-aware: only commits to the build site once BUILD/ESCORT latches.
      if (floor5EngineEngaged(state)) {
        return floor5StructurePosition(world, state, 'command-post') ?? enemyCheckpoint;
      }
      return enemyCheckpoint;
    }
    case 'minion-support': {
      const friends = liveFloor5Minions(world, 'enemy');
      if (friends.length === 0) return enemyCheckpoint;
      let sx = 0;
      let sy = 0;
      for (const friend of friends) {
        sx += world.stores.position.x[friend] ?? 0;
        sy += world.stores.position.y[friend] ?? 0;
      }
      return { x: sx / friends.length, y: sy / friends.length };
    }
    case 'checkpoint-defense':
    case 'artillery':
    default:
      return enemyCheckpoint;
  }
}

/**
 * Role-scoped target selection (spec `FR6.3`). Chooses only WITHIN the Hero's
 * single declared role — there is no cross-role fallback ladder.
 *
 * Heroes engage MINIONS only. Structures are role anchors (where a Hero holds),
 * never Hero damage targets: demolishing structures is the lane-war minion and
 * Ratings Ram contract from Slices 2/3, and a Hero that could level a checkpoint
 * would silently rewrite checkpoint-ownership and build-site rules it does not
 * own. A Hero's pressure on an objective is expressed through position and its
 * telegraphed role ability instead.
 */
function selectFloor5HeroTarget(
  world: GameWorld,
  state: Floor5SiegeState,
  eid: number,
  card: Floor5FieldHeroCardEntry,
): number | null {
  const roster = floor5HeroRosterEntry(card);
  const nearestAlliedMinion = liveFloor5Minions(world, 'allied')
    .map((candidate) => ({ eid: candidate, distance: distanceBetween(world, eid, candidate) }))
    .filter((candidate) => candidate.distance <= roster.aggroRadiusFt)
    .sort((a, b) => a.distance - b.distance || a.eid - b.eid)[0];
  if (!nearestAlliedMinion) {
    return null;
  }

  // Engine disruption is the one role whose objective OVERRIDES a nearby
  // skirmisher: once BUILD/ESCORT latches it refuses to be pulled off the build
  // site, holding its anchor instead of chasing. That refusal is the observable
  // signature of the role (spec FR6.2 — one strategic mode for its lifetime).
  if (card.role === 'engine-disruption' && floor5EngineEngaged(state)) {
    const buildSite = floor5StructurePosition(world, state, 'command-post');
    if (buildSite) {
      const tx = world.stores.position.x[nearestAlliedMinion.eid] ?? 0;
      const ty = world.stores.position.y[nearestAlliedMinion.eid] ?? 0;
      if (Math.hypot(tx - buildSite.x, ty - buildSite.y) > roster.engageRangeFt) {
        return null;
      }
    }
  }
  return nearestAlliedMinion.eid;
}

/** Stance: hold at engage range, close on target, or re-centre on the anchor. */
function steerFloor5Hero(
  world: GameWorld,
  state: Floor5SiegeState,
  eid: number,
  card: Floor5FieldHeroCardEntry,
): void {
  const roster = floor5HeroRosterEntry(card);
  const anchor = floor5HeroAnchor(world, state, card.role);
  if (anchor) {
    world.stores.siegeHero.anchorX[eid] = anchor.x;
    world.stores.siegeHero.anchorY[eid] = anchor.y;
  }

  let target = selectFloor5HeroTarget(world, state, eid, card);
  if (target !== null && anchor) {
    const tx = world.stores.position.x[target] ?? 0;
    const ty = world.stores.position.y[target] ?? 0;
    // Leash: a Hero never abandons its role anchor to chase.
    if (Math.hypot(tx - anchor.x, ty - anchor.y) > roster.leashRadiusFt) {
      target = null;
    }
  }
  world.stores.siegeHero.targetEid[eid] = target ?? 0;
  state.heroes.targetEid = target ?? 0;

  if (target !== null) {
    if (distanceBetween(world, eid, target) <= roster.engageRangeFt) {
      setComponent(world.ecs, eid, Velocity, { x: 0, y: 0 });
      return;
    }
    stepFloor5Movement(
      world,
      eid,
      world.stores.position.x[target] ?? 0,
      world.stores.position.y[target] ?? 0,
      roster.speedFtPerFrame,
    );
    return;
  }

  if (!anchor) {
    setComponent(world.ecs, eid, Velocity, { x: 0, y: 0 });
    return;
  }
  const distanceToAnchor = Math.hypot(
    (world.stores.position.x[eid] ?? 0) - anchor.x,
    (world.stores.position.y[eid] ?? 0) - anchor.y,
  );
  if (distanceToAnchor <= FLOOR5_HERO_ANCHOR_SLACK_FT) {
    setComponent(world.ecs, eid, Velocity, { x: 0, y: 0 });
    return;
  }
  stepFloor5Movement(world, eid, anchor.x, anchor.y, roster.speedFtPerFrame);
}

function spawnFloor5Hero(
  world: GameWorld,
  state: Floor5SiegeState,
  card: Floor5FieldHeroCardEntry,
): void {
  const roster = floor5HeroRosterEntry(card);
  const layout = computeSiegeCastleLayout(siegeCastleOptionsFromConfig(buildFloor5MapConfig()));
  const spawn = tileCenterToWorld(
    layout,
    'enemy-spawn',
    world.floorMap?.config.tileSizeFt ?? buildFloor5MapConfig().tileSizeFt,
  );
  const eid = createEntity(world);
  const body = PHYSICS_BODIES['mob-baseline'];
  addComponent(world.ecs, eid, set(Position, spawn));
  addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
  addComponent(world.ecs, eid, set(Health, { current: roster.hp, max: roster.hp }));
  addComponent(
    world.ecs,
    eid,
    set(Damage, {
      amount: roster.attackDamage,
      cooldownMs: roster.attackCooldownMs,
      lastFireMs: -roster.attackCooldownMs,
    }),
  );
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 3, height: 3 }));
  addComponent(world.ecs, eid, set(Team, { id: FLOOR5_TEAM_CODE.enemy }));
  addComponent(
    world.ecs,
    eid,
    set(Size, { radius: body.radius, halfWidth: 0, halfHeight: 0, shape: SHAPE_CIRCLE }),
  );
  addComponent(world.ecs, eid, set(Weight, { value: body.weight * 1.5 }));
  const anchor = floor5HeroAnchor(world, state, card.role) ?? spawn;
  addComponent(
    world.ecs,
    eid,
    set(SiegeHero, {
      team: FLOOR5_SIEGE_MARKER_TEAM.enemy,
      rosterOrder: card.order,
      role: FLOOR5_HERO_ROLE_CODE[card.role],
      targetEid: 0,
      anchorX: anchor.x,
      anchorY: anchor.y,
    }),
  );
  // Bind the shared mob-ability runtime's caster-validity key to this role, then
  // register the role's one telegraphed ability (spec FR6.3).
  setEnemyAppearanceKey(world, eid, floor5HeroArchetypeKey(card.role));
  registerMobAbility(world, eid, createFloor5HeroAbilityDefinition(card));

  state.heroes.eid = eid;
  state.heroes.status = 'active';
  state.heroes.health = roster.hp;
  state.heroes.maxHealth = roster.hp;
  state.heroes.targetEid = 0;
  state.heroes.spawnedFrame = world.frameCount;
  state.heroes.defeatedFrame = null;
  state.heroes.respawnFrame = null;
  state.heroes.spawns += 1;
  state.heroes.fieldedHeroIds.push(card.heroId);
}

function despawnFloor5Hero(world: GameWorld, state: Floor5SiegeState): void {
  const eid = state.heroes.eid;
  state.heroes.eid = 0;
  state.heroes.targetEid = 0;
  state.heroes.health = 0;
  if (eid > 0 && entityExists(world.ecs, eid)) {
    clearMobAbility(world, eid);
    clearEntityStores(world, eid);
    removeEntity(world.ecs, eid);
  }
}

/**
 * Post-damage defeat authority for the field-Hero slot (spec `FR6.4`).
 *
 * Runs from `floor5ObjectiveTick`, after damage has been applied this tick, so
 * the recorded defeat frame is the frame of the killing blow. The respawn frame
 * is a FIXED manifest-authored offset from that frame — never wall-clock, never
 * an RNG draw. When the without-replacement card is exhausted the slot is
 * `retired` and never refills: that is the spec's "remain defeated according to
 * their slot" outcome.
 */
function resolveFloor5HeroDefeat(world: GameWorld, state: Floor5SiegeState): void {
  const heroes = state.heroes;
  if (heroes.status !== 'active') {
    return;
  }
  if (floor5HeroEntityIsAlive(world, heroes.eid)) {
    heroes.health = Math.max(0, world.stores.health.current[heroes.eid] ?? 0);
    return;
  }

  despawnFloor5Hero(world, state);
  heroes.defeats += 1;
  heroes.defeatedFrame = world.frameCount;
  const hasNextSlot = heroes.cursor + 1 < heroes.card.length;
  if (hasNextSlot) {
    heroes.status = 'down';
    heroes.respawnFrame = world.frameCount + getFloor5HeroConfig().respawnDelayFrames;
  } else {
    heroes.status = 'retired';
    heroes.respawnFrame = null;
  }
}

/**
 * Hero attacks, executed on the same post-damage authority tick as minion
 * attacks so both siege actors resolve through one `applyDamage` path.
 */
function applyFloor5HeroAttacks(world: GameWorld, state: Floor5SiegeState): void {
  const heroes = state.heroes;
  const eid = heroes.eid;
  if (heroes.status !== 'active' || !floor5HeroEntityIsAlive(world, eid)) {
    return;
  }
  const card = heroes.card[heroes.cursor];
  if (!card) return;
  const roster = floor5HeroRosterEntry(card);
  const target = world.stores.siegeHero.targetEid[eid] ?? 0;
  if (
    target <= 0 ||
    !entityExists(world.ecs, target) ||
    !hasComponent(world.ecs, target, Health) ||
    (world.stores.health.current[target] ?? 0) <= 0 ||
    teamForFloor5Entity(world, target) === 'enemy' ||
    distanceBetween(world, eid, target) > roster.engageRangeFt
  ) {
    return;
  }
  const lastFireMs = world.stores.damage.lastFireMs[eid] ?? -Infinity;
  if (world.elapsedMs - lastFireMs < roster.attackCooldownMs) {
    return;
  }
  world.stores.damage.lastFireMs[eid] = world.elapsedMs;
  applyDamage(
    world,
    target,
    roster.attackDamage,
    world.stores.position.x[target] ?? 0,
    world.stores.position.y[target] ?? 0,
    {
      origin: 'environment',
      affinity: 'physical',
      scaleWithPrimary: false,
      canCrit: false,
      delivery: roster.engageRangeFt > FLOOR5_MINION_ATTACK_RANGE_FT ? 'projectile' : 'contact',
      sourceX: world.stores.position.x[eid] ?? 0,
      sourceY: world.stores.position.y[eid] ?? 0,
      sourceEid: eid,
    },
  );
}

/**
 * Floor 5 field-Hero authority (spec `FR6.1`–`FR6.4`).
 *
 * Owns exactly: which drawn Hero occupies the single field slot, when it takes
 * the field, its role-scoped target, and its role-scoped stance. Movement,
 * damage resolution, and telegraphed abilities are executed by the existing
 * shared systems (`stepFloor5Movement` → tile pathfinder, `applyDamage`,
 * `mobAbilitySystem`).
 */
export function siegeHeroSystem(world: GameWorld): void {
  if (world.floorId !== 'floor5' || world.state !== 'playing') {
    return;
  }
  const state = floor5SiegeState(world);
  if (!state || isFloor5Terminal(state)) {
    return;
  }
  // The breach commit explicitly retires the Hero slot; nothing may re-field it.
  if (state.breach.latched) {
    return;
  }
  const heroes = state.heroes;
  const config = getFloor5HeroConfig();

  // Fail-closed liveness: an entity lost outside the defeat path (recycled EID,
  // external despawn) drops the slot to `down` rather than steering a ghost.
  if (heroes.status === 'active' && !floor5HeroEntityIsAlive(world, heroes.eid)) {
    resolveFloor5HeroDefeat(world, state);
  }

  const dueFrame =
    heroes.status === 'pending'
      ? config.firstSpawnFrame
      : heroes.status === 'down'
        ? heroes.respawnFrame
        : null;
  if (dueFrame !== null && world.frameCount >= dueFrame) {
    const nextCursor = heroes.cursor + 1;
    const nextCard = heroes.card[nextCursor];
    if (nextCard) {
      heroes.cursor = nextCursor;
      spawnFloor5Hero(world, state, nextCard);
    } else {
      heroes.status = 'retired';
      heroes.respawnFrame = null;
    }
  }

  if (heroes.status === 'active' && floor5HeroEntityIsAlive(world, heroes.eid)) {
    const card = heroes.card[heroes.cursor];
    if (card) {
      heroes.health = Math.max(0, world.stores.health.current[heroes.eid] ?? 0);
      steerFloor5Hero(world, state, heroes.eid, card);
    }
  }
  state.heroState = floor5HeroStateLabel(heroes);
}

function releaseFloor5WaveDebt(world: GameWorld, state: Floor5SiegeState): void {
  for (const team of ['allied', 'enemy'] as const) {
    const entries = floor5WaveEntriesForTeam(state, team);
    while (
      state.spawnDebt[team] < FLOOR5_MINION_LIVE_CAP &&
      state.waveCursor[team] < entries.length &&
      world.frameCount >= entries[state.waveCursor[team]]!.entry.releaseFrame
    ) {
      const pending = entries[state.waveCursor[team]]!;
      const remaining = state.waveRemainder[team] || pending.entry.count;
      const queued = Math.min(FLOOR5_MINION_LIVE_CAP - state.spawnDebt[team], remaining);
      for (let i = 0; i < queued; i += 1) {
        state.spawnDebtManifestQueue[team].push(pending.manifestIndex);
      }
      state.spawnDebt[team] += queued;
      state.waveRemainder[team] = remaining - queued;
      state.laneTelemetry.spawnDebtPeak[team] = Math.max(
        state.laneTelemetry.spawnDebtPeak[team],
        state.spawnDebt[team],
      );
      if (state.waveRemainder[team] > 0) {
        break;
      }
      state.waveCursor[team] += 1;
    }
    state.liveMinions[team] = countLiveFloor5Minions(world, team);
    while (state.spawnDebt[team] > 0 && state.liveMinions[team] < FLOOR5_MINION_LIVE_CAP) {
      spawnFloor5Minion(world, state, team, state.spawnDebtManifestQueue[team].shift() ?? 0);
      state.spawnDebt[team] -= 1;
      state.liveMinions[team] += 1;
    }
  }
  if (
    state.laneTelemetry.waveCyclesCompleted === 0 &&
    state.waveCursor.allied >= floor5WaveEntriesForTeam(state, 'allied').length &&
    state.waveCursor.enemy >= floor5WaveEntriesForTeam(state, 'enemy').length
  ) {
    state.laneTelemetry.waveCyclesCompleted = 1;
  }
}

function teamForFloor5Entity(world: GameWorld, eid: number): Floor5SiegeTeam | null {
  const team = hasComponent(world.ecs, eid, Team) ? (world.stores.team.id[eid] ?? -1) : -1;
  if (team === TeamId.SIEGE_ALLIED) return 'allied';
  if (team === TeamId.SIEGE_ENEMY) return 'enemy';
  return null;
}

function applyFloor5MinionAttacks(world: GameWorld, state: Floor5SiegeState): void {
  for (const eid of liveFloor5Minions(world)) {
    const team = teamForFloor5Entity(world, eid);
    if (!team) continue;
    const target = world.stores.siegeMinion.targetEid[eid] ?? 0;
    if (
      target <= 0 ||
      !entityExists(world.ecs, target) ||
      !hasComponent(world.ecs, target, Health) ||
      (world.stores.health.current[target] ?? 0) <= 0 ||
      teamForFloor5Entity(world, target) === team ||
      distanceBetween(world, eid, target) > FLOOR5_MINION_ATTACK_RANGE_FT
    ) {
      continue;
    }
    const lastFireMs = world.stores.damage.lastFireMs[eid] ?? -Infinity;
    const cooldownMs = world.stores.damage.cooldownMs[eid] ?? FLOOR5_MINION_COOLDOWN_MS;
    if (world.elapsedMs - lastFireMs < cooldownMs) continue;
    world.stores.damage.lastFireMs[eid] = world.elapsedMs;
    applyDamage(
      world,
      target,
      world.stores.damage.amount[eid] ?? FLOOR5_MINION_DAMAGE,
      world.stores.position.x[target] ?? 0,
      world.stores.position.y[target] ?? 0,
      {
        origin: 'environment',
        affinity: 'physical',
        scaleWithPrimary: false,
        canCrit: false,
        delivery: 'contact',
        sourceX: world.stores.position.x[eid] ?? 0,
        sourceY: world.stores.position.y[eid] ?? 0,
        sourceEid: eid,
      },
    );
  }

  const combatEvents = world.combatEvents;
  if (
    state.combatEventCursor > combatEvents.length ||
    (state.combatEventCursor > 0 &&
      combatEvents[state.combatEventCursor - 1] !== state.lastCombatEvent)
  ) {
    state.combatEventCursor = 0;
  }
  for (
    let eventIndex = state.combatEventCursor;
    eventIndex < combatEvents.length;
    eventIndex += 1
  ) {
    const event = combatEvents[eventIndex]!;
    if (event.type !== 'hit' || event.sourceEid === undefined || event.targetEid === undefined) {
      continue;
    }
    if (!hasComponent(world.ecs, event.sourceEid, SiegeMinion)) {
      continue;
    }
    const sourceTeam = teamForFloor5Entity(world, event.sourceEid);
    const targetTeam = teamForFloor5Entity(world, event.targetEid);
    if (sourceTeam !== null && targetTeam !== null && sourceTeam !== targetTeam) {
      state.laneTelemetry.legalDamageEvents += 1;
    } else {
      state.laneTelemetry.illegalDamageEvents += 1;
    }
  }
  state.combatEventCursor = combatEvents.length;
  state.lastCombatEvent = combatEvents.at(-1);
}

function updateFloor5Checkpoint(world: GameWorld, state: Floor5SiegeState): void {
  const layout = computeSiegeCastleLayout(siegeCastleOptionsFromConfig(buildFloor5MapConfig()));
  const checkpointCenter = centerOf(layout.checkpointPocket);
  const tileSizeFt = world.floorMap?.config.tileSizeFt ?? buildFloor5MapConfig().tileSizeFt;
  const cx = checkpointCenter.x * tileSizeFt + tileSizeFt / 2;
  const cy = checkpointCenter.y * tileSizeFt + tileSizeFt / 2;
  const teamPresent = { allied: false, enemy: false };
  for (const eid of liveFloor5Minions(world)) {
    const team = teamForFloor5Entity(world, eid);
    if (!team) continue;
    const dist = Math.hypot(
      (world.stores.position.x[eid] ?? 0) - cx,
      (world.stores.position.y[eid] ?? 0) - cy,
    );
    if (dist <= FLOOR5_CHECKPOINT_RADIUS_FT) {
      teamPresent[team] = true;
    }
  }
  const nextOwner: Floor5SiegeCheckpointOwner =
    teamPresent.allied && teamPresent.enemy
      ? 'contested'
      : teamPresent.allied
        ? 'allied'
        : teamPresent.enemy
          ? 'enemy'
          : state.checkpointOwner;
  if (
    nextOwner !== state.checkpointOwner &&
    (nextOwner === 'contested' || state.checkpointOwner === 'enemy')
  ) {
    state.laneTelemetry.checkpointContests += 1;
  }
  state.checkpointOwner = nextOwner;
}

function recordFloor5PhaseTransition(
  world: GameWorld,
  state: Floor5SiegeState,
  phase: Floor5SiegePhase,
  reason: string,
): void {
  state.phase = phase;
  state.trace.push({
    phase: clonePhase(phase),
    reason,
    frame: world.frameCount,
    worldElapsedMs: world.elapsedMs,
    commandPostHealth: state.commandPostHealth,
    engineState: state.engineState,
    breachState: state.breachState,
    heroState: state.heroState,
  });
}

function transitionFloor5Phase(
  world: GameWorld,
  state: Floor5SiegeState,
  phase: Floor5SiegePhase,
  reason: string,
): void {
  if (state.phase.kind === phase.kind) {
    return;
  }
  recordFloor5PhaseTransition(world, state, phase, reason);
}

function isFloor5Terminal(state: Floor5SiegeState): boolean {
  return state.phase.kind === 'CAPTURED' || state.phase.kind === 'DEFEAT';
}

export function _completeFloor5FieldTask(world: GameWorld, taskId: Floor5FieldTaskId): boolean {
  const state = floor5SiegeState(world);
  if (!state || isFloor5Terminal(state)) {
    return false;
  }

  switch (taskId) {
    case 'openingPush':
      if (state.tasks.openingPushRepelled) return true;
      state.tasks.openingPushRepelled = true;
      latchFloor5RequisitionMilestone(state, 'opening-push');
      transitionFloor5Phase(world, state, { kind: 'CONTEST' }, 'opening-push-repelled');
      return true;
    case 'siegeYard':
      state.tasks.yardSecured = true;
      latchFloor5RequisitionMilestone(state, 'siege-yard');
      return true;
    case 'checkpoint':
      state.tasks.checkpointCleared = true;
      latchFloor5RequisitionMilestone(state, 'checkpoint');
      return true;
    default: {
      const exhaustive: never = taskId;
      return exhaustive;
    }
  }
}

export function _recoverFloor5RamComponent(
  world: GameWorld,
  componentClass: Floor5RamComponentClass,
): boolean {
  const state = floor5SiegeState(world);
  if (!state || isFloor5Terminal(state)) {
    return false;
  }
  if (!FLOOR5_RAM_COMPONENT_CLASSES.includes(componentClass)) {
    return false;
  }
  if (!state.tasks.recoveredComponents.includes(componentClass)) {
    state.tasks.recoveredComponents.push(componentClass);
  }
  if (hasAllFloor5RamComponents(state)) {
    latchFloor5RequisitionMilestone(state, 'components');
  }
  return true;
}

function _setFloor5BuildSiteUnderAttack(world: GameWorld, underAttack: boolean): boolean {
  const state = floor5SiegeState(world);
  if (!state || isFloor5Terminal(state)) {
    return false;
  }
  state.construction.buildSiteUnderAttack = underAttack;
  return true;
}

export function _requestFloor5RamConstruction(world: GameWorld): boolean {
  const state = floor5SiegeState(world);
  if (!state || isFloor5Terminal(state)) {
    return false;
  }

  state.construction.attempts += 1;
  if (!hasFloor5RamPrerequisites(state)) {
    state.construction.deniedAttempts += 1;
    return false;
  }

  if (state.engineState === 'LOCKED' || state.engineState === 'DESTROYED') {
    // A destroyed ram may only re-enter construction once its authored recovery
    // delay has elapsed (spec `FR5.6`); `advanceFloor5RamRebuild` owns that
    // schedule, so an early manual request is denied rather than skipping it.
    if (state.engineState === 'DESTROYED' && state.ram.rebuildAvailableFrame !== null) {
      state.construction.deniedAttempts += 1;
      return false;
    }
    setFloor5EngineState(world, state, 'BUILDING', 'ram-construction-authorized');
    state.ram.builds += 1;
    state.construction.progressMs = 0;
    state.construction.lastProgressWorldElapsedMs = world.elapsedMs;
    state.construction.startedFrame = world.frameCount;
    state.construction.completedFrame = null;
    transitionFloor5Phase(world, state, { kind: 'BUILD' }, 'ram-construction-authorized');
  }
  return true;
}

function advanceFloor5FieldTasks(world: GameWorld, state: Floor5SiegeState): void {
  if (world.elapsedMs < 1_000 || hasFloor5RamPrerequisites(state)) {
    return;
  }

  _completeFloor5FieldTask(world, 'openingPush');
  _completeFloor5FieldTask(world, 'siegeYard');
  for (const componentClass of FLOOR5_RAM_COMPONENT_CLASSES) {
    _recoverFloor5RamComponent(world, componentClass);
  }
  _completeFloor5FieldTask(world, 'checkpoint');
  _requestFloor5RamConstruction(world);
}

function projectFloor5GoalFlags(world: GameWorld, state: Floor5SiegeState): void {
  setGoalFlag(world, FLOOR5_SIEGE_GOAL_IDS.openingPushRepelled, state.tasks.openingPushRepelled);
  setGoalFlag(world, FLOOR5_SIEGE_GOAL_IDS.yardSecured, state.tasks.yardSecured);
  setGoalFlag(world, FLOOR5_SIEGE_GOAL_IDS.componentsReady, hasAllFloor5RamComponents(state));
  setGoalFlag(world, FLOOR5_SIEGE_GOAL_IDS.checkpointCleared, state.tasks.checkpointCleared);
  setGoalFlag(world, FLOOR5_SIEGE_GOAL_IDS.ramBuilt, state.engineState === 'READY');
  setGoalFlag(world, FLOOR5_SIEGE_GOAL_IDS.wallBreached, state.breachState === 'BREACHED');
  setGoalFlag(world, FLOOR5_SIEGE_GOAL_IDS.courtyardCleared, false);
  setGoalFlag(world, FLOOR5_SIEGE_GOAL_IDS.regentDefeated, false);
  setGoalFlag(world, FLOOR5_SIEGE_GOAL_IDS.castleCaptured, state.phase.kind === 'CAPTURED');
}

function advanceFloor5RamConstruction(world: GameWorld, state: Floor5SiegeState): void {
  const elapsedDeltaMs = Math.max(
    0,
    world.elapsedMs - state.construction.lastProgressWorldElapsedMs,
  );
  state.construction.lastProgressWorldElapsedMs = world.elapsedMs;
  if (elapsedDeltaMs === 0) {
    return;
  }

  // Engine-disruption Hero ability: a telegraphed window that stalls the Ram's
  // advance (spec R6 gimmick). The window is a REAL-TIME window, so it burns
  // down against the fixed-step clock unconditionally — whether or not the Ram
  // is building and whether or not the build site is simultaneously under
  // attack. That is what stops repeated casts from banking deferred stall debt
  // that would be applied long after the telegraph (or after the Hero dies).
  const stalled = Math.min(state.heroes.buildStallMs, elapsedDeltaMs);
  state.heroes.buildStallMs -= stalled;

  if (state.engineState !== 'BUILDING') {
    return;
  }

  if (state.construction.buildSiteUnderAttack) {
    state.construction.pausedMs += elapsedDeltaMs;
    return;
  }

  if (stalled > 0) {
    // Booked through the same paused-progress accounting as build-site pressure.
    state.construction.pausedMs += stalled;
    if (stalled >= elapsedDeltaMs) {
      return;
    }
    state.construction.progressMs = Math.min(
      state.construction.requiredMs,
      state.construction.progressMs + (elapsedDeltaMs - stalled),
    );
    if (state.construction.progressMs >= state.construction.requiredMs) {
      setFloor5EngineState(world, state, 'READY', 'ratings-ram-built');
      state.construction.completedFrame ??= world.frameCount;
    }
    return;
  }

  state.construction.progressMs = Math.min(
    state.construction.requiredMs,
    state.construction.progressMs + elapsedDeltaMs,
  );
  if (state.construction.progressMs >= state.construction.requiredMs) {
    setFloor5EngineState(world, state, 'READY', 'ratings-ram-built');
    state.construction.completedFrame ??= world.frameCount;
  }
}

// ---------------------------------------------------------------------------
// Ratings Ram (spec R5 / FR5.1–FR5.7)
// ---------------------------------------------------------------------------

function getFloor5RamConfig() {
  return getFloor5Config().ram;
}

/**
 * The ONLY sanctioned mutation point for {@link Floor5SiegeState.engineState}.
 * Every transition is appended to `ram.stateTrace`, which is what the real
 * headless pipeline asserts the `BUILDING → READY → ADVANCING → ATTACKING →
 * DESTROYED → BUILDING → READY → ADVANCING → ATTACKING → BREACHED` sequence
 * against. Re-entering the same state is a no-op so the trace stays a pure
 * transition log.
 */
function setFloor5EngineState(
  world: GameWorld,
  state: Floor5SiegeState,
  next: Floor5RatingsRamState,
  reason: string,
): void {
  if (state.engineState === next) return;
  state.engineState = next;
  state.ram.stateTrace.push({ state: next, frame: world.frameCount, reason });
}

function floor5RamIsOnField(world: GameWorld, state: Floor5SiegeState): boolean {
  const eid = state.ram.eid;
  return (
    eid > 0 &&
    entityExists(world.ecs, eid) &&
    hasComponent(world.ecs, eid, SiegeRam) &&
    (world.stores.health.current[eid] ?? 0) > 0
  );
}

function floor5RamRouteTarget(state: Floor5SiegeState): Floor5RamRouteMarkerState | undefined {
  return state.ram.route[Math.min(state.ram.routeIndex, state.ram.route.length - 1)];
}

function spawnFloor5RouteMarkers(world: GameWorld, state: Floor5SiegeState): void {
  for (const marker of state.ram.route) {
    if (marker.eid > 0 && entityExists(world.ecs, marker.eid)) continue;
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Position, { x: marker.x, y: marker.y }));
    addComponent(
      world.ecs,
      eid,
      set(SiegeRouteMarker, { index: marker.index, reached: marker.reachedFrame === null ? 0 : 1 }),
    );
    marker.eid = eid;
  }
}

function retireFloor5RouteMarkers(world: GameWorld, state: Floor5SiegeState): number {
  let retired = 0;
  for (const marker of state.ram.route) {
    if (marker.eid > 0 && entityExists(world.ecs, marker.eid)) {
      clearEntityStores(world, marker.eid);
      removeEntity(world.ecs, marker.eid);
      retired += 1;
    }
    marker.eid = 0;
  }
  return retired;
}

function retireFloor5RamEntity(world: GameWorld, state: Floor5SiegeState): boolean {
  const eid = state.ram.eid;
  state.ram.eid = 0;
  if (eid > 0 && entityExists(world.ecs, eid)) {
    clearEntityStores(world, eid);
    removeEntity(world.ecs, eid);
    return true;
  }
  return false;
}

/** Spawn (or respawn) the ram at the authored `build-site` landmark. */
function spawnFloor5RamEntity(world: GameWorld, state: Floor5SiegeState): number {
  retireFloor5RamEntity(world, state);
  const config = getFloor5RamConfig();
  const buildSite = state.ram.route[0]!;
  const body = PHYSICS_BODIES['spawner-structure'];
  const eid = createEntity(world);
  addComponent(world.ecs, eid, set(Position, { x: buildSite.x, y: buildSite.y }));
  addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
  addComponent(world.ecs, eid, set(Health, { current: config.health, max: config.health }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 3, height: 3 }));
  addComponent(world.ecs, eid, set(Team, { id: TeamId.SIEGE_ALLIED }));
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      radius: body.radius,
      halfWidth: body.halfWidth,
      halfHeight: body.halfHeight,
      shape: body.shape,
    }),
  );
  addComponent(world.ecs, eid, set(Weight, { value: body.weight }));
  addComponent(
    world.ecs,
    eid,
    set(SiegeRam, { routeIndex: 1, protectionMet: 0, strikes: 0, lastStrikeMs: 0 }),
  );
  state.ram.eid = eid;
  state.ram.health = config.health;
  state.ram.maxHealth = config.health;
  state.ram.strikes = 0;
  state.ram.lastStrikeMs = 0;
  state.ram.spawnedFrame = world.frameCount;
  state.ram.destroyedFrame = null;
  state.ram.routeIndex = Math.min(1, state.ram.route.length - 1);
  for (const marker of state.ram.route) {
    marker.reachedFrame = marker.index === 0 ? world.frameCount : null;
    if (marker.eid > 0 && entityExists(world.ecs, marker.eid)) {
      world.stores.siegeRouteMarker.reached[marker.eid] = marker.index === 0 ? 1 : 0;
    }
  }
  spawnFloor5RouteMarkers(world, state);
  return eid;
}

/**
 * Spec `FR5.3` — advance gating.
 *
 * The gate is a THREAT threshold, never an escort headcount: Floor 5 releases
 * its allied wave once and never replenishes it, so a "needs N escorts alive"
 * rule would permanently soft-lock the escort the moment the allied wave was
 * attrited. Escort count is still measured and reported (it is what clears the
 * threats), it just does not gate.
 */
function evaluateFloor5RamProtection(world: GameWorld, state: Floor5SiegeState): boolean {
  const { radiusFt, maxThreats } = getFloor5RamConfig().protection;
  const ramEid = state.ram.eid;
  if (!floor5RamIsOnField(world, state)) {
    state.ram.escorts = 0;
    state.ram.threats = 0;
    state.ram.protectionMet = false;
    return false;
  }
  let escorts = 0;
  let threats = 0;
  for (const eid of liveFloor5Minions(world)) {
    if (distanceBetween(world, eid, ramEid) > radiusFt) continue;
    if ((world.stores.siegeMinion.team[eid] ?? 0) === FLOOR5_SIEGE_MARKER_TEAM.allied) {
      escorts += 1;
    } else {
      threats += 1;
    }
  }
  const heroEid = state.heroes.eid;
  if (
    floor5HeroEntityIsAlive(world, heroEid) &&
    distanceBetween(world, heroEid, ramEid) <= radiusFt
  ) {
    threats += 1;
  }
  state.ram.escorts = escorts;
  state.ram.threats = threats;
  state.ram.protectionMet = threats <= maxThreats;
  world.stores.siegeRam.protectionMet[ramEid] = state.ram.protectionMet ? 1 : 0;
  return state.ram.protectionMet;
}

/** Walk the ram one step along the derived semantic route. */
function advanceFloor5RamRoute(world: GameWorld, state: Floor5SiegeState): void {
  const config = getFloor5RamConfig();
  const ramEid = state.ram.eid;
  const target = floor5RamRouteTarget(state);
  if (!target) return;
  const rx = world.stores.position.x[ramEid] ?? 0;
  const ry = world.stores.position.y[ramEid] ?? 0;
  // Arrival is "within tolerance OR standing on the landmark's tile". The tile
  // test is load-bearing, not belt-and-braces: `stepFloor5Movement` resolves a
  // TILE path, so once the ram shares a tile with its waypoint the path is a
  // single node and steering legitimately produces zero velocity. Without the
  // tile test the escort parks a metre short of a junction forever.
  const tile = world.floorMap?.worldToTile(rx, ry);
  const onLandmarkTile = tile !== undefined && tile.x === target.tileX && tile.y === target.tileY;
  if (Math.hypot(target.x - rx, target.y - ry) <= config.arrivalToleranceFt || onLandmarkTile) {
    target.reachedFrame ??= world.frameCount;
    if (target.eid > 0 && entityExists(world.ecs, target.eid)) {
      world.stores.siegeRouteMarker.reached[target.eid] = 1;
    }
    if (state.ram.routeIndex < state.ram.route.length - 1) {
      state.ram.routeIndex += 1;
      world.stores.siegeRam.routeIndex[ramEid] = state.ram.routeIndex;
    }
    setComponent(world.ecs, ramEid, Velocity, { x: 0, y: 0 });
    return;
  }
  state.ram.advanceFrames += 1;
  stepFloor5Movement(world, ramEid, target.x, target.y, config.advanceSpeedFtPerFrame);
}

function floor5RamAtAttackAnchor(world: GameWorld, state: Floor5SiegeState): boolean {
  const finalMarker = state.ram.route[state.ram.route.length - 1]!;
  if (finalMarker.reachedFrame === null) return false;
  const wall = state.structures['outer-wall'];
  if (!structureIsAlive(world, wall)) return false;
  return distanceBetween(world, state.ram.eid, wall.eid) <= getFloor5RamConfig().strike.rangeFt;
}

/**
 * Spec `FR5.5` — outer-wall damage authority.
 *
 * `ram.wallAuthorizedHealth` is the scenario's ledger of the ONLY legitimate
 * source of outer-wall damage (ram strikes). Any other system that lowers the
 * wall's ECS health is restored here and counted. Symmetrically, the ram's hull
 * is only ever spent by outer-wall counter-battery fire, so it is restored too.
 * Run BEFORE `applyFloor5RamStrike` so the strike's own damage is never rolled back.
 */
function enforceFloor5SiegeDamageAuthority(world: GameWorld, state: Floor5SiegeState): void {
  const wall = state.structures['outer-wall'];
  if (floor5StructureMatchesEntity(world, wall)) {
    const current = world.stores.health.current[wall.eid] ?? 0;
    const authorized = state.ram.wallAuthorizedHealth;
    if (current !== authorized) {
      if (current < authorized) {
        state.ram.rejectedWallDamage += authorized - current;
      }
      setComponent(world.ecs, wall.eid, Health, { current: authorized, max: wall.maxHealth });
    }
  }
  if (floor5RamIsOnField(world, state)) {
    const current = world.stores.health.current[state.ram.eid] ?? 0;
    if (current !== state.ram.health) {
      setComponent(world.ecs, state.ram.eid, Health, {
        current: state.ram.health,
        max: state.ram.maxHealth,
      });
    }
  }
}

/**
 * Ram ↔ outer-wall exchange. Runs inside the objective tick's damage phase so
 * ALL post-damage resolution stays in one authority.
 */
function applyFloor5RamStrike(world: GameWorld, state: Floor5SiegeState): void {
  if (state.engineState !== 'ATTACKING' || state.breach.latched) return;
  if (!floor5RamIsOnField(world, state)) return;
  const wall = state.structures['outer-wall'];
  if (!structureIsAlive(world, wall)) return;
  const config = getFloor5RamConfig();
  if (distanceBetween(world, state.ram.eid, wall.eid) > config.strike.rangeFt) return;
  if (
    state.ram.lastStrikeMs > 0 &&
    world.elapsedMs - state.ram.lastStrikeMs < config.strike.cooldownMs
  ) {
    return;
  }
  state.ram.lastStrikeMs = world.elapsedMs;
  world.stores.siegeRam.lastStrikeMs[state.ram.eid] = world.elapsedMs;
  state.ram.strikes += 1;
  world.stores.siegeRam.strikes[state.ram.eid] = state.ram.strikes;

  applyDamage(
    world,
    wall.eid,
    config.strike.damage,
    world.stores.position.x[wall.eid] ?? 0,
    world.stores.position.y[wall.eid] ?? 0,
    {
      origin: 'environment',
      affinity: 'physical',
      scaleWithPrimary: false,
      canCrit: false,
      delivery: 'contact',
      sourceX: world.stores.position.x[state.ram.eid] ?? 0,
      sourceY: world.stores.position.y[state.ram.eid] ?? 0,
      sourceEid: state.ram.eid,
    },
  );
  const wallHealth = Math.max(0, world.stores.health.current[wall.eid] ?? 0);
  state.ram.wallDamageDealt += Math.max(0, state.ram.wallAuthorizedHealth - wallHealth);
  state.ram.wallAuthorizedHealth = wallHealth;

  // Counter-battery: the wall answers every strike. This is the ONLY source of
  // ram damage, which is what makes the destruction/rebuild cycle replayable.
  if (config.strike.wallCounterDamage > 0) {
    applyDamage(
      world,
      state.ram.eid,
      config.strike.wallCounterDamage,
      world.stores.position.x[state.ram.eid] ?? 0,
      world.stores.position.y[state.ram.eid] ?? 0,
      {
        origin: 'environment',
        affinity: 'physical',
        scaleWithPrimary: false,
        canCrit: false,
        delivery: 'contact',
        sourceX: world.stores.position.x[wall.eid] ?? 0,
        sourceY: world.stores.position.y[wall.eid] ?? 0,
        sourceEid: wall.eid,
      },
    );
    const ramHealth = Math.max(0, world.stores.health.current[state.ram.eid] ?? 0);
    state.ram.counterDamageTaken += Math.max(0, state.ram.health - ramHealth);
    state.ram.health = ramHealth;
  }
}

function syncFloor5RamHealth(world: GameWorld, state: Floor5SiegeState): void {
  if (state.ram.eid > 0 && entityExists(world.ecs, state.ram.eid)) {
    state.ram.health = Math.max(0, world.stores.health.current[state.ram.eid] ?? 0);
  } else if (state.ram.eid > 0) {
    state.ram.eid = 0;
    state.ram.health = 0;
  }
}

function destroyFloor5Ram(world: GameWorld, state: Floor5SiegeState, reason: string): void {
  retireFloor5RamEntity(world, state);
  retireFloor5RouteMarkers(world, state);
  state.ram.health = 0;
  state.ram.protectionMet = false;
  state.ram.escorts = 0;
  state.ram.threats = 0;
  state.ram.destroyedFrame = world.frameCount;
  state.ram.destructions += 1;
  state.ram.rebuildAvailableFrame = world.frameCount + getFloor5RamConfig().recoveryDelayFrames;
  setFloor5EngineState(world, state, 'DESTROYED', reason);
  transitionFloor5Phase(world, state, { kind: 'BUILD' }, reason);
}

/** Zero every outstanding wave/spawn obligation. Returns the units cancelled. */
function clearFloor5WaveDebt(state: Floor5SiegeState): number {
  let cleared = 0;
  for (const team of ['allied', 'enemy'] as const) {
    cleared += state.waveRemainder[team] + state.spawnDebt[team];
    state.waveRemainder[team] = 0;
    state.spawnDebt[team] = 0;
    state.spawnDebtManifestQueue[team].length = 0;
    state.waveCursor[team] = state.waveManifest.length;
  }
  return cleared;
}

function clearFloor5Minions(world: GameWorld, state: Floor5SiegeState): number {
  let cleared = 0;
  for (const eid of query(world.ecs, [SiegeMinion])) {
    clearEntityStores(world, eid);
    removeEntity(world.ecs, eid);
    cleared += 1;
  }
  state.liveMinions.allied = 0;
  state.liveMinions.enemy = 0;
  return cleared;
}

/**
 * One-shot outer-wall breach commit (spec `FR5.7`).
 *
 * Every observable consequence of the breach lands in ONE transaction, in a
 * fixed order, exactly once: drop the sealing barrier (whose live blocked-tile
 * registry is consulted by navigation), retire the ram + route markers + wall entity, freeze the lane
 * front at the courtyard, cancel all outstanding wave/spawn debt, and
 * explicitly clean up the field Hero and every live minion. Re-entry is a
 * counted no-op — `commitAttempts` proves the latch under test.
 */
function commitFloor5Breach(world: GameWorld, state: Floor5SiegeState): void {
  state.breach.commitAttempts += 1;
  if (state.breach.latched) return;
  state.breach.latched = true;
  state.breach.committedFrame = world.frameCount;

  // 1. Drop the barrier that sealed the carved ingress. Navigation consults the
  //    live blocked-tile registry, so the newly-open lane is visible immediately.
  if (state.breach.barrierId !== null) {
    dropBarrier(world, state.breach.barrierId);
    state.breach.barrierId = null;
  }

  // 2. Retire the siege engine, its route markers, and the wall itself.
  state.breach.cleanup.ramRetired = retireFloor5RamEntity(world, state);
  state.breach.cleanup.markersRetired = retireFloor5RouteMarkers(world, state);
  const wall = state.structures['outer-wall'];
  if (floor5StructureMatchesEntity(world, wall)) {
    clearEntityStores(world, wall.eid);
    removeEntity(world.ecs, wall.eid);
    state.breach.cleanup.wallRetired = true;
  }
  wall.eid = 0;
  wall.health = 0;
  state.ram.wallAuthorizedHealth = 0;
  state.ram.health = 0;

  // 3. Freeze the lane front at the courtyard and cancel every wave obligation
  //    so no spawn debt can leak past the breach.
  state.breach.frontFrozen = true;
  state.breach.cleanup.waveDebtCleared = clearFloor5WaveDebt(state);

  // 4. Explicit actor cleanup — Heroes first (they own ability runtime state),
  //    then every remaining minion on both sides.
  const heroWasFielded = floor5HeroEntityIsAlive(world, state.heroes.eid);
  despawnFloor5Hero(world, state);
  state.heroes.status = 'retired';
  state.heroes.respawnFrame = null;
  state.heroes.targetEid = 0;
  state.breach.cleanup.heroesCleared = heroWasFielded ? 1 : 0;
  state.heroState = floor5HeroStateLabel(state.heroes);
  state.breach.cleanup.minionsCleared = clearFloor5Minions(world, state);

  // 5. Latch the terminal ram/breach states last so every observer that reads
  //    `BREACHED` also sees a fully cleaned-up world.
  state.breachState = 'BREACHED';
  setFloor5EngineState(world, state, 'BREACHED', 'outer-wall-breached');
  recordFloor5PhaseTransition(world, state, { kind: 'BREACH' }, 'outer-wall-breached');
}

/**
 * Post-damage wall-vs-ram outcome, evaluated AFTER the Command Post defeat
 * precedence in {@link floor5ObjectiveTick}.
 *
 * Precedence when both fall on the same tick: Command Post defeat (already
 * handled by the caller) > outer-wall lethal (breach) > ram lethal
 * (destruction). A wall that reached 0 HP can never be un-destroyed, so the
 * wall's lethal blow wins and the doomed ram is retired by the breach cleanup.
 */
function resolveFloor5WallVsRam(world: GameWorld, state: Floor5SiegeState): void {
  if (state.breach.latched) return;
  const wall = state.structures['outer-wall'];
  const wallDown = !structureIsAlive(world, wall) && wall.maxHealth > 0 && wall.eid !== 0;
  const ramDown = state.ram.eid > 0 && state.ram.health <= 0;
  if (wallDown) {
    commitFloor5Breach(world, state);
    return;
  }
  if (ramDown) {
    destroyFloor5Ram(world, state, 'ratings-ram-destroyed');
  }
}

/** Fixed-tick rebuild schedule (spec `FR5.6`). */
function advanceFloor5RamRebuild(world: GameWorld, state: Floor5SiegeState): void {
  if (state.engineState !== 'DESTROYED' || state.breach.latched) return;
  const availableFrame = state.ram.rebuildAvailableFrame;
  if (availableFrame === null || world.frameCount < availableFrame) return;
  state.ram.rebuildAvailableFrame = null;
  state.construction.progressMs = 0;
  state.construction.lastProgressWorldElapsedMs = world.elapsedMs;
  state.construction.attempts += 1;
  state.construction.startedFrame = world.frameCount;
  state.construction.completedFrame = null;
  state.ram.builds += 1;
  setFloor5EngineState(world, state, 'BUILDING', 'ratings-ram-rebuild-started');
  spawnFloor5RamEntity(world, state);
  transitionFloor5Phase(world, state, { kind: 'BUILD' }, 'ratings-ram-rebuild-started');
}

/**
 * Floor 5 Ratings Ram spawn / movement / protection system (spec `R5`).
 *
 * Deliberately NOT a damage authority: every post-damage consequence (strike
 * resolution, destruction, breach commit) stays in `floor5ObjectiveTick` so
 * there is exactly one ordering site.
 */
export function siegeRamSystem(world: GameWorld): void {
  if (world.floorId !== 'floor5' || world.state !== 'playing') {
    return;
  }
  const state = floor5SiegeState(world);
  if (!state || isFloor5Terminal(state) || state.breach.latched) {
    return;
  }

  advanceFloor5RamRebuild(world, state);

  if (state.engineState === 'LOCKED' || state.engineState === 'DESTROYED') {
    return;
  }

  // The ram becomes a real, observable entity the moment construction starts.
  if (!floor5RamIsOnField(world, state)) {
    if (state.engineState === 'BUILDING' || state.engineState === 'READY') {
      spawnFloor5RamEntity(world, state);
    } else {
      return;
    }
  }

  const protectionMet = evaluateFloor5RamProtection(world, state);

  if (state.engineState === 'BUILDING') {
    setComponent(world.ecs, state.ram.eid, Velocity, { x: 0, y: 0 });
    return;
  }

  if (state.engineState === 'READY') {
    if (!protectionMet) {
      state.ram.holdFrames += 1;
      setComponent(world.ecs, state.ram.eid, Velocity, { x: 0, y: 0 });
      return;
    }
    setFloor5EngineState(world, state, 'ADVANCING', 'ratings-ram-escort-started');
    recordFloor5PhaseTransition(world, state, { kind: 'ESCORT' }, 'ratings-ram-escort-started');
  }

  if (state.engineState === 'ADVANCING') {
    if (floor5RamAtAttackAnchor(world, state)) {
      setComponent(world.ecs, state.ram.eid, Velocity, { x: 0, y: 0 });
      setFloor5EngineState(world, state, 'ATTACKING', 'ratings-ram-reached-breach-approach');
      return;
    }
    if (!protectionMet) {
      state.ram.holdFrames += 1;
      setComponent(world.ecs, state.ram.eid, Velocity, { x: 0, y: 0 });
      return;
    }
    advanceFloor5RamRoute(world, state);
    return;
  }

  if (state.engineState === 'ATTACKING') {
    setComponent(world.ecs, state.ram.eid, Velocity, { x: 0, y: 0 });
  }
}

/**
 * Seal the carved breach ingress at floor init (spec `FR5.1`).
 *
 * `SiegeCastleGenerator` deliberately carves the breach site as passable
 * RUBBLE so the post-breach courtyard route is authored in the tile layout.
 * The floor therefore starts with the wall already open, which would let the
 * player and every minion walk straight past the objective. Rather than
 * mutating `TileMap.flags` (which the generator owns and which would desync
 * the authored layout), the ingress is closed with the existing dynamic poly
 * barrier: it blocks movement, projectiles and `findTilePath` alike, carries
 * no `Health` so nothing can chip it down, and dropping it at breach commit is
 * a single version-bumping transaction.
 */
function sealFloor5BreachIngress(
  world: GameWorld,
  state: Floor5SiegeState,
  floorMap: { readonly tileMap: { index(x: number, y: number): number } },
  layout: SiegeCastleLayout,
): void {
  const tiles: number[] = [];
  for (let y = layout.breachSite.y; y < layout.breachSite.y + layout.breachSite.height; y += 1) {
    for (let x = layout.breachSite.x; x < layout.breachSite.x + layout.breachSite.width; x += 1) {
      tiles.push(floorMap.tileMap.index(x, y));
    }
  }
  if (tiles.length === 0) return;
  const handle = createPolyBarrier(world, tiles, 'wall');
  state.breach.barrierId = handle.id;
}

export function getFloor5SiegeRunStats(world: GameWorld): Floor5SiegeRunStats | undefined {
  const state = floor5SiegeState(world);
  if (!state) return undefined;
  syncFloor5StructureHealth(world, state);
  const activeCard = state.heroes.cursor >= 0 ? state.heroes.card[state.heroes.cursor] : undefined;
  return {
    phase: clonePhase(state.phase),
    commandPostHealth: state.commandPostHealth,
    engineState: state.engineState,
    breachState: state.breachState,
    ram: {
      eid: state.ram.eid,
      health: state.ram.health,
      maxHealth: state.ram.maxHealth,
      routeIndex: state.ram.routeIndex,
      routeLandmarks: state.ram.route.map((marker) => marker.landmark),
      routeReached: state.ram.route
        .filter((marker) => marker.reachedFrame !== null)
        .map((marker) => marker.landmark),
      protectionMet: state.ram.protectionMet,
      escorts: state.ram.escorts,
      threats: state.ram.threats,
      strikes: state.ram.strikes,
      builds: state.ram.builds,
      destructions: state.ram.destructions,
      wallDamageDealt: state.ram.wallDamageDealt,
      counterDamageTaken: state.ram.counterDamageTaken,
      rejectedWallDamage: state.ram.rejectedWallDamage,
      advanceFrames: state.ram.advanceFrames,
      holdFrames: state.ram.holdFrames,
      rebuildAvailableFrame: state.ram.rebuildAvailableFrame,
      stateSequence: state.ram.stateTrace.map((entry) => entry.state),
      stateTrace: state.ram.stateTrace.map((entry) => ({ ...entry })),
    },
    breach: {
      latched: state.breach.latched,
      committedFrame: state.breach.committedFrame,
      barrierSealed: state.breach.barrierId !== null,
      frontFrozen: state.breach.frontFrozen,
      commitAttempts: state.breach.commitAttempts,
      cleanup: { ...state.breach.cleanup },
    },
    heroState: state.heroState,
    heroes: {
      card: state.heroes.card.map((entry) => ({ ...entry })),
      status: state.heroes.status,
      cursor: state.heroes.cursor,
      activeHeroId: state.heroes.status === 'active' ? (activeCard?.heroId ?? null) : null,
      activeRole: state.heroes.status === 'active' ? (activeCard?.role ?? null) : null,
      eid: state.heroes.eid,
      health: state.heroes.health,
      maxHealth: state.heroes.maxHealth,
      targetEid: state.heroes.targetEid,
      spawnedFrame: state.heroes.spawnedFrame,
      defeatedFrame: state.heroes.defeatedFrame,
      respawnFrame: state.heroes.respawnFrame,
      fieldedHeroIds: [...state.heroes.fieldedHeroIds],
      spawns: state.heroes.spawns,
      defeats: state.heroes.defeats,
      abilityCasts: state.heroes.abilityCasts,
      buildStallMs: state.heroes.buildStallMs,
    },
    tasks: {
      openingPushRepelled: state.tasks.openingPushRepelled,
      yardSecured: state.tasks.yardSecured,
      recoveredComponents: [...state.tasks.recoveredComponents],
      componentsReady: hasAllFloor5RamComponents(state),
      checkpointCleared: state.tasks.checkpointCleared,
      allPrerequisitesMet: hasFloor5RamPrerequisites(state),
    },
    requisition: {
      milestones: [...state.requisitionMilestones],
      completedMilestones: state.requisitionMilestones.length,
      requiredMilestones: FLOOR5_REQUISITION_MILESTONES.length,
      ready: FLOOR5_REQUISITION_MILESTONES.every((milestone) =>
        state.requisitionMilestones.includes(milestone),
      ),
    },
    construction: {
      progressMs: state.construction.progressMs,
      requiredMs: state.construction.requiredMs,
      buildSiteUnderAttack: state.construction.buildSiteUnderAttack,
      pausedMs: state.construction.pausedMs,
      attempts: state.construction.attempts,
      deniedAttempts: state.construction.deniedAttempts,
      startedFrame: state.construction.startedFrame,
      completedFrame: state.construction.completedFrame,
    },
    rngStreamKeys: { ...state.rngStreamKeys },
    trace: state.trace.map(cloneTraceEntry),
    structures: {
      'command-post': cloneStructure(state.structures['command-post']),
      'allied-checkpoint': cloneStructure(state.structures['allied-checkpoint']),
      'enemy-checkpoint': cloneStructure(state.structures['enemy-checkpoint']),
      'outer-wall': cloneStructure(state.structures['outer-wall']),
    },
    waveManifest: state.waveManifest.map((entry) => ({ ...entry })),
    spawnDebt: { ...state.spawnDebt },
    liveMinions: { ...state.liveMinions },
    checkpointOwner: state.checkpointOwner,
    laneTelemetry: {
      waveCyclesCompleted: state.laneTelemetry.waveCyclesCompleted,
      checkpointContests: state.laneTelemetry.checkpointContests,
      legalDamageEvents: state.laneTelemetry.legalDamageEvents,
      illegalDamageEvents: state.laneTelemetry.illegalDamageEvents,
      pathStalls: state.laneTelemetry.pathStalls,
      spawned: { ...state.laneTelemetry.spawned },
      spawnDebtPeak: { ...state.laneTelemetry.spawnDebtPeak },
    },
  };
}

export function siegeDirectorSystem(world: GameWorld): void {
  if (world.floorId !== 'floor5' || world.state !== 'playing') {
    return;
  }
  const state = floor5SiegeState(world);
  if (!state || isFloor5Terminal(state)) {
    return;
  }
  state.lastWorldElapsedMs = world.elapsedMs;
  const buildSite = state.ram.route[0];
  const threatRadius = getFloor5RamConfig().protection.radiusFt;
  const isNearBuildSite = (eid: number): boolean =>
    buildSite !== undefined &&
    Math.hypot(
      (world.stores.position.x[eid] ?? 0) - buildSite.x,
      (world.stores.position.y[eid] ?? 0) - buildSite.y,
    ) <= threatRadius;
  const enemyMinionThreat = liveFloor5Minions(world, 'enemy').some(isNearBuildSite);
  const heroThreat =
    floor5HeroEntityIsAlive(world, state.heroes.eid) && isNearBuildSite(state.heroes.eid);
  _setFloor5BuildSiteUnderAttack(world, enemyMinionThreat || heroThreat);
  if (state.commandPostHealth <= 0) {
    recordFloor5PhaseTransition(world, state, { kind: 'DEFEAT' }, 'command-post-destroyed');
  }
}

export function siegeMinionSystem(world: GameWorld): void {
  if (world.floorId !== 'floor5' || world.state !== 'playing') {
    return;
  }
  const state = floor5SiegeState(world);
  if (!state || state.phase.kind === 'CAPTURED' || state.phase.kind === 'DEFEAT') {
    return;
  }
  // Post-breach the lane front is frozen at the courtyard: no further wave
  // release, no debt drain, no steering. Without this the commit's cleanup
  // would be undone by the very next tick.
  if (state.breach.frontFrozen) {
    state.liveMinions.allied = 0;
    state.liveMinions.enemy = 0;
    return;
  }
  releaseFloor5WaveDebt(world, state);
  for (const team of ['allied', 'enemy'] as const) {
    state.liveMinions[team] = countLiveFloor5Minions(world, team);
  }
  for (const eid of liveFloor5Minions(world)) {
    const x = world.stores.position.x[eid] ?? 0;
    const y = world.stores.position.y[eid] ?? 0;
    const lastX = world.stores.siegeMinion.lastX[eid] ?? x;
    const lastY = world.stores.siegeMinion.lastY[eid] ?? y;
    steerFloor5Minion(world, state, eid);
    const target = world.stores.siegeMinion.targetEid[eid] ?? 0;
    const inAttackRange =
      target > 0 && distanceBetween(world, eid, target) <= FLOOR5_MINION_ATTACK_RANGE_FT;
    if (Math.hypot(x - lastX, y - lastY) <= 0.01 && target > 0 && !inAttackRange) {
      world.stores.siegeMinion.stillFrames[eid] =
        (world.stores.siegeMinion.stillFrames[eid] ?? 0) + 1;
      if (world.stores.siegeMinion.stillFrames[eid] === FLOOR5_PATH_STALL_FRAMES) {
        state.laneTelemetry.pathStalls += 1;
      }
    } else {
      world.stores.siegeMinion.stillFrames[eid] = 0;
    }
    world.stores.siegeMinion.lastX[eid] = x;
    world.stores.siegeMinion.lastY[eid] = y;
  }
}

export function confirmFloor5StairDescend(): boolean {
  return false;
}

export function getFloor5RunOutcome(world: GameWorld) {
  const phase = floor5SiegeState(world)?.phase.kind;
  return phase === 'CAPTURED' ? 'cleared_floor' : phase === 'DEFEAT' ? 'failed_timeout' : null;
}

function floor5ObjectiveTick(world: GameWorld): void {
  if (world.floorId !== 'floor5' || world.state !== 'playing') {
    return;
  }
  const state = floor5SiegeState(world);
  if (!state) {
    return;
  }
  if (isFloor5Terminal(state)) {
    projectFloor5GoalFlags(world, state);
    return;
  }
  // --- Damage phase -------------------------------------------------------
  applyFloor5MinionAttacks(world, state);
  applyFloor5HeroAttacks(world, state);
  // Roll back any damage the outer wall / ram took from an unauthorised source
  // BEFORE the ram's own strike lands, so the strike is never rolled back.
  enforceFloor5SiegeDamageAuthority(world, state);
  applyFloor5RamStrike(world, state);
  // --- Health sync --------------------------------------------------------
  syncFloor5StructureHealth(world, state);
  syncFloor5RamHealth(world, state);
  resolveFloor5HeroDefeat(world, state);
  state.heroState = floor5HeroStateLabel(state.heroes);
  // --- Outcome precedence -------------------------------------------------
  // 1. Command Post defeat is absolute and short-circuits everything else.
  if (state.commandPostHealth <= 0) {
    recordFloor5PhaseTransition(world, state, { kind: 'DEFEAT' }, 'command-post-destroyed');
    projectFloor5GoalFlags(world, state);
    return;
  }
  // 2. Wall-vs-ram: a lethal blow on the wall outranks a lethal blow on the ram.
  resolveFloor5WallVsRam(world, state);
  if (state.breach.latched && state.breach.committedFrame === world.frameCount) {
    // The breach commit already froze the front and cleaned every actor up;
    // running the lane systems again this tick would resurrect that bookkeeping.
    projectFloor5GoalFlags(world, state);
    return;
  }
  updateFloor5Checkpoint(world, state);
  for (const team of ['allied', 'enemy'] as const) {
    state.liveMinions[team] = countLiveFloor5Minions(world, team);
  }
  advanceFloor5FieldTasks(world, state);
  advanceFloor5RamConstruction(world, state);
  projectFloor5GoalFlags(world, state);
}

function equipFloor5StarterWeapon(
  world: GameWorld,
  playerEid: number,
  starterWeaponPool: readonly string[],
): void {
  if (starterWeaponPool.length === 0) return;
  const weaponRng = new SeededRandomClass(hashStringToSeed(`${world.seed}:floor5:starter-weapon`));
  const pickedId = starterWeaponPool[weaponRng.nextInt(0, starterWeaponPool.length - 1)];
  const weaponDef =
    (pickedId ? getWeaponDef(pickedId) : undefined) ??
    (starterWeaponPool[0] ? getWeaponDef(starterWeaponPool[0]) : undefined);
  if (!weaponDef) return;
  equipStarterOrFallback(world, weaponDef.id, weaponDef);
  initializePlayerWeaponSkills(world, playerEid);
}

export function initializeFloor5Scenario(
  world: GameWorld,
  playerEid: number,
  options?: { readonly playerCarryover?: PlayerCarryoverSnapshot },
): void {
  const manifest = getFloor5Manifest();
  const mapConfig = buildFloor5MapConfig();
  const layout = computeSiegeCastleLayout(siegeCastleOptionsFromConfig(mapConfig));
  if (mapConfig.widthTiles < layout.widthTiles || mapConfig.heightTiles < layout.heightTiles) {
    throw new Error(
      `Floor 5 map config is smaller than authored battlefield: got ${mapConfig.widthTiles}×${mapConfig.heightTiles}, needs at least ${layout.widthTiles}×${layout.heightTiles}`,
    );
  }
  const floorMap = getGenerator(mapConfig.biome).generate(
    mapConfig,
    new SeededRandomClass(hashStringToSeed(`${world.seed}:floor5:battlefield`)),
  );
  world.floorMap = floorMap;
  attachBarriersToFloorMap(world);
  world.floor = 5;
  world.floorId = 'floor5';
  world.floorScenario = null;
  const siegeState = createFloor5SiegeState(world);
  world.floorExtendedState = { floor5Siege: siegeState };
  world.hideFloorTimer = true;
  // Floor 5 field Heroes are the first production users of the shared
  // mob-ability runtime, so this floor explicitly opts in. Nothing casts until
  // `siegeHeroSystem` registers a Hero: registration is the real gate.
  setMobAbilitiesEnabled(world, true);
  activateMobAbilityEncounter(world);

  const spawn = floorMap.tileToWorld(floorMap.playerSpawn.x, floorMap.playerSpawn.y);
  if (hasComponent(world.ecs, playerEid, Position)) {
    setComponent(world.ecs, playerEid, Position, { x: spawn.x, y: spawn.y });
  }
  if (!hasComponent(world.ecs, playerEid, BroadcastScore)) {
    addComponent(world.ecs, playerEid, set(BroadcastScore, { current: 0 }));
  }

  removeStatModifiers(world, 'floor', FLOOR5_PLAYER_STAT_SOURCE_ID);
  if (manifest.player.moveSpeedBonus > 0) {
    addStatModifier(world, {
      sourceType: 'floor',
      sourceId: FLOOR5_PLAYER_STAT_SOURCE_ID,
      stat: 'moveSpeed',
      op: 'add',
      value: manifest.player.moveSpeedBonus,
    });
  }
  if (manifest.player.pickupRangeBonus > 0) {
    addStatModifier(world, {
      sourceType: 'floor',
      sourceId: FLOOR5_PLAYER_STAT_SOURCE_ID,
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
    equipFloor5StarterWeapon(world, playerEid, manifest.starterWeapons);
  }

  for (const questId of FLOOR5_SLICE3_QUEST_IDS) {
    acceptQuest(world, questId);
  }
  setTrackedQuest(world, FLOOR5_SLICE3_QUEST_IDS[0]);

  world.featureUnlocks.inventory = true;
  world.featureUnlocks.equipment = true;
  world.featureUnlocks.spells = true;
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
  spawnFloor5Structures(world, siegeState, layout, mapConfig.tileSizeFt);
  sealFloor5BreachIngress(world, siegeState, floorMap, layout);
  world.state = 'playing';
  world.floorObjectiveTick = floor5ObjectiveTick;
}
