/**
 * Interleaved A/B microbench + equivalence oracle for `hasClearLineOfSight`.
 *
 * ## Why this exists — and what it FOUND
 *
 * `hasClearLineOfSight` is the hottest leaf in the headless sim (**7.47% self /
 * 7.63% total** per `npm run perf:profile` at `278bcf51a`) now that grid A* has
 * landed. The obvious hypothesis was allocation churn: its sampling loop calls
 * `FloorMap.isPassableAt` and `FloorMap.worldToTile` 2-4 times per sample step,
 * and *both* allocate a throwaway `{x, y}` — `worldToTile` by construction, and
 * `isPassableAt` because it calls `worldToTile` internally.
 *
 * **That hypothesis did not survive measurement, and this bench is the
 * evidence.** Removing every one of those allocations measures at
 * **0.909x-1.111x median** across process invocations, worst paired round
 * **0.521x**, and the worst round is *below* 1.0x in every panel. One waypoint
 * panel did post a 1.111x median, but it did not repeat and only won 10/15
 * rounds, so there is no shipping-grade win here.
 *
 * The likely reason is that V8's escape analysis already scalar-replaces the
 * non-escaping `{x, y}` once these small methods inline — but note that is an
 * *explanation*, not something this bench demonstrates. What it demonstrates is
 * the absence of a measurable production win, which is what governs the
 * decision. The barrier callbacks below could equally be masking a cheap
 * allocation.
 *
 * The `--barrier-share` diagnostic shows where the time actually goes: merely
 * *consulting* the barrier overlay from `isPassableAt` costs **1.438x-2.275x**
 * of this function's runtime (15/15 rounds won in all four panels, worst round
 * 1.085x) — i.e. roughly **30-56%** of `hasClearLineOfSight` is barrier
 * lookups, not tile math and not GC. On the Floor-1 combat fixture the barrier
 * registry is EMPTY, so that figure is the cost of an *always-false* overlay
 * query; see {@link runBarrierShareDiagnostic} for why that changes the
 * reading. Those percentages are measured on this bench's synthetic segment
 * mix, not on the production-weighted mix of real LOS calls, so treat them as
 * sizing for this panel rather than a proven share of the profiler's 7.47%.
 *
 * Keep this file. Its job now is to stop the next agent re-chasing the
 * allocation and to hand them a quantified target instead.
 *
 * ## Known limits of this harness
 *
 * Read these before quoting a number from it:
 *
 *   - `SCALAR-MAP` replaces one `worldToTile` call with two (`worldToTileX` +
 *     `worldToTileY`), so it is not a pure allocation ablation — it trades an
 *     allocation for an extra dispatch.
 *   - The candidates live on a `FloorMap` subclass. Each timed call site is
 *     monomorphic, but shared inherited helpers see both receiver shapes, so
 *     transitive ICs can go polymorphic. A reverse-role run (candidate as the
 *     base class) measured 0.966x-1.034x, which argues against a large subclass
 *     tax; that run required `src/` edits and is therefore not reproducible from
 *     this file.
 *   - The symmetric barrier delegation (see {@link main}) adds one indirection
 *     to *both* sides. It removes a much larger confound but does dilute a
 *     small candidate gain.
 *
 * All three point the same way — they could hide a *small* win, not invert the
 * conclusion — but they are why the finding is stated as "no shipping-grade
 * production win" rather than as a clean mechanistic falsification.
 *
 * ## Variants
 *
 *   - SHIPPED      — a local copy of the loop as it exists in
 *                    `bt-ai-geometry.ts`, against the real `FloorMap`.
 *   - SCALAR-MAP   — the same loop copy, against a `FloorMap` subclass whose
 *                    `isPassableAt` uses allocation-free scalar tile lookups.
 *                    Isolates the map-side fix.
 *   - SCALAR-BOTH  — the candidate loop (scalar `prevTileX`/`prevTileY`, hoisted
 *                    deltas) against that same subclass. Adds the loop-side fix.
 *
 * All three loops are **local copies**, so none of them gets the inline-cache
 * head start that the genuinely-shipped function picks up from the headless
 * warmup run. Each copy is duplicated per receiver type where needed so its
 * `floorMap.*` call sites stay **monomorphic**; feeding two receiver maps into
 * one copy would make its caches polymorphic and silently penalise it.
 *
 * ## Arithmetic neutrality of the candidate
 *
 * Every candidate edit is **bit-identical arithmetic**: `Math.floor(x / t)` is
 * the same double whether it lands in an object field or a local, and hoisting
 * an IEEE-754 subtraction out of a loop is exact. Nothing reassociates floating
 * point and nothing changes which positions are probed. (Rewriting
 * `startX + deltaX * t` into an incremental accumulator WOULD accumulate error,
 * and replacing the sub-tile walk with a DDA/supercover walk would probe
 * different positions. Both are deliberately not done.)
 *
 * ## Correctness
 *
 * Booleans are compared per fixture AND the **ordered probe trace** is compared
 * entry by entry. `isPassableAt` is caller-supplied on the `LineOfSightMap`
 * interface and is not required to be pure, so comparing only return values
 * could pass while a pruned or reordered probe changed what a stateful
 * implementation observes.
 *
 * ## Timing method
 *
 * Rounds ALTERNATE which variant leads, in ONE process, after
 * {@link WARMUP_SWEEPS} rotated untimed sweeps, reported as paired per-round
 * ratios. A cross-process A/B once produced a bogus 4.5x in this repo, and a
 * single warmup sweep once swung the median between 4.7x and 8.4x for
 * byte-identical code.
 *
 * Usage:
 *   npx tsx scripts/agent/perf/bench-line-of-sight.ts [rounds]
 *   npx tsx scripts/agent/perf/bench-line-of-sight.ts --no-barriers
 *   npx tsx scripts/agent/perf/bench-line-of-sight.ts --barrier-share
 *
 * Run it at least twice and publish the RANGE plus the worst single round.
 */

