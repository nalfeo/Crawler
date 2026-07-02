import { describe, expect, it } from 'vitest';
import { addComponent, addEntity, set } from 'bitecs';
import { createTestWorld } from '../helpers/world-factory';
import { fovSystem } from '../../src/core/systems/fovSystem';
import { Player, Position } from '../../src/core/components';
import { FloorMap } from '../../src/core/map/FloorMap';
import { TileMap } from '../../src/core/map/TileMap';
import { RoomGraph } from '../../src/core/map/RoomGraph';
import {
  computeLightField,
  createLightField,
  type ComputeLightFieldParams,
} from '../../src/engine/lighting/light-field';
import { BiomeType, TilePresets } from '../../src/shared/map-types';
import type { MapConfig } from '../../src/shared/map-types';
import type { GameWorld } from '../../src/core/world';

/**
 * Deterministic end-to-end proof of the discovered-darkening feature — the
 * "observe-before-done" artifact for the fog-of-war memory change (project rule
 * #10). It drives the REAL `fovSystem` to build discovered memory, then runs the
 * REAL `computeLightField` (as the scene does) over that map and asserts the
 * rendered light of three archetypal cells:
 *
 *   - currently visible          → at least `ambient`
 *   - discovered-but-not-visible → the dim `discoveredLight` memory (< ambient)
 *   - never seen                 → full black (0)
 *
 * It also reproduces the OLD behavior (black out-of-FOV) by setting
 * `discoveredLight = 0`, so the before/after is provable in one deterministic
 * pass with no Phaser, DOM, or LLM judgement.
 */

const TILE_PX = 32;
const MAP_TILES = 64;

function makeOpenMap(): FloorMap {
  const config: MapConfig = {
    widthTiles: MAP_TILES,
    heightTiles: MAP_TILES,
    tileSizeFt: TILE_PX,
    biome: BiomeType.ARENA,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(MAP_TILES, MAP_TILES);
  const terrain = new Uint8Array(MAP_TILES * MAP_TILES);
  const roomGraph = new RoomGraph();
  for (let y = 0; y < MAP_TILES; y++) {
    for (let x = 0; x < MAP_TILES; x++) {
      const idx = y * MAP_TILES + x;
      const border = x === 0 || x === MAP_TILES - 1 || y === 0 || y === MAP_TILES - 1;
      tileMap.flags[idx] = border ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }
  // Fully enclose the "never seen" tile (30,30) in a wall pocket so it is
  // unreachable by line-of-sight from any vantage — guaranteeing it stays
  // undiscovered regardless of rot-js's radius metric (Euclidean vs Chebyshev).
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      tileMap.flags[(30 + dy) * MAP_TILES + (30 + dx)] = TilePresets.WALL;
    }
  }
  return new FloorMap(config, tileMap, roomGraph, terrain, { x: 10, y: 10 });
}

/** Move the player to the centre of `(tx, ty)` and recompute FOV. */
function lookFrom(world: GameWorld, eid: number, tx: number, ty: number): void {
  world.stores.position.x[eid] = tx * TILE_PX + TILE_PX / 2;
  world.stores.position.y[eid] = ty * TILE_PX + TILE_PX / 2;
  fovSystem(world);
}

/** Light-field adapter over the FloorMap, one field cell per tile (stepPx=TILE_PX). */
function makeMapAdapter(floorMap: FloorMap): ComputeLightFieldParams['map'] {
  return {
    pixelToTile: (px, py) => ({ x: Math.floor(px / TILE_PX), y: Math.floor(py / TILE_PX) }),
    isVisible: (tx, ty) => floorMap.isVisible(tx, ty),
    isDiscovered: (tx, ty) => floorMap.isDiscovered(tx, ty),
    hasLineOfSight: () => true,
  };
}

function tileLight(
  floorMap: FloorMap,
  ambient: number,
  discoveredLight: number,
): (tx: number, ty: number) => number {
  const field = createLightField(MAP_TILES * TILE_PX, MAP_TILES * TILE_PX, TILE_PX);
  computeLightField({
    map: makeMapAdapter(floorMap),
    field,
    sources: [], // no torch → a visible cell resolves to exactly `ambient`
    ambient,
    discoveredLight,
    falloffExponent: 1.6,
  });
  return (tx, ty) => field.values[ty * field.widthCells + tx] ?? -1;
}

describe('discovered-darkening (headless end-to-end)', () => {
  const AMBIENT = 0.08;
  const DISCOVERED = 0.05;
  // Three archetypal tiles chosen so vision radius (25 tiles) cleanly separates them.
  const VISIBLE_TILE = { x: 50, y: 50 }; // player's current vantage
  const DISCOVERED_TILE = { x: 10, y: 10 }; // seen first, then left behind
  const NEVER_SEEN_TILE = { x: 30, y: 30 }; // > 25 tiles from BOTH vantages

  function setupDiscoveredWorld(): FloorMap {
    const world = createTestWorld({ seed: 42 });
    const floorMap = makeOpenMap();
    world.floorMap = floorMap;
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, eid, Player);

    // Vantage 1: discover the region around (10,10).
    lookFrom(world, eid, DISCOVERED_TILE.x, DISCOVERED_TILE.y);
    expect(floorMap.isVisible(DISCOVERED_TILE.x, DISCOVERED_TILE.y)).toBe(true);

    // Vantage 2: (50,50) is > 25 tiles away, so (10,10) drops out of FOV.
    lookFrom(world, eid, VISIBLE_TILE.x, VISIBLE_TILE.y);
    return floorMap;
  }

  it('renders visible/discovered/never-seen tiles at distinct light levels', () => {
    const floorMap = setupDiscoveredWorld();

    // Sanity on the FOV state the lighting reads from.
    expect(floorMap.isVisible(VISIBLE_TILE.x, VISIBLE_TILE.y)).toBe(true);
    expect(floorMap.isVisible(DISCOVERED_TILE.x, DISCOVERED_TILE.y)).toBe(false);
    expect(floorMap.isDiscovered(DISCOVERED_TILE.x, DISCOVERED_TILE.y)).toBe(true);
    expect(floorMap.isDiscovered(NEVER_SEEN_TILE.x, NEVER_SEEN_TILE.y)).toBe(false);

    const light = tileLight(floorMap, AMBIENT, DISCOVERED);
    const visible = light(VISIBLE_TILE.x, VISIBLE_TILE.y);
    const discovered = light(DISCOVERED_TILE.x, DISCOVERED_TILE.y);
    const neverSeen = light(NEVER_SEEN_TILE.x, NEVER_SEEN_TILE.y);

    expect(visible).toBeCloseTo(AMBIENT, 6); // no torch ⇒ visible resolves to ambient
    expect(discovered).toBeCloseTo(DISCOVERED, 6);
    expect(neverSeen).toBe(0);

    // The whole point: memory is dim, not black, and never brighter than visible.
    expect(discovered).toBeGreaterThan(neverSeen);
    expect(discovered).toBeLessThan(visible);
  });

  it('reproduces the legacy full-black behavior when discoveredLight is 0', () => {
    const floorMap = setupDiscoveredWorld();
    const light = tileLight(floorMap, AMBIENT, 0);
    // Same discovered tile that dims to 0.05 above renders fully black at 0.
    expect(light(DISCOVERED_TILE.x, DISCOVERED_TILE.y)).toBe(0);
  });
});
