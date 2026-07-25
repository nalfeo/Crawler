/**
 * Interleaved A/B microbench + equivalence oracle for `fovSystem`.
 *
 * Why this exists: FOV is still a performance-sensitive pass (~1.88% total in
 * headless sim per `npm run perf:profile`), and any optimization there must be
 * proven (a) faster and (b) *byte-identical* in the visibility it
 * produces, because visibility feeds enemy AI and therefore the whole downstream
 * simulation.
 *
 * Design (per the perf-optimizer skill's "commit the bench" rule):
 *   - BASELINE is the pre-optimization implementation, inlined verbatim below.
 *   - CURRENT is the live `fovSystem` export.
 *   - Correctness: both variants are replayed over the same deterministic
 *     position walk on freshly-built worlds; the resulting `visible` /
 *     `discovered` bitmaps and tile-level caches are hashed and compared.
 *   - Timing: rounds ALTERNATE which variant runs first, in ONE process, so JIT
 *     warmup and machine noise hit both sides symmetrically. (A cross-process
 *     A/B previously produced a 4.5x number that same-process measurement
 *     corrected to ~3x — never trust cross-process perf deltas.)
 *
 * Usage:
 *   npx tsx scripts/agent/perf/bench-fov.ts [positions] [rounds]
 */

import { FOV } from 'rot-js';
import { query } from 'bitecs';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { fovSystem } from '../../../src/core/systems/fovSystem.js';
import { Player, Position } from '../../../src/core/components.js';
import type { GameWorld } from '../../../src/core/world.js';
import { TileFlags } from '../../../src/shared/map-types.js';

const DEFAULT_POSITIONS = 400;
const DEFAULT_ROUNDS = 9;
const WARMUP_RUN_FRAMES = 2500;
const DEFAULT_FOV_RADIUS = 25;

/* ------------------------------------------------------------------ *
 * BASELINE — verbatim copy of fovSystem before the optimization.
 * Kept in the bench (not in src) so the comparison stays reproducible
 * without shipping dead code in the game.
 * ------------------------------------------------------------------ */

interface BaselineCacheKey {
  originX: number;
  originY: number;
  subFactor: number;
  transparencyRevision: number;
}

const baselineCacheByMap = new WeakMap<GameWorld['floorMap'] & object, BaselineCacheKey>();

function fovSystemBaseline(world: GameWorld): void {
  const floorMap = world.floorMap;
  if (!floorMap) return;

  const players = query(world.ecs, [Player, Position]);
  if (players.length === 0) return;

  const playerEid = players[0]!;
  const px = world.stores.position.x[playerEid] ?? 0;
  const py = world.stores.position.y[playerEid] ?? 0;

  const origin = floorMap.worldToSubTile(px, py);
  const originTile = floorMap.worldToTile(px, py);
  const sf = floorMap.subFactor;
  const transparencyRevision = floorMap.tileMap.transparencyRevision;
  const cached = baselineCacheByMap.get(floorMap);
  if (
    cached?.originX === origin.x &&
    cached.originY === origin.y &&
    cached.subFactor === sf &&
    cached.transparencyRevision === transparencyRevision
  ) {
    return;
  }

  floorMap.clearVisibility();

  const lightPasses = (hx: number, hy: number): boolean =>
    floorMap.tileMap.isTransparent(Math.floor(hx / sf), Math.floor(hy / sf));

  const fov = new FOV.RecursiveShadowcasting(lightPasses);

  const seamCache = new Map<number, boolean>();
  const mapWidth = floorMap.tileMap.width;

  fov.compute(
    origin.x,
    origin.y,
    DEFAULT_FOV_RADIUS * sf,
    (hx: number, hy: number, _r: number, visibility: number) => {
      if (visibility > 0) {
        const tx = Math.floor(hx / sf);
        const ty = Math.floor(hy / sf);
        const cacheKey = ty * mapWidth + tx;
        let seamBlocked = seamCache.get(cacheKey);
        if (seamBlocked === undefined) {
          seamBlocked = floorMap.tileMap.hasBlockedCornerSeam(originTile.x, originTile.y, tx, ty);
          seamCache.set(cacheKey, seamBlocked);
        }
        if (seamBlocked) {
          return;
        }
        floorMap.setVisible(hx, hy);
        floorMap.setDiscovered(hx, hy);
      }
    },
  );
  baselineCacheByMap.set(floorMap, {
    originX: origin.x,
    originY: origin.y,
    subFactor: sf,
    transparencyRevision,
  });
}