import { query } from 'bitecs';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { Player, Position } from '../../../src/core/components.js';
import type { GameWorld } from '../../../src/core/world.js';
import { FloorMap } from '../../../src/core/map/FloorMap.js';
import { attachBarriersToFloorMap } from '../../../src/core/barriers/wiring.js';
import { hasClearLineOfSight } from '../../../src/game/ai/bt-ai-geometry.js';
import {
  LINE_OF_SIGHT_SAMPLE_FT,
  CLOSE_APPROACH_DIRECT_FT,
} from '../../../src/game/ai/bt-ai-tuning.js';
import { SeededRandom } from '../../../src/shared/random.js';

const DEFAULT_ROUNDS = 15;
/**
 * Rotated untimed sweeps per variant before timing starts. One sweep is NOT
 * enough — V8 tiering is still in flight during the first timed rounds. See
 * `bench-pathfinding.ts` for the incident that established this floor.
 */
const WARMUP_SWEEPS = 4;
const WARMUP_RUN_FRAMES = 1200;
/**
 * Segment counts are sized so a single timed round takes ~10-25 ms. An earlier
 * revision used 3000/1500, which made a round <1 ms — short enough that OS
 * scheduling noise dominated and per-round ratios swung 0.64x-1.37x on
 * byte-identical work.
 */
const CLOSE_SEGMENTS = 60_000;
const WAYPOINT_SEGMENTS = 30_000;
/** Long segments, matching navmesh-waypoint smoothing in `bt-ai-provider.ts`. */
const WAYPOINT_MAX_FT = 48;

/* ------------------------------------------------------------------ *
 * CANDIDATE map — allocation-free scalar tile lookups.
 *
 * A subclass rather than a hand-rolled stand-in, so every other part of the map
 * (tile flags, barrier lookups, config) is the real thing and the only measured
 * difference is the allocation.
 * ------------------------------------------------------------------ */

class FloorMapScalar extends FloorMap {
  /** Candidate: allocation-free per-axis tile lookup. */
  worldToTileX(x: number): number {
    return Math.floor(x / this.config.tileSizeFt);
  }

  worldToTileY(y: number): number {
    return Math.floor(y / this.config.tileSizeFt);
  }

  /** Candidate: scalar locals instead of a throwaway `{x, y}`. */
  override isPassableAt(x: number, y: number): boolean {
    const tileX = this.worldToTileX(x);
    const tileY = this.worldToTileY(y);
    if (!this.tileMap.isPassable(tileX, tileY)) return false;
    if (this.hasBarrierAtTile(tileX, tileY)) return false;
    return !this.hasBarrierAtPoint(x, y);
  }
}

/** Structural view the shipped loop needs (object-returning tile lookup). */
interface ObjectLineOfSightMap {
  isPassableAt(x: number, y: number): boolean;
  worldToTile(x: number, y: number): { x: number; y: number };
}

/** Structural view the candidate loop needs (scalar tile lookups). */
interface ScalarLineOfSightMap {
  isPassableAt(x: number, y: number): boolean;
  worldToTileX(x: number): number;
  worldToTileY(y: number): number;
}

/* ------------------------------------------------------------------ *
 * SHIPPED loop — verbatim copy of `hasClearLineOfSight` as it stands.
 *
 * Duplicated once per receiver type on purpose (see the header): one copy only
 * ever sees `FloorMap`, the other only ever sees `FloorMapScalar`, so both keep
 * monomorphic inline caches.
 * ------------------------------------------------------------------ */

