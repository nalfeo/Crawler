import { resolveOpaqueFit, type OpaqueBounds } from '../../shared/generated-assets.js';

/**
 * door-visuals — pure precedence logic for which art a dungeon door tile renders.
 *
 * Doors are NOT part of the terrain RenderTexture bake; MainGameScene draws them
 * per-frame in `updateDoorOverlay()` (they animate open/closed and sit above the
 * baked floor at depth -19). This module owns ONLY the branch-selection decision
 * — which render mode, which texture key, and which Kenney frame — kept pure and
 * Phaser-free so it is unit-testable in isolation. The renderer maps the returned
 * mode to a concrete Image and derives the generated texture's scale from its
 * ACTUAL loaded width (never a hardcoded asset dimension), mirroring
 * terrain-renderer.
 *
 * ONE door system, for every floor. Precedence, per open/closed state:
 *   - approved GENERATED art for the EXACT orientation, then
 *   - approved GENERATED art for the OTHER orientation (a face-on leaf in a side
 *     doorway still reads better than swapping art families mid-wall), then
 *   - the Kenney frame for that state, then
 *   - a solid colour fill.
 *
 * The fallback chain never crosses the open/closed boundary: rendering closed art
 * for an open door would show a shut leaf on a tile the player is walking
 * through, which is worse than a placeholder that is at least honest about state.
 *
 * HISTORY — why there is no longer a terrain-pack branch. Doors used to have a
 * SECOND system: a per-pack `doorSet` whose art won precedence unconditionally,
 * drawn at a bespoke `tileSize / TERRAIN_PACK_CELL_PX` scale that bypassed the fit
 * below. That meant a door's SIZE was decided by which asset happened to exist,
 * not by design — pack doors rendered a full 4 ft × 4 ft cell (square, against a
 * 5.75 ft player) while generated doors were aspect-correct and up to 6.5 ft. The
 * two systems also disagreed about PROJECTION: pack art was a top-down hatch,
 * generated art a side-on elevation, so the shipped floors drew top-down doors
 * into a side-on world. It bought no biome variety either — the four packs shipped
 * only two visually distinct door looks between them. The pack path was retired
 * and per-tileset door art now re-enters through the SAME selection and fit rules
 * as everything else. See {@link DOOR_ART_CONTRACT_NOTE}.
 */

/**
 * Which way the wall run containing this door travels, from the flanking tiles.
 * `horizontal` = wall runs left↔right, so the doorway is crossed N↕S.
 * `vertical`   = wall runs up↕down, so the doorway is crossed E↔W.
 */
export type DoorOrientation = 'horizontal' | 'vertical';

/**
 * The MAXIMUM height a dungeon doorway renders, in FEET, measured on the art's
 * opaque box. It is one term of a CONTAIN-fit, not a target the door is stretched
 * to reach.
 *
 * Together with one cell of width this defines THE DOORWAY BOX — the single
 * logical volume every door on every floor is drawn into, regardless of which art
 * source won selection:
 *
 *   doorway box = tileSize (one cell, 4 ft) wide × DOOR_TARGET_HEIGHT_FT tall,
 *   floor-anchored on the tile's bottom edge.
 *
 * Art is contain-fitted into that box with a single uniform scale that never
 * exceeds EITHER axis:
 *
 *   scale = min(tileSize / box.width, doorTargetHeightPx / box.height)
 *
 * Whichever term is smaller binds; the other axis then comes in under its cap.
 * The art is NOT distorted to fill the box — a shorter door is accepted over a
 * stretched one.
 *
 * Why the WIDTH cap exists: fitted HEIGHT-authoritatively (`doorTargetHeightPx /
 * box.height` alone), height pins at 6.5 ft and the art's ~1:1.25 aspect decides
 * width — a ~5.2 ft leaf in a 4 ft cell that overhangs the doorway onto adjacent
 * floor. The width cap keeps a door inside its cell in either orientation.
 *
 * IMPORTANT — the box is the shared contract; contain-fit is only the ALGORITHM
 * that maps art into it. Sources with no meaningful aspect cannot be "fitted" into
 * a portrait box in any useful sense:
 *   - GENERATED art carries a real opaque box, so it fits properly and is the only
 *     source that can actually use the box's full height.
 *   - The KENNEY placeholder frame is a 16×16 SQUARE, so contain-fit necessarily
 *     binds on width and lands at 4 ft × 4 ft. That is a property of square
 *     placeholder art, not a second geometry rule — it still goes through the same
 *     call.
 *   - The COLOUR fallback has no art at all; it draws the doorway box's own
 *     footprint (one cell, floor-anchored). There is nothing to fit.
 * Do not read "one geometry rule" as "every door is the same size" — it means
 * every door is DERIVED THE SAME WAY, from the same box, with no per-source scale
 * constants.
 *
 * The accepted cost on the face-on N/S art (aspect ~0.8): it binds on WIDTH and so
 * renders SHORTER than 6.5 ft — 4.90 ft closed, 5.07 ft open. Taller N/S art was
 * pursued and hit a hard generator ceiling (six attempts), so the renderer is the
 * only lever; a ~5 ft door that fits its cell was preferred to a 6.5 ft door that
 * spills.
 *
 * The side-on E/W art (aspect ~0.47) binds on HEIGHT instead and renders as a
 * narrow ~3.1 ft × 6.5 ft strip — which is CORRECT: viewed edge-on a door should
 * read as a thin tall slab, not a 4 ft face.
 *
 * The art contract this relies on: door textures are bottom-aligned, so the
 * opaque box's bottom edge is the floor line and any excess height extends NORTH.
 * Pinned deterministically by tests/unit/generated-door-art.test.ts.
 */
