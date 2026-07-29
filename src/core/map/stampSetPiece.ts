/**
 * Stamp a hand-authored {@link SetPieceDef} into a room's tile space.
 *
 * This is the REAL map-generation seam that turns the data-model set piece (a
 * grid of themed props + NPCs, authored in set-piece-local tile coordinates)
 * into concrete world-space placements for a specific room on a generated
 * floor. It is consumed by two callers:
 *
 * 1. `floorScenario.ts` — stamps the `welcome-room` set piece into Floor 1's
 *    welcome-office hub (the `roomRole: "spawn"` room resolved via
 *    `welcomeOfficePos`, 3–8 hops from the player start — NOT the literal
 *    player-spawn room `floorMap.spawnRoom`; stamping there would collapse the
 *    welcome-sign trail and pull the goon next to the player), recording the
 *    props (via `addSetPieceProp`) and the three quest NPCs at fixed, spaced
 *    positions.
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
  type SpriteRef,
} from '../../shared/set-piece-types.js';
import { getNpcDef } from '../../shared/npc-types.js';

/**
 * Per-layer depth separation so stacked layers within (and across) props keep a
 * stable draw order without crossing a `setPieceZToDepth` band boundary. With
 * fewer than ~100 draw layers the cumulative offset (<0.1) stays inside every
 * band gap (the tightest is 0.1 in the foreground band).
 */
const LAYER_DEPTH_EPSILON = 0.001;

/**
 * Native tile footprint of a non-base (accent/overlay) layer's sprite.
 *
 * Only the BASE layer of a prop fills the prop's whole footprint (a table slab,
 * a rug). Stacked accent layers are discrete items — a potion on the table, a
 * gem, a welcome sign — and must keep their own extent instead of inheriting
 * the parent footprint (which would render a `scale: 0.8` bottle at ~80% of a
 * 3-tile table). Custom refs carry an explicit tile footprint (default 1×1);
 * catalog/sheet refs have no core-visible sprite-frame size, so fall back to a
 * single tile. The layer's `scale` is applied by the renderer on top of this.
 */
function nativeLayerTiles(sprite: SpriteRef): { width: number; height: number } {
  if (sprite.source === 'custom') {
    return { width: sprite.widthTiles ?? 1, height: sprite.heightTiles ?? 1 };
  }
  return { width: 1, height: 1 };
}

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
  /** Optional per-instance width in feet (paired with heightFt). */
  readonly widthFt?: number;
  /** Optional per-instance height in feet (paired with widthFt). */
  readonly heightFt?: number;
  /** Optional sprite mirror flags applied at render time. */
  readonly flipX?: boolean;
  readonly flipY?: boolean;
  /** Optional clockwise sprite rotation in degrees. */
  readonly rotationDeg?: number;
  /** Optional local z-order carried through to runtime draw depth. */
  readonly z?: number;
  /** Optional visual override sprite for this spawned NPC. */
  readonly spriteOverride?: SpriteRef;
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
  /**
   * How the def's (0,0) maps into the room:
   *   - `interior-center` (default): historical behaviour — the def is aligned
   *     within the 1-tile-inset interior per its `placement`.
   *   - `bounds-topleft`: prefab-room mode — (0,0) maps to the room's top-left
   *     bounds tile so the def's authored wall ring coincides with the room's
   *     perimeter walls. Props may sit on the border ring; NPCs still clamp to
   *     the interior so they never spawn on a wall.
   */
  readonly anchor?: 'interior-center' | 'bounds-topleft';
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