/* ------------------------------------------------------------------ *
 * ABLATION — the stateless subset only.
 *
 * Answers "does the shared per-map scratch actually earn its correctness
 * risk?". This variant keeps the two allocation-free wins that need NO
 * cross-frame mutable state (the fused visible+discovered write and the
 * integer-math transparency probe) but still allocates a fresh rot-js
 * instance, fresh closures, and a fresh seam `Map` every pass, exactly like
 * BASELINE. The gap between ABLATION and CURRENT is the isolated value of the
 * reusable state.
 * ------------------------------------------------------------------ */

const ablationCacheByMap = new WeakMap<GameWorld['floorMap'] & object, BaselineCacheKey>();

function fovSystemAblation(world: GameWorld): void {
  const floorMap = world.floorMap;
  if (!floorMap) return;

  const players = query(world.ecs, [Player, Position]);
  if (players.length === 0) return;

  const playerEid = players[0]!;
  const px = world.stores.position.x[playerEid] ?? 0;
  const py = world.stores.position.y[playerEid] ?? 0;

  const origin = floorMap.worldToSubTile(px, py);
  const originTile = floorMap.worldToTile(px, py);
  const sf = floorMap.subFactor;
  const transparencyRevision = floorMap.tileMap.transparencyRevision;
  const cached = ablationCacheByMap.get(floorMap);
  if (
    cached?.originX === origin.x &&
    cached.originY === origin.y &&
    cached.subFactor === sf &&
    cached.transparencyRevision === transparencyRevision
  ) {
    return;
  }

  floorMap.clearVisibility();

  const tileMap = floorMap.tileMap;
  const tileW = tileMap.width;
  const tileH = tileMap.height;
  const flags = tileMap.flags;
  const subW = floorMap.subWidth;
  const subH = floorMap.subHeight;

  const fov = new FOV.RecursiveShadowcasting((hx: number, hy: number): boolean => {
    if (hx < 0 || hy < 0) return false;
    const tx = (hx / sf) | 0;
    const ty = (hy / sf) | 0;
    if (tx >= tileW || ty >= tileH) return false;
    return (flags[ty * tileW + tx]! & TileFlags.TRANSPARENT) !== 0;
  });

  const seamCache = new Map<number, boolean>();
  fov.compute(
    origin.x,
    origin.y,
    DEFAULT_FOV_RADIUS * sf,
    (hx: number, hy: number, _r: number, visibility: number) => {
      if (visibility <= 0) return;
      if (hx < 0 || hx >= subW || hy < 0 || hy >= subH) return;
      const tx = (hx / sf) | 0;
      const ty = (hy / sf) | 0;
      const cacheKey = ty * tileW + tx;
      let seamBlocked = seamCache.get(cacheKey);
      if (seamBlocked === undefined) {
        seamBlocked = tileMap.hasBlockedCornerSeam(originTile.x, originTile.y, tx, ty);
        seamCache.set(cacheKey, seamBlocked);
      }
      if (seamBlocked) return;
      floorMap.markVisibleAndDiscovered(hx, hy);
    },
  );
  ablationCacheByMap.set(floorMap, {
    originX: origin.x,
    originY: origin.y,
    subFactor: sf,
    transparencyRevision,
  });
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/** Build a real Floor-1 world and record the player's world positions. */
async function buildWorld(
  seed: number,
): Promise<{ world: GameWorld; walk: Array<{ x: number; y: number }> }> {
  const walk: Array<{ x: number; y: number }> = [];
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
          const players = query(w.ecs, [Player, Position]);
          const eid = players[0];
          if (eid === undefined) return;
          walk.push({ x: w.stores.position.x[eid] ?? 0, y: w.stores.position.y[eid] ?? 0 });
        },
      ],
    },
  });

  if (!captured) throw new Error('bench-fov: headless run did not surface a world');
  if (!captured.floorMap) throw new Error('bench-fov: captured world has no floorMap');
  return { world: captured, walk };
}

/**
 * Pick `count` positions from the recorded walk that land on DISTINCT sub-tiles,
 * so every benched call is a real FOV recompute rather than a cache hit.
 */
function distinctSubTilePositions(
  world: GameWorld,
  walk: ReadonlyArray<{ x: number; y: number }>,
  count: number,
): Array<{ x: number; y: number }> {
  const floorMap = world.floorMap!;
  const seen = new Set<number>();
  const out: Array<{ x: number; y: number }> = [];
  for (const p of walk) {
    const st = floorMap.worldToSubTile(p.x, p.y);
    const key = st.y * floorMap.subWidth + st.x;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= count) break;
  }
  if (out.length === 0) throw new Error('bench-fov: no distinct sub-tile positions recorded');
  return out;
}

/**
 * Reset a freshly-built world to a blank visibility state.
 *
 * The warmup run simulates 2 500 frames using whichever `fovSystem` is live, so
 * both comparison worlds arrive pre-populated with CURRENT-produced `discovered`
 * bits and a warm CURRENT cache. Replaying from that state would let a CURRENT
 * bug hide inside the shared prefix. Zeroing every bitmap and forcing a
 * transparency-revision bump puts both variants on a provably identical,
 * cache-cold footing.
 */
