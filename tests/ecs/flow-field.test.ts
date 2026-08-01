import { describe, expect, it } from 'vitest';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import {
  computeFlowField,
  flowFieldStep,
  FLOW_UNREACHABLE,
  type FlowField,
  type FlowFieldOptions,
} from '../../src/core/map/flow-field.js';
import { PATH_TRAVERSAL } from '../../src/core/map/pathfinding.js';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { makePathMap } from '../helpers/map-fixtures.js';

const WIDTH = 12;
const HEIGHT = 9;
const FLOW_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Walk the gradient from `start`, returning every tile visited up to the goal. */
function descend(
  field: ReturnType<typeof computeFlowField>,
  start: { x: number; y: number },
): { x: number; y: number }[] {
  const visited = [{ ...start }];
  let cur = { ...start };
  for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
    const step = flowFieldStep(field, cur.x, cur.y);
    if (!step) {
      break;
    }
    cur = { x: cur.x + step.x, y: cur.y + step.y };
    visited.push({ ...cur });
  }
  return visited;
}

const distanceAt = (field: ReturnType<typeof computeFlowField>, x: number, y: number): number =>
  field.distance[y * WIDTH + x]!;

function computeFlowFieldBaseline(
  floorMap: FloorMap,
  goal: { x: number; y: number },
  options: FlowFieldOptions = {},
): FlowField {
  const traversalMode = options.traversalMode ?? PATH_TRAVERSAL.GROUND;
  const isTilePassable = options.isTilePassable;
  const width = floorMap.tileMap.width;
  const height = floorMap.tileMap.height;
  const distance = new Int32Array(width * height).fill(FLOW_UNREACHABLE);
  const field: FlowField = { width, height, goalX: goal.x, goalY: goal.y, distance };

  if (
    !floorMap.tileMap.inBounds(goal.x, goal.y) ||
    (!floorMap.tileMap.isPassable(goal.x, goal.y) && traversalMode !== PATH_TRAVERSAL.FLYING)
  ) {
    return field;
  }
  if (
    traversalMode === PATH_TRAVERSAL.FLYING
      ? floorMap.hasBarrierAtTile(goal.x, goal.y)
      : !(
          (isTilePassable
            ? isTilePassable(goal.x, goal.y)
            : floorMap.tileMap.isPassable(goal.x, goal.y)) &&
          !floorMap.hasBarrierAtTile(goal.x, goal.y)
        )
  ) {
    return field;
  }

  const goalIndex = goal.y * width + goal.x;
  distance[goalIndex] = 0;
  const queue: number[] = [goalIndex];
  let head = 0;

  while (head < queue.length) {
    const idx = queue[head]!;
    head += 1;
    const cx = idx % width;
    const cy = (idx - cx) / width;
    const nextDistance = distance[idx]! + 1;

    for (const [dx, dy] of FLOW_DIRECTIONS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!floorMap.tileMap.inBounds(nx, ny)) {
        continue;
      }
      const nextIndex = ny * width + nx;
      if (distance[nextIndex] !== FLOW_UNREACHABLE) {
        continue;
      }
      const traversable =
        traversalMode === PATH_TRAVERSAL.FLYING
          ? !floorMap.hasBarrierAtTile(nx, ny)
          : (isTilePassable ? isTilePassable(nx, ny) : floorMap.tileMap.isPassable(nx, ny)) &&
            !floorMap.hasBarrierAtTile(nx, ny);
      if (!traversable) {
        continue;
      }
      distance[nextIndex] = nextDistance;
      queue.push(nextIndex);
    }
  }

  return field;
}

function traceFor(
  run: (floorMap: FloorMap, goal: { x: number; y: number }, options: FlowFieldOptions) => FlowField,
  floorMap: FloorMap,
  goal: { x: number; y: number },
  basePassable: (x: number, y: number) => boolean,
): { field: FlowField; trace: string[] } {
  const trace: string[] = [];
  const field = run(floorMap, goal, {
    isTilePassable: (x, y) => {
      trace.push(`${x},${y}`);
      return basePassable(x, y);
    },
  });
  return { field, trace };
}

/** Open arena (only the border is wall), with optional extra wall tiles. */
function makeOpenMap(extraWalls: ReadonlyArray<readonly [number, number]> = []): FloorMap {
  const tileMap = new TileMap(WIDTH, HEIGHT);
  const terrain = new Uint8Array(WIDTH * HEIGHT);
  const config: MapConfig = {
    widthTiles: WIDTH,
    heightTiles: HEIGHT,
    tileSizeFt: 4,
    biome: BiomeType.ARENA,
    seed: 7,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const isBorder = x === 0 || y === 0 || x === WIDTH - 1 || y === HEIGHT - 1;
      tileMap.flags[y * WIDTH + x] = isBorder ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }
  for (const [wx, wy] of extraWalls) {
    tileMap.flags[wy * WIDTH + wx] = TilePresets.WALL;
  }
  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 2, y: 2 });
}

