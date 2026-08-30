import { describe, expect, it } from 'vitest';
import {
  SiegeCastleGenerator,
  computeSiegeCastleLayout,
} from '../../src/core/map/generators/SiegeCastleGenerator.js';
import { getGenerator } from '../../src/core/map/generators/registry.js';
import type { FloorMap } from '../../src/core/map/FloorMap.js';
import { BiomeType, type MapConfig, type RoomBounds } from '../../src/shared/map-types.js';
import { SeededRandom } from '../../src/shared/random.js';
import { floor5Manifest } from '../../src/shared/floor-manifest.js';
import { getFloorManifest, getImplementedFloorIds } from '../../src/shared/floor-registry.js';
import { getScenarioDefinition } from '../../src/game/scenarioDefinitions.js';

function floor5Config(overrides: Partial<MapConfig> = {}): MapConfig {
  const geometry = floor5Manifest.floor5;
  return {
    widthTiles: floor5Manifest.map.widthTiles,
    heightTiles: floor5Manifest.map.heightTiles,
    tileSizeFt: floor5Manifest.map.tileSizeFt,
    biome: floor5Manifest.map.biome ?? BiomeType.SIEGE_CASTLE,
    seed: floor5Manifest.map.seed,
    roomWidthRange: floor5Manifest.map.roomWidthRange,
    roomHeightRange: floor5Manifest.map.roomHeightRange,
    maxRooms: floor5Manifest.map.maxRooms,
    floorDensity: floor5Manifest.map.floorDensity,
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
    ...overrides,
  };
}

function generate(config: MapConfig = floor5Config(), seed = 5): FloorMap {
  return new SiegeCastleGenerator().generate(config, new SeededRandom(seed));
}

function countingRng(seed: number): { rng: SeededRandom; draws: () => number } {
  const inner = new SeededRandom(seed);
  let calls = 0;
  const rng = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          calls += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  }) as SeededRandom;
  return { rng, draws: () => calls };
}

function contains(rect: RoomBounds, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function canReach(map: FloorMap, target: { readonly x: number; readonly y: number }): boolean {
  const width = map.config.widthTiles;
  const seen = new Set<number>();
  const queue = [map.playerSpawn];
  seen.add(map.playerSpawn.y * width + map.playerSpawn.x);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.x === target.x && cur.y === target.y) return true;
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const key = ny * width + nx;
      if (seen.has(key) || !map.tileMap.isPassable(nx, ny)) continue;
      seen.add(key);
      queue.push({ x: nx, y: ny });
    }
  }
  return false;
}

describe('computeSiegeCastleLayout', () => {
  it('publishes the required Command Post-to-throne set pieces', () => {
    const layout = computeSiegeCastleLayout();
    expect(layout.setPieces.map((piece) => piece.id)).toEqual([
      'command-post',
      'siege-yard',
      'component-pocket',
      'checkpoint-pocket',
      'primary-lane',
      'outer-wall',
      'breach-site',
      'courtyard',
      'throne-room',
      'winners-balcony',
    ]);
  });

  it('spawns the player inside the Command Post, which is not a safe room', () => {
    const layout = computeSiegeCastleLayout();
    expect(contains(layout.commandPost, layout.playerSpawn.x, layout.playerSpawn.y)).toBe(true);
  });

  it('throws rather than clamping when a breach cannot fit in the outer wall', () => {
    expect(() => computeSiegeCastleLayout({ breachWidthTiles: 0 })).toThrow(/positive integer/);
    expect(() => computeSiegeCastleLayout({ laneWidthTiles: 3, breachWidthTiles: 6 })).toThrow(
      /breach width/,
    );
  });
});

describe('SiegeCastleGenerator', () => {
  it('is registered for the siege_castle biome', () => {
    expect(getGenerator(BiomeType.SIEGE_CASTLE).name).toBe('SiegeCastleGenerator');
  });

  it('consumes zero RNG draws', () => {
    const { rng, draws } = countingRng(12345);
    new SiegeCastleGenerator().generate(floor5Config(), rng);
    expect(draws()).toBe(0);
  });

  it('produces byte-identical geometry for different seeds', () => {
    const a = generate(floor5Config({ seed: 1 }), 1);
    const b = generate(floor5Config({ seed: 999_999 }), 999_999);
    expect(Array.from(b.flags)).toEqual(Array.from(a.flags));
    expect(b.playerSpawn).toEqual(a.playerSpawn);
  });

  it('keeps the Command Post-to-throne route reachable through the authored breach', () => {
    const map = generate();
    const layout = computeSiegeCastleLayout(floor5Config().siegeCastle);
    const throneCenter = {
      x: layout.throneRoom.x + Math.floor(layout.throneRoom.width / 2),
      y: layout.throneRoom.y + Math.floor(layout.throneRoom.height / 2),
    };
    expect(canReach(map, throneCenter)).toBe(true);
    expect(map.rooms.find((room) => room.label === 'command-post')?.role).toBe('spawn');
    expect(map.rooms.find((room) => room.label === 'throne-room')?.role).toBe('boss_stair');
    expect(map.rooms.some((room) => room.role === 'safe')).toBe(false);
  });

  it('refuses a map smaller than the authored battlefield', () => {
    expect(() => generate(floor5Config({ widthTiles: 40, heightTiles: 20 }))).toThrow(
      /authored battlefield needs at least/,
    );
  });
});

describe('floor5 plumbing', () => {
  const manifest = getFloorManifest('floor5');

  it('is registered but not implemented as a winnable floor yet', () => {
    expect(manifest?.map.biome).toBe(BiomeType.SIEGE_CASTLE);
    expect(manifest?.implemented.mvp).toBe(false);
    expect(getImplementedFloorIds()).not.toContain('floor5');
  });

  it('has a registered scenario with barred stairs and a minimal AI route', () => {
    const scenario = getScenarioDefinition('floor5');
    expect(scenario.floorId).toBe('floor5');
    expect(scenario.onStairDescend?.({} as never, 0)).toBe(false);
    expect(scenario.aiTaskConfig?.scenarioId).toBe('floor5');
    expect(scenario.nextFloorId).toBeUndefined();
  });
});
