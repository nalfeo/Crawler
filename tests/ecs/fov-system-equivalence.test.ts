/**
 * Differential equivalence pins for the optimized `fovSystem`.
 *
 * `fovSystem` was rewritten to reuse per-map scratch state (a `WeakMap`-held
 * rot-js instance + closures, a generation-stamped seam memo, a fused
 * visible+discovered write, and integer sub-tile math). Every one of those is
 * only legitimate if the resulting visibility state is *byte-identical* to the
 * original allocate-per-frame implementation.
 *
 * The reference below is the pre-optimization algorithm, reproduced verbatim,
 * plus the whole-tile wall reveal (opaque tiles are filled across every
 * sub-tile) written in its most naive form. Each test replays the same walk
 * through both and compares the FULL state — `visible`, `discovered`, and the
 * derived tile-level caches — byte for byte.
 *
 * The scenarios deliberately cover the cases a Floor-1 walk does NOT reliably
 * hit: map corners and edges, origins outside the map, corner-seam blocking,
 * every supported `subFactor`, a `subFactor` change mid-life, transparency
 * mutation at a fixed origin, and two worlds sharing one `FloorMap`.
 */

import { describe, it, expect } from 'vitest';
import { addEntity, addComponent, set, query } from 'bitecs';
import { FOV } from 'rot-js';
import { createTestWorld } from '../../tests/helpers/world-factory';
import { fovSystem } from '../../src/core/systems/fovSystem';
import { Player, Position } from '../../src/core/components';
import { FloorMap } from '../../src/core/map/FloorMap';
import { TileMap } from '../../src/core/map/TileMap';
import { RoomGraph } from '../../src/core/map/RoomGraph';
import { TilePresets, BiomeType, TileFlags } from '../../src/shared/map-types';
import type { MapConfig } from '../../src/shared/map-types';
import type { GameWorld } from '../../src/core/world';

const DEFAULT_FOV_RADIUS = 25;
const TILE_FT = 32;

/* ------------------------------------------------------------------ *
 * Reference implementation (pre-optimization fovSystem, verbatim)
 * ------------------------------------------------------------------ */

const referenceOrigins = new WeakMap<
  FloorMap,
  { x: number; y: number; subFactor: number; revision: number }
>();

function fovSystemReference(world: GameWorld): void {
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
  const revision = floorMap.tileMap.transparencyRevision;

  const last = referenceOrigins.get(floorMap);
  if (
    last &&
    last.x === origin.x &&
    last.y === origin.y &&
    last.subFactor === sf &&
    last.revision === revision
  ) {
    return;
  }

  floorMap.clearVisibility();

  const tileMap = floorMap.tileMap;
  const fov = new FOV.RecursiveShadowcasting((hx: number, hy: number) =>
    tileMap.isTransparent(Math.floor(hx / sf), Math.floor(hy / sf)),
  );

  const seamCache = new Map<number, boolean>();
  fov.compute(origin.x, origin.y, DEFAULT_FOV_RADIUS * sf, (hx, hy, _r, visibility) => {
    if (visibility <= 0) return;
    const tx = Math.floor(hx / sf);
    const ty = Math.floor(hy / sf);
    const key = ty * tileMap.width + tx;
    let seamBlocked = seamCache.get(key);
    if (seamBlocked === undefined) {
      seamBlocked = tileMap.hasBlockedCornerSeam(originTile.x, originTile.y, tx, ty);
      seamCache.set(key, seamBlocked);
    }
    if (seamBlocked) return;
    if (!tileMap.isTransparent(tx, ty)) {
      // Whole-tile wall reveal: a seen opaque tile is revealed in full, not
      // only on the sub-tiles a ray landed on. Written naively here (nested
      // loop over per-sub-tile setters) against the optimized row-fill path.
      for (let dy = 0; dy < sf; dy++) {
        for (let dx = 0; dx < sf; dx++) {
          floorMap.setVisible(tx * sf + dx, ty * sf + dy);
          floorMap.setDiscovered(tx * sf + dx, ty * sf + dy);
        }
      }
      return;
    }
    floorMap.setVisible(hx, hy);
    floorMap.setDiscovered(hx, hy);
  });

  referenceOrigins.set(floorMap, { x: origin.x, y: origin.y, subFactor: sf, revision });
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function makeMap(n: number, subFactor: number, paint?: (t: TileMap) => void): FloorMap {
  const config: MapConfig = {
    widthTiles: n,
    heightTiles: n,
    tileSizeFt: TILE_FT,
    biome: BiomeType.ARENA,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      tileMap.flags[y * n + x] =
        x === 0 || x === n - 1 || y === 0 || y === n - 1 ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }
  paint?.(tileMap);
  return new FloorMap(
    config,
    tileMap,
    new RoomGraph(),
    new Uint8Array(n * n),
    { x: 1, y: 1 },
    subFactor,
  );
}

function makeWorldFor(floorMap: FloorMap): GameWorld {
  const w = createTestWorld({ seed: 42 });
  w.floorMap = floorMap;
  const eid = addEntity(w.ecs);
  addComponent(w.ecs, eid, set(Position, { x: 0, y: 0 }));
  addComponent(w.ecs, eid, Player);
  return w;
}

function setPlayer(world: GameWorld, wx: number, wy: number): void {
  const eid = query(world.ecs, [Player, Position])[0]!;
  world.stores.position.x[eid] = wx;
  world.stores.position.y[eid] = wy;
}

/** Full visibility state as bytes, including the private tile-level caches. */
function snapshot(floorMap: FloorMap): Uint8Array {
  const tw = floorMap.config.widthTiles;
  const th = floorMap.config.heightTiles;
  const out = new Uint8Array(floorMap.visible.length + floorMap.discovered.length + tw * th);
  let o = 0;
  out.set(floorMap.visible, o);
  o += floorMap.visible.length;
  out.set(floorMap.discovered, o);
  o += floorMap.discovered.length;
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      out[o++] = (floorMap.isVisible(tx, ty) ? 1 : 0) | (floorMap.isDiscovered(tx, ty) ? 2 : 0);
    }
  }
  return out;
}