export const DOOR_TARGET_HEIGHT_FT = 6.5;

/**
 * The projection + framing contract every door texture must satisfy, enforced by
 * tests/unit/generated-door-art.test.ts.
 *
 * This exists because the retired terrain-pack door art violated all of it: it was
 * a TOP-DOWN metal hatch that filled its 64×64 cell edge-to-edge with ZERO
 * transparent pixels. A naive "fits in the doorway box" gate cannot catch that —
 * contain-fit trivially shrinks any texture until it fits, so a full-cell hatch
 * passes a width/height cap. The gate therefore keys on properties a top-down
 * full-bleed tile CANNOT have:
 *
 *  1. TRANSPARENT SIDE MARGINS — a side-on door is an object standing in a
 *     doorway, so it must not touch the left and right texture edges. A full-bleed
 *     cell tile fails immediately.
 *  2. PORTRAIT OPAQUE BOX — a door is taller than it is wide. A square hatch fails.
 *  3. BOTTOM-ALIGNED — the opaque box's bottom edge is the floor line, because the
 *     renderer floor-anchors it.
 *
 * These are proxies for "is this drawn side-on", not a proof; projection cannot be
 * derived from pixels alone. They are chosen to be exactly the properties the known
 * bad art failed, so the specific regression that shipped cannot silently return.
 */
export const DOOR_ART_CONTRACT_NOTE =
  'Door art must be side-on: transparent left/right margins, portrait opaque box, bottom-aligned.';

/**
 * Inputs for {@link resolveDoorContainFit}.
 *
 * Units are ratio-only and may be pixels (runtime) or feet (tests), as long as
 * `canvas*`, `targetWidth`, and `targetHeight` use the same unit family.
 */
export interface DoorContainFitInput {
  readonly bounds: OpaqueBounds | undefined;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly targetWidth: number;
  readonly targetHeight: number;
}

/**
 * THE door fit. Every art-backed door — generated or Kenney placeholder — is sized
 * by this one call: contain-fit the art's opaque box into the doorway box
 * (one-cell width × {@link DOOR_TARGET_HEIGHT_FT}), floor-anchored on its base.
 *
 * No render branch may compute its own scale. That rule is the whole point: door
 * size used to depend on which asset existed, because the retired pack branch
 * applied a bespoke `tileSize / TERRAIN_PACK_CELL_PX`. Centralizing here also keeps
 * the runtime wiring and the regression gates from drifting apart.
 */
export function resolveDoorContainFit(input: DoorContainFitInput) {
  return resolveOpaqueFit({
    bounds: input.bounds,
    canvasWidth: input.canvasWidth,
    canvasHeight: input.canvasHeight,
    targetWidthPx: input.targetWidth,
    targetHeightPx: input.targetHeight,
    anchorBase: true,
    floorPlane: true,
  });
}

/**
 * Approved generated door texture keys, by open state × orientation. Each is
 * auto-loaded at boot under its bare manifest key when the art is approved; a key
 * with no approved art simply never appears in the renderer's available set and
 * the fallback chain takes over.
 */
export const GENERATED_DOOR_TEXTURE_KEYS = {
  closedHorizontal: 'tile-door-v1-var-9',
  // Genuinely side-on E/W art (shipped by PR #2375): drawn edge-on, not a rotated
  // face-on door, so the renderer applies NO rotation. Contain-fitting makes it
  // bind on height and render as a narrow tall strip, which is the correct edge-on
  // read.
  closedVertical: 'tile-door-sideon-v1-var-0',
  openHorizontal: 'tile-door-open-v1-var-0',
  // Side-on E/W open art (generated 2026-07-31, closing the last orientation gap).
  // `generatedKeysFor` still lists the face-on open leaf as a second candidate: the
  // fallback is defence-in-depth, not an expected path. When it fires the renderer
  // records a `cross` orientation match, so a regression is measurable rather than
  // invisible — `crossOrientationCount` must be 0 on both floors.
  openVertical: 'tile-door-open-side-v1-var-0',
} as const satisfies Record<string, string>;