function clampNpcTopLeftForFootprint(
  topLeftTile: number,
  interiorMin: number,
  interiorMax: number,
  sizeTiles: number,
): number | null {
  const minTopLeft = interiorMin;
  const maxTopLeft = interiorMax + 1 - sizeTiles;
  if (maxTopLeft < minTopLeft) {
    return null;
  }
  return clamp(topLeftTile, minTopLeft, maxTopLeft);
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
 * Choose the interior tile the def's (0,0) maps to. The def is anchored within
 * the room interior per its `placement` (defaulting to centre/centre), applied
 * over the SLACK on each axis (interior extent − footprint extent). When the def
 * is larger than the interior the slack is 0, so the origin pins to the interior
 * top-left and per-tile clamping keeps everything on passable tiles.
 *
 * `verticalAlign: "top"` (slack applied as 0) hugs the room's top wall so
 * wall-mounted decor can reach the wall; `center` reproduces the historical
 * `floor(slack / 2)` centring exactly; `bottom`/`right` push to the far edge.
 */
export function computeStampOrigin(
  def: SetPieceDef,
  roomBounds: RoomBounds,
  anchor: 'interior-center' | 'bounds-topleft' = 'interior-center',
): { originTileX: number; originTileY: number } {
  if (anchor === 'bounds-topleft') {
    // Prefab-room mode: the def's (0,0) IS the room's top-left corner so the
    // authored wall ring lands exactly on the room's perimeter wall tiles.
    return { originTileX: roomBounds.x, originTileY: roomBounds.y };
  }
  const interior = interiorOf(roomBounds);
  const footprint = getSetPieceFootprint(def);
  const slackX = Math.max(0, interior.width - footprint.width);
  const slackY = Math.max(0, interior.height - footprint.height);
  const horizontalAlign = def.placement?.horizontalAlign ?? 'center';
  const verticalAlign = def.placement?.verticalAlign ?? 'center';
  const offsetX =
    horizontalAlign === 'left' ? 0 : horizontalAlign === 'right' ? slackX : Math.floor(slackX / 2);
  const offsetY =
    verticalAlign === 'top' ? 0 : verticalAlign === 'bottom' ? slackY : Math.floor(slackY / 2);
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
  const anchor = opts.anchor ?? 'interior-center';
  const interior = interiorOf(roomBounds);
  const { originTileX, originTileY } = computeStampOrigin(def, roomBounds, anchor);

  // A room with no passable interior (width/height ≤ 0 after the 1-tile wall
  // inset) cannot host the set piece. Bail with the origin but no placements —
  // clamping into a degenerate interior (lo > hi) would otherwise pin props and
  // NPCs onto the wall/border tiles instead of leaving the room untouched.
  if (interior.width <= 0 || interior.height <= 0) {
    return { originTileX, originTileY, props: [], npcs: [] };
  }

  // Region props are clamped into. In `bounds-topleft` (prefab) mode props may
  // legitimately sit on the perimeter ring (wall/door art), so clamp to the full
  // bounds; otherwise clamp to the interior as before.
  const propRegion =
    anchor === 'bounds-topleft'
      ? {
          minX: roomBounds.x,
          minY: roomBounds.y,
          maxX: roomBounds.x + roomBounds.width - 1,
          maxY: roomBounds.y + roomBounds.height - 1,
        }
      : { minX: interior.minX, minY: interior.minY, maxX: interior.maxX, maxY: interior.maxY };

  const props: StampedSetPieceProp[] = [];
  flattenSetPieceLayers(def).forEach((draw, index) => {
    const { prop, layer, z, layerIndex } = draw;
    // Top-left tile of the prop footprint, clamped so the WHOLE footprint stays
    // inside the clamp region. Clamping only the top-left let a multi-tile prop's
    // right/bottom edge overflow; bound the top-left by
    // `maxX - (width - 1)` / `maxY - (height - 1)` instead. A prop bigger than
    // the region pins to the top-left (the `Math.max` floor); the degenerate
    // interior is handled above.
    const maxTileX = Math.max(propRegion.minX, propRegion.maxX - (prop.width - 1));
    const maxTileY = Math.max(propRegion.minY, propRegion.maxY - (prop.height - 1));
    const tileX = clamp(originTileX + prop.x, propRegion.minX, maxTileX);
    const tileY = clamp(originTileY + prop.y, propRegion.minY, maxTileY);
    // Centre the sprite over the whole footprint (feet), then apply the layer's
    // sub-tile pixel offset (lab pixels → feet).
    const footprintCentreX = tileX * tileSizeFt + (prop.width * tileSizeFt) / 2;
    const footprintCentreY = tileY * tileSizeFt + (prop.height * tileSizeFt) / 2;
    // Position nudge: legacy lab-pixel offset (offsetX/offsetY) plus an explicit
    // feet nudge (offsetXFt/offsetYFt), so a sconce can be lifted onto the wall.
    const offsetXFt =
      ((layer.offsetX ?? 0) / SET_PIECE_TILE_SIZE) * tileSizeFt + (layer.offsetXFt ?? 0);
    const offsetYFt =
      ((layer.offsetY ?? 0) / SET_PIECE_TILE_SIZE) * tileSizeFt + (layer.offsetYFt ?? 0);
    // Render box in feet. `heightFt` is AUTHORITATIVE for upright props: the
    // renderer scales the sprite so its apparent vertical height matches, and the
    // width follows the art's own aspect. Floor decals contain-fit both dims.
    // Otherwise the base layer fills the prop footprint and accent layers keep
    // their own (smaller) extent.
    let boxWidthFt: number;
    let boxHeightFt: number;
    if (layer.widthFt !== undefined && layer.heightFt !== undefined) {
      boxWidthFt = layer.widthFt;
      boxHeightFt = layer.heightFt;
    } else {
      const layerTiles =
        layerIndex === 0
          ? { width: prop.width, height: prop.height }
          : nativeLayerTiles(layer.sprite);
      boxWidthFt = layerTiles.width * tileSizeFt;
      boxHeightFt = layerTiles.height * tileSizeFt;
    }
    const render: SetPiecePropRender = {
      sprite: layer.sprite,
      depth: setPieceZToDepth(z) + index * LAYER_DEPTH_EPSILON,
      widthFt: boxWidthFt,
      heightFt: boxHeightFt,
      // Floor decals lie in the ground plane, so both declared feet are real
      // ground extents and the renderer must contain-fit them. Upright props are
      // height-authoritative so a conservative width can never flatten them.
      ...(prop.kind === 'floor' ? { floorPlane: true } : {}),
      ...(layer.scale !== undefined ? { scale: layer.scale } : {}),
      ...(layer.anchorBase !== undefined ? { anchorBase: layer.anchorBase } : {}),
      ...(layer.flipX !== undefined ? { flipX: layer.flipX } : {}),
      ...(layer.flipY !== undefined ? { flipY: layer.flipY } : {}),
      ...(layer.rotationDeg !== undefined ? { rotationDeg: layer.rotationDeg } : {}),
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

  const npcs: StampedSetPieceNpc[] = def.npcs.flatMap((npc) => {
    const npcDef = getNpcDef(npc.npcTypeId);
    const widthFt = npc.widthFt ?? npcDef?.widthFt ?? tileSizeFt;
    const heightFt = npc.heightFt ?? npcDef?.heightFt ?? tileSizeFt;
    const widthTiles = widthFt / tileSizeFt;
    const heightTiles = heightFt / tileSizeFt;
    const rawTileX = originTileX + npc.x;
    const rawTileY = originTileY + npc.y;
    const boundedTileX = clampNpcTopLeftForFootprint(
      rawTileX,
      interior.minX,
      interior.maxX,
      widthTiles,
    );
    const boundedTileY = clampNpcTopLeftForFootprint(
      rawTileY,
      interior.minY,
      interior.maxY,
      heightTiles,
    );
    if (boundedTileX === null || boundedTileY === null) {
      return [];
    }
    const centreTileX = boundedTileX + widthTiles / 2;
    const centreTileY = boundedTileY + heightTiles / 2;
    // Keep objective/occupancy tile bookkeeping integer-based (the containing
    // interior tile), while preserving authored sub-tile world positions within
    // the same interior bounds.
    const tileX = Math.floor(centreTileX);
    const tileY = Math.floor(centreTileY);
    return [
      {
        npcTypeId: npc.npcTypeId,
        ...(npc.widthFt !== undefined ? { widthFt: npc.widthFt } : {}),
        ...(npc.heightFt !== undefined ? { heightFt: npc.heightFt } : {}),
        ...(npc.flipX !== undefined ? { flipX: npc.flipX } : {}),
        ...(npc.flipY !== undefined ? { flipY: npc.flipY } : {}),
        ...(npc.rotationDeg !== undefined ? { rotationDeg: npc.rotationDeg } : {}),
        ...(npc.z !== undefined ? { z: npc.z } : {}),
        ...(npc.spriteOverride !== undefined ? { spriteOverride: npc.spriteOverride } : {}),
        ...(npc.anchorRole !== undefined ? { anchorRole: npc.anchorRole } : {}),
        tileX,
        tileY,
        x: centreTileX * tileSizeFt,
        y: centreTileY * tileSizeFt,
      },
    ];
  });

  return { originTileX, originTileY, props, npcs };
}