function decontaminate(world: GameWorld): void {
  const floorMap = world.floorMap!;
  // revealAll() sets the clear bbox to the whole map, so clearVisibility()
  // then zeroes `visible` + `tileVisible` completely rather than just the bbox.
  floorMap.revealAll();
  floorMap.clearVisibility();
  floorMap.clearDiscovered();

  // Bump transparencyRevision without changing any flag bit, invalidating the
  // origin/revision early-return in BOTH variants symmetrically.
  const tileMap = floorMap.tileMap;
  const original = tileMap.flags[0]!;
  tileMap.setFlags(0, 0, original ^ TileFlags.TRANSPARENT);
  tileMap.setFlags(0, 0, original);
}

function setPlayerPosition(world: GameWorld, x: number, y: number): void {
  const eid = query(world.ecs, [Player, Position])[0]!;
  world.stores.position.x[eid] = x;
  world.stores.position.y[eid] = y;
}

/**
 * Full visibility state as raw bytes: both sub-tile bitmaps plus the derived
 * tile-level caches probed through the public API (they are private, so a
 * divergence there could otherwise hide behind matching bitmaps).
 *
 * Compared byte-for-byte rather than hashed — a 32-bit hash can collide, and
 * "byte-identical" is the claim this bench exists to substantiate.
 */
function snapshotVisibility(world: GameWorld, into: Uint8Array): Uint8Array {
  const floorMap = world.floorMap!;
  const vis = floorMap.visible;
  const disc = floorMap.discovered;
  let o = 0;
  into.set(vis, o);
  o += vis.length;
  into.set(disc, o);
  o += disc.length;
  for (let ty = 0; ty < floorMap.config.heightTiles; ty++) {
    for (let tx = 0; tx < floorMap.config.widthTiles; tx++) {
      into[o++] = (floorMap.isVisible(tx, ty) ? 1 : 0) | (floorMap.isDiscovered(tx, ty) ? 2 : 0);
    }
  }
  return into;
}

function snapshotSize(world: GameWorld): number {
  const floorMap = world.floorMap!;
  return (
    floorMap.visible.length +
    floorMap.discovered.length +
    floorMap.config.widthTiles * floorMap.config.heightTiles
  );
}

/**
 * Step both variants through the same walk in lockstep, comparing the FULL
 * state byte-for-byte after every position. Returns the index of the first
 * divergence, or -1 when every state matched.
 */
function compareReplay(
  worldA: GameWorld,
  worldB: GameWorld,
  positions: ReadonlyArray<{ x: number; y: number }>,
  variantA: (w: GameWorld) => void,
  variantB: (w: GameWorld) => void,
): { mismatch: number; detail: string } {
  const size = snapshotSize(worldA);
  if (snapshotSize(worldB) !== size) {
    return { mismatch: 0, detail: 'world snapshots have different sizes' };
  }
  const bufA = new Uint8Array(size);
  const bufB = new Uint8Array(size);

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i]!;
    setPlayerPosition(worldA, p.x, p.y);
    variantA(worldA);
    setPlayerPosition(worldB, p.x, p.y);
    variantB(worldB);

    snapshotVisibility(worldA, bufA);
    snapshotVisibility(worldB, bufB);
    for (let b = 0; b < size; b++) {
      if (bufA[b] !== bufB[b]) {
        return {
          mismatch: i,
          detail: `byte ${b}: baseline=${bufA[b]} current=${bufB[b]} at world (${p.x}, ${p.y})`,
        };
      }
    }
  }
  return { mismatch: -1, detail: '' };
}

