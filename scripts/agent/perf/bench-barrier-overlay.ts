/**
 * Interleaved A/B microbench + equivalence oracle for the **empty-barrier-
 * overlay fast path** on `FloorMap`.
 *
 * ## What this measures and why
 *
 * `attachBarriersToFloorMap` installs two lookup closures on every floor map
 * unconditionally. Instrumenting `FloorMap.prototype` during a real Floor-1
 * headless run (seed 1, to completion) shows what that costs:
 *
 * ```
 * isPassableAt        15,476,669 calls
 * hasBarrierAtTile    19,371,656 calls  -> returned TRUE 0  (0.0%)
 * hasBarrierAtPoint   14,752,490 calls  -> returned TRUE 0  (0.0%)
 * ```
 *
 * 34.1 M closure invocations in one run, every one false, because the barrier
 * registry stays empty for the entire floor. The change under test gates each
 * lookup on the **live size** of the collection that backs it, so the empty
 * case costs a property read instead of a call.
 *
 * A prior session (`2026-07-27-los-allocation-churn-falsified.md`) sized the
 * whole overlay at **30-56%** of `hasClearLineOfSight` (1.438x-2.275x, 15/15
 * rounds won in all 8 panels). This bench measures how much of that the gate
 * actually recovers, on the two real callers:
 *
 *   - `hasClearLineOfSight` (src/game/ai/bt-ai-geometry.ts) — 7.45% self in
 *     `npm run perf:profile`; drives `isPassableAt` -> both lookups.
 *   - `isTileTraversable` (src/core/map/pathfinding.ts) — 1.11% self / 2.38%
 *     total; calls `hasBarrierAtTile` directly. This is why the tile lookup is
 *     called MORE often than `isPassableAt` (19.4 M vs 15.5 M).
 *
 * Both timed variants call the genuinely-shipped functions. There is no local
 * copy of a hot loop here, so there is nothing to drift.
 *
 * ## Variant construction — read before quoting a number
 *
 * `BEFORE` and `AFTER` are **both** `FloorMap` subclasses with an identical
 * field set and identical override sets; only the three method bodies differ.
 * The asymmetries that bit the previous bench are avoided deliberately:
 *
 *   - **Both** maps get the barrier closures installed. `isPassableAt`
 *     short-circuits on `barrierLookup === null`, so timing a wired map against
 *     a bare one gives one side two live callbacks and the other a null
 *     short-circuit — that confound flipped the prior session's result by ~1.6x
 *     in both directions.
 *   - Neither variant uses the base class's own `barrier*` fields, so the base
 *     `FloorMap` shape is identical for both and no `null -> function` hidden-
 *     class transition distinguishes them.
 *   - `BEFORE` carries the same (unread) `presence` field as `AFTER`, so the
 *     two subclasses have the same field count and write order.
 *   - The equivalence oracle and the drift guard run **after** all timing.
 *     They need extra receiver shapes, and feeding a second receiver into a
 *     timed call site makes its inline caches polymorphic.
 *
 * ## Correctness
 *
 * `checkEquivalence` compares `hasBarrierAtTile`, `hasBarrierAtPoint` and
 * `isPassableAt` between the two variants across three registry states —
 * empty, tile-barriers-live, and ring-wall-live — over thousands of fixtures.
 * The fast path is a deliberate pruning of calls to a **pure** closure, so
 * result equality is the contract here (unlike the LOS bench, where the
 * caller-supplied probe could be stateful). `checkClosuresMatchProduction`
 * separately proves the hand-built closures in this file still behave like the
 * ones `attachBarriersToFloorMap` installs.
 *
 * ## Timing method
 *
 * Rounds ALTERNATE which variant leads, in ONE process, after
 * {@link WARMUP_SWEEPS} rotated untimed sweeps, reported as paired per-round
 * ratios. Headline the WORST round; publish a range across >= 2 invocations.
 *
 * Usage:
 *   npx tsx scripts/agent/perf/bench-barrier-overlay.ts [rounds]
 */

