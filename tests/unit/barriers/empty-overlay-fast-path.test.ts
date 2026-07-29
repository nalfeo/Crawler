/**
 * Regression suite for the empty-barrier-overlay fast path.
 *
 * `FloorMap.hasBarrierAtTile` / `hasBarrierAtPoint` skip their installed lookup
 * closure entirely when the presence source handed to them by
 * `attachBarriersToFloorMap` reports an empty backing collection. On a Floor-1
 * headless run those two methods are called 19.4 M / 14.8 M times and return
 * `true` zero times, so that skip is the whole optimization.
 *
 * **This file is the load-bearing correctness gate for that skip.** The
 * Floor-1 `RunStats` fingerprint cannot catch a broken fast path, because
 * Floor 1 raises no barriers at all — a gate that wrongly answered "empty"
 * would produce a byte-identical fingerprint while silently making every
 * barrier in the game non-solid.
 *
 * Every test therefore raises a REAL barrier through the real registry
 * mutators AFTER wiring is attached (the mid-run case), and asserts it blocks.
 * The tile and point halves are exercised INDEPENDENTLY — with the other
 * collection empty — so an implementation that crossed the wires (gating the
 * point lookup on `blockedTiles.size`, or vice versa) fails here even though a
 * both-barriers-live test would pass.
 *
 * Mutation proof (see the handoff): deleting either `presence !== null &&`
 * guard so the gate always fires turns the "blocks" assertions red; deleting
 * the `size === 0` conditions so the gate never fires turns the
 * "lookup is skipped" assertions red.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  attachBarriersToFloorMap,
  createBarrierRegistry,
  createPolyBarrier,
  createRingWallBarrier,
  dropBarrier,
} from '../../../src/core/barriers/index.js';
import { FloorMap } from '../../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../../src/core/map/RoomGraph.js';
import { TileMap } from '../../../src/core/map/TileMap.js';
import { BiomeType, TilePresets, type MapConfig } from '../../../src/shared/map-types.js';

const W = 16;
const H = 16;
const TILE_FT = 4;

/** Build a 16×16 all-floor map with a walled border. */
function makeOpenMap(): FloorMap {
  const config: MapConfig = {
    widthTiles: W,
    heightTiles: H,
    tileSizeFt: TILE_FT,
    biome: BiomeType.DUNGEON,
    seed: 1,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(W, H);
  tileMap.fill(TilePresets.FLOOR);
  for (let x = 0; x < W; x += 1) {
    tileMap.flags[x] = TilePresets.WALL;
    tileMap.flags[(H - 1) * W + x] = TilePresets.WALL;
  }
  for (let y = 0; y < H; y += 1) {
    tileMap.flags[y * W] = TilePresets.WALL;
    tileMap.flags[y * W + (W - 1)] = TilePresets.WALL;
  }
  return new FloorMap(config, tileMap, new RoomGraph(), new Uint8Array(W * H), { x: 1, y: 1 });
}

function makeBarrierWorld() {
  const floorMap = makeOpenMap();
  const world = { floorMap, barriers: createBarrierRegistry() };
  attachBarriersToFloorMap(world);
  return world;
}

/** Centre of tile `(tx, ty)` in feet. */
const centreFt = (t: number): number => t * TILE_FT + TILE_FT / 2;

describe('empty-barrier-overlay fast path — the skip is real', () => {
  it('skips both lookup closures while the registry is empty', () => {
    const floorMap = makeOpenMap();
    const world = { floorMap, barriers: createBarrierRegistry() };
    attachBarriersToFloorMap(world);

    // Re-install spies THROUGH the same wiring contract (lookup + presence),
    // so we observe exactly what production installs.
    const tileSpy = vi.fn(() => false);
    const pointSpy = vi.fn(() => false);
    floorMap.setBarrierLookup(tileSpy, world);
    floorMap.setBarrierPointLookup(pointSpy, world);

    expect(floorMap.hasBarrierAtTile(5, 5)).toBe(false);
    expect(floorMap.hasBarrierAtPoint(centreFt(5), centreFt(5))).toBe(false);
    expect(floorMap.isPassableAt(centreFt(5), centreFt(5))).toBe(true);

    expect(tileSpy).not.toHaveBeenCalled();
    expect(pointSpy).not.toHaveBeenCalled();
  });

  it('invokes the lookup again as soon as a barrier exists', () => {
    const floorMap = makeOpenMap();
    const world = { floorMap, barriers: createBarrierRegistry() };
    attachBarriersToFloorMap(world);

    const tileSpy = vi.fn(() => false);
    const pointSpy = vi.fn(() => false);
    floorMap.setBarrierLookup(tileSpy, world);
    floorMap.setBarrierPointLookup(pointSpy, world);

    createPolyBarrier(world, [world.floorMap.tileMap.index(9, 9)], 'fence');
    createRingWallBarrier(world, centreFt(3), centreFt(3), 6, 1, 'fence');

    floorMap.hasBarrierAtTile(5, 5);
    floorMap.hasBarrierAtPoint(centreFt(5), centreFt(5));

    expect(tileSpy).toHaveBeenCalledTimes(1);
    expect(pointSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * The two tests above re-install spy lookups *through* the wiring contract, so
 * they prove `FloorMap`'s gate works — but they would still pass if
 * `attachBarriersToFloorMap` stopped passing `world` as the presence source and
 * the shipped optimization silently vanished. These tests close that hole by
 * observing the closures **that production actually installed**, never
 * re-installing anything.
 *
 * Observation points are chosen so the gate and the closure touch *different*
 * members:
 *   - tile half:  the gate reads `blockedTiles.size`; only the closure calls
 *                 `blockedTiles.has`. Gate active => `has` call count 0.
 *   - point half: both read `ringShapes.size`, so with a barrier live the gate
 *                 is worth exactly one extra `size` read (2 vs 1). In the
 *                 *empty* case the two paths are observationally identical (the
 *                 closure's own `size === 0` check also reads it exactly once),
 *                 so no assertion is made there — a test that could not fail is
 *                 worse than no test. The empty-case skip for the point half is
 *                 covered behaviourally by the `vi.fn` spy test above.
 */
describe('attachBarriersToFloorMap installs the presence source (wiring coverage)', () => {
  function instrumentedWorld() {
    const counts = { tileHas: 0, ringSize: 0 };
    const registry = createBarrierRegistry();
    // Proxies must forward with the *target* as receiver: Set/Map methods and
    // the `size` getter read internal slots that a Proxy does not carry.
    const blockedTiles = new Proxy(registry.blockedTiles, {
      get(target, prop) {
        if (prop === 'has') {
          return (value: number): boolean => {
            counts.tileHas += 1;
            return target.has(value);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ringShapes = new Proxy(registry.ringShapes, {
      get(target, prop) {
        if (prop === 'size') {
          counts.ringSize += 1;
          return target.size;
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const floorMap = makeOpenMap();
    const world = { floorMap, barriers: { ...registry, blockedTiles, ringShapes } };
    attachBarriersToFloorMap(world);
    return { world, floorMap, counts };
  }

  it('gates the production tile closure: blockedTiles.has is never reached while empty', () => {
    const { floorMap, counts } = instrumentedWorld();
    expect(floorMap.hasBarrierAtTile(5, 5)).toBe(false);
    expect(counts.tileHas).toBe(0);
  });

  it('reaches the production tile closure once a tile barrier exists', () => {
    const { world, floorMap, counts } = instrumentedWorld();
    createPolyBarrier(world, [floorMap.tileMap.index(9, 9)], 'fence');
    expect(floorMap.hasBarrierAtTile(9, 9)).toBe(true);
    expect(counts.tileHas).toBe(1);
  });

  it('gates the production point closure: the gate itself adds a ringShapes.size read', () => {
    const { world, floorMap, counts } = instrumentedWorld();
    createRingWallBarrier(world, centreFt(8), centreFt(8), 8, 2, 'forcefield');
    counts.ringSize = 0;
    expect(floorMap.hasBarrierAtPoint(centreFt(8) + 8, centreFt(8))).toBe(true);
    // 2 = the gate's read + `isBarrierPointBlocked`'s own `size === 0` check.
    // Without the presence source only the closure runs, so this is 1.
    expect(counts.ringSize).toBe(2);
  });
});

describe('barrier still blocks — tile half, raised mid-run', () => {
  it('blocks a tile barrier created after wiring, with zero ring shapes', () => {
    const world = makeBarrierWorld();
    const { floorMap } = world;
    const tx = 7;
    const ty = 7;
    const idx = floorMap.tileMap.index(tx, ty);

    expect(floorMap.hasBarrierAtTile(tx, ty)).toBe(false);
    expect(floorMap.isPassableAt(centreFt(tx), centreFt(ty))).toBe(true);

    const handle = createPolyBarrier(world, [idx], 'fence');

    // The other collection stays empty — this isolates the tile gate, so a
    // crossed-wire implementation gating tiles on `ringShapes.size` fails.
    expect(world.barriers.ringShapes.size).toBe(0);
    expect(world.barriers.blockedTiles.size).toBe(1);

    expect(floorMap.hasBarrierAtTile(tx, ty)).toBe(true);
    expect(floorMap.isPassableAt(centreFt(tx), centreFt(ty))).toBe(false);
    // The point half must NOT claim a block — no analytic shape exists.
    expect(floorMap.hasBarrierAtPoint(centreFt(tx), centreFt(ty))).toBe(false);

    dropBarrier(world, handle);
    expect(world.barriers.blockedTiles.size).toBe(0);
    expect(floorMap.hasBarrierAtTile(tx, ty)).toBe(false);
    expect(floorMap.isPassableAt(centreFt(tx), centreFt(ty))).toBe(true);
  });
});

describe('barrier still blocks — analytic ring-wall half, raised mid-run', () => {
  it('blocks a ring wall created after wiring, with zero blocked tiles', () => {
    const world = makeBarrierWorld();
    const { floorMap } = world;
    const cx = centreFt(8);
    const cy = centreFt(8);
    const outerFt = 10;
    const thicknessFt = 2;
    // A point inside the annulus band (radius 9 ft from centre, band is 8–10).
    const onWallX = cx + 9;
    const onWallY = cy;

    expect(floorMap.hasBarrierAtPoint(onWallX, onWallY)).toBe(false);
    expect(floorMap.isPassableAt(onWallX, onWallY)).toBe(true);

    const handle = createRingWallBarrier(world, cx, cy, outerFt, thicknessFt, 'forcefield');

    // A ring WALL owns no tiles by design — `blockedTiles` stays empty. This is
    // precisely the case a `blockedTiles`-gated point lookup would break.
    expect(world.barriers.blockedTiles.size).toBe(0);
    expect(world.barriers.ringShapes.size).toBe(1);

    expect(floorMap.hasBarrierAtPoint(onWallX, onWallY)).toBe(true);
    expect(floorMap.isPassableAt(onWallX, onWallY)).toBe(false);
    // Interior of the ring stays passable — the band is what is solid.
    expect(floorMap.isPassableAt(cx, cy)).toBe(true);
    // The tile half must NOT claim a block — the ring wall owns no tiles.
    expect(floorMap.hasBarrierAtTile(8, 8)).toBe(false);

    dropBarrier(world, handle);
    expect(world.barriers.ringShapes.size).toBe(0);
    expect(floorMap.hasBarrierAtPoint(onWallX, onWallY)).toBe(false);
    expect(floorMap.isPassableAt(onWallX, onWallY)).toBe(true);
  });
});

describe('presence source freshness', () => {
  it('follows a wholesale world.barriers reassignment', () => {
    const world = makeBarrierWorld();
    const { floorMap } = world;
    const tx = 6;
    const ty = 6;

    createPolyBarrier(world, [floorMap.tileMap.index(tx, ty)], 'fence');
    expect(floorMap.hasBarrierAtTile(tx, ty)).toBe(true);

    // Labs swap the whole registry (src/labs/ai-runner-lab/scenario-presets.ts).
    // The gate reads through `world`, so it must see the new empty registry
    // AND the barriers subsequently raised in it — without re-attaching.
    world.barriers = createBarrierRegistry();
    expect(floorMap.hasBarrierAtTile(tx, ty)).toBe(false);

    createPolyBarrier(world, [floorMap.tileMap.index(tx, ty)], 'fence');
    expect(floorMap.hasBarrierAtTile(tx, ty)).toBe(true);
    expect(floorMap.isPassableAt(centreFt(tx), centreFt(ty))).toBe(false);
  });

  it('never caches a per-call answer across mutations', () => {
    const world = makeBarrierWorld();
    const { floorMap } = world;
    const tx = 4;
    const ty = 4;
    const idx = floorMap.tileMap.index(tx, ty);

    for (let i = 0; i < 3; i += 1) {
      expect(floorMap.hasBarrierAtTile(tx, ty)).toBe(false);
      const handle = createPolyBarrier(world, [idx], 'fence');
      expect(floorMap.hasBarrierAtTile(tx, ty)).toBe(true);
      dropBarrier(world, handle);
      expect(floorMap.hasBarrierAtTile(tx, ty)).toBe(false);
    }
  });
});

describe('lookups installed WITHOUT a presence source keep the old behaviour', () => {
  it('always invokes a hand-installed lookup, even with an empty registry', () => {
    const floorMap = makeOpenMap();
    const world = { floorMap, barriers: createBarrierRegistry() };
    attachBarriersToFloorMap(world);

    // No presence argument — e.g. tests/unit/boss-spawn-placement.test.ts.
    const tileSpy = vi.fn(() => true);
    const pointSpy = vi.fn(() => true);
    floorMap.setBarrierLookup(tileSpy);
    floorMap.setBarrierPointLookup(pointSpy);

    expect(world.barriers.blockedTiles.size).toBe(0);
    expect(world.barriers.ringShapes.size).toBe(0);
    expect(floorMap.hasBarrierAtTile(5, 5)).toBe(true);
    expect(floorMap.hasBarrierAtPoint(centreFt(5), centreFt(5))).toBe(true);
    expect(tileSpy).toHaveBeenCalledTimes(1);
    expect(pointSpy).toHaveBeenCalledTimes(1);
  });

  it('clears a stale presence source when a new lookup is installed', () => {
    const floorMap = makeOpenMap();
    const world = { floorMap, barriers: createBarrierRegistry() };
    attachBarriersToFloorMap(world);

    // Registry empty -> the wired lookup is gated off...
    expect(floorMap.hasBarrierAtTile(5, 5)).toBe(false);
    // ...but replacing the lookup must drop the presence source with it,
    // otherwise the new (unrelated) lookup would be silently suppressed.
    floorMap.setBarrierLookup(() => true);
    expect(floorMap.hasBarrierAtTile(5, 5)).toBe(true);

    floorMap.setBarrierPointLookup(() => true);
    expect(floorMap.hasBarrierAtPoint(centreFt(5), centreFt(5))).toBe(true);
  });

  it('detaching with null still reports no barrier', () => {
    const world = makeBarrierWorld();
    const { floorMap } = world;
    createPolyBarrier(world, [floorMap.tileMap.index(5, 5)], 'fence');
    expect(floorMap.hasBarrierAtTile(5, 5)).toBe(true);

    floorMap.setBarrierLookup(null);
    floorMap.setBarrierPointLookup(null);
    expect(floorMap.hasBarrierAtTile(5, 5)).toBe(false);
    expect(floorMap.hasBarrierAtPoint(centreFt(5), centreFt(5))).toBe(false);
  });
});