/** Kenney Tiny Dungeon spritesheet key (placeholder fallback art). */
export const DOOR_SHEET_KEY = 'kenney-tiny-dungeon';

/**
 * Side length, in pixels, of one Kenney Tiny Dungeon frame.
 *
 * Exported so the renderer can feed the placeholder through the SAME
 * {@link resolveDoorContainFit} call as generated art instead of hardcoding a
 * `tileSize / 16` scale. The frame is square, so the fit binds on width and the
 * result is numerically identical to that old constant — the win is that there is
 * no longer a per-source scale expression that can drift from the doorway box.
 */
export const KENNEY_DOOR_FRAME_PX = 16;

/** Kenney Tiny Dungeon frame: brown arched wooden door, shut. */
export const DOOR_CLOSED_FRAME = 46;

/** Kenney Tiny Dungeon frame: door swung open, clear passage. */
export const DOOR_OPEN_FRAME = 34;

/**
 * How a single door tile should be rendered, chosen by
 * {@link resolveDoorRenderMode}. `generated` and the Kenney frames stamp an
 * Image; `color` fills a solid rect (its `open` flag picks the palette).
 *
 * There is deliberately no `pack` kind. Terrain packs no longer carry door art —
 * see the module header for why that second system was retired.
 */
export type DoorRenderMode =
  | {
      readonly kind: 'generated';
      readonly textureKey: string;
      /**
       * Whether the chosen texture was authored for THIS doorway's orientation
       * (`exact`) or borrowed from the other one (`cross`).
       *
       * Rendered telemetry must distinguish these. A door count alone cannot: if
       * every E/W doorway silently borrowed the face-on N/S leaf, a gate asserting
       * "all doors are generated" still passes while every side doorway shows the
       * wrong projection. `cross` is a real, visible art defect, so it is counted
       * separately and gated at zero.
       */
      readonly orientationMatch: 'exact' | 'cross';
    }
  | { readonly kind: 'kenney-closed' }
  | { readonly kind: 'kenney-open' }
  | { readonly kind: 'color'; readonly open: boolean };

/** The generated texture keys for one open/closed state, most-preferred first. */
function generatedKeysFor(isOpen: boolean, orientation: DoorOrientation): readonly string[] {
  const K = GENERATED_DOOR_TEXTURE_KEYS;
  if (isOpen) {
    return orientation === 'vertical'
      ? [K.openVertical, K.openHorizontal]
      : [K.openHorizontal, K.openVertical];
  }
  return orientation === 'vertical'
    ? [K.closedVertical, K.closedHorizontal]
    : [K.closedHorizontal, K.closedVertical];
}

/**
 * Decide how a door tile renders, by precedence. Pure: no Phaser, no asset
 * dimensions, no frame math beyond the exported constants — the caller maps the
 * returned mode to a concrete Image and derives scale from the actual loaded
 * texture via {@link resolveDoorContainFit}.
 *
 * @param isOpen Whether the door tile is currently passable (open).
 * @param opts.orientation Which way the containing wall run travels.
 * @param opts.availableGeneratedKeys Generated door texture keys that are loaded
 *   AND have a usable (>0) width, so they can be scaled to fill a tile's width.
 * @param opts.hasSheet The Kenney Tiny Dungeon spritesheet is loaded.
 */
export function resolveDoorRenderMode(
  isOpen: boolean,
  opts: {
    readonly orientation: DoorOrientation;
    readonly availableGeneratedKeys: ReadonlySet<string>;
    readonly hasSheet: boolean;
  },
): DoorRenderMode {
  const preferred = generatedKeysFor(isOpen, opts.orientation);
  for (let i = 0; i < preferred.length; i += 1) {
    const key = preferred[i];
    if (key !== undefined && opts.availableGeneratedKeys.has(key)) {
      return {
        kind: 'generated',
        textureKey: key,
        // Index 0 is this doorway's own orientation; anything later is borrowed.
        orientationMatch: i === 0 ? 'exact' : 'cross',
      };
    }
  }
  if (opts.hasSheet) {
    return isOpen ? { kind: 'kenney-open' } : { kind: 'kenney-closed' };
  }
  return { kind: 'color', open: isOpen };
}
