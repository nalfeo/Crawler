/**
 * FOV System — computes player field-of-view each frame.
 *
 * Uses rot-js RecursiveShadowcasting at **dynamic sub-tile resolution**.
 * Each tile is divided into a `subFactor`×`subFactor` grid (default 2×, i.e.
 * quarter-tile); the FOV algorithm runs on this finer grid so the visibility
 * boundary follows shadow edges to within `1/subFactor` of a tile. The factor
 * is runtime-configurable via `FloorMap.setSubFactor` (lab-tunable).
 *
 * Results are stored on FloorMap's `visible` (per-frame) and `discovered`
 * (persistent) bitmaps for O(1) tile-level queries by other systems (enemy AI,
 * rendering fog-of-war, discovered-terrain dimming).
 *
 * Opaque tiles are an exception to the sub-tile rule: when any ray reaches a
 * wall, the **whole** wall tile is marked visible/discovered (see `onVisible`).
 *
 * ## Performance shape
 *
 * fovSystem accounts for ~1.88% of headless simulation time per
 * `npm run perf:profile`. The ~19.6% self / ~21.8% inclusive `rot.js:compute`
 * frame that initially looked like shadowcasting is `AStar.compute`
 * (pathfinding), not FOV. All per-pass working state (the rot-js FOV
 * instance, its two closures, and the corner-seam memo) is therefore built
 * **once per FloorMap** and reused instead of being reallocated every frame.
 *
 * Reuse mechanism: **encapsulated non-escaping per-map scratch**. The state
 * object lives in a `WeakMap` keyed by the FloorMap, is never returned or
 * exposed to callers, and is only mutated inside the synchronous
 * `fov.compute(...)` call below. A reentrancy guard makes a nested call fail
 * loudly rather than silently corrupt a pass in progress. See
 * `.github/skills/perf-optimizer/references/hunting-grounds.md` (A3).
 */

import { FOV } from 'rot-js';
import type RecursiveShadowcasting from 'rot-js/lib/fov/recursive-shadowcasting.js';
import { query } from 'bitecs';
import { Player, Position } from '../components.js';
import { TileFlags } from '../../shared/map-types.js';
import type { GameWorld } from '../world.js';
import type { FloorMap } from '../map/FloorMap.js';

/** Default FOV radius in tiles (~25 tiles ≈ 100ft at 4ft/tile). */
const DEFAULT_FOV_RADIUS = 25;

/** Sentinel for "no seam result memoized yet" — generations start at 1. */
const NO_GENERATION = 0;

interface FovPassState {
  /** Cache key of the last completed pass. NaN origin means "never computed". */
  originX: number;
  originY: number;
  readonly subFactor: number;
  transparencyRevision: number;

  /** Reused rot-js instance; its `lightPasses` closure reads this object. */
  fov: RecursiveShadowcasting;
  onVisible: (hx: number, hy: number, r: number, visibility: number) => void;

  /** Live inputs for the closures, refreshed before each `compute`. */
  originTileX: number;
  originTileY: number;

  /**
   * Corner-seam memo for the current pass, keyed by tile index. `seamGen[i]`
   * holds the generation that wrote `seamValue[i]`, so a new pass invalidates
   * every entry by bumping `generation` instead of clearing the arrays.
   */
  readonly seamGen: Int32Array;
  readonly seamValue: Uint8Array;
  generation: number;

  /** Guards against a nested pass mutating the shared scratch mid-compute. */
  inUse: boolean;
}

const fovStateByMap = new WeakMap<FloorMap, FovPassState>();

/**
 * Build the reusable per-map pass state.
 *
 * Rebuilt when `subFactor` changes, because `setSubFactor` reallocates the
 * visibility bitmaps and the sub-tile bounds captured by the callback.
 */
