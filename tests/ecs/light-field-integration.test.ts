import { addComponent, addEntity, set } from 'bitecs';
import { beforeEach, describe, expect, it } from 'vitest';
import { Player, Position } from '../../src/core/components';
import { FloorMap } from '../../src/core/map/FloorMap';
import { RoomGraph } from '../../src/core/map/RoomGraph';
import { TileMap } from '../../src/core/map/TileMap';
import { fovSystem } from '../../src/core/systems/fovSystem';
import type { GameWorld } from '../../src/core/world';
import { BiomeType, TilePresets, TerrainType, type MapConfig } from '../../src/shared/map-types';
import { createTestWorld } from '../helpers/world-factory';
import { computeLightField, createLightField } from '../../src/engine/lighting/light-field';

function createDoorMap(): FloorMap {
  const config: MapConfig = {
    widthTiles: 10,
    heightTiles: 5,
    tileSizePx: 32,
    biome: BiomeType.ARENA,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.4,
  };
  const tileMap = new TileMap(config.widthTiles, config.heightTiles);
  tileMap.fill(TilePresets.WALL);
  tileMap.fillRect(1, 1, 8, 3, TilePresets.FLOOR);
  tileMap.setFlags(4, 1, TilePresets.WALL);
  tileMap.setFlags(4, 2, TilePresets.DOOR_CLOSED);
  tileMap.setFlags(4, 3, TilePresets.WALL);
  const terrain = new Uint8Array(config.widthTiles * config.heightTiles);
  terrain.fill(TerrainType.STONE_FLOOR);
  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 2, y: 2 });
}

function sampleCellLight(
  field: ReturnType<typeof createLightField>,
  px: number,
  py: number,
): number {
  const cx = Math.floor(px / field.stepPx);
  const cy = Math.floor(py / field.stepPx);
  return field.values[cy * field.widthCells + cx] ?? 0;
}

describe('lighting field integration', () => {
  let world: GameWorld;

  beforeEach(() => {
    world = createTestWorld({ seed: 42 });
  });

  it('reacts to door open and stays consistent at tile and pixel granularity', () => {
    const map = createDoorMap();
    world.floorMap = map;
    const player = addEntity(world.ecs);
    addComponent(world.ecs, player, set(Position, { x: 2 * 32 + 16, y: 2 * 32 + 16 }));
    addComponent(world.ecs, player, Player);

    fovSystem(world);

    const targetPx = { x: 6 * 32 + 16, y: 2 * 32 + 16 };
    const sourcePx = { x: 2 * 32 + 16, y: 2 * 32 + 16 };
    const tileFieldClosed = createLightField(map.widthPx, map.heightPx, 32);
    const pixelFieldClosed = createLightField(map.widthPx, map.heightPx, 1);
    computeLightField({
      map,
      field: tileFieldClosed,
      source: { x: sourcePx.x, y: sourcePx.y, radiusPx: 320, intensity: 1 },
      ambient: 0,
      falloffExponent: 1.2,
    });
    computeLightField({
      map,
      field: pixelFieldClosed,
      source: { x: sourcePx.x, y: sourcePx.y, radiusPx: 320, intensity: 1 },
      ambient: 0,
      falloffExponent: 1.2,
    });
    expect(sampleCellLight(tileFieldClosed, targetPx.x, targetPx.y)).toBe(0);
    expect(sampleCellLight(pixelFieldClosed, targetPx.x, targetPx.y)).toBe(0);

    map.tileMap.openDoor(4, 2);
    fovSystem(world);

    const tileFieldOpen = createLightField(map.widthPx, map.heightPx, 32);
    const pixelFieldOpen = createLightField(map.widthPx, map.heightPx, 1);
    computeLightField({
      map,
      field: tileFieldOpen,
      source: { x: sourcePx.x, y: sourcePx.y, radiusPx: 320, intensity: 1 },
      ambient: 0,
      falloffExponent: 1.2,
    });
    computeLightField({
      map,
      field: pixelFieldOpen,
      source: { x: sourcePx.x, y: sourcePx.y, radiusPx: 320, intensity: 1 },
      ambient: 0,
      falloffExponent: 1.2,
    });
    expect(sampleCellLight(tileFieldOpen, targetPx.x, targetPx.y)).toBeGreaterThan(0.01);
    expect(sampleCellLight(pixelFieldOpen, targetPx.x, targetPx.y)).toBeGreaterThan(0.01);
  });
});
