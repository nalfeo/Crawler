import { spawnPlayer } from '../../core/spawners/combatants.js';
import { createGameWorld, type GameWorld } from '../../core/world.js';
import {
  FLOOR2_CAVE_SYSTEM_DEFAULTS,
  initializeFloor2Scenario,
} from '../../game/floor2Scenario.js';
import { initializeFloor1Scenario } from '../../game/floorScenario.js';
import { floor1Config } from '../../shared/floor-config.js';
import { getFloorManifest } from '../../shared/floor-registry.js';
import { BiomeType } from '../../shared/map-types.js';

export type PreviewFloorId = 'floor1' | 'floor2';

export interface FloorConstraintDefaults {
  readonly biome: BiomeType;
  readonly widthTiles: number;
  readonly heightTiles: number;
  readonly maxRooms: number;
  readonly floorDensity: number;
  readonly roomWidthMin: number;
  readonly roomWidthMax: number;
  readonly roomHeightMin: number;
  readonly roomHeightMax: number;
  readonly cavePresentCount: number;
  readonly caveInitialFill: number;
  readonly caveSmoothingPasses: number;
  readonly caveBossDenSize: number;
  readonly caveResourceHeartDiameterTiles: number;
  readonly caveTerritoryRadiusFraction: number;
  readonly caveDenStartAngleJitterFraction: number;
  readonly caveDenDistanceJitterFraction: number;
  readonly caveDenTargetRadiusMinFraction: number;
  readonly caveDenTargetRadiusMaxFraction: number;
  readonly caveDenTargetMinSeparationTiles: number;
  readonly caveSpawnMinDistanceFromDenTiles: number;
  readonly caveSpawnMinDistanceFromResourceHeartTiles: number;
  readonly caveSpawnMinDistanceFromSettlementTiles: number;
  readonly caveSettlementMinDistanceFromDenTiles: number;
  readonly caveSettlementMinDistanceFromResourceHeartTiles: number;
  readonly caveRegionSeparationTiles: number;
  readonly caveMaxRetries: number;
  readonly caveCavernWidenPasses: number;
  readonly caveStraightHallwayMinRun: number;
}

export interface ScenarioWorldFactoryResult {
  readonly world: GameWorld;
  readonly playerEid: number;
}

export type ScenarioWorldFactory = (seed: number, floor: number) => ScenarioWorldFactoryResult;

const DEFAULT_CAVE_SETTINGS = {
  presentCount: 4,
  initialFill: 0.5,
  smoothingPasses: 4,
  bossDenSize: 5,
  resourceHeartDiameterTiles: 20,
  territoryRadiusFraction: 0.3,
  denStartAngleJitterFraction: 1.0,
  denDistanceJitterFraction: 1.0,
  denTargetRadiusMinFraction: 0.6,
  denTargetRadiusMaxFraction: 0.8,
  denTargetMinSeparationTiles: 12,
  spawnMinDistanceFromDenTiles: 24,
  spawnMinDistanceFromResourceHeartTiles: 24,
  spawnMinDistanceFromSettlementTiles: 24,
  settlementMinDistanceFromDenTiles: 20,
  settlementMinDistanceFromResourceHeartTiles: 16,
  regionSeparationTiles: 0,
  maxRetries: 8,
  cavernWidenPasses: 2,
  straightHallwayMinRun: 10,
} as const;
function defaultScenarioWorldFactory(seed: number, floor: number): ScenarioWorldFactoryResult {
  const world = createGameWorld({ seed, floor });
  const playerEid = spawnPlayer(world, 0, 0);
  return { world, playerEid };
}

