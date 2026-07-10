/**
 * Pure gesture-logic helpers for the set-piece editor.
 *
 * All functions here are free of DOM, canvas, or server-side dependencies so
 * they can be unit-tested in isolation (see
 * tests/editor-gestures.test.mjs) and pasted verbatim into the
 * browser-side rendering block of extension.mjs.
 *
 * --- Parity guarantees (see issue #997) ---
 *
 * `setPieceZToDepth` replicates the runtime function in
 * src/shared/render-depths.ts:setPieceZToDepth so the editor draw order
 * matches the runtime Phaser depth stack.
 *
 * `drawSortKey` wraps that function and inserts the ENTITY_DEPTH slot (0)
 * for NPCs without an authored z value, matching the runtime default of
 * ENTITY_DEPTH = 0.
 *
 * `npcCenterSnapPos` snaps the NPC *center* to the grid, then derives the
 * stored top-left position.  The runtime always computes NPC spawn-world
 * position from the footprint *center* (centreTileX = boundedTileX +
 * widthTiles/2), so snapping the center in the editor makes authoring
 * positions visually predictable.
 */

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

/** Safe-number: returns d when v is not a finite number. */
export function nnum(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/** Normalise an arbitrary degree value to the half-open range [0, 360). */
export function normalizeRotationDeg(v) {
  let n = Number(v);
  if (!Number.isFinite(n)) return 0;
  n = n % 360;
  if (n < 0) n += 360;
  return n;
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

/**
 * Snap `v` to the nearest multiple of `step`.
 * A step ≤ 0 means free placement (no snapping); the value is returned as-is.
 */
export function snapToStep(v, step) {
  if (!Number.isFinite(step) || step <= 0) return v;
  return Math.round(v / step) * step;
}

// ---------------------------------------------------------------------------
// Depth / z-ordering (mirrors src/shared/render-depths.ts)
// ---------------------------------------------------------------------------

/**
 * Map a set-piece prop's authored z (the PROP_KIND_Z ladder: floor=0,
 * wall=10, door=12, fixture=20, furniture=30, decoration=40, actor=50) to
 * a Phaser render depth.  Mirrors the runtime implementation exactly.
 *
 * - z < 20  → background band (TERRAIN_DEPTH, ENTITY_DEPTH)
 * - z >= 20 → foreground band above ENTITY_DEPTH
 */
export function setPieceZToDepth(z) {
  if (z < 20) return -19 + z * 0.8;
  return 2 + (z - 20) * 0.1;
}

/**
 * The Phaser depth assigned to living entities (NPCs, player, mobs) when
 * they carry no authored z override.  Must equal ENTITY_DEPTH in
 * src/shared/render-depths.ts.
 */
export const ENTITY_DEPTH = 0;

/**
 * Compute the draw-sort key for a drawable item so the editor canvas order
 * matches the runtime Phaser depth stack.
 *
 * @param kind  'prop' or 'npc'
 * @param z     The authored z value (undefined for NPCs that have no z).
 */
export function drawSortKey(kind, z) {
  if (kind === 'npc') {
    return z !== undefined ? setPieceZToDepth(z) : ENTITY_DEPTH;
  }
  return setPieceZToDepth(z);
}

// ---------------------------------------------------------------------------
// NPC center-convention snapping (issue #997 item 3)
// ---------------------------------------------------------------------------

/**
 * Compute the snapped NPC top-left tile coordinate, where the *center* of
 * the NPC footprint is snapped to the nearest grid point.
 *
 * The runtime places NPC sprites at `centreTile * tileSizeFt`, i.e. the
 * authored (x, y) is the footprint top-left and the world spawn point is
 * the center.  Snapping the center gives authoring positions that are
 * visually predictable: the center of the NPC lands on a grid line, not
 * its top-left corner.
 *
 * @param dispPx       Current drag display position (top-left, in canvas px).
 * @param tileSize     Canvas pixels per tile.
 * @param sizeTiles    NPC footprint size in tiles (single axis).
 * @param snapStep     Grid snap step in tiles (0 = free placement).
 * @param limitTiles   Set-piece dimension limit (width or height) in tiles.
 * @returns            Top-left tile coordinate, clamped within [0, limitTiles - sizeTiles].
 */
export function npcCenterSnapPos(dispPx, tileSize, sizeTiles, snapStep, limitTiles) {
  const halfTiles = sizeTiles / 2;
  const topLeftTiles = dispPx / tileSize;
  const centerTiles = topLeftTiles + halfTiles;
  const snappedCenter = snapToStep(centerTiles, snapStep);
  const snappedTopLeft = snappedCenter - halfTiles;
  const max = Math.max(0, limitTiles - sizeTiles);
  return Math.max(0, Math.min(max, snappedTopLeft));
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

/**
 * Returns true if canvas point (cx, cy) falls within the tile-grid bounding
 * box of an item at tile position (itemX, itemY) with footprint (itemW × itemH).
 */
export function hitTestRect(itemX, itemY, itemW, itemH, cx, cy, tileSize) {
  const px = itemX * tileSize;
  const py = itemY * tileSize;
  return cx >= px && cx < px + itemW * tileSize && cy >= py && cy < py + itemH * tileSize;
}

// ---------------------------------------------------------------------------
// Undo / redo history (pure state machine)
// ---------------------------------------------------------------------------

/** Maximum history entries kept before the oldest is discarded. */
const DEFAULT_MAX_HISTORY = 80;

/**
 * Push a new serialised state onto the history stack.
 * Drops any redo tail (entries after `histIdx`).
 *
 * @param hist     Current history array (serialised strings).
 * @param histIdx  Current position in history.
 * @param state    Serialised state string to push.
 * @param maxLen   Max history length (default 80).
 * @returns        New {hist, histIdx}.
 */
export function historyPush(hist, histIdx, state, maxLen = DEFAULT_MAX_HISTORY) {
  let next = hist.slice(0, histIdx + 1);
  next.push(state);
  if (next.length > maxLen) {
    next = next.slice(next.length - maxLen);
    return { hist: next, histIdx: next.length - 1 };
  }
  return { hist: next, histIdx: next.length - 1 };
}

/**
 * Move one step back in history.
 *
 * @returns {histIdx, state} where `state` is the entry to restore, or
 *          `null` when already at the beginning.
 */
export function historyUndo(hist, histIdx) {
  if (histIdx <= 0) return null;
  const nextIdx = histIdx - 1;
  return { histIdx: nextIdx, state: hist[nextIdx] };
}

/**
 * Move one step forward in history.
 *
 * @returns {histIdx, state} where `state` is the entry to restore, or
 *          `null` when already at the end.
 */
export function historyRedo(hist, histIdx) {
  if (histIdx >= hist.length - 1) return null;
  const nextIdx = histIdx + 1;
  return { histIdx: nextIdx, state: hist[nextIdx] };
}