function shippedLoopOnRealMap(
  floorMap: ObjectLineOfSightMap | null | undefined,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  sampleStepFt: number = LINE_OF_SIGHT_SAMPLE_FT,
): boolean {
  if (!floorMap) {
    return false;
  }
  const distance = Math.hypot(endX - startX, endY - startY);
  if (distance <= 0) {
    return floorMap.isPassableAt(endX, endY);
  }
  const steps = Math.max(1, Math.ceil(distance / sampleStepFt));
  let prevX = startX;
  let prevY = startY;
  let prevTile = floorMap.worldToTile(startX, startY);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const sampleX = startX + (endX - startX) * t;
    const sampleY = startY + (endY - startY) * t;
    if (!floorMap.isPassableAt(sampleX, sampleY)) {
      return false;
    }
    const sampleTile = floorMap.worldToTile(sampleX, sampleY);
    const crossesBlockedCorner =
      sampleTile.x !== prevTile.x &&
      sampleTile.y !== prevTile.y &&
      !floorMap.isPassableAt(sampleX, prevY) &&
      !floorMap.isPassableAt(prevX, sampleY);
    if (crossesBlockedCorner) {
      return false;
    }
    prevX = sampleX;
    prevY = sampleY;
    prevTile = sampleTile;
  }
  return true;
}

