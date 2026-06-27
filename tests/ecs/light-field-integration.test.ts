import { addComponent, addEntity, set } from 'bitecs';
import { beforeEach, describe, expect, it } from 'vitest';
import { Player, Position } from '../../src/core/components';
import { FloorMap } from '../../src/core/map/FloorMap';
import { RoomGraph } from '../../src/core/map/RoomGraph';
import { TileMap } from '../../src/core/map/TileMap';
import { fovSystem } from '../../src/core/systems/fovSystem';
import type { GameWorld } from '../../src/core/world';
import { BiomeType, TilePresets, TerrainType, type MapConfig } from '../../src/shared/map-types';
import { ftToPx, pxToFt } from '../../src/shared/units';
import { createTestWorld } from '../helpers/world-factory';
import {
  computeLightField,
  createLightField,
  type ComputeLightFieldParams,
} from '../../src/engine/lighting/light-field';

const TILE_SIZE_FT = 4;

function createDoorMap(): FloorMap {
  const config: MapConfig = {
    widthTiles: 10,
    heightTiles: 5,
    tileSizeFt: TILE_SIZE_FT,
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

/**
 * The light field works in render pixels, but the FloorMap reasons in feet.
 * This mirrors the bridge MainGameScene installs at the feet→pixel boundary so
 * the integration test exercises the real conversion path.
 */
function pixelMapAdapter(map: FloorMap): ComputeLightFieldParams['map'] {
  return {
    pixelToTile: (px, py) => map.worldToTile(pxToFt(px), pxToFt(py)),
    isVisible: (tx, ty) => map.isVisible(tx, ty),
    hasLineOfSight: (x0, y0, x1, y1) =>
      map.hasLineOfSight(pxToFt(x0), pxToFt(y0), pxToFt(x1), pxToFt(y1)),
  };
}

/** Pixel coordinates of the centre of tile (tx, ty). */
function tileCenterPx(tx: number, ty: number): { x: number; y: number } {
  const half = TILE_SIZE_FT / 2;
  return { x: ftToPx(tx * TILE_SIZE_FT + half), y: ftToPx(ty * TILE_SIZE_FT + half) };
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
    const spawn = tileCenterPx(2, 2);
    const player = addEntity(world.ecs);
    addComponent(world.ecs, player, set(Position, { x: pxToFt(spawn.x), y: pxToFt(spawn.y) }));
    addComponent(world.ecs, player, Player);

    fovSystem(world);

    const target = tileCenterPx(6, 2);
    const source = tileCenterPx(2, 2);
    const adapter = pixelMapAdapter(map);
    const widthPx = ftToPx(map.widthFt);
    const heightPx = ftToPx(map.heightFt);
    const tilePx = ftToPx(TILE_SIZE_FT);

    const tileFieldClosed = createLightField(widthPx, heightPx, tilePx);
    const pixelFieldClosed = createLightField(widthPx, heightPx, 1);
    computeLightField({
      map: adapter,
      field: tileFieldClosed,
      source: { x: source.x, y: source.y, radiusPx: 320, intensity: 1 },
      ambient: 0,
      falloffExponent: 1.2,
    });
    computeLightField({
      map: adapter,
      field: pixelFieldClosed,
      source: { x: source.x, y: source.y, radiusPx: 320, intensity: 1 },
      ambient: 0,
      falloffExponent: 1.2,
    });
    expect(sampleCellLight(tileFieldClosed, target.x, target.y)).toBe(0);
    expect(sampleCellLight(pixelFieldClosed, target.x, target.y)).toBe(0);

    map.tileMap.openDoor(4, 2);
    fovSystem(world);

    const tileFieldOpen = createLightField(widthPx, heightPx, tilePx);
    const pixelFieldOpen = createLightField(widthPx, heightPx, 1);
    computeLightField({
      map: adapter,
      field: tileFieldOpen,
      source: { x: source.x, y: source.y, radiusPx: 320, intensity: 1 },
      ambient: 0,
      falloffExponent: 1.2,
    });
    computeLightField({
      map: adapter,
      field: pixelFieldOpen,
      source: { x: source.x, y: source.y, radiusPx: 320, intensity: 1 },
      ambient: 0,
      falloffExponent: 1.2,
    });
    expect(sampleCellLight(tileFieldOpen, target.x, target.y)).toBeGreaterThan(0.01);
    expect(sampleCellLight(pixelFieldOpen, target.x, target.y)).toBeGreaterThan(0.01);
  });
});
