import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/spawners/combatants.js';
import type { GameWorld } from '../../src/core/world.js';
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
    expect(defaults.caveRegionSeparationTiles).toBe(0);
    expect(defaults.caveMaxRetries).toBe(8);
    expect(defaults.caveCavernWidenPasses).toBe(2);
    expect(defaults.caveStraightHallwayMinRun).toBe(10);
  });

  it('mirrors Floor 2 manifest defaults for constrained preview controls', () => {
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
    expect(defaults.caveInitialFill).toBe(0.5);
    expect(defaults.caveSmoothingPasses).toBe(4);
    expect(defaults.caveBossDenSize).toBe(5);
    expect(defaults.caveRegionSeparationTiles).toBe(0);
    expect(defaults.caveMaxRetries).toBe(8);
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
