/**
 * Stamp a hand-authored {@link SetPieceDef} into a room's tile space.
 *
 * This is the REAL map-generation seam that turns the data-model set piece (a
 * grid of themed props + NPCs, authored in set-piece-local tile coordinates)
 * into concrete world-space placements for a specific room on a generated
 * floor. It is consumed by two callers:
 *
 * 1. `floorScenario.ts` — stamps the `welcome-room` set piece into Floor 1's
 *    spawn room, spawning the props (via `spawnSetPieceProp`) and the three
 *    quest NPCs at fixed, spaced positions.
 * 2. The map-gen lab overlay — draws the same stamped output on top of a
 *    generated floor so the placement can be inspected visually.
 *
 * The function is PURE and deterministic: given the same def + room bounds it
 * always returns the same placements, with no RNG and no I/O. All rendering
 * concerns (texture resolution, tinting) are deferred to the engine via the
 * {@link SetPiecePropRender} sidecar carried on each stamped prop.
 *
 * Coordinate model:
 * - Set-piece tiles are 0-based within the def's footprint (`prop.x/prop.y`,
 *   `npc.x/npc.y`), top-left origin.
 * - The stamp origin is the interior tile the def's (0,0) maps to. It is chosen
 *   to CENTER the def inside the room interior (a 1-tile inset of `roomBounds`,
 *   matching the rectangular-room generators). Individual tiles are clamped to
 *   the interior so nothing lands on a wall even if the def slightly overflows.
 * - World positions are in FEET and match `FloorMap.tileToWorld` (tile center =
 *   `tile * tileSizeFt + tileSizeFt / 2`). Multi-tile props are centred on their
 *   whole footprint; per-layer sub-tile pixel offsets are converted feet using
 *   {@link SET_PIECE_TILE_SIZE} (the lab's pixels-per-tile).
 */

import type { RoomBounds } from '../../shared/map-types.js';
import { setPieceZToDepth } from '../../shared/render-depths.js';
import type { SetPiecePropRender } from '../../shared/set-piece-render.js';
import {
  flattenSetPieceLayers,
  getSetPieceFootprint,
  SET_PIECE_TILE_SIZE,
  type SetPieceDef,
  type SetPieceNpcAnchorRole,
} from '../../shared/set-piece-types.js';

/**
 * Per-layer depth separation so stacked layers within (and across) props keep a
 * stable draw order without crossing a `setPieceZToDepth` band boundary. With
 * fewer than ~100 draw layers the cumulative offset (<0.1) stays inside every
 * band gap (the tightest is 0.1 in the foreground band).
 */
const LAYER_DEPTH_EPSILON = 0.001;

/** A single stamped prop layer: a world-space position plus its render sidecar. */
export interface StampedSetPieceProp {
  /** World X in feet (footprint centre + layer offset). */
  readonly x: number;
  /** World Y in feet (footprint centre + layer offset). */
  readonly y: number;
  /** Clamped interior tile column of the prop footprint's top-left. */
  readonly tileX: number;
  /** Clamped interior tile row of the prop footprint's top-left. */
  readonly tileY: number;
  /** Render instructions consumed by the engine's prop pass. */
  readonly render: SetPiecePropRender;
}

/** A stamped NPC placement: which NPC, where, and which objective it anchors. */
export interface StampedSetPieceNpc {
  /** NPC type id resolved against the NPC registry (e.g. `tutorial-goon`). */
  readonly npcTypeId: string;
  /** Objective anchor this NPC drives, if any. */
  readonly anchorRole?: SetPieceNpcAnchorRole;
  /** Clamped interior tile column. */
  readonly tileX: number;
  /** Clamped interior tile row. */
  readonly tileY: number;
  /** World X in feet (tile centre). */
  readonly x: number;
  /** World Y in feet (tile centre). */
  readonly y: number;
}

/** The full result of stamping a set piece into a room. */
export interface StampedSetPiece {
  /** Interior tile the def's (0,0) maps to. */
  readonly originTileX: number;
  readonly originTileY: number;
  /** One entry per flattened draw layer, in render order. */
  readonly props: readonly StampedSetPieceProp[];
  /** One entry per authored NPC. */
  readonly npcs: readonly StampedSetPieceNpc[];
}

