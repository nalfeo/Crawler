import { addComponent, hasComponent, set, setComponent } from 'bitecs';
import { attachBarriersToFloorMap } from '../core/barriers/index.js';
import { BroadcastScore, Position, type GameWorld } from '../core/index.js';
import {
  broadcastRelaySetOptionsFromConfig,
  computeBroadcastRelaySetLayout,
} from '../core/map/generators/BroadcastRelaySetGenerator.js';
import { getGenerator } from '../core/map/generators/registry.js';
import { floor6Manifest } from '../shared/floor-manifest.js';
import type { Floor6DefenseState } from '../shared/floor-types.js';
import { BiomeType, type MapConfig } from '../shared/map-types.js';
import { hashStringToSeed, SeededRandom } from '../shared/random.js';
import type { ScenarioRunOutcome } from '../shared/scenario-presentation.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { initializePlayerWeaponSkills } from './floorScenario.js';
import type { PlayerCarryoverSnapshot } from './playerCarryover.js';
import { restorePlayerCarryover } from './playerCarryover.js';
import { equipStarterOrFallback } from './scenarios/starterWeaponEquip.js';

function getFloor6Config(): NonNullable<typeof floor6Manifest.floor6> {
  const config = floor6Manifest.floor6;
  if (!config) {
    throw new Error('Floor 6 manifest is missing floor6 configuration');
  }
  return config;
}

export function _buildFloor6MapConfig(): MapConfig {
  const manifest = floor6Manifest;
  const config = getFloor6Config();
  return {
    widthTiles: manifest.map.widthTiles,
    heightTiles: manifest.map.heightTiles,
    tileSizeFt: manifest.map.tileSizeFt,
    biome: manifest.map.biome ?? BiomeType.BROADCAST_RELAY_SET,
    seed: manifest.map.seed,
    roomWidthRange: manifest.map.roomWidthRange,
    roomHeightRange: manifest.map.roomHeightRange,
    maxRooms: manifest.map.maxRooms,
    floorDensity: manifest.map.floorDensity,
    broadcastRelaySet: {
      routeWidthTiles: config.geometry.routeWidthTiles,
      buildSiteSizeTiles: config.geometry.buildSiteSizeTiles,
      borderThicknessTiles: config.geometry.borderThicknessTiles,
      supportedFootprints: config.supportedFootprints,
    },
  };
}

function createFloor6DefenseState(world: GameWorld, mapConfig: MapConfig): Floor6DefenseState {
  const config = getFloor6Config();
  const rngStreamKeys = Object.freeze(
    Object.fromEntries(
      config.rngStreams.map((label) => [label, `${world.seed}:floor6:${label}`] as const),
    ),
  ) as Floor6DefenseState['rngStreamKeys'];
  return {
    phase: { kind: config.phase.initial },
    phaseTrace: [],
    rngStreamKeys,
    geometry: computeBroadcastRelaySetLayout(broadcastRelaySetOptionsFromConfig(mapConfig)),
  };
}

function equipFloor6StarterWeapon(world: GameWorld, playerEid: number): void {
  const starterId = floor6Manifest.starterWeapons[0];
  const starter = starterId ? getWeaponDef(starterId) : undefined;
  if (!starterId || !starter) return;
  equipStarterOrFallback(world, starterId, starter);
  initializePlayerWeaponSkills(world, playerEid);
}

export function initializeFloor6Scenario(
  world: GameWorld,
  playerEid: number,
  options?: { readonly playerCarryover?: PlayerCarryoverSnapshot },
): void {
  const mapConfig = _buildFloor6MapConfig();
  const defenseState = createFloor6DefenseState(world, mapConfig);
  const floorMap = getGenerator(mapConfig.biome).generate(
    mapConfig,
    new SeededRandom(hashStringToSeed(defenseState.rngStreamKeys.dressing)),
  );

  world.floorMap = floorMap;
  world.setPieceProps.length = 0;
  attachBarriersToFloorMap(world);
  world.floor = 6;
  world.floorId = 'floor6';
  world.floorScenario = null;
  world.floorExtendedState = { floor6Defense: defenseState };
  world.hideFloorTimer = true;
  world.floorObjectiveTick = null;

  const spawn = floorMap.tileToWorld(floorMap.playerSpawn.x, floorMap.playerSpawn.y);
  if (hasComponent(world.ecs, playerEid, Position)) {
    setComponent(world.ecs, playerEid, Position, { x: spawn.x, y: spawn.y });
  }
  if (!hasComponent(world.ecs, playerEid, BroadcastScore)) {
    addComponent(world.ecs, playerEid, set(BroadcastScore, { current: 0 }));
  }

  if (options?.playerCarryover) {
    restorePlayerCarryover(world, playerEid, options.playerCarryover);
    initializePlayerWeaponSkills(world, playerEid);
  } else {
    equipFloor6StarterWeapon(world, playerEid);
  }

  world.featureUnlocks.inventory = true;
  world.featureUnlocks.equipment = true;
  world.featureUnlocks.spells = true;
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
  world.state = 'playing';
}

/** Floor 6 cannot open its exit before the later finale/release slices. */
export function confirmFloor6StairDescend(): boolean {
  return false;
}

export function getFloor6RunOutcome(world: GameWorld): ScenarioRunOutcome | null {
  const phase = world.floorExtendedState?.floor6Defense?.phase.kind;
  if (phase === 'VICTORY') return 'cleared_floor';
  if (phase === 'DEFEAT') return 'failed_timeout';
  return null;
}

/** JSON-stable initialization artifact used by parity tests and the parity lab. */
export function _getFloor6InitializationArtifact(world: GameWorld) {
  const map = world.floorMap;
  const defense = world.floorExtendedState?.floor6Defense;
  if (!map || !defense) return null;
  return {
    map: {
      config: map.config,
      playerSpawn: map.playerSpawn,
      rooms: map.rooms.map((room) => ({
        id: room.id,
        bounds: room.bounds,
        role: room.role,
        label: room.label,
        neighbors: [...room.neighbors],
      })),
      tileFlags: [...map.tileMap.flags],
      terrain: [...map.terrain],
    },
    phase: defense.phase,
    phaseTrace: defense.phaseTrace,
    rngStreamKeys: defense.rngStreamKeys,
    geometry: defense.geometry,
  };
}