import { query } from 'bitecs';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { Player, Position } from '../../../src/core/components.js';
import type { GameWorld } from '../../../src/core/world.js';
import { FloorMap, type BarrierPresenceSource } from '../../../src/core/map/FloorMap.js';
import {
  attachBarriersToFloorMap,
  createPolyBarrier,
  createRingWallBarrier,
  dropBarrier,
  isBarrierPointBlocked,
  isBarrierTile,
} from '../../../src/core/barriers/index.js';
import { hasClearLineOfSight } from '../../../src/game/ai/bt-ai-geometry.js';
import { isTileTraversable, PATH_TRAVERSAL } from '../../../src/core/map/pathfinding.js';
import {
  LINE_OF_SIGHT_SAMPLE_FT,
  CLOSE_APPROACH_DIRECT_FT,
} from '../../../src/game/ai/bt-ai-tuning.js';
import { SeededRandom } from '../../../src/shared/random.js';

const DEFAULT_ROUNDS = 15;
/**
 * Rotated untimed sweeps per variant before timing starts. One is NOT enough —
 * V8 tiering is still in flight during the first timed rounds, and an earlier
 * bench in this repo reported 4.71x/8.13x/8.42x for byte-identical code with a
 * single warmup sweep.
 */
const WARMUP_SWEEPS = 4;
const WARMUP_RUN_FRAMES = 1200;
/** Sized so one timed round lands in the ~10-25 ms band. Sub-ms rounds are noise. */
const CLOSE_SEGMENTS = 60_000;
const WAYPOINT_SEGMENTS = 30_000;
const TRAVERSAL_PROBES = 1_500_000;
/** Waypoint smoothing checks run over several tiles. */
const WAYPOINT_MAX_FT = 48;

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

/**
 * Pre-change `FloorMap`: the lookup is invoked unconditionally whenever one is
 * attached. Verbatim bodies from before the change.
 */
class FloorMapBefore extends FloorMap {
  tileLookup: ((tileX: number, tileY: number) => boolean) | null = null;
  pointLookup: ((xFt: number, yFt: number) => boolean) | null = null;
  /** Unused here — present so both subclasses have the same shape. */
  presence: BarrierPresenceSource | null = null;

  override hasBarrierAtTile(tileX: number, tileY: number): boolean {
    return this.tileLookup ? this.tileLookup(tileX, tileY) : false;
  }

  override hasBarrierAtPoint(xFt: number, yFt: number): boolean {
    return this.pointLookup ? this.pointLookup(xFt, yFt) : false;
  }
}

/** Post-change `FloorMap`: gate on the live size of the backing collection. */
class FloorMapAfter extends FloorMap {
  tileLookup: ((tileX: number, tileY: number) => boolean) | null = null;
  pointLookup: ((xFt: number, yFt: number) => boolean) | null = null;
  presence: BarrierPresenceSource | null = null;

  override hasBarrierAtTile(tileX: number, tileY: number): boolean {
    const presence = this.presence;
    if (presence !== null && presence.barriers.blockedTiles.size === 0) return false;
    return this.tileLookup !== null ? this.tileLookup(tileX, tileY) : false;
  }

  override hasBarrierAtPoint(xFt: number, yFt: number): boolean {
    const presence = this.presence;
    if (presence !== null && presence.barriers.ringShapes.size === 0) return false;
    return this.pointLookup !== null ? this.pointLookup(xFt, yFt) : false;
  }
}

type BenchMap = FloorMapBefore | FloorMapAfter;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function buildFloorOneWorld(seed: number): Promise<GameWorld> {
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
  if (!captured?.floorMap)
    throw new Error('bench-barrier-overlay: headless run surfaced no floorMap');
  return captured;
}

/** Re-wrap a real FloorMap's data in another FloorMap subclass. */
function cloneAs<T extends FloorMap>(
  Ctor: new (...args: ConstructorParameters<typeof FloorMap>) => T,
  src: FloorMap,
): T {
  return new Ctor(
    src.config,
    src.tileMap,
    src.roomGraph,
    src.terrain,
    src.playerSpawn,
    src.subFactor,
    src.territoryZones,
  );
}