/**
 * Replay `walk` through the optimized and reference systems on two independent
 * FloorMaps, asserting byte-identical state after every step.
 */
function assertEquivalent(
  makeFloorMap: () => FloorMap,
  walk: ReadonlyArray<{ x: number; y: number }>,
  mutate?: (floorMap: FloorMap, step: number) => void,
): void {
  const mapA = makeFloorMap();
  const mapB = makeFloorMap();
  const worldA = makeWorldFor(mapA);
  const worldB = makeWorldFor(mapB);

  walk.forEach((p, step) => {
    mutate?.(mapA, step);
    mutate?.(mapB, step);
    setPlayer(worldA, p.x, p.y);
    setPlayer(worldB, p.x, p.y);
    fovSystem(worldA);
    fovSystemReference(worldB);
    expect(Array.from(snapshot(mapA)), `divergence at step ${step} (${p.x}, ${p.y})`).toEqual(
      Array.from(snapshot(mapB)),
    );
  });
}

/** Tile center in world feet. */
const at = (tx: number, ty: number) => ({
  x: tx * TILE_FT + TILE_FT / 2,
  y: ty * TILE_FT + TILE_FT / 2,
});

describe('fovSystem — differential equivalence vs the pre-optimization reference', () => {
  it('matches at every map corner and along all four edges', () => {
    const n = 24;
    const walk = [
      at(1, 1),
      at(n - 2, 1),
      at(1, n - 2),
      at(n - 2, n - 2),
      at(n >> 1, 1),
      at(n >> 1, n - 2),
      at(1, n >> 1),
      at(n - 2, n >> 1),
      at(0, 0),
      at(n - 1, n - 1),
    ];
    assertEquivalent(() => makeMap(n, 2), walk);
  });

  it('matches for origins outside the map (negative and past the far edge)', () => {
    const n = 20;
    // Negative world coords floor to negative tile/sub-tile coords — the case
    // where `Math.floor(v / sf)` and `(v / sf) | 0` disagree.
    const walk = [
      { x: -TILE_FT * 3, y: -TILE_FT * 3 },
      { x: -1, y: -1 },
      { x: -TILE_FT * 0.5, y: TILE_FT * 5 },
      { x: TILE_FT * 5, y: -TILE_FT * 0.5 },
      { x: TILE_FT * (n + 5), y: TILE_FT * (n + 5) },
      { x: TILE_FT * (n + 2), y: TILE_FT * 5 },
      at(5, 5),
    ];
    assertEquivalent(() => makeMap(n, 2), walk);
  });

  it('matches through corner-seam blocking geometry (diagonal pillar gaps)', () => {
    const n = 24;
    // A checkerboard of pillars creates many diagonal seams, which is exactly
    // what `hasBlockedCornerSeam` (and therefore the generation-stamped memo)
    // is responsible for rejecting.
    const paint = (t: TileMap): void => {
      for (let y = 3; y < n - 3; y += 2) {
        for (let x = 3; x < n - 3; x += 2) {
          t.flags[y * n + x] = TilePresets.WALL;
        }
      }
    };
    const walk = [at(2, 2), at(5, 5), at(6, 5), at(5, 6), at(12, 12), at(2, 12), at(12, 2)];
    assertEquivalent(() => makeMap(n, 2, paint), walk);
  });

  it.each([1, 2, 4, 8])('matches at subFactor %i', (subFactor) => {
    const n = 20;
    const paint = (t: TileMap): void => {
      for (let y = 4; y < 14; y++) t.flags[y * n + 9] = TilePresets.WALL;
      t.flags[8 * n + 9] = TilePresets.FLOOR; // doorway
    };
    const walk = [at(4, 8), at(5, 8), at(5, 9), at(14, 8), at(9, 3)];
    assertEquivalent(() => makeMap(n, subFactor, paint), walk);
  });

  it('matches after a subFactor change rebuilds the cached pass state', () => {
    const n = 20;
    const walk = [at(5, 5), at(6, 5), at(7, 5), at(8, 5)];
    assertEquivalent(
      () => makeMap(n, 2),
      walk,
      (floorMap, step) => {
        if (step === 2) floorMap.setSubFactor(4);
      },
    );
  });

  it('matches when subFactor changes at a fixed origin', () => {
    // Regression pin for a cache keyed on (origin, revision) but NOT subFactor.
    //
    // Changing subFactor normally also changes the sub-tile origin, which masks
    // a missing subFactor check. It does NOT at world coords < tileSize/maxSf,
    // where floor(w / (32/sf)) is 0 for every sf under test — so the origin is
    // byte-identical across the change and only the subFactor differs. The
    // corner tiles are opened so the pass has real geometry to light.
    const n = 20;
    const paint = (t: TileMap): void => {
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 3; x++) t.flags[y * n + x] = TilePresets.FLOOR;
      }
    };
    const fixed = { x: 4, y: 4 }; // sub-tile (0,0) at subFactor 1, 2 and 4
    const walk = [fixed, fixed, fixed, fixed];
    assertEquivalent(
      () => makeMap(n, 2, paint),
      walk,
      (floorMap, step) => {
        if (step === 1) floorMap.setSubFactor(4);
        if (step === 2) floorMap.setSubFactor(1);
        if (step === 3) floorMap.setSubFactor(2);
      },
    );
  });

  it('matches when transparency mutates at a fixed origin', () => {
    const n = 20;
    const fixed = at(10, 10);
    const walk = [fixed, fixed, fixed, fixed];
    assertEquivalent(
      () => makeMap(n, 2),
      walk,
      (floorMap, step) => {
        if (step === 1) floorMap.tileMap.setFlags(12, 10, TilePresets.WALL);
        if (step === 2) floorMap.tileMap.setFlags(12, 10, TilePresets.FLOOR);
        if (step === 3) floorMap.tileMap.setFlags(10, 12, TilePresets.WALL);
      },
    );
  });

  it('matches when two worlds share one FloorMap', () => {
    const n = 20;
    const shared = makeMap(n, 2);
    const reference = makeMap(n, 2);
    const worldA = makeWorldFor(shared);
    const worldB = makeWorldFor(shared);
    const worldRef = makeWorldFor(reference);

    // Alternate which world drives the shared map; the reference map is driven
    // by the same sequence. Shared per-map scratch must not leak between them.
    const walk = [at(4, 4), at(5, 4), at(6, 4), at(6, 5)];
    walk.forEach((p, step) => {
      const driver = step % 2 === 0 ? worldA : worldB;
      setPlayer(driver, p.x, p.y);
      fovSystem(driver);
      setPlayer(worldRef, p.x, p.y);
      fovSystemReference(worldRef);
      expect(Array.from(snapshot(shared)), `divergence at step ${step}`).toEqual(
        Array.from(snapshot(reference)),
      );
    });
  });
});