/** Byte-identical twin of the above; exists only to keep ICs monomorphic. */
function shippedLoopOnScalarMap(
  floorMap: ObjectLineOfSightMap | null | undefined,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  sampleStepFt: number = LINE_OF_SIGHT_SAMPLE_FT,
): boolean {
  if (!floorMap) {
    return false;
  }
  const distance = Math.hypot(endX - startX, endY - startY);
  if (distance <= 0) {
    return floorMap.isPassableAt(endX, endY);
  }
  const steps = Math.max(1, Math.ceil(distance / sampleStepFt));
  let prevX = startX;
  let prevY = startY;
  let prevTile = floorMap.worldToTile(startX, startY);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const sampleX = startX + (endX - startX) * t;
    const sampleY = startY + (endY - startY) * t;
    if (!floorMap.isPassableAt(sampleX, sampleY)) {
      return false;
    }
    const sampleTile = floorMap.worldToTile(sampleX, sampleY);
    const crossesBlockedCorner =
      sampleTile.x !== prevTile.x &&
      sampleTile.y !== prevTile.y &&
      !floorMap.isPassableAt(sampleX, prevY) &&
      !floorMap.isPassableAt(prevX, sampleY);
    if (crossesBlockedCorner) {
      return false;
    }
    prevX = sampleX;
    prevY = sampleY;
    prevTile = sampleTile;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * CANDIDATE loop — scalar tile tracking, hoisted deltas.
 *
 * `deltaX`/`deltaY` are computed once. That is exact: it is the same IEEE-754
 * subtraction, just performed once instead of `steps` times. `Math.hypot` sees
 * the same two doubles. The probe order and short-circuit structure are
 * unchanged, which the trace oracle verifies.
 * ------------------------------------------------------------------ */

function candidateLoop(
  floorMap: ScalarLineOfSightMap | null | undefined,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  sampleStepFt: number = LINE_OF_SIGHT_SAMPLE_FT,
): boolean {
  if (!floorMap) {
    return false;
  }
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const distance = Math.hypot(deltaX, deltaY);
  if (distance <= 0) {
    return floorMap.isPassableAt(endX, endY);
  }
  const steps = Math.max(1, Math.ceil(distance / sampleStepFt));
  let prevX = startX;
  let prevY = startY;
  let prevTileX = floorMap.worldToTileX(startX);
  let prevTileY = floorMap.worldToTileY(startY);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // NOT an incremental accumulator: `startX + deltaX * t` recomputed from the
    // origin every step, exactly as the shipped loop does. Accumulating
    // `sampleX += stepX` would drift and change results.
    const sampleX = startX + deltaX * t;
    const sampleY = startY + deltaY * t;
    if (!floorMap.isPassableAt(sampleX, sampleY)) {
      return false;
    }
    const sampleTileX = floorMap.worldToTileX(sampleX);
    const sampleTileY = floorMap.worldToTileY(sampleY);
    const crossesBlockedCorner =
      sampleTileX !== prevTileX &&
      sampleTileY !== prevTileY &&
      !floorMap.isPassableAt(sampleX, prevY) &&
      !floorMap.isPassableAt(prevX, sampleY);
    if (crossesBlockedCorner) {
      return false;
    }
    prevX = sampleX;
    prevY = sampleY;
    prevTileX = sampleTileX;
    prevTileY = sampleTileY;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Ordered probe trace — the side-effect oracle.
 *
 * `isPassableAt` is supplied by the caller through `LineOfSightMap` and is not
 * required to be pure, so equality of the returned boolean is NOT sufficient: a
 * pruned or reordered probe would be invisible to a return-value-only
 * comparison but visible to a stateful implementation. These recorders capture
 * the exact ordered sequence of map queries each variant issues.
 *
 * Tile lookups are normalised to a single `T:x,y` entry because the candidate
 * deliberately splits one `worldToTile(x, y)` into `worldToTileX(x)` +
 * `worldToTileY(y)`. The equivalence being asserted is "the same coordinates
 * were converted at the same point in the sequence", which is what a stateful
 * implementer could observe.
 * ------------------------------------------------------------------ */

type Trace = string[];

class RecordingRealMap extends FloorMap {
  trace: Trace = [];
  /**
   * Depth counter, not a copy of `isPassableAt`'s body. An earlier revision
   * inlined the body here to stop the internal tile conversion being recorded
   * as a caller-level query; that silently drifts the day the real
   * `isPassableAt` changes. Delegating to `super` and suppressing the nested
   * `worldToTile` record keeps the oracle pinned to the shipped implementation.
   */
  private probeDepth = 0;
  override worldToTile(x: number, y: number): { x: number; y: number } {
    if (this.probeDepth === 0) this.trace.push(`T:${x},${y}`);
    return super.worldToTile(x, y);
  }
  override isPassableAt(x: number, y: number): boolean {
    this.trace.push(`P:${x},${y}`);
    this.probeDepth++;
    try {
      return super.isPassableAt(x, y);
    } finally {
      this.probeDepth--;
    }
  }
  /** Clear all recorder state between segments. */
  reset(): void {
    this.trace.length = 0;
    this.probeDepth = 0;
  }
}

class RecordingScalarMap extends FloorMapScalar {
  trace: Trace = [];
  private probeDepth = 0;
  private pendingTileX: number | null = null;
  override worldToTileX(x: number): number {
    if (this.probeDepth === 0) {
      if (this.pendingTileX !== null) {
        throw new Error('bench-line-of-sight: worldToTileX twice without an intervening Y');
      }
      this.pendingTileX = x;
    }
    return super.worldToTileX(x);
  }
  override worldToTileY(y: number): number {
    if (this.probeDepth === 0) {
      if (this.pendingTileX === null) {
        throw new Error('bench-line-of-sight: worldToTileY without a preceding worldToTileX');
      }
      this.trace.push(`T:${this.pendingTileX},${y}`);
      this.pendingTileX = null;
    }
    return super.worldToTileY(y);
  }
  override isPassableAt(x: number, y: number): boolean {
    this.trace.push(`P:${x},${y}`);
    this.probeDepth++;
    try {
      return super.isPassableAt(x, y);
    } finally {
      this.probeDepth--;
    }
  }
  /** Clear all recorder state between segments (including the X/Y pair buffer). */
  reset(): void {
    this.trace.length = 0;
    this.probeDepth = 0;
    this.pendingTileX = null;
  }
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/** Build a real Floor-1 world by running the headless AI briefly. */
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
    throw new Error('bench-line-of-sight: headless run surfaced no floorMap');
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
  readonly label: string;
}

/**
 * Build LOS segments over the real Floor-1 geometry.
 *
 * Two length regimes, both taken from the call sites in `bt-ai-provider.ts`:
 *   - "close"    — up to `CLOSE_APPROACH_DIRECT_FT` (6 ft), the direct-approach
 *                  and local-step probes. ~6 samples per call at
 *                  `LINE_OF_SIGHT_SAMPLE_FT = 1`.
 *   - "waypoint" — up to `maxLenFt`, the path/navmesh waypoint smoothing checks
 *                  which run over several tiles.
 *
 * Endpoints are drawn with `SeededRandom` (never `Math.random`, AGENTS.md r3)
 * from the map's passable tiles, so the mix of clear and blocked corridors is
 * whatever the real Floor-1 layout produces rather than hand-picked.
 */
function buildSegments(
  floorMap: FloorMap,
  count: number,
  maxLenFt: number,
  seed: number,
  label: string,
): Segment[] {
  const rng = new SeededRandom(seed);
  const tileSize = floorMap.config.tileSizeFt;
  const open: Array<{ x: number; y: number }> = [];
  const { width, height } = floorMap.tileMap;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (floorMap.tileMap.isPassable(x, y)) open.push({ x, y });
    }
  }
  if (open.length === 0) throw new Error('bench-line-of-sight: map has no passable tiles');

  const out: Segment[] = [];
  for (let i = 0; i < count; i++) {
    const t = open[rng.nextInt(0, open.length - 1)]!;
    // Jitter inside the tile so samples are not all tile-centred.
    const startX = t.x * tileSize + rng.next() * tileSize;
    const startY = t.y * tileSize + rng.next() * tileSize;
    const angle = rng.next() * Math.PI * 2;
    const len = rng.next() * maxLenFt;
    out.push({
      startX,
      startY,
      endX: startX + Math.cos(angle) * len,
      endY: startY + Math.sin(angle) * len,
      label: `${label}-${i}`,
    });
  }
  return out;
}