export function getFloorConstraintDefaults(floorId: PreviewFloorId): FloorConstraintDefaults {
  if (floorId === 'floor1') {
    return {
      biome: BiomeType.BASIC_UNDERGROUND,
      widthTiles: floor1Config.map.widthTiles,
      heightTiles: floor1Config.map.heightTiles,
      maxRooms: floor1Config.map.maxRooms,
      floorDensity: floor1Config.map.floorDensity,
      roomWidthMin: floor1Config.map.roomWidthRange[0],
      roomWidthMax: floor1Config.map.roomWidthRange[1],
      roomHeightMin: floor1Config.map.roomHeightRange[0],
      roomHeightMax: floor1Config.map.roomHeightRange[1],
      cavePresentCount: DEFAULT_CAVE_SETTINGS.presentCount,
      caveInitialFill: DEFAULT_CAVE_SETTINGS.initialFill,
      caveSmoothingPasses: DEFAULT_CAVE_SETTINGS.smoothingPasses,
      caveBossDenSize: DEFAULT_CAVE_SETTINGS.bossDenSize,
      caveResourceHeartDiameterTiles: DEFAULT_CAVE_SETTINGS.resourceHeartDiameterTiles,
      caveTerritoryRadiusFraction: DEFAULT_CAVE_SETTINGS.territoryRadiusFraction,
      caveDenStartAngleJitterFraction: DEFAULT_CAVE_SETTINGS.denStartAngleJitterFraction,
      caveDenDistanceJitterFraction: DEFAULT_CAVE_SETTINGS.denDistanceJitterFraction,
      caveDenTargetRadiusMinFraction: DEFAULT_CAVE_SETTINGS.denTargetRadiusMinFraction,
      caveDenTargetRadiusMaxFraction: DEFAULT_CAVE_SETTINGS.denTargetRadiusMaxFraction,
      caveDenTargetMinSeparationTiles: DEFAULT_CAVE_SETTINGS.denTargetMinSeparationTiles,
      caveSpawnMinDistanceFromDenTiles: DEFAULT_CAVE_SETTINGS.spawnMinDistanceFromDenTiles,
      caveSpawnMinDistanceFromResourceHeartTiles:
        DEFAULT_CAVE_SETTINGS.spawnMinDistanceFromResourceHeartTiles,
      caveSpawnMinDistanceFromSettlementTiles:
        DEFAULT_CAVE_SETTINGS.spawnMinDistanceFromSettlementTiles,
      caveSettlementMinDistanceFromDenTiles:
        DEFAULT_CAVE_SETTINGS.settlementMinDistanceFromDenTiles,
      caveSettlementMinDistanceFromResourceHeartTiles:
        DEFAULT_CAVE_SETTINGS.settlementMinDistanceFromResourceHeartTiles,
      caveRegionSeparationTiles: DEFAULT_CAVE_SETTINGS.regionSeparationTiles,
      caveMaxRetries: DEFAULT_CAVE_SETTINGS.maxRetries,
      caveCavernWidenPasses: DEFAULT_CAVE_SETTINGS.cavernWidenPasses,
      caveStraightHallwayMinRun: DEFAULT_CAVE_SETTINGS.straightHallwayMinRun,
    };
  }

  const manifest = getFloorManifest('floor2');
  if (!manifest) {
    throw new Error('Floor 2 manifest is not registered.');
  }
  return {
    biome: (manifest.map.biome ?? BiomeType.CAVE_SYSTEM) as BiomeType,
    widthTiles: manifest.map.widthTiles,
    heightTiles: manifest.map.heightTiles,
    maxRooms: manifest.map.maxRooms,
    floorDensity: manifest.map.floorDensity,
    roomWidthMin: manifest.map.roomWidthRange[0],
    roomWidthMax: manifest.map.roomWidthRange[1],
    roomHeightMin: manifest.map.roomHeightRange[0],
    roomHeightMax: manifest.map.roomHeightRange[1],
    cavePresentCount: manifest.floor2?.presentCount ?? DEFAULT_CAVE_SETTINGS.presentCount,
    caveInitialFill: FLOOR2_CAVE_SYSTEM_DEFAULTS.initialFill,
    caveSmoothingPasses: FLOOR2_CAVE_SYSTEM_DEFAULTS.smoothingPasses,
    caveBossDenSize: FLOOR2_CAVE_SYSTEM_DEFAULTS.bossDenSize,
    caveResourceHeartDiameterTiles: FLOOR2_CAVE_SYSTEM_DEFAULTS.resourceHeartDiameterTiles,
    caveTerritoryRadiusFraction: FLOOR2_CAVE_SYSTEM_DEFAULTS.territoryRadiusFraction,
    caveDenStartAngleJitterFraction: FLOOR2_CAVE_SYSTEM_DEFAULTS.denStartAngleJitterFraction,
    caveDenDistanceJitterFraction: FLOOR2_CAVE_SYSTEM_DEFAULTS.denDistanceJitterFraction,
    caveDenTargetRadiusMinFraction: FLOOR2_CAVE_SYSTEM_DEFAULTS.denTargetRadiusMinFraction,
    caveDenTargetRadiusMaxFraction: FLOOR2_CAVE_SYSTEM_DEFAULTS.denTargetRadiusMaxFraction,
    caveDenTargetMinSeparationTiles: FLOOR2_CAVE_SYSTEM_DEFAULTS.denTargetMinSeparationTiles,
    caveSpawnMinDistanceFromDenTiles: FLOOR2_CAVE_SYSTEM_DEFAULTS.spawnMinDistanceFromDenTiles,
    caveSpawnMinDistanceFromResourceHeartTiles:
      FLOOR2_CAVE_SYSTEM_DEFAULTS.spawnMinDistanceFromResourceHeartTiles,
    caveSpawnMinDistanceFromSettlementTiles:
      FLOOR2_CAVE_SYSTEM_DEFAULTS.spawnMinDistanceFromSettlementTiles,
    caveSettlementMinDistanceFromDenTiles:
      FLOOR2_CAVE_SYSTEM_DEFAULTS.settlementMinDistanceFromDenTiles,
    caveSettlementMinDistanceFromResourceHeartTiles:
      FLOOR2_CAVE_SYSTEM_DEFAULTS.settlementMinDistanceFromResourceHeartTiles,
    caveRegionSeparationTiles: FLOOR2_CAVE_SYSTEM_DEFAULTS.regionSeparationTiles,
    caveMaxRetries: FLOOR2_CAVE_SYSTEM_DEFAULTS.maxRetries,
    caveCavernWidenPasses: FLOOR2_CAVE_SYSTEM_DEFAULTS.cavernWidenPasses,
    caveStraightHallwayMinRun: FLOOR2_CAVE_SYSTEM_DEFAULTS.straightHallwayMinRun,
  };
}

export function buildConstrainedFloorPreview(
  floorId: PreviewFloorId,
  seed: number,
  worldFactory: ScenarioWorldFactory = defaultScenarioWorldFactory,
): GameWorld {
  const floor = floorId === 'floor1' ? 1 : 2;
  const { world, playerEid } = worldFactory(seed, floor);
  if (floorId === 'floor1') {
    initializeFloor1Scenario(world, playerEid);
  } else {
    initializeFloor2Scenario(world, playerEid);
  }
  if (!world.floorMap) {
    throw new Error(`Scenario preview failed to generate a map for ${floorId}.`);
  }
  return world;
}
