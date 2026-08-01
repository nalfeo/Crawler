/**
 * Interleaved A/B microbench + differential oracle for `computeFlowField`.
 *
 * Why this exists: `computeFlowField` is currently the top self-time game-code
 * frame in the headless perf profile (~5.7-5.9% self on 2026-07-31). The most
 * plausible low-risk win is removing avoidable hot-loop overhead without
 * changing the exact distance field it produces.
 *
 * Design:
 *   - BASELINE — verbatim copy of the pre-optimization implementation so the
 *                comparison remains reproducible after the source changes.
 *   - CURRENT  — the live `computeFlowField`.
 *   - Correctness: time first, then run the differential oracle so the untimed
 *                  checks cannot perturb V8 tiering. Compare width/height/goal
 *                  metadata and every `distance` entry, never a hash.
 *   - Option-bearing oracle cases: cover FLYING traversal and the
 *                  caller-supplied `isTilePassable` path, including the ordered
 *                  callback probe trace.
 *   - Timing: same-process, interleaved, rotating lead, with several rotated
 *             warmup sweeps before timing starts.
 *
 * Usage:
 *   npx tsx scripts/agent/perf/bench-flow-field.ts [rounds]
 */

import { query } from 'bitecs';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import { Player, Position } from '../../../src/core/components.js';
import {
  computeFlowField,
  FLOW_UNREACHABLE,
  type FlowField,
  type FlowFieldOptions,
} from '../../../src/core/map/flow-field.js';
import { FloorMap } from '../../../src/core/map/FloorMap.js';
import type { TilePoint } from '../../../src/core/map/pathfinding.js';
import { isTileTraversable, PATH_TRAVERSAL } from '../../../src/core/map/pathfinding.js';
import type { GameWorld } from '../../../src/core/world.js';
import { SeededRandom } from '../../../src/shared/random.js';

const DEFAULT_ROUNDS = 15;
const WARMUP_SWEEPS = 4;
const WARMUP_RUN_FRAMES = 1200;

const FLOW_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function computeFlowFieldBaseline(
  floorMap: FloorMap,
  goal: TilePoint,
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
    !isTileTraversable(floorMap, goal.x, goal.y, traversalMode, isTilePassable)
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
      const nIdx = ny * width + nx;
      if (distance[nIdx] !== FLOW_UNREACHABLE) {
        continue;
      }
      if (!isTileTraversable(floorMap, nx, ny, traversalMode, isTilePassable)) {
        continue;
      }
      distance[nIdx] = nextDistance;
      queue.push(nIdx);
    }
  }

  return field;
}

interface FlowCase {
  readonly floorMap: FloorMap;
  readonly goal: TilePoint;
  readonly probeIndex: number;
  readonly label: string;
  readonly options?: FlowFieldOptions;
}

type Variant = (floorMap: FloorMap, goal: TilePoint, options?: FlowFieldOptions) => FlowField;

interface NamedVariant {
  readonly name: string;
  readonly run: Variant;
}

async function buildFloorOneMap(seed: number): Promise<FloorMap> {
  let captured: GameWorld | undefined;
  const ai = new BehaviorTreeAI({ seed });
  await runHeadless(ai, {
    seed,
    maxFrames: WARMUP_RUN_FRAMES,
    forceWeaponId: 'sword',
    questStallFrames: 0,
    onFinish: (w) => {
      captured = w;
    },
    simulationOptions: {
      preSystems: [
        (w: GameWorld) => {
          query(w.ecs, [Player, Position]);
        },
      ],
    },
  });
  if (!captured?.floorMap) throw new Error('bench-flow-field: headless run surfaced no floorMap');
  return captured.floorMap;
}

function passableTiles(floorMap: FloorMap): TilePoint[] {
  const out: TilePoint[] = [];
  const width = floorMap.tileMap.width;
  const height = floorMap.tileMap.height;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (isTileTraversable(floorMap, x, y, PATH_TRAVERSAL.GROUND)) {
        out.push({ x, y });
      }
    }
  }
  return out;
}