describe('fovSystem — scratch-state invariants', () => {
  it('does not leak the per-map scratch: a second map computes independently', () => {
    const mapA = makeMap(20, 2);
    const mapB = makeMap(20, 2);
    const worldA = makeWorldFor(mapA);
    const worldB = makeWorldFor(mapB);

    setPlayer(worldA, at(5, 5).x, at(5, 5).y);
    fovSystem(worldA);
    setPlayer(worldB, at(5, 5).x, at(5, 5).y);
    fovSystem(worldB);

    // Same geometry, same origin, independent maps → identical results.
    expect(Array.from(snapshot(mapA))).toEqual(Array.from(snapshot(mapB)));
  });

  it('throws on a reentrant call and recovers afterwards', () => {
    const floorMap = makeMap(20, 2);
    const world = makeWorldFor(floorMap);
    setPlayer(world, at(5, 5).x, at(5, 5).y);

    // Re-enter from inside the pass by hooking a method the callback invokes.
    let reentryError: unknown;
    let fired = false;
    const original = floorMap.markVisibleAndDiscovered.bind(floorMap);
    floorMap.markVisibleAndDiscovered = (hx: number, hy: number): void => {
      if (!fired) {
        fired = true;
        // Move the player so the nested call cannot take the cache-hit path.
        setPlayer(world, at(9, 9).x, at(9, 9).y);
        try {
          fovSystem(world);
        } catch (err) {
          reentryError = err;
        }
        setPlayer(world, at(5, 5).x, at(5, 5).y);
      }
      original(hx, hy);
    };

    fovSystem(world);
    expect(reentryError).toBeInstanceOf(Error);
    expect((reentryError as Error).message).toContain('reentrant call detected');

    // The `finally` must have released the guard: a later pass still works.
    floorMap.markVisibleAndDiscovered = original;
    setPlayer(world, at(12, 12).x, at(12, 12).y);
    expect(() => fovSystem(world)).not.toThrow();
    expect(floorMap.isVisible(12, 12)).toBe(true);
  });

  it('rejects a reentrant call even when the nested call changes subFactor', () => {
    const floorMap = makeMap(20, 2);
    const world = makeWorldFor(floorMap);
    setPlayer(world, at(5, 5).x, at(5, 5).y);

    let reentryError: unknown;
    let fired = false;
    const original = floorMap.markVisibleAndDiscovered.bind(floorMap);
    floorMap.markVisibleAndDiscovered = (hx: number, hy: number): void => {
      if (!fired) {
        fired = true;
        try {
          // A subFactor change would otherwise replace the in-flight state and
          // bypass a guard checked after the rebuild.
          floorMap.setSubFactor(4);
          fovSystem(world);
        } catch (err) {
          reentryError = err;
        }
      }
      original(hx, hy);
    };

    try {
      fovSystem(world);
    } catch {
      // The outer pass may itself fail once the bitmaps are reallocated mid-pass;
      // what matters is that the nested call was rejected rather than silently
      // corrupting shared scratch.
    }
    expect(reentryError).toBeInstanceOf(Error);
    expect((reentryError as Error).message).toContain('reentrant call detected');
  });
});