/** Degenerate + boundary fixtures the random draw is unlikely to hit. */
function edgeCaseSegments(floorMap: FloorMap): Segment[] {
  const tileSize = floorMap.config.tileSizeFt;
  const c = (t: number): number => t * tileSize + tileSize / 2;
  return [
    { startX: c(5), startY: c(5), endX: c(5), endY: c(5), label: 'zero-length' },
    { startX: c(5), startY: c(5), endX: c(5) + 1e-12, endY: c(5), label: 'sub-epsilon' },
    { startX: -50, startY: -50, endX: c(3), endY: c(3), label: 'from-out-of-bounds' },
    { startX: c(3), startY: c(3), endX: -50, endY: -50, label: 'to-out-of-bounds' },
    { startX: 0, startY: 0, endX: 0, endY: 0, label: 'origin' },
    // Exactly tile-aligned endpoints — floor() boundary behaviour.
    {
      startX: tileSize,
      startY: tileSize,
      endX: tileSize * 6,
      endY: tileSize * 6,
      label: 'aligned-diag',
    },
    {
      startX: tileSize * 2,
      startY: tileSize * 2,
      endX: tileSize * 2,
      endY: tileSize * 9,
      label: 'aligned-vert',
    },
    {
      startX: floorMap.widthFt + 10,
      startY: floorMap.heightFt + 10,
      endX: c(2),
      endY: c(2),
      label: 'past-far-edge',
    },
  ];
}

/**
 * Compare the SHIPPED function against the CANDIDATE loop on both the returned
 * boolean and the ordered probe trace. Returns null when everything matched.
 */
function checkEquivalence(
  realMap: RecordingRealMap,
  scalarMap: RecordingScalarMap,
  segments: readonly Segment[],
): string | null {
  for (const s of segments) {
    realMap.reset();
    scalarMap.reset();
    // The genuinely shipped export, not a copy — the oracle must pin the real
    // thing even though the timing panels use copies for symmetry.
    const expected = hasClearLineOfSight(realMap, s.startX, s.startY, s.endX, s.endY);
    const actual = candidateLoop(scalarMap, s.startX, s.startY, s.endX, s.endY);
    if (expected !== actual) {
      return `"${s.label}": returned ${expected} vs ${actual}`;
    }
    const mismatch = diffTraces(s.label, realMap.trace, scalarMap.trace);
    if (mismatch) return mismatch;
  }
  return null;
}

/** Element-by-element ordered-trace comparison. Returns null when identical. */
function diffTraces(label: string, a: Trace, b: Trace): string | null {
  if (a.length !== b.length) {
    return `"${label}": probe trace length ${a.length} vs ${b.length}`;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return `"${label}": probe ${i} "${a[i]}" vs "${b[i]}"`;
    }
  }
  return null;
}

/**
 * Guard against the SHIPPED copies drifting away from the real implementation.
 * If `hasClearLineOfSight` changes and these copies are not updated, the whole
 * bench silently starts measuring the wrong baseline.
 *
 * Compares the ordered probe trace, not just the returned boolean: a copy that
 * pruned or reordered a probe would return the same answer while doing a
 * different amount of work — exactly the drift that would corrupt the timing.
 * Both local copies are checked, since either one drifting biases one side.
 */
function checkShippedCopiesMatchReal(
  realMap: RecordingRealMap,
  segments: readonly Segment[],
): string | null {
  const copies: ReadonlyArray<[string, typeof shippedLoopOnRealMap]> = [
    ['shippedLoopOnRealMap', shippedLoopOnRealMap],
    ['shippedLoopOnScalarMap', shippedLoopOnScalarMap],
  ];
  for (const s of segments) {
    realMap.reset();
    const expected = hasClearLineOfSight(realMap, s.startX, s.startY, s.endX, s.endY);
    const expectedTrace = [...realMap.trace];
    for (const [name, copy] of copies) {
      realMap.reset();
      const actual = copy(realMap, s.startX, s.startY, s.endX, s.endY);
      if (expected !== actual) {
        return `"${s.label}": shipped ${expected} vs ${name} ${actual}`;
      }
      const mismatch = diffTraces(`${s.label}" via "${name}`, expectedTrace, realMap.trace);
      if (mismatch) return mismatch;
    }
  }
  return null;
}

