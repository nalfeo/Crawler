import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/spawners/combatants.js';
import type { GameWorld } from '../../src/core/world.js';
import { FLOOR2_CAVE_SYSTEM_DEFAULTS } from '../../src/game/floor2Scenario.js';
import { floor1Config } from '../../src/shared/floor-config.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import { BiomeType } from '../../src/shared/map-types.js';
import {
  buildConstrainedFloorPreview,
  getFloorConstraintDefaults,
  type ScenarioWorldFactory,
} from '../../src/labs/map-gen-lab/runtime-preview.js';
import { createTestWorld } from '../helpers/world-factory.js';

const testWorldFactory: ScenarioWorldFactory = (seed, floor) => {
  const world = createTestWorld({ seed, floor });
  const playerEid = spawnPlayer(world, 0, 0);
  return { world, playerEid };
};

function getNpcTileSnapshot(world: GameWorld): Record<string, string> {
  const map = world.floorMap!;
  const snapshot: Record<string, string> = {};
  for (const [eid, instance] of world.npcs.entries()) {
    const tile = map.worldToTile(
      world.stores.position.x[eid] ?? Number.NaN,
      world.stores.position.y[eid] ?? Number.NaN,
    );
    snapshot[instance.defId] = `${tile.x},${tile.y}`;
  }
  return snapshot;
}

function roomIdAtNpc(world: GameWorld, npcEid: number): number {
  const map = world.floorMap!;
  const tile = map.worldToTile(
    world.stores.position.x[npcEid] ?? Number.NaN,
    world.stores.position.y[npcEid] ?? Number.NaN,
  );
  return map.roomGraph.getRoomAt(tile.x, tile.y);
}