function timeVariant(
  world: GameWorld,
  positions: ReadonlyArray<{ x: number; y: number }>,
  variant: (w: GameWorld) => void,
): number {
  const start = process.hrtime.bigint();
  for (const p of positions) {
    setPlayerPosition(world, p.x, p.y);
    variant(world);
  }
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

async function main(): Promise<void> {
  const positionCount = Number(process.argv[2] ?? DEFAULT_POSITIONS);
  const rounds = Number(process.argv[3] ?? DEFAULT_ROUNDS);
  if (!Number.isFinite(positionCount) || positionCount <= 0) {
    throw new Error(`bench-fov: invalid position count "${process.argv[2]}"`);
  }
  if (!Number.isFinite(rounds) || rounds <= 0) {
    throw new Error(`bench-fov: invalid round count "${process.argv[3]}"`);
  }

  console.log('Building Floor-1 world (headless warmup run)...');
  const seed = 1;
  const built = await buildWorld(seed);
  const positions = distinctSubTilePositions(built.world, built.walk, positionCount);
  console.log(
    `Recorded ${built.walk.length} frames -> ${positions.length} distinct sub-tile origins.\n`,
  );

  // ---- Correctness: independent worlds, same walk, byte-exact comparison. ----
  const worldA = (await buildWorld(seed)).world;
  const worldB = (await buildWorld(seed)).world;
  decontaminate(worldA);
  decontaminate(worldB);
  const { mismatch, detail } = compareReplay(
    worldA,
    worldB,
    positions,
    fovSystemBaseline,
    fovSystem,
  );

  if (mismatch >= 0) {
    console.error(`❌ EQUIVALENCE FAILED at position ${mismatch}: ${detail}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ Equivalence: ${positions.length}/${positions.length} states byte-identical.`);

  // The ablation must be equivalent too, otherwise the attribution is garbage.
  const worldC = (await buildWorld(seed)).world;
  const worldD = (await buildWorld(seed)).world;
  decontaminate(worldC);
  decontaminate(worldD);
  const ablationCheck = compareReplay(
    worldC,
    worldD,
    positions,
    fovSystemBaseline,
    fovSystemAblation,
  );
  if (ablationCheck.mismatch >= 0) {
    console.error(
      `❌ ABLATION EQUIVALENCE FAILED at position ${ablationCheck.mismatch}: ${ablationCheck.detail}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`✅ Ablation equivalence: ${positions.length}/${positions.length} byte-identical.`);

  // ---- Timing: interleaved, rotating lead, one process. ----
  const timingWorld = (await buildWorld(seed)).world;
  const baselineMs: number[] = [];
  const ablationMs: number[] = [];
  const currentMs: number[] = [];

  // Warm all paths before measuring.
  timeVariant(timingWorld, positions, fovSystemBaseline);
  timeVariant(timingWorld, positions, fovSystemAblation);
  timeVariant(timingWorld, positions, fovSystem);

  const run = [
    (): void => void baselineMs.push(timeVariant(timingWorld, positions, fovSystemBaseline)),
    (): void => void ablationMs.push(timeVariant(timingWorld, positions, fovSystemAblation)),
    (): void => void currentMs.push(timeVariant(timingWorld, positions, fovSystem)),
  ];

  for (let r = 0; r < rounds; r++) {
    // Rotate which variant leads each round so ordering effects cancel out.
    for (let i = 0; i < run.length; i++) run[(r + i) % run.length]!();
  }

  const n = positions.length;
  const baseMedian = median(baselineMs);
  const ablMedian = median(ablationMs);
  const currMedian = median(currentMs);
  const toUsPerCall = (ms: number): number => (ms * 1000) / n;

  const report = (label: string, samples: number[]): void => {
    console.log(
      `  ${label.padEnd(9)} median ${toUsPerCall(median(samples)).toFixed(1)}  ` +
        `[best ${toUsPerCall(Math.min(...samples)).toFixed(1)}, ` +
        `worst ${toUsPerCall(Math.max(...samples)).toFixed(1)}]`,
    );
  };

  console.log(`\n${rounds} rounds x ${n} FOV recomputes (us/call):`);
  report('BASELINE', baselineMs);
  report('ABLATION', ablationMs);
  report('CURRENT', currentMs);

  /*
   * Paired per-round ratios, not raw distributions.
   *
   * All three variants run inside the same round, so a machine-wide stall
   * inflates every one of them together. Comparing raw min/max across rounds
   * therefore reports "overlapping" for a real, consistent win. The correct
   * statistic for an interleaved design is the within-round ratio: if the
   * WORST round still shows a ratio > 1, the win held on every single round.
   */
  const pairedRatios = (slow: number[], fast: number[]): number[] =>
    slow.map((s, i) => s / fast[i]!);
  const reportPaired = (label: string, ratios: number[]): void => {
    const worst = Math.min(...ratios);
    console.log(
      `  ${label.padEnd(22)} ${median(ratios).toFixed(2)}x median  ` +
        `[worst round ${worst.toFixed(2)}x, best ${Math.max(...ratios).toFixed(2)}x]` +
        `${worst > 1 ? '  ✅ every round' : '  ⚠️ not every round'}`,
    );
  };

  console.log('\n  Paired per-round ratios (immune to machine-wide stalls):');
  reportPaired('ABLATION vs BASELINE', pairedRatios(baselineMs, ablationMs));
  reportPaired('CURRENT  vs ABLATION', pairedRatios(ablationMs, currentMs));
  reportPaired('CURRENT  vs BASELINE', pairedRatios(baselineMs, currentMs));

  console.log(
    `\n  Median-of-medians: ablation ${(baseMedian / ablMedian).toFixed(2)}x, ` +
      `reusable state ${(ablMedian / currMedian).toFixed(2)}x, ` +
      `total ${(baseMedian / currMedian).toFixed(2)}x`,
  );
}

await main();