interface Segment {
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
}

/**
 * LOS segments over the real Floor-1 geometry, drawn with `SeededRandom`
 * (never `Math.random`, AGENTS.md r3) from the map's passable tiles.
 */
function buildSegments(
  floorMap: FloorMap,
  count: number,
  maxLenFt: number,
  seed: number,
): Segment[] {
  const rng = new SeededRandom(seed);
  const tileSize = floorMap.config.tileSizeFt;
  const open = collectOpenTiles(floorMap);
  const out: Segment[] = [];
  for (let i = 0; i < count; i++) {
    const t = open[rng.nextInt(0, open.length - 1)]!;
    const startX = t.x * tileSize + rng.next() * tileSize;
    const startY = t.y * tileSize + rng.next() * tileSize;
    const angle = rng.next() * Math.PI * 2;
    const len = rng.next() * maxLenFt;
    out.push({
      startX,
      startY,
      endX: startX + Math.cos(angle) * len,
      endY: startY + Math.sin(angle) * len,
    });
  }
  return out;
}

function collectOpenTiles(floorMap: FloorMap): Array<{ x: number; y: number }> {
  const open: Array<{ x: number; y: number }> = [];
  const { width, height } = floorMap.tileMap;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (floorMap.tileMap.isPassable(x, y)) open.push({ x, y });
    }
  }
  if (open.length === 0) throw new Error('bench-barrier-overlay: map has no passable tiles');
  return open;
}

/**
 * Tile coordinates for the pathfinding panel. A* probes neighbours of frontier
 * tiles, so the mix is mostly-open with occasional out-of-bounds/wall probes;
 * drawing uniformly around open tiles reproduces that shape closely enough to
 * size the overlay cost.
 */