function makeAllFloorMap(width: number, height: number): FloorMap {
  const tileMap = new TileMap(width, height);
  tileMap.fill(TilePresets.FLOOR);
  const config: MapConfig = {
    widthTiles: width,
    heightTiles: height,
    tileSizeFt: 4,
    biome: BiomeType.ARENA,
    seed: 11,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 1,
  };
  return new FloorMap(config, tileMap, new RoomGraph(), new Uint8Array(width * height), {
    x: 0,
    y: 0,
  });
}

describe('computeFlowField', () => {
  it('marks the goal tile distance 0 and walls as unreachable', () => {
    const floorMap = makePathMap(true, { tileSizeFt: 4 });
    const field = computeFlowField(floorMap, { x: 9, y: 4 });

    expect(field.goalX).toBe(9);
    expect(field.goalY).toBe(4);
    expect(distanceAt(field, 9, 4)).toBe(0);
    // Border wall never gets visited.
    expect(distanceAt(field, 0, 0)).toBe(FLOW_UNREACHABLE);
  });

  it('expands a BFS wavefront where each passable neighbour is one step further', () => {
    const floorMap = makePathMap(true, { tileSizeFt: 4 });
    const field = computeFlowField(floorMap, { x: 9, y: 4 });

    expect(distanceAt(field, 8, 4)).toBe(1);
    expect(distanceAt(field, 9, 3)).toBe(1);
    expect(distanceAt(field, 9, 5)).toBe(1);
    expect(distanceAt(field, 7, 4)).toBe(2);
  });

  it('produces a gradient that descends through an open door to the goal', () => {
    const floorMap = makePathMap(true, { tileSizeFt: 4 });
    const field = computeFlowField(floorMap, { x: 9, y: 4 });

    const path = descend(field, { x: 2, y: 4 });

    expect(path[path.length - 1]).toEqual({ x: 9, y: 4 });
    expect(path.some((p) => p.x === 6 && p.y === 4)).toBe(true);
  });

  it('leaves the far side unreachable when the only door is closed', () => {
    const floorMap = makePathMap(false, { tileSizeFt: 4 });
    const field = computeFlowField(floorMap, { x: 9, y: 4 });

    expect(distanceAt(field, 2, 4)).toBe(FLOW_UNREACHABLE);
    expect(flowFieldStep(field, 2, 4)).toBeNull();
  });

  it('floods across closed structures under flying traversal', () => {
    const floorMap = makePathMap(false, { tileSizeFt: 4 });
    const field = computeFlowField(
      floorMap,
      { x: 9, y: 4 },
      {
        traversalMode: PATH_TRAVERSAL.FLYING,
      },
    );

    // Flying treats every in-bounds tile as traversable, so the left side and
    // even pillar walls are reachable.
    expect(distanceAt(field, 2, 4)).toBeGreaterThanOrEqual(0);
    expect(distanceAt(field, 6, 1)).toBeGreaterThanOrEqual(0);
  });

  it('honours an isTilePassable override the way A* does', () => {
    const floorMap = makePathMap(true, { tileSizeFt: 4 });
    // Open door in the map, but the override seals (6,4) — the field must route
    // identically to the pathfinder and abandon the left half.
    const field = computeFlowField(
      floorMap,
      { x: 9, y: 4 },
      {
        isTilePassable: (x, y) => floorMap.tileMap.isPassable(x, y) && !(x === 6 && y === 4),
      },
    );

    expect(distanceAt(field, 2, 4)).toBe(FLOW_UNREACHABLE);
  });

  it('matches the pre-optimization baseline for flying traversal', () => {
    const floorMap = makePathMap(false, { tileSizeFt: 4 });
    const goal = { x: 9, y: 4 };

    const current = computeFlowField(floorMap, goal, {
      traversalMode: PATH_TRAVERSAL.FLYING,
    });
    const baseline = computeFlowFieldBaseline(floorMap, goal, {
      traversalMode: PATH_TRAVERSAL.FLYING,
    });

    expect(Array.from(current.distance)).toEqual(Array.from(baseline.distance));
  });

  it('matches the pre-optimization callback probe trace', () => {
    const floorMap = makePathMap(true, { tileSizeFt: 4 });
    const goal = { x: 9, y: 4 };
    const basePassable = (x: number, y: number): boolean =>
      floorMap.tileMap.isPassable(x, y) && !(x === 6 && y === 4);

    const current = traceFor(computeFlowField, floorMap, goal, basePassable);
    const baseline = traceFor(computeFlowFieldBaseline, floorMap, goal, basePassable);

    expect(current.trace).toEqual(baseline.trace);
    expect(Array.from(current.field.distance)).toEqual(Array.from(baseline.field.distance));
  });

  it('matches the pre-optimization baseline for boundary goals', () => {
    const floorMap = makeAllFloorMap(4, 4);
    const goals = [
      { x: 3, y: 2 },
      { x: 0, y: 1 },
      { x: 2, y: 3 },
      { x: 1, y: 0 },
    ];

    for (const goal of goals) {
      const current = computeFlowField(floorMap, goal);
      const baseline = computeFlowFieldBaseline(floorMap, goal);
      expect(Array.from(current.distance)).toEqual(Array.from(baseline.distance));
    }
  });

  it('returns an all-unreachable field when the goal itself is blocked', () => {
    const floorMap = makePathMap(true, { tileSizeFt: 4 });
    const field = computeFlowField(floorMap, { x: 0, y: 0 });

    expect(distanceAt(field, 0, 0)).toBe(FLOW_UNREACHABLE);
    expect(field.distance.every((d) => d === FLOW_UNREACHABLE)).toBe(true);
  });

  it('is deterministic across rebuilds', () => {
    const floorMap = makePathMap(true, { tileSizeFt: 4 });
    const a = computeFlowField(floorMap, { x: 9, y: 4 });
    const b = computeFlowField(floorMap, { x: 9, y: 4 });

    expect(Array.from(a.distance)).toEqual(Array.from(b.distance));
  });
});