interface NamedVariant {
  readonly name: string;
  readonly run: (segments: readonly Segment[]) => number;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function runPanel(
  title: string,
  segments: readonly Segment[],
  variants: readonly NamedVariant[],
  rounds: number,
): void {
  const samples = variants.map(() => [] as number[]);

  // Rotated warmup sweeps — one is not enough (see WARMUP_SWEEPS).
  for (let w = 0; w < WARMUP_SWEEPS; w++) {
    for (let i = 0; i < variants.length; i++) {
      variants[(w + i) % variants.length]!.run(segments);
    }
  }

  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < variants.length; i++) {
      // Rotate which variant leads so ordering effects cancel out.
      const idx = (r + i) % variants.length;
      const start = process.hrtime.bigint();
      const sink = variants[idx]!.run(segments);
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
      if (sink < 0) throw new Error('unreachable');
      samples[idx]!.push(elapsed);
    }
  }

  const toUsPerCall = (ms: number): number => (ms * 1000) / segments.length;
  console.log(`\n${title} — ${rounds} rounds x ${segments.length} calls (us/call):`);
  for (let i = 0; i < variants.length; i++) {
    const s = samples[i]!;
    console.log(
      `  ${variants[i]!.name.padEnd(12)} median ${toUsPerCall(median(s)).toFixed(3)}  ` +
        `[best ${toUsPerCall(Math.min(...s)).toFixed(3)}, worst ${toUsPerCall(Math.max(...s)).toFixed(3)}]`,
    );
  }

  /*
   * Paired per-round ratios. All variants run inside the same round, so a
   * machine-wide stall inflates every one of them together; comparing raw
   * min/max across rounds would report "overlapping" for a real, consistent
   * win. Pairing does NOT immunise against a stall that hits one variant only,
   * which is why the rounds-won count is printed alongside the median.
   */
  console.log(`  Paired per-round ratios vs ${variants[0]!.name}:`);
  const baselineSamples = samples[0]!;
  for (let i = 1; i < variants.length; i++) {
    const ratios = baselineSamples.map((b, r) => b / samples[i]![r]!);
    const worst = Math.min(...ratios);
    const med = median(ratios);
    const won = ratios.filter((x) => x > 1).length;
    /*
     * Pass marker follows the skill's stated criterion: median ratio above 1
     * AND a large majority of rounds won (>=80%). The WORST round is printed
     * because it is the mandated headline figure, but a single bad round does
     * not by itself disqualify an otherwise consistent win — an earlier
     * revision gated the marker on `worst > 1`, which is stricter than the
     * recipe and would flag a real win as a failure.
     */
    const pass = med > 1 && won >= Math.ceil(ratios.length * 0.8);
    console.log(
      `    ${variants[i]!.name.padEnd(12)} ${med.toFixed(3)}x median  ` +
        `[worst round ${worst.toFixed(3)}x, best ${Math.max(...ratios).toFixed(3)}x]  ` +
        `${won}/${ratios.length} rounds won  ${pass ? '✅' : '⚠️'}`,
    );
  }
}

/**
 * Diagnostic panel (opt-in, `--barrier-share`): how much of
 * `hasClearLineOfSight`'s cost is the barrier overlay rather than the tile
 * lookup it was assumed to be?
 *
 * Both variants call the SAME shipped `hasClearLineOfSight` on structurally
 * identical clones; the only difference is whether the production barrier
 * closures (rebuilt through `attachBarriersToFloorMap`, so they are the real
 * ones and not a delegating stand-in) are installed.
 *
 * This is NOT a change proposal — detaching barriers would change gameplay. It
 * only sizes where the time goes.
 *
 * The panel PRINTS the live barrier-registry sizes and both variants' sink
 * counts, because the interpretation depends on them:
 *
 *   - registry EMPTY (the Floor-1 combat fixture: `blockedTiles` and
 *     `ringShapes` are both 0) — the callbacks always return false, both
 *     variants sample identically, and the sink counts match. What is measured
 *     is then the pure overhead of *consulting an empty overlay*: a closure
 *     call, `tileMap.index`, a `Set.has` miss, and a second closure that
 *     short-circuits on `ringShapes.size === 0`. That is a clean apples-to-
 *     apples delta but says nothing about the cost of live barriers.
 *   - registry NON-EMPTY — the variants diverge, because barriers block
 *     segments and blocked segments exit the sampling loop early. Only then is
 *     the measured share a lower bound on the barrier cost.
 *
 * An earlier revision of this file asserted the lower-bound reading
 * unconditionally. That was wrong for this fixture; check the printed counts
 * before repeating the claim.
 */