function buildCases(
  floorMap: FloorMap,
  seed: number,
  total: number,
  options?: FlowFieldOptions,
  labelPrefix = `seed${seed}`,
): FlowCase[] {
  const tiles = passableTiles(floorMap);
  if (tiles.length === 0) {
    throw new Error('bench-flow-field: floor map has no traversable tiles');
  }
  const rng = new SeededRandom(seed);
  const cases: FlowCase[] = [];
  for (let i = 0; i < total; i += 1) {
    const goal = tiles[rng.nextInt(0, tiles.length - 1)]!;
    const probe = tiles[rng.nextInt(0, tiles.length - 1)]!;
    cases.push({
      floorMap,
      goal,
      probeIndex: probe.y * floorMap.tileMap.width + probe.x,
      label: `${labelPrefix}-${i}`,
      options,
    });
  }
  return cases;
}

function makePassableOverride(floorMap: FloorMap): (x: number, y: number) => boolean {
  return (x: number, y: number): boolean => floorMap.tileMap.isPassable(x, y);
}

function fieldsDiffer(expected: FlowField, actual: FlowField): string | null {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return `dimensions ${expected.width}x${expected.height} vs ${actual.width}x${actual.height}`;
  }
  if (expected.goalX !== actual.goalX || expected.goalY !== actual.goalY) {
    return `goal (${expected.goalX},${expected.goalY}) vs (${actual.goalX},${actual.goalY})`;
  }
  if (expected.distance.length !== actual.distance.length) {
    return `distance length ${expected.distance.length} vs ${actual.distance.length}`;
  }
  for (let i = 0; i < expected.distance.length; i += 1) {
    if (expected.distance[i] !== actual.distance[i]) {
      return `distance[${i}] ${expected.distance[i]} vs ${actual.distance[i]}`;
    }
  }
  return null;
}

function tracesDiffer(expected: readonly string[], actual: readonly string[]): string | null {
  if (expected.length !== actual.length) {
    return `trace length ${expected.length} vs ${actual.length}`;
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i] !== actual[i]) {
      return `trace[${i}] ${expected[i]} vs ${actual[i]}`;
    }
  }
  return null;
}

function runWithTrace(flowCase: FlowCase, variant: Variant): { field: FlowField; trace: string[] } {
  const originalPassable = flowCase.options?.isTilePassable;
  if (!originalPassable) {
    return {
      field: variant(flowCase.floorMap, flowCase.goal, flowCase.options),
      trace: [],
    };
  }
  const trace: string[] = [];
  const options: FlowFieldOptions = {
    ...flowCase.options,
    isTilePassable: (x, y) => {
      trace.push(`${x},${y}`);
      return originalPassable(x, y);
    },
  };
  return {
    field: variant(flowCase.floorMap, flowCase.goal, options),
    trace,
  };
}

function checkEquivalence(cases: readonly FlowCase[], variants: readonly NamedVariant[]): boolean {
  let compared = 0;
  let traced = 0;
  for (const c of cases) {
    const expected = runWithTrace(c, computeFlowFieldBaseline);
    for (const variant of variants) {
      const actual = runWithTrace(c, variant.run);
      const diff = fieldsDiffer(expected.field, actual.field);
      compared += 1;
      if (diff !== null) {
        console.error(`❌ ${variant.name} diverged on "${c.label}": ${diff}`);
        return false;
      }
      if (c.options?.isTilePassable) {
        traced += 1;
        const traceDiff = tracesDiffer(expected.trace, actual.trace);
        if (traceDiff !== null) {
          console.error(`❌ ${variant.name} callback trace diverged on "${c.label}": ${traceDiff}`);
          return false;
        }
      }
    }
  }
  console.log(
    `✅ Post-timing oracle: ${compared} grid comparisons across ${cases.length} fixtures` +
      `${traced > 0 ? ` and ${traced} callback-trace comparisons` : ''} — all exact.`,
  );
  return true;
}