describe('FloorMap.markVisibleAndDiscovered', () => {
  it('is equivalent to setVisible + setDiscovered across in- and out-of-bounds coords', () => {
    const fused = makeMap(20, 2);
    const split = makeMap(20, 2);

    const coords: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [0, 1],
      [7, 9],
      [39, 39], // last valid sub-tile at subFactor 2 on a 20-tile map
      [-1, 5],
      [5, -1],
      [-1, -1],
      [40, 5],
      [5, 40],
      [1000, 1000],
    ];

    for (const [hx, hy] of coords) {
      fused.markVisibleAndDiscovered(hx, hy);
      split.setVisible(hx, hy);
      split.setDiscovered(hx, hy);
      expect(Array.from(snapshot(fused)), `coord ${hx},${hy}`).toEqual(Array.from(snapshot(split)));
    }

    // The bounding box is private; prove it matches by clearing both and
    // comparing the resulting state.
    fused.clearVisibility();
    split.clearVisibility();
    expect(Array.from(snapshot(fused))).toEqual(Array.from(snapshot(split)));
  });

  it('keeps the transparent-bit revision contract used to invalidate FOV', () => {
    const floorMap = makeMap(20, 2);
    const before = floorMap.tileMap.transparencyRevision;
    // Passability-only change must NOT bump the revision.
    floorMap.tileMap.setFlags(5, 5, TilePresets.FLOOR & ~TileFlags.PASSABLE);
    expect(floorMap.tileMap.transparencyRevision).toBe(before);
    // A transparency change must.
    floorMap.tileMap.setFlags(5, 5, TilePresets.WALL);
    expect(floorMap.tileMap.transparencyRevision).toBeGreaterThan(before);
  });
});