export interface StampSetPieceOptions {
  /** Target room's bounding box in tile coordinates (border tiles are walls). */
  readonly roomBounds: RoomBounds;
  /** Feet per tile for the floor (e.g. 4.0). */
  readonly tileSizeFt: number;
}

interface InteriorBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
}

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) {
    return lo;
  }
  if (value > hi) {
    return hi;
  }
  return value;
}

/** Interior of a room = a 1-tile inset of its bounds (the border is walls). */
function interiorOf(bounds: RoomBounds): InteriorBounds {
  const minX = bounds.x + 1;
  const minY = bounds.y + 1;
  const maxX = bounds.x + bounds.width - 2;
  const maxY = bounds.y + bounds.height - 2;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(0, maxX - minX + 1),
    height: Math.max(0, maxY - minY + 1),
  };
}

/**
 * Choose the interior tile the def's (0,0) maps to, centring the def within the
 * room interior. When the def is larger than the interior the origin pins to the
 * interior's top-left and per-tile clamping keeps everything on passable tiles.
 */
export function computeStampOrigin(
  def: SetPieceDef,
  roomBounds: RoomBounds,
): { originTileX: number; originTileY: number } {
  const interior = interiorOf(roomBounds);
  const footprint = getSetPieceFootprint(def);
  const offsetX = Math.max(0, Math.floor((interior.width - footprint.width) / 2));
  const offsetY = Math.max(0, Math.floor((interior.height - footprint.height) / 2));
  return {
    originTileX: interior.minX + offsetX,
    originTileY: interior.minY + offsetY,
  };
}

/**
 * Stamp `def` into the room described by `opts`, returning world-space prop and
 * NPC placements. Pure + deterministic.
 */
export function stampSetPiece(def: SetPieceDef, opts: StampSetPieceOptions): StampedSetPiece {
  const { roomBounds, tileSizeFt } = opts;
  const interior = interiorOf(roomBounds);
  const { originTileX, originTileY } = computeStampOrigin(def, roomBounds);
  const half = tileSizeFt / 2;

  const props: StampedSetPieceProp[] = [];
  flattenSetPieceLayers(def).forEach((draw, index) => {
    const { prop, layer, z } = draw;
    // Top-left tile of the prop footprint, clamped so it can never sit on a wall.
    const tileX = clamp(originTileX + prop.x, interior.minX, interior.maxX);
    const tileY = clamp(originTileY + prop.y, interior.minY, interior.maxY);
    // Centre the sprite over the whole footprint (feet), then apply the layer's
    // sub-tile pixel offset (lab pixels → feet).
    const footprintCentreX = tileX * tileSizeFt + (prop.width * tileSizeFt) / 2;
    const footprintCentreY = tileY * tileSizeFt + (prop.height * tileSizeFt) / 2;
    const offsetXFt = ((layer.offsetX ?? 0) / SET_PIECE_TILE_SIZE) * tileSizeFt;
    const offsetYFt = ((layer.offsetY ?? 0) / SET_PIECE_TILE_SIZE) * tileSizeFt;
    const render: SetPiecePropRender = {
      sprite: layer.sprite,
      depth: setPieceZToDepth(z) + index * LAYER_DEPTH_EPSILON,
      widthFt: prop.width * tileSizeFt,
      heightFt: prop.height * tileSizeFt,
      ...(layer.scale !== undefined ? { scale: layer.scale } : {}),
      ...(layer.tintHex !== undefined ? { tintHex: layer.tintHex } : {}),
      label: prop.id,
    };
    props.push({
      x: footprintCentreX + offsetXFt,
      y: footprintCentreY + offsetYFt,
      tileX,
      tileY,
      render,
    });
  });

  const npcs: StampedSetPieceNpc[] = def.npcs.map((npc) => {
    const tileX = clamp(originTileX + npc.x, interior.minX, interior.maxX);
    const tileY = clamp(originTileY + npc.y, interior.minY, interior.maxY);
    return {
      npcTypeId: npc.npcTypeId,
      ...(npc.anchorRole !== undefined ? { anchorRole: npc.anchorRole } : {}),
      tileX,
      tileY,
      x: tileX * tileSizeFt + half,
      y: tileY * tileSizeFt + half,
    };
  });

  return { originTileX, originTileY, props, npcs };
}