describe('map-gen lab runtime preview', () => {
  it('uses Floor 1 gameplay defaults instead of manifest-biome fallback', () => {
    const defaults = getFloorConstraintDefaults('floor1');
    expect(defaults.biome).toBe(BiomeType.BASIC_UNDERGROUND);
    expect(defaults.widthTiles).toBe(floor1Config.map.widthTiles);
    expect(defaults.heightTiles).toBe(floor1Config.map.heightTiles);
    expect(defaults.maxRooms).toBe(floor1Config.map.maxRooms);
    expect(defaults.floorDensity).toBe(floor1Config.map.floorDensity);
    expect(defaults.roomWidthMin).toBe(floor1Config.map.roomWidthRange[0]);
    expect(defaults.roomWidthMax).toBe(floor1Config.map.roomWidthRange[1]);
    expect(defaults.roomHeightMin).toBe(floor1Config.map.roomHeightRange[0]);
    expect(defaults.roomHeightMax).toBe(floor1Config.map.roomHeightRange[1]);
    expect(defaults.cavePresentCount).toBe(4);
    expect(defaults.caveInitialFill).toBe(0.5);
    expect(defaults.caveSmoothingPasses).toBe(4);
    expect(defaults.caveBossDenSize).toBe(5);
    expect(defaults.caveResourceHeartDiameterTiles).toBe(20);
    expect(defaults.caveTerritoryRadiusFraction).toBe(0.3);
    expect(defaults.caveDenStartAngleJitterFraction).toBe(1.0);
    expect(defaults.caveDenDistanceJitterFraction).toBe(1.0);
    expect(defaults.caveDenTargetRadiusMinFraction).toBe(0.6);
    expect(defaults.caveDenTargetRadiusMaxFraction).toBe(0.8);
    expect(defaults.caveDenTargetMinSeparationTiles).toBe(12);
    expect(defaults.caveSpawnMinDistanceFromDenTiles).toBe(24);
    expect(defaults.caveSpawnMinDistanceFromResourceHeartTiles).toBe(24);
    expect(defaults.caveSpawnMinDistanceFromSettlementTiles).toBe(24);
    expect(defaults.caveSettlementMinDistanceFromDenTiles).toBe(20);
    expect(defaults.caveSettlementMinDistanceFromResourceHeartTiles).toBe(16);
    expect(defaults.caveRegionSeparationTiles).toBe(0);
    expect(defaults.caveMaxRetries).toBe(8);
    expect(defaults.caveCavernWidenPasses).toBe(2);
    expect(defaults.caveStraightHallwayMinRun).toBe(10);
  });

  it('uses Floor 2 runtime defaults for constrained preview controls', () => {
    const manifest = getFloorManifest('floor2')!;
    const defaults = getFloorConstraintDefaults('floor2');
    expect(defaults.biome).toBe((manifest.map.biome ?? BiomeType.CAVE_SYSTEM) as BiomeType);
    expect(defaults.widthTiles).toBe(manifest.map.widthTiles);
    expect(defaults.heightTiles).toBe(manifest.map.heightTiles);
    expect(defaults.maxRooms).toBe(manifest.map.maxRooms);
    expect(defaults.floorDensity).toBe(manifest.map.floorDensity);
    expect(defaults.roomWidthMin).toBe(manifest.map.roomWidthRange[0]);
    expect(defaults.roomWidthMax).toBe(manifest.map.roomWidthRange[1]);
    expect(defaults.roomHeightMin).toBe(manifest.map.roomHeightRange[0]);
    expect(defaults.roomHeightMax).toBe(manifest.map.roomHeightRange[1]);
    expect(defaults.cavePresentCount).toBe(manifest.floor2?.presentCount ?? 4);
    expect(defaults.caveInitialFill).toBe(FLOOR2_CAVE_SYSTEM_DEFAULTS.initialFill);
    expect(defaults.caveSmoothingPasses).toBe(FLOOR2_CAVE_SYSTEM_DEFAULTS.smoothingPasses);
    expect(defaults.caveBossDenSize).toBe(FLOOR2_CAVE_SYSTEM_DEFAULTS.bossDenSize);
    expect(defaults.caveResourceHeartDiameterTiles).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.resourceHeartDiameterTiles,
    );
    expect(defaults.caveTerritoryRadiusFraction).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.territoryRadiusFraction,
    );
    expect(defaults.caveDenStartAngleJitterFraction).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.denStartAngleJitterFraction,
    );
    expect(defaults.caveDenDistanceJitterFraction).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.denDistanceJitterFraction,
    );
    expect(defaults.caveDenTargetRadiusMinFraction).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.denTargetRadiusMinFraction,
    );
    expect(defaults.caveDenTargetRadiusMaxFraction).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.denTargetRadiusMaxFraction,
    );
    expect(defaults.caveDenTargetMinSeparationTiles).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.denTargetMinSeparationTiles,
    );
    expect(defaults.caveSpawnMinDistanceFromDenTiles).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.spawnMinDistanceFromDenTiles,
    );
    expect(defaults.caveSpawnMinDistanceFromResourceHeartTiles).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.spawnMinDistanceFromResourceHeartTiles,
    );
    expect(defaults.caveSpawnMinDistanceFromSettlementTiles).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.spawnMinDistanceFromSettlementTiles,
    );
    expect(defaults.caveSettlementMinDistanceFromDenTiles).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.settlementMinDistanceFromDenTiles,
    );
    expect(defaults.caveSettlementMinDistanceFromResourceHeartTiles).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.settlementMinDistanceFromResourceHeartTiles,
    );
    expect(defaults.caveRegionSeparationTiles).toBe(
      FLOOR2_CAVE_SYSTEM_DEFAULTS.regionSeparationTiles,
    );
    expect(defaults.caveMaxRetries).toBe(FLOOR2_CAVE_SYSTEM_DEFAULTS.maxRetries);
    expect(defaults.caveCavernWidenPasses).toBe(2);
    expect(defaults.caveStraightHallwayMinRun).toBe(10);
  });

  it('reuses the real Floor 1 scenario so spawn and NPC hubs stay separated deterministically', () => {
    const first = buildConstrainedFloorPreview('floor1', 42, testWorldFactory);
    const second = buildConstrainedFloorPreview('floor1', 42, testWorldFactory);
    const map = first.floorMap!;
    const spawnRoomId = map.roomGraph.getRoomAt(map.playerSpawn.x, map.playerSpawn.y);

    expect(map.config.biome).toBe(BiomeType.BASIC_UNDERGROUND);
    expect(map.width).toBe(floor1Config.map.widthTiles);
    expect(map.height).toBe(floor1Config.map.heightTiles);
    expect(roomIdAtNpc(first, first.floorScenario!.guideNpcEid!)).not.toBe(spawnRoomId);
    expect(roomIdAtNpc(first, first.floorScenario!.spellQuestGiverNpcEid!)).not.toBe(spawnRoomId);
    expect(roomIdAtNpc(first, first.floorScenario!.shopkeeperNpcEid!)).not.toBe(spawnRoomId);
    expect(getNpcTileSnapshot(first)).toEqual(getNpcTileSnapshot(second));
    expect(first.floorMap!.playerSpawn).toEqual(second.floorMap!.playerSpawn);
  });
});
