import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import {
  computeFlowField,
  flowFieldStep,
  FLOW_UNREACHABLE,
} from '../../src/core/map/flow-field.js';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { SeededRandom } from '../../src/shared/random.js';

/**
 * Property-based invariants for the shared flow-field pathfinder. Maps are
 * generated deterministically from a SeededRandom-driven wall layout (border
 * walls + random interior walls) so unreachable regions are exercised, never
 * Math.random.
 */

interface Tile {
  x: number;
  y: number;
}

interface GeneratedMap {
  floorMap: FloorMap;
  width: number;
  height: number;
  floorTiles: Tile[];
}

const CARDINALS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Build a FloorMap: solid border, interior tiles wall at ~`wallChance`. */
function makeRandomMap(
  seed: number,
  width: number,
  height: number,
  wallChance: number,
): GeneratedMap {
  const rng = new SeededRandom(seed);
  const tileMap = new TileMap(width, height);
  const terrain = new Uint8Array(width * height);
  const config: MapConfig = {
    widthTiles: width,
    heightTiles: height,
    tileSizeFt: 4,
    biome: BiomeType.ARENA,
    seed,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };

  const floorTiles: Tile[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const isBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      const isWall = isBorder || rng.next() < wallChance;
      tileMap.flags[y * width + x] = isWall ? TilePresets.WALL : TilePresets.FLOOR;
      if (!isWall) floorTiles.push({ x, y });
    }
  }

  const spawn = floorTiles[0] ?? { x: 1, y: 1 };
  const floorMap = new FloorMap(config, tileMap, new RoomGraph(), terrain, spawn);
  return { floorMap, width, height, floorTiles };
}

const mapArb = () =>
  fc.record({
    seed: fc.integer(),
    width: fc.integer({ min: 6, max: 12 }),
    height: fc.integer({ min: 6, max: 12 }),
    wallChance: fc.double({ min: 0, max: 0.35, noNaN: true }),
    goalPick: fc.double({ min: 0, max: 0.999_999, noNaN: true }),
  });

describe('computeFlowField invariants (property-based)', () => {
  it('every distance is FLOW_UNREACHABLE or a non-negative integer, and the goal is 0', () => {
    fc.assert(
      fc.property(mapArb(), ({ seed, width, height, wallChance, goalPick }) => {
        const { floorMap, floorTiles } = makeRandomMap(seed, width, height, wallChance);
        fc.pre(floorTiles.length > 0);
        const goal = floorTiles[Math.floor(goalPick * floorTiles.length)]!;

        const field = computeFlowField(floorMap, goal);

        for (const d of field.distance) {
          expect(d === FLOW_UNREACHABLE || (Number.isInteger(d) && d >= 0)).toBe(true);
        }
        expect(field.distance[goal.y * width + goal.x]).toBe(0);
      }),
      { numRuns: 80 },
    );
  });

  it('cardinally adjacent reachable tiles differ in distance by at most 1', () => {
    fc.assert(
      fc.property(mapArb(), ({ seed, width, height, wallChance, goalPick }) => {
        const { floorMap, floorTiles } = makeRandomMap(seed, width, height, wallChance);
        fc.pre(floorTiles.length > 0);
        const goal = floorTiles[Math.floor(goalPick * floorTiles.length)]!;
        const field = computeFlowField(floorMap, goal);

        const at = (x: number, y: number) => field.distance[y * width + x]!;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const here = at(x, y);
            if (here === FLOW_UNREACHABLE) continue;
            for (const [dx, dy] of CARDINALS) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
              const neighbor = at(nx, ny);
              if (neighbor === FLOW_UNREACHABLE) continue;
              expect(Math.abs(here - neighbor)).toBeLessThanOrEqual(1);
            }
          }
        }
      }),
      { numRuns: 80 },
    );
  });

  it('is deterministic across rebuilds', () => {
    fc.assert(
      fc.property(mapArb(), ({ seed, width, height, wallChance, goalPick }) => {
        const { floorMap, floorTiles } = makeRandomMap(seed, width, height, wallChance);
        fc.pre(floorTiles.length > 0);
        const goal = floorTiles[Math.floor(goalPick * floorTiles.length)]!;

        const a = computeFlowField(floorMap, goal);
        const b = computeFlowField(floorMap, goal);
        expect(Array.from(a.distance)).toEqual(Array.from(b.distance));
      }),
      { numRuns: 60 },
    );
  });
});

describe('flowFieldStep invariants (property-based)', () => {
  it('every reachable non-goal tile has a strictly-downhill step; unreachable tiles step to null', () => {
    fc.assert(
      fc.property(mapArb(), ({ seed, width, height, wallChance, goalPick }) => {
        const { floorMap, floorTiles } = makeRandomMap(seed, width, height, wallChance);
        fc.pre(floorTiles.length > 0);
        const goal = floorTiles[Math.floor(goalPick * floorTiles.length)]!;
        const field = computeFlowField(floorMap, goal);
        const at = (x: number, y: number) => field.distance[y * width + x]!;

        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const here = at(x, y);
            if (here === FLOW_UNREACHABLE) {
              expect(flowFieldStep(field, x, y)).toBeNull();
              continue;
            }
            if (here === 0) {
              expect(flowFieldStep(field, x, y)).toBeNull();
              continue;
            }
            const step = flowFieldStep(field, x, y);
            expect(step).not.toBeNull();
            const neighbor = at(x + step!.x, y + step!.y);
            expect(neighbor).toBeGreaterThanOrEqual(0);
            expect(neighbor).toBeLessThan(here);
          }
        }
      }),
      { numRuns: 80 },
    );
  });

  it('descending the gradient from any reachable tile terminates exactly at the goal', () => {
    fc.assert(
      fc.property(mapArb(), ({ seed, width, height, wallChance, goalPick }) => {
        const { floorMap, floorTiles } = makeRandomMap(seed, width, height, wallChance);
        fc.pre(floorTiles.length > 0);
        const goal = floorTiles[Math.floor(goalPick * floorTiles.length)]!;
        const field = computeFlowField(floorMap, goal);
        const at = (x: number, y: number) => field.distance[y * width + x]!;

        for (const start of floorTiles) {
          if (at(start.x, start.y) === FLOW_UNREACHABLE) continue;
          let cur = { ...start };
          let prev = at(cur.x, cur.y);
          for (let i = 0; i < width * height; i += 1) {
            const step = flowFieldStep(field, cur.x, cur.y);
            if (!step) break;
            cur = { x: cur.x + step.x, y: cur.y + step.y };
            const d = at(cur.x, cur.y);
            expect(d).toBeLessThan(prev); // strictly monotone descent
            prev = d;
          }
          expect(cur).toEqual({ x: goal.x, y: goal.y });
        }
      }),
      { numRuns: 60 },
    );
  });
});