function runBarrierShareDiagnostic(
  world: GameWorld,
  real: FloorMap,
  close: readonly Segment[],
  waypoint: readonly Segment[],
  rounds: number,
): void {
  const withBarriers = cloneAs(FloorMap, real);
  const withoutBarriers = cloneAs(FloorMap, real);
  // Rebuild the genuine production closures against this clone by pointing the
  // world's floorMap at it for the duration of the wiring call. `finally` so a
  // throw inside the wiring cannot leave the world holding the clone.
  const mutableWorld = world as { floorMap: FloorMap | null };
  const original = mutableWorld.floorMap;
  try {
    mutableWorld.floorMap = withBarriers;
    attachBarriersToFloorMap(world as unknown as Parameters<typeof attachBarriersToFloorMap>[0]);
  } finally {
    mutableWorld.floorMap = original;
  }
  // Give the barrier-free clone the same hidden-class history (attach then
  // detach) so the two differ only in whether the callbacks fire.
  withoutBarriers.setBarrierLookup(() => false);
  withoutBarriers.setBarrierPointLookup(() => false);
  withoutBarriers.setBarrierLookup(null);
  withoutBarriers.setBarrierPointLookup(null);

  const variants: NamedVariant[] = [
    {
      name: 'WITH-BARR',
      run: (segs) => {
        let sink = 0;
        for (const s of segs) {
          if (hasClearLineOfSight(withBarriers, s.startX, s.startY, s.endX, s.endY)) sink++;
        }
        return sink;
      },
    },
    {
      name: 'NO-BARR',
      run: (segs) => {
        let sink = 0;
        for (const s of segs) {
          if (hasClearLineOfSight(withoutBarriers, s.startX, s.startY, s.endX, s.endY)) sink++;
        }
        return sink;
      },
    },
  ];
  const registry = world.barriers;
  const empty = registry.blockedTiles.size === 0 && registry.ringShapes.size === 0;
  console.log(
    '\n--- DIAGNOSTIC: barrier-overlay share of hasClearLineOfSight ---\n' +
      'Not a proposal — NO-BARR is not shippable. This only sizes the cost.\n' +
      `Barrier registry: ${registry.barriers.size} handle(s), ` +
      `${registry.blockedTiles.size} blocked tile(s), ${registry.ringShapes.size} ring shape(s).\n` +
      (empty
        ? 'Registry is EMPTY -> both variants sample identically; this measures the\n' +
          'overhead of consulting an empty overlay, NOT the cost of live barriers.\n'
        : 'Registry is NON-EMPTY -> variants diverge (blocked segments exit early),\n' +
          'so the measured share is a LOWER bound on the barrier cost.\n') +
      `Sink counts (equal => identical sampling): close ` +
      `${variants[0]!.run(close)} vs ${variants[1]!.run(close)}, waypoint ` +
      `${variants[0]!.run(waypoint)} vs ${variants[1]!.run(waypoint)}.`,
  );
  runPanel('Barrier share — close approach', close, variants, rounds);
  runPanel('Barrier share — waypoint', waypoint, variants, rounds);
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const noBarriers = process.argv.includes('--no-barriers');
  const rounds = Number(positional[0] ?? DEFAULT_ROUNDS);
  if (!Number.isFinite(rounds) || rounds <= 0) {
    throw new Error(`bench-line-of-sight: invalid round count "${positional[0]}"`);
  }

  console.log('Building a real Floor-1 map (headless warmup run)...');
  const world = await buildFloorOneWorld(1);
  const real = world.floorMap as FloorMap;
  console.log(
    `Floor 1: ${real.tileMap.width}x${real.tileMap.height} tiles, ${real.config.tileSizeFt} ft/tile.`,
  );

  /*
   * Both timed maps are clones of the real one, and BOTH get the same barrier
   * configuration.
   *
   * This is not optional. The real Floor-1 map has live barrier lookups
   * installed (`attachBarriersToFloorMap`), and `isPassableAt` calls both of
   * them. An earlier revision of this bench timed the real map against a bare
   * clone, so one side ran the barrier callbacks and the other short-circuited
   * on `barrierLookup === null` — which flipped the reported result by ~1.6x
   * and had nothing to do with the change under test. Delegating through
   * `real.hasBarrierAt*` costs one extra indirection, paid identically by both
   * variants, and keeps the field-write sequence (and therefore the hidden
   * class) identical too.
   *
   * `--no-barriers` leaves both maps barrier-free. That is NOT production
   * shaped. It is the most favourable setting this harness can construct for
   * the allocation change — with the barrier callbacks gone, the tile
   * conversion is the largest remaining part of `isPassableAt` — but it is not
   * a proven theoretical maximum, since the harness confounds listed in the
   * file header still apply.
   */
  const barrierTile = (tileX: number, tileY: number): boolean =>
    real.hasBarrierAtTile(tileX, tileY);
  const barrierPoint = (xFt: number, yFt: number): boolean => real.hasBarrierAtPoint(xFt, yFt);
  const attach = (m: FloorMap): void => {
    if (noBarriers) return;
    m.setBarrierLookup(barrierTile);
    m.setBarrierPointLookup(barrierPoint);
  };
  const realMap = cloneAs(FloorMap, real);
  const scalarMap = cloneAs(FloorMapScalar, real);
  attach(realMap);
  attach(scalarMap);
  console.log(
    noBarriers
      ? 'Barrier lookups: DETACHED on both maps (upper-bound mode, not production shaped).'
      : 'Barrier lookups: attached identically to both maps (production shaped).',
  );

  const close = buildSegments(real, CLOSE_SEGMENTS, CLOSE_APPROACH_DIRECT_FT, 0x105e, 'close');
  const waypoint = buildSegments(real, WAYPOINT_SEGMENTS, WAYPOINT_MAX_FT, 0x1057, 'waypoint');

  const variants: NamedVariant[] = [
    {
      name: 'SHIPPED',
      run: (segs) => {
        let sink = 0;
        for (const s of segs) {
          if (shippedLoopOnRealMap(realMap, s.startX, s.startY, s.endX, s.endY)) sink++;
        }
        return sink;
      },
    },
    {
      name: 'SCALAR-MAP',
      run: (segs) => {
        let sink = 0;
        for (const s of segs) {
          if (shippedLoopOnScalarMap(scalarMap, s.startX, s.startY, s.endX, s.endY)) sink++;
        }
        return sink;
      },
    },
    {
      name: 'SCALAR-BOTH',
      run: (segs) => {
        let sink = 0;
        for (const s of segs) {
          if (candidateLoop(scalarMap, s.startX, s.startY, s.endX, s.endY)) sink++;
        }
        return sink;
      },
    },
  ];

  runPanel(`Close approach (<= ${CLOSE_APPROACH_DIRECT_FT} ft)`, close, variants, rounds);
  runPanel(`Waypoint smoothing (<= ${WAYPOINT_MAX_FT} ft)`, waypoint, variants, rounds);

  console.log(
    '\nSCALAR-MAP = allocation-free isPassableAt only. SCALAR-BOTH adds the loop fix.\n' +
      'Report the WORST round and a range across >=2 process invocations.',
  );

  if (process.argv.includes('--barrier-share')) {
    runBarrierShareDiagnostic(world, real, close, waypoint, rounds);
  }

  /*
   * Equivalence AND the shipped-copy drift guard both run AFTER timing,
   * deliberately.
   *
   * Both need recording subclasses, and feeding a second receiver map into a
   * variant makes that variant's inline caches polymorphic. Running them first
   * therefore penalises exactly the variants they touch — an earlier revision
   * of this bench did that and made the one variant it left monomorphic look
   * ~1.3x better than it was. Timing first keeps every timed call site
   * monomorphic; the checks then pollute only themselves.
   *
   * The cost of ordering it this way: a drift failure is reported after the
   * (now meaningless) numbers rather than before. The exit code still fails,
   * and the message says to discard them.
   */
  const recReal = cloneAs(RecordingRealMap, real);
  const recScalar = cloneAs(RecordingScalarMap, real);
  attach(recReal);
  attach(recScalar);
  const oracle = [
    ...edgeCaseSegments(real),
    ...buildSegments(real, 4000, CLOSE_APPROACH_DIRECT_FT, 0x0a11c105, 'oracle-close'),
    ...buildSegments(real, 4000, WAYPOINT_MAX_FT, 0x0a11fa12, 'oracle-far'),
  ];

  const drift = checkShippedCopiesMatchReal(recReal, oracle);
  if (drift) {
    console.error(
      `\n❌ DISCARD THE NUMBERS ABOVE. A local SHIPPED copy has drifted from\n` +
        `   hasClearLineOfSight on ${drift}\n` +
        '   Update shippedLoopOnRealMap/shippedLoopOnScalarMap before trusting any timing.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `\n✅ Drift guard: ${oracle.length} segments — both local SHIPPED copies match\n` +
      '   hasClearLineOfSight on result AND ordered probe trace.',
  );

  const failure = checkEquivalence(recReal, recScalar, oracle);
  if (failure) {
    console.error(`\n❌ EQUIVALENCE FAILED on ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\n✅ Equivalence: ${oracle.length} segments — identical result AND identical ordered probe trace.`,
  );
}

await main();