function createPassState(floorMap: FloorMap): FovPassState {
  const tileMap = floorMap.tileMap;
  const tileW = tileMap.width;
  const tileH = tileMap.height;
  const flags = tileMap.flags;
  const sf = floorMap.subFactor;
  const subW = floorMap.subWidth;
  const subH = floorMap.subHeight;

  const state: FovPassState = {
    originX: Number.NaN,
    originY: Number.NaN,
    subFactor: sf,
    transparencyRevision: Number.NaN,
    fov: undefined as unknown as RecursiveShadowcasting,
    onVisible: () => {},
    originTileX: 0,
    originTileY: 0,
    seamGen: new Int32Array(tileW * tileH),
    seamValue: new Uint8Array(tileW * tileH),
    generation: NO_GENERATION,
    inUse: false,
  };

  /*
   * Equivalent to `tileMap.isTransparent(Math.floor(hx / sf), Math.floor(hy / sf))`:
   * a negative sub-tile coord floors to a negative tile coord, which
   * `isTransparent` reports as opaque, so the early return matches. For
   * non-negative integers, `(v / sf) | 0 === Math.floor(v / sf)`.
   */
  const lightPasses = (hx: number, hy: number): boolean => {
    if (hx < 0 || hy < 0) return false;
    const tx = (hx / sf) | 0;
    const ty = (hy / sf) | 0;
    if (tx >= tileW || ty >= tileH) return false;
    return (flags[ty * tileW + tx]! & TileFlags.TRANSPARENT) !== 0;
  };

  const onVisible = (hx: number, hy: number, _r: number, visibility: number): void => {
    if (visibility <= 0) return;
    // Out-of-bounds sub-tiles are rejected by markVisibleAndDiscovered anyway,
    // so neither branch below can change state — skip the seam work entirely.
    if (hx < 0 || hx >= subW || hy < 0 || hy >= subH) return;

    const tx = (hx / sf) | 0;
    const ty = (hy / sf) | 0;

    // Apply corner-seam blocking across the entire ray from origin to candidate,
    // matching the consistency rules enforced by lineOfSight. This ensures FOV
    // and LOS agree: if lineOfSight rejects a candidate due to a blocked corner
    // seam, FOV rejects it too. Memoized per tile so the ray is walked once per
    // tile rather than once per sub-tile mapping to it.
    const tileIdx = ty * tileW + tx;
    const firstTouchThisPass = state.seamGen[tileIdx] !== state.generation;
    let seamBlocked: boolean;
    if (firstTouchThisPass) {
      seamBlocked = tileMap.hasBlockedCornerSeam(state.originTileX, state.originTileY, tx, ty);
      state.seamGen[tileIdx] = state.generation;
      state.seamValue[tileIdx] = seamBlocked ? 1 : 0;
    } else {
      seamBlocked = state.seamValue[tileIdx] !== 0;
    }
    if (seamBlocked) return;

    // Opaque tiles are revealed as WHOLE tiles. Shadowcasting only reports the
    // sub-tiles a ray physically lands on — the face of the wall nearest the
    // player — so at sub-tile resolution a seen wall would render half-lit with
    // the rest of the same tile still black. Filling the tile makes walls read
    // as solid blocks and lets the light field illuminate all of it.
    //
    // The seam memo doubles as the "already expanded this pass" flag: the fill
    // covers every sub-tile of the tile, so later sub-tiles of the same tile
    // have nothing left to add.
    if ((flags[tileIdx]! & TileFlags.TRANSPARENT) === 0) {
      if (firstTouchThisPass) floorMap.markTileVisibleAndDiscovered(tx, ty);
      return;
    }

    floorMap.markVisibleAndDiscovered(hx, hy);
  };

  state.fov = new FOV.RecursiveShadowcasting(lightPasses);
  state.onVisible = onVisible;
  return state;
}

export function fovSystem(world: GameWorld): void {
  const floorMap = world.floorMap;
  if (!floorMap) return;

  const players = query(world.ecs, [Player, Position]);
  if (players.length === 0) return;

  const playerEid = players[0]!;
  const px = world.stores.position.x[playerEid] ?? 0;
  const py = world.stores.position.y[playerEid] ?? 0;

  // Convert world position (feet) to sub-tile coordinates.
  const origin = floorMap.worldToSubTile(px, py);
  const originTile = floorMap.worldToTile(px, py);
  const sf = floorMap.subFactor;
  const transparencyRevision = floorMap.tileMap.transparencyRevision;

  let state = fovStateByMap.get(floorMap);

  // Reentrancy must be rejected BEFORE any other branch. A nested call that hit
  // the cache would observe a half-rebuilt bitmap, and one that saw a changed
  // subFactor would replace the in-flight state and bypass the guard entirely.
  if (state?.inUse) {
    throw new Error(
      'fovSystem: reentrant call detected — the per-map FOV scratch state is already ' +
        'in use by an in-progress pass. Do not call fovSystem from inside an FOV callback, ' +
        'or from a system invoked by one.',
    );
  }

  if (!state || state.subFactor !== sf) {
    state = createPassState(floorMap);
    fovStateByMap.set(floorMap, state);
  }

  if (
    state.originX === origin.x &&
    state.originY === origin.y &&
    state.transparencyRevision === transparencyRevision
  ) {
    return;
  }

  state.inUse = true;
  try {
    // Clear previous per-frame visibility (discovered memory persists).
    floorMap.clearVisibility();

    state.originTileX = originTile.x;
    state.originTileY = originTile.y;
    // Invalidate the whole seam memo in O(1). On wrap, reset the stamps so a
    // stale entry can never alias the new generation.
    state.generation += 1;
    if (state.generation > 0x7fffffff) {
      state.seamGen.fill(NO_GENERATION);
      state.generation = NO_GENERATION + 1;
    }

    // Compute FOV using recursive shadowcasting at `subFactor`× tile resolution.
    // Scaling the radius by `subFactor` keeps the vision range in feet unchanged.
    state.fov.compute(origin.x, origin.y, DEFAULT_FOV_RADIUS * sf, state.onVisible);
  } finally {
    state.inUse = false;
  }

  state.originX = origin.x;
  state.originY = origin.y;
  state.transparencyRevision = transparencyRevision;
}