describe('flowFieldStep', () => {
  it('returns null on the goal tile', () => {
    const floorMap = makePathMap(true, { tileSizeFt: 4 });
    const field = computeFlowField(floorMap, { x: 9, y: 4 });

    expect(flowFieldStep(field, 9, 4)).toBeNull();
  });

  it('returns null for out-of-bounds and unreachable tiles', () => {
    const floorMap = makePathMap(true, { tileSizeFt: 4 });
    const field = computeFlowField(floorMap, { x: 9, y: 4 });

    expect(flowFieldStep(field, -1, 4)).toBeNull();
    expect(flowFieldStep(field, WIDTH, 4)).toBeNull();
    expect(flowFieldStep(field, 0, 0)).toBeNull();
  });

  it('always steps strictly downhill toward the goal', () => {
    const floorMap = makePathMap(true, { tileSizeFt: 4 });
    const field = computeFlowField(floorMap, { x: 9, y: 4 });

    const here = distanceAt(field, 2, 4);
    const step = flowFieldStep(field, 2, 4);

    expect(step).not.toBeNull();
    const next = distanceAt(field, 2 + step!.x, 4 + step!.y);
    expect(next).toBe(here - 1);
  });

  it('descends diagonally toward an off-axis goal in open space', () => {
    const floorMap = makeOpenMap();
    const field = computeFlowField(floorMap, { x: 9, y: 7 });

    // From (2,2) the player sits down-and-right, so the most downhill neighbour
    // is the diagonal — the chaser should cut the corner, not stair-step.
    expect(flowFieldStep(field, 2, 2)).toEqual({ x: 1, y: 1 });
  });

  it('walks a straight diagonal line down the gradient', () => {
    const floorMap = makeOpenMap();
    const field = computeFlowField(floorMap, { x: 7, y: 7 });

    const steps: { x: number; y: number }[] = [];
    let cur = { x: 2, y: 2 };
    for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
      const step = flowFieldStep(field, cur.x, cur.y);
      if (!step) {
        break;
      }
      steps.push(step);
      cur = { x: cur.x + step.x, y: cur.y + step.y };
    }

    expect(cur).toEqual({ x: 7, y: 7 });
    // (2,2) → (7,7) is a perfect 45° line, so every step is the same diagonal.
    expect(steps.every((s) => s.x === 1 && s.y === 1)).toBe(true);
  });

  it('refuses a diagonal that would clip a wall corner', () => {
    // Wall at (4,3) sits orthogonally beside the diagonal target (4,4).
    const floorMap = makeOpenMap([[4, 3]]);
    const field = computeFlowField(floorMap, { x: 9, y: 7 });

    const step = flowFieldStep(field, 3, 3);

    // The diagonal (1,1) would graze the (4,3) corner, so it must fall back to a
    // cardinal step that still descends toward the goal.
    expect(step).not.toEqual({ x: 1, y: 1 });
    expect(step).not.toBeNull();
    const next = distanceAt(field, 3 + step!.x, 3 + step!.y);
    expect(next).toBeLessThan(distanceAt(field, 3, 3));
    expect(step!.x === 0 || step!.y === 0).toBe(true);
  });
});
