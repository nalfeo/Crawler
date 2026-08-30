import { addComponent, entityExists, hasComponent, query, set, setComponent } from 'bitecs';
import { attachBarriersToFloorMap } from '../core/barriers/index.js';
import {
  applyDamage,
  BroadcastScore,
  Damage,
  Health,
  Immovable,
  Position,
  SiegeMinion,
  SiegeStructure,
  Size,
  Sprite,
  Team,
  Velocity,
  Weight,
  createEntity,
  type GameWorld,
} from '../core/index.js';
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
import { getWeaponDef } from '../shared/weaponDefs.js';
import { initializePlayerWeaponSkills } from './floorScenario.js';
import type { PlayerCarryoverSnapshot } from './playerCarryover.js';
import { restorePlayerCarryover } from './playerCarryover.js';
import { equipStarterOrFallback } from './scenarios/starterWeaponEquip.js';
import { addStatModifier, removeStatModifiers } from './systems/statsSystem.js';

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
const FLOOR5_STRUCTURE_HEALTH: Record<Floor5SiegeStructureId, number> = {
  'command-post': 90,
  'allied-checkpoint': 36,
  'enemy-checkpoint': 36,
  'outer-wall': 140,
};

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
              : {
                  x: layout.breachSite.x + layout.breachSite.width + 2,
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
    heroState: 'PENDING',
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
): readonly Floor5SiegeWaveManifestEntry[] {
  return state.waveManifest.filter((entry) => entry.team === team);
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

  const priorities: readonly Floor5SiegeStructureId[] =
    team === 'allied'
      ? state.checkpointOwner === 'allied'
        ? ['outer-wall']
        : ['enemy-checkpoint', 'outer-wall']
      : state.checkpointOwner === 'enemy'
        ? ['command-post']
        : ['allied-checkpoint', 'command-post'];
  for (const structureId of priorities) {
    const structure = state.structures[structureId];
    if (structure.team !== team && structureIsAlive(world, structure)) {
      return structure.eid;
    }
  }
  return null;
}

function steerFloor5Minion(world: GameWorld, state: Floor5SiegeState, eid: number): void {
  const team =
    (world.stores.siegeMinion.team[eid] ?? 0) === FLOOR5_SIEGE_MARKER_TEAM.allied
      ? 'allied'
      : 'enemy';
  const target = selectFloor5Target(world, state, eid, team);
  world.stores.siegeMinion.targetEid[eid] = target ?? 0;
  if (target === null || distanceBetween(world, eid, target) <= FLOOR5_MINION_ATTACK_RANGE_FT) {
    setComponent(world.ecs, eid, Velocity, { x: 0, y: 0 });
    return;
  }

  const floorMap = world.floorMap;
  const sx = world.stores.position.x[eid] ?? 0;
  const sy = world.stores.position.y[eid] ?? 0;
  const tx = world.stores.position.x[target] ?? sx;
  const ty = world.stores.position.y[target] ?? sy;
  if (!floorMap) {
    const len = Math.hypot(tx - sx, ty - sy);
    setComponent(world.ecs, eid, Velocity, {
      x: len > 0 ? ((tx - sx) / len) * FLOOR5_MINION_SPEED_FT_PER_FRAME : 0,
      y: len > 0 ? ((ty - sy) / len) * FLOOR5_MINION_SPEED_FT_PER_FRAME : 0,
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
    x: len > 0 ? (dx / len) * FLOOR5_MINION_SPEED_FT_PER_FRAME : 0,
    y: len > 0 ? (dy / len) * FLOOR5_MINION_SPEED_FT_PER_FRAME : 0,
  });
}

function releaseFloor5WaveDebt(world: GameWorld, state: Floor5SiegeState): void {
  for (const team of ['allied', 'enemy'] as const) {
    const entries = floor5WaveEntriesForTeam(state, team);
    while (
      state.waveCursor[team] < entries.length &&
      world.frameCount >= entries[state.waveCursor[team]]!.releaseFrame
    ) {
      const manifestIndex = state.waveCursor[team];
      const queued = Math.min(
        FLOOR5_MINION_LIVE_CAP - state.spawnDebt[team],
        entries[manifestIndex]!.count,
      );
      for (let i = 0; i < queued; i += 1) {
        state.spawnDebtManifestQueue[team].push(manifestIndex);
      }
      state.spawnDebt[team] += queued;
      state.laneTelemetry.spawnDebtPeak[team] = Math.max(
        state.laneTelemetry.spawnDebtPeak[team],
        state.spawnDebt[team],
      );
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

export function getFloor5SiegeRunStats(world: GameWorld): Floor5SiegeRunStats | undefined {
  const state = floor5SiegeState(world);
  if (!state) return undefined;
  syncFloor5StructureHealth(world, state);
  return {
    phase: clonePhase(state.phase),
    commandPostHealth: state.commandPostHealth,
    engineState: state.engineState,
    breachState: state.breachState,
    heroState: state.heroState,
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
  if (!state || state.phase.kind === 'CAPTURED' || state.phase.kind === 'DEFEAT') {
    return;
  }
  state.lastWorldElapsedMs = world.elapsedMs;
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
    if (
      Math.hypot(x - lastX, y - lastY) <= 0.01 &&
      (world.stores.siegeMinion.targetEid[eid] ?? 0) > 0
    ) {
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
  const state = floor5SiegeState(world);
  if (!state || state.phase.kind === 'CAPTURED' || state.phase.kind === 'DEFEAT') {
    return;
  }
  applyFloor5MinionAttacks(world, state);
  syncFloor5StructureHealth(world, state);
  if (state.commandPostHealth <= 0) {
    recordFloor5PhaseTransition(world, state, { kind: 'DEFEAT' }, 'command-post-destroyed');
    return;
  }
  updateFloor5Checkpoint(world, state);
  for (const team of ['allied', 'enemy'] as const) {
    state.liveMinions[team] = countLiveFloor5Minions(world, team);
  }
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

  world.featureUnlocks.inventory = true;
  world.featureUnlocks.equipment = true;
  world.featureUnlocks.spells = true;
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
  spawnFloor5Structures(world, siegeState, layout, mapConfig.tileSizeFt);
  world.state = 'playing';
  world.floorObjectiveTick = floor5ObjectiveTick;
}