function buildTileProbes(floorMap: FloorMap, count: number, seed: number): Int32Array {
  const rng = new SeededRandom(seed);
  const open = collectOpenTiles(floorMap);
  const out = new Int32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const t = open[rng.nextInt(0, open.length - 1)]!;
    out[i * 2] = t.x + rng.nextInt(-1, 1);
    out[i * 2 + 1] = t.y + rng.nextInt(-1, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

interface NamedVariant {
  readonly name: string;
  readonly run: () => number;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function runPanel(
  title: string,
  callsPerRound: number,
  variants: readonly NamedVariant[],
  rounds: number,
): void {
  const samples = variants.map(() => [] as number[]);

  for (let w = 0; w < WARMUP_SWEEPS; w++) {
    for (let i = 0; i < variants.length; i++) {
      variants[(w + i) % variants.length]!.run();
    }
  }

  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < variants.length; i++) {
      // Rotate which variant leads so ordering effects cancel out.
      const idx = (r + i) % variants.length;
      const start = process.hrtime.bigint();
      const sink = variants[idx]!.run();
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
      if (sink < 0) throw new Error('unreachable');
      samples[idx]!.push(elapsed);
    }
  }

  const toUsPerCall = (ms: number): number => (ms * 1000) / callsPerRound;
  console.log(`\n${title} — ${rounds} rounds x ${callsPerRound} calls (us/call):`);
  for (let i = 0; i < variants.length; i++) {
    const s = samples[i]!;
    console.log(
      `  ${variants[i]!.name.padEnd(8)} median ${toUsPerCall(median(s)).toFixed(4)}  ` +
        `[best ${toUsPerCall(Math.min(...s)).toFixed(4)}, worst ${toUsPerCall(Math.max(...s)).toFixed(4)}]`,
    );
  }

  /*
   * Paired per-round ratios. All variants run inside the same round, so a
   * machine-wide stall inflates every one together. Pairing does NOT immunise
   * against a stall hitting one variant only, which is why rounds-won and the
   * worst round are printed alongside the median.
   */
  console.log(`  Paired per-round ratios vs ${variants[0]!.name}:`);
  const baselineSamples = samples[0]!;
  for (let i = 1; i < variants.length; i++) {
    const ratios = baselineSamples.map((b, r) => b / samples[i]![r]!);
    const worst = Math.min(...ratios);
    const med = median(ratios);
    const won = ratios.filter((x) => x > 1).length;
    const pass = med > 1 && won >= Math.ceil(ratios.length * 0.8);
    console.log(
      `    ${variants[i]!.name.padEnd(8)} ${med.toFixed(3)}x median  ` +
        `[worst round ${worst.toFixed(3)}x, best ${Math.max(...ratios).toFixed(3)}x]  ` +
        `${won}/${ratios.length} rounds won  ${pass ? '✅' : '⚠️'}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Correctness (runs AFTER timing — see file header)
// ---------------------------------------------------------------------------

/**
 * The two variants must agree on every query in every registry state. Called
 * with the registry empty, with tile barriers live, and with a ring wall live.
 */
function checkEquivalence(
  before: BenchMap,
  after: BenchMap,
  segments: readonly Segment[],
  probes: Int32Array,
  state: string,
): string | null {
  for (let i = 0; i < probes.length; i += 2) {
    const x = probes[i]!;
    const y = probes[i + 1]!;
    if (before.hasBarrierAtTile(x, y) !== after.hasBarrierAtTile(x, y)) {
      return `${state}: hasBarrierAtTile(${x}, ${y})`;
    }
    if (
      isTileTraversable(before, x, y, PATH_TRAVERSAL.GROUND) !==
      isTileTraversable(after, x, y, PATH_TRAVERSAL.GROUND)
    ) {
      return `${state}: isTileTraversable(${x}, ${y}) GROUND`;
    }
    if (
      isTileTraversable(before, x, y, PATH_TRAVERSAL.FLYING) !==
      isTileTraversable(after, x, y, PATH_TRAVERSAL.FLYING)
    ) {
      return `${state}: isTileTraversable(${x}, ${y}) FLYING`;
    }
  }
  for (const s of segments) {
    if (
      before.hasBarrierAtPoint(s.startX, s.startY) !== after.hasBarrierAtPoint(s.startX, s.startY)
    )
      return `${state}: hasBarrierAtPoint(${s.startX}, ${s.startY})`;
    if (before.isPassableAt(s.startX, s.startY) !== after.isPassableAt(s.startX, s.startY))
      return `${state}: isPassableAt(${s.startX}, ${s.startY})`;
    if (
      hasClearLineOfSight(before, s.startX, s.startY, s.endX, s.endY) !==
      hasClearLineOfSight(after, s.startX, s.startY, s.endX, s.endY)
    ) {
      return `${state}: hasClearLineOfSight(${s.startX}, ${s.startY} -> ${s.endX}, ${s.endY})`;
    }
  }
  return null;
}

/**
 * The closures this file hand-builds must behave exactly like the ones
 * `attachBarriersToFloorMap` installs — otherwise the whole panel is timing
 * something production never runs. Compared against a genuinely-wired map with
 * the registry NON-empty, so the production gate is inert and the underlying
 * closure bodies are what is actually compared.
 */
function checkClosuresMatchProduction(
  wired: FloorMap,
  handBuiltTile: (tileX: number, tileY: number) => boolean,
  handBuiltPoint: (xFt: number, yFt: number) => boolean,
  segments: readonly Segment[],
  probes: Int32Array,
): string | null {
  for (let i = 0; i < probes.length; i += 2) {
    const x = probes[i]!;
    const y = probes[i + 1]!;
    if (wired.hasBarrierAtTile(x, y) !== handBuiltTile(x, y)) return `tile lookup at (${x}, ${y})`;
  }
  for (const s of segments) {
    if (wired.hasBarrierAtPoint(s.startX, s.startY) !== handBuiltPoint(s.startX, s.startY))
      return `point lookup at (${s.startX}, ${s.startY})`;
  }
  return null;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const rounds = Number(positional[0] ?? DEFAULT_ROUNDS);
  if (!Number.isFinite(rounds) || rounds <= 0) {
    throw new Error(`bench-barrier-overlay: invalid round count "${positional[0]}"`);
  }

  console.log('Building a real Floor-1 map (headless warmup run)...');
  const world = await buildFloorOneWorld(1);
  const real = world.floorMap as FloorMap;
  console.log(
    `Floor 1: ${real.tileMap.width}x${real.tileMap.height} tiles, ${real.config.tileSizeFt} ft/tile.`,
  );
  console.log(
    `Barrier registry: ${world.barriers.barriers.size} handle(s), ` +
      `${world.barriers.blockedTiles.size} blocked tile(s), ` +
      `${world.barriers.ringShapes.size} ring shape(s).`,
  );

  const beforeMap = cloneAs(FloorMapBefore, real);
  const afterMap = cloneAs(FloorMapAfter, real);

  /*
   * Hand-built copies of the closures `attachBarriersToFloorMap` installs.
   * They cannot be read off a wired map (the fields are private with setters
   * and no getters), and delegating through a wired map's PUBLIC accessor
   * would leak the gate into the BEFORE variant. `checkClosuresMatchProduction`
   * proves these have not drifted.
   */
  const makeTileLookup =
    (owner: FloorMap) =>
    (tileX: number, tileY: number): boolean => {
      const idx = owner.tileMap.index(tileX, tileY);
      if (idx < 0) return false;
      return isBarrierTile(world, idx);
    };
  const pointLookup = (xFt: number, yFt: number): boolean => isBarrierPointBlocked(world, xFt, yFt);

  // Each map gets its OWN closure instance, so neither call site is penalised
  // by a shared polymorphic callee.
  beforeMap.tileLookup = makeTileLookup(beforeMap);
  beforeMap.pointLookup = (xFt, yFt) => pointLookup(xFt, yFt);
  beforeMap.presence = null;
  afterMap.tileLookup = makeTileLookup(afterMap);
  afterMap.pointLookup = (xFt, yFt) => pointLookup(xFt, yFt);
  afterMap.presence = world;

  const close = buildSegments(real, CLOSE_SEGMENTS, CLOSE_APPROACH_DIRECT_FT, 0x105e);
  const waypoint = buildSegments(real, WAYPOINT_SEGMENTS, WAYPOINT_MAX_FT, 0x1057);
  const probes = buildTileProbes(real, TRAVERSAL_PROBES, 0x7a1e);

  console.log(
    `LOS sample spacing ${LINE_OF_SIGHT_SAMPLE_FT} ft; both maps have the barrier ` +
      'closures installed (production shaped).',
  );

  const losVariants = (segs: readonly Segment[]): NamedVariant[] => [
    {
      name: 'BEFORE',
      run: () => {
        let sink = 0;
        for (const s of segs) {
          if (hasClearLineOfSight(beforeMap, s.startX, s.startY, s.endX, s.endY)) sink++;
        }
        return sink;
      },
    },
    {
      name: 'AFTER',
      run: () => {
        let sink = 0;
        for (const s of segs) {
          if (hasClearLineOfSight(afterMap, s.startX, s.startY, s.endX, s.endY)) sink++;
        }
        return sink;
      },
    },
  ];

  const traversalVariants: NamedVariant[] = [
    {
      name: 'BEFORE',
      run: () => {
        let sink = 0;
        for (let i = 0; i < probes.length; i += 2) {
          if (isTileTraversable(beforeMap, probes[i]!, probes[i + 1]!, PATH_TRAVERSAL.GROUND))
            sink++;
        }
        return sink;
      },
    },
    {
      name: 'AFTER',
      run: () => {
        let sink = 0;
        for (let i = 0; i < probes.length; i += 2) {
          if (isTileTraversable(afterMap, probes[i]!, probes[i + 1]!, PATH_TRAVERSAL.GROUND))
            sink++;
        }
        return sink;
      },
    },
  ];

  runPanel(
    `hasClearLineOfSight — close approach (<= ${CLOSE_APPROACH_DIRECT_FT} ft)`,
    CLOSE_SEGMENTS,
    losVariants(close),
    rounds,
  );
  runPanel(
    `hasClearLineOfSight — waypoint smoothing (<= ${WAYPOINT_MAX_FT} ft)`,
    WAYPOINT_SEGMENTS,
    losVariants(waypoint),
    rounds,
  );
  runPanel(
    'isTileTraversable — pathfinding tile probes (GROUND)',
    TRAVERSAL_PROBES,
    traversalVariants,
    rounds,
  );

  console.log(
    '\nReport the WORST round and a range across >=2 process invocations.\n' +
      'Then derive end-to-end honestly: saving = share x (1 - 1/speedup).',
  );

  // -- Correctness, deliberately last (extra receiver shapes poison ICs). ----

  const oracleSegments = [
    ...buildSegments(real, 3000, CLOSE_APPROACH_DIRECT_FT, 0x0a11c105),
    ...buildSegments(real, 3000, WAYPOINT_MAX_FT, 0x0a11fa12),
  ];
  const oracleProbes = buildTileProbes(real, 6000, 0x0a11b0b);

  const states: Array<{ label: string; setUp: () => () => void }> = [
    { label: 'registry EMPTY', setUp: () => () => {} },
    {
      label: 'tile barriers LIVE',
      setUp: () => {
        const open = collectOpenTiles(real).slice(0, 400);
        const handle = createPolyBarrier(
          world,
          open.map((t) => real.tileMap.index(t.x, t.y)),
          'fence',
        );
        return () => dropBarrier(world, handle);
      },
    },
    {
      label: 'analytic ring wall LIVE',
      setUp: () => {
        const spawn = real.playerSpawn;
        const cx = spawn.x * real.config.tileSizeFt;
        const cy = spawn.y * real.config.tileSizeFt;
        const handle = createRingWallBarrier(world, cx, cy, 40, 2, 'forcefield');
        return () => dropBarrier(world, handle);
      },
    },
  ];

  for (const state of states) {
    const tearDown = state.setUp();
    try {
      const failure = checkEquivalence(
        beforeMap,
        afterMap,
        oracleSegments,
        oracleProbes,
        state.label,
      );
      if (failure) {
        console.error(`\n❌ EQUIVALENCE FAILED on ${failure}`);
        process.exitCode = 1;
        return;
      }
    } finally {
      tearDown();
    }
  }
  console.log(
    `\n✅ Equivalence: ${oracleSegments.length} segments + ${oracleProbes.length / 2} tile probes\n` +
      '   identical across BEFORE/AFTER in all 3 registry states (empty, tile, ring wall).',
  );

  // Drift guard: the hand-built closures must match production's, checked with
  // a NON-empty registry so the shipped gate is inert.
  const wired = cloneAs(FloorMap, real);
  const mutableWorld = world as { floorMap: FloorMap | null };
  const originalFloorMap = mutableWorld.floorMap;
  const openForDrift = collectOpenTiles(real).slice(0, 400);
  const driftHandle = createPolyBarrier(
    world,
    openForDrift.map((t) => real.tileMap.index(t.x, t.y)),
    'fence',
  );
  const driftRing = createRingWallBarrier(
    world,
    real.playerSpawn.x * real.config.tileSizeFt,
    real.playerSpawn.y * real.config.tileSizeFt,
    40,
    2,
    'forcefield',
  );
  try {
    mutableWorld.floorMap = wired;
    attachBarriersToFloorMap(world as unknown as Parameters<typeof attachBarriersToFloorMap>[0]);
  } finally {
    mutableWorld.floorMap = originalFloorMap;
  }
  const drift = ((): string | null => {
    try {
      return checkClosuresMatchProduction(
        wired,
        makeTileLookup(wired),
        pointLookup,
        oracleSegments,
        oracleProbes,
      );
    } finally {
      dropBarrier(world, driftHandle);
      dropBarrier(world, driftRing);
    }
  })();
  if (drift) {
    console.error(
      `\n❌ DISCARD THE NUMBERS ABOVE. This bench's hand-built barrier closures have\n` +
        `   drifted from attachBarriersToFloorMap on ${drift}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    "\n✅ Drift guard: this file's hand-built closures match the ones\n" +
      '   attachBarriersToFloorMap installs (checked with a NON-empty registry).',
  );
}

await main();
