import { addComponent, hasComponent, set, setComponent } from 'bitecs';
import { attachBarriersToFloorMap } from '../core/barriers/index.js';
import { BroadcastScore, Health, Position, type GameWorld } from '../core/index.js';
import {
  computeSiegeCastleLayout,
  siegeCastleOptionsFromConfig,
} from '../core/map/generators/SiegeCastleGenerator.js';
import { getGenerator } from '../core/map/generators/registry.js';
import { getFloorManifest } from '../shared/floor-registry.js';
import { BiomeType, type MapConfig } from '../shared/map-types.js';
import { SeededRandom as SeededRandomClass, hashStringToSeed } from '../shared/random.js';
import type {
  Floor5SiegePhase,
  Floor5SiegePhaseTraceEntry,
  Floor5SiegeRunStats,
  Floor5SiegeState,
} from '../shared/floor-types.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { initializePlayerWeaponSkills } from './floorScenario.js';
import type { PlayerCarryoverSnapshot } from './playerCarryover.js';
import { restorePlayerCarryover } from './playerCarryover.js';
import { equipStarterOrFallback } from './scenarios/starterWeaponEquip.js';
import { addStatModifier, removeStatModifiers } from './systems/statsSystem.js';

const FLOOR5_PLAYER_STAT_SOURCE_ID = 'floor5-manifest-player';

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

export function buildFloor5MapConfig(): MapConfig {
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
          checkpointCount: geometry.lane.checkpointCount,
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

function clonePhase(phase: Floor5SiegePhase): Floor5SiegePhase {
  return { ...phase };
}

function cloneTraceEntry(entry: Floor5SiegePhaseTraceEntry): Floor5SiegePhaseTraceEntry {
  return { ...entry, phase: clonePhase(entry.phase) };
}

function createFloor5SiegeState(world: GameWorld): Floor5SiegeState {
  const config = getFloor5Config();
  const rngStreamKeys = Object.fromEntries(
    config.rngStreams.map((label) => [label, `${world.seed}:floor5:${label}`]),
  ) as Floor5SiegeState['rngStreamKeys'];
  return {
    phase: { kind: config.phase.initial },
    lastWorldElapsedMs: world.elapsedMs,
    commandPostHealth: config.commandPost.health,
    engineState: 'LOCKED',
    breachState: 'SEALED',
    heroState: 'PENDING',
    rngStreamKeys,
    trace: [],
  };
}

function floor5SiegeState(world: GameWorld): Floor5SiegeState | undefined {
  return world.floorExtendedState?.floor5Siege;
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
  return {
    phase: clonePhase(state.phase),
    commandPostHealth: state.commandPostHealth,
    engineState: state.engineState,
    breachState: state.breachState,
    heroState: state.heroState,
    rngStreamKeys: { ...state.rngStreamKeys },
    trace: state.trace.map(cloneTraceEntry),
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

export function confirmFloor5StairDescend(): boolean {
  return false;
}

export function getFloor5RunOutcome(world: GameWorld) {
  const phase = floor5SiegeState(world)?.phase.kind;
  return phase === 'CAPTURED' ? 'cleared_floor' : phase === 'DEFEAT' ? 'failed_timeout' : null;
}

function floor5ObjectiveTick(_world: GameWorld): void {}

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
  world.floorExtendedState = { floor5Siege: createFloor5SiegeState(world) };
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
  world.state = 'playing';
  world.floorObjectiveTick = floor5ObjectiveTick;
}