function timeVariant(cases: readonly FlowCase[], variant: Variant): number {
  const start = process.hrtime.bigint();
  let sink = 0;
  for (const c of cases) {
    const field = variant(c.floorMap, c.goal, c.options);
    sink += field.distance[c.probeIndex] ?? 0;
  }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  if (sink > Number.MAX_SAFE_INTEGER) {
    throw new Error('unreachable');
  }
  return elapsed;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function runPanel(
  title: string,
  cases: readonly FlowCase[],
  variants: readonly NamedVariant[],
  rounds: number,
): void {
  const samples = variants.map(() => [] as number[]);
  for (let w = 0; w < WARMUP_SWEEPS; w += 1) {
    for (let i = 0; i < variants.length; i += 1) {
      const idx = (w + i) % variants.length;
      timeVariant(cases, variants[idx]!.run);
    }
  }

  for (let round = 0; round < rounds; round += 1) {
    for (let i = 0; i < variants.length; i += 1) {
      const idx = (round + i) % variants.length;
      samples[idx]!.push(timeVariant(cases, variants[idx]!.run));
    }
  }

  const toUsPerCall = (ms: number): number => (ms * 1000) / cases.length;
  console.log(`\n${title} — ${rounds} rounds x ${cases.length} calls (us/call):`);
  for (let i = 0; i < variants.length; i += 1) {
    const sample = samples[i]!;
    console.log(
      `  ${variants[i]!.name.padEnd(10)} median ${toUsPerCall(median(sample)).toFixed(2)}  ` +
        `[best ${toUsPerCall(Math.min(...sample)).toFixed(2)}, worst ${toUsPerCall(Math.max(...sample)).toFixed(2)}]`,
    );
  }

  const baselineSamples = samples[0]!;
  console.log('  Paired per-round ratios vs BASELINE:');
  for (let i = 1; i < variants.length; i += 1) {
    const ratios = baselineSamples.map((baseline, round) => baseline / samples[i]![round]!);
    const worst = Math.min(...ratios);
    const won = ratios.filter((ratio) => ratio > 1).length;
    console.log(
      `    ${variants[i]!.name.padEnd(10)} ${worst.toFixed(2)}x worst round  ` +
        `[median ${median(ratios).toFixed(2)}x, best ${Math.max(...ratios).toFixed(2)}x]  ` +
        `[rounds won ${won}/${ratios.length}]`,
    );
  }
}

async function main(): Promise<void> {
  const roundsRaw = Number(process.argv[2] ?? DEFAULT_ROUNDS);
  const rounds = Number.isInteger(roundsRaw) && roundsRaw > 0 ? roundsRaw : DEFAULT_ROUNDS;
  const [seed1Map, seed2Map] = await Promise.all([buildFloorOneMap(1), buildFloorOneMap(2)]);
  const timedCases = [...buildCases(seed1Map, 0x5eed, 150), ...buildCases(seed2Map, 0x5eee, 150)];
  const oracleCases = [
    ...timedCases,
    ...buildCases(seed1Map, 0x5eef, 8, { traversalMode: PATH_TRAVERSAL.FLYING }, 'flying-seed1'),
    ...buildCases(
      seed2Map,
      0x5ef0,
      8,
      { isTilePassable: makePassableOverride(seed2Map) },
      'callback-seed2',
    ),
  ];
  const variants: NamedVariant[] = [
    { name: 'BASELINE', run: computeFlowFieldBaseline },
    { name: 'CURRENT', run: computeFlowField },
  ];

  runPanel('computeFlowField on real Floor 1 maps', timedCases, variants, rounds);

  if (!checkEquivalence(oracleCases, variants.slice(1))) {
    console.error('❌ Post-timing oracle failed; disregard the timings above.');
    process.exitCode = 1;
    return;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
