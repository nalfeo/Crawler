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
 * Precedence when a terrain-pack door variant is available: pack door art wins
 * (for both open/closed × orientation), so pack-using floors render their
 * authored `doorSet` textures. Otherwise, per open/closed state:
 *   - approved GENERATED art for the EXACT orientation, then
 *   - approved GENERATED art for the OTHER orientation (a face-on leaf in a side
 *     doorway still reads better than swapping art families mid-wall), then
 *   - the Kenney frame for that state, then
 *   - a solid colour fill.
 *
 * The fallback chain never crosses the open/closed boundary: rendering closed art
 * for an open door would show a shut leaf on a tile the player is walking
 * through, which is worse than a placeholder that is at least honest about state.
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
 * The renderer fits each door's opaque box inside a `tileSize` (one cell, 4 ft) ×
 * `DOOR_TARGET_HEIGHT_FT` (6.5 ft) box with a single uniform scale that never
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
 * floor. The width cap keeps a generated door inside its cell in either
 * orientation.
 *
 * PATH REALITY — this governs the generated-door FALLBACK only, NOT the doors the
 * player currently sees. Both shipped floors (Floor 1 and Floor 2) declare terrain
 * packs whose `doorSet` art wins precedence in {@link resolveDoorRenderMode}, so
 * every door they render is a pack door already sized to exactly one cell. The
 * generated keys below render ZERO times in the shipped game today — verified live:
 * `floor1-default` renders 84 pack doors and 0 generated doors. This contain-fit is
 * correct hardening for any pack-less floor, or a pack missing an orientation; it
 * does not change Floor 1's pack doors. (The original "wrong widths" complaint was
 * about Floor 1, i.e. pack doors — a separate lever from this generated path.)
 *
 * The accepted cost, chosen explicitly by the maintainer for the generated path:
 * the face-on N/S art (aspect ~0.8) binds on WIDTH and so renders SHORTER than
 * 6.5 ft — 4.90 ft closed, 5.07 ft open. Taller N/S art was pursued and hit a hard
 * generator ceiling (six attempts), so the renderer is the only lever; a ~5 ft door
 * that fits its cell was preferred to a 6.5 ft door that spills. Revisit only if a
 * pack-less floor ever renders these and it reads badly.
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
 * Inputs for {@link resolveGeneratedDoorContainFit}.
 *
 * Units are ratio-only and may be pixels (runtime) or feet (tests), as long as
 * `canvas*`, `targetWidth`, and `targetHeight` use the same unit family.
 */
export interface GeneratedDoorContainFitInput {
  readonly bounds: OpaqueBounds | undefined;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly targetWidth: number;
  readonly targetHeight: number;
}

/**
 * Shared generated-door fit contract used by both runtime and regression tests:
 * contain-fit into one-cell width × max doorway height, anchored on the art's
 * base. Centralizing this prevents drift between `MainGameScene` wiring and test
 * assertions.
 */
export function resolveGeneratedDoorContainFit(input: GeneratedDoorContainFitInput) {
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
  // KNOWN GAP: the E/W *open* door failed generation (same generator ceiling as
  // the taller N/S art), so no `tile-door-open-side-v1-var-0` art exists. Vertical
  // OPEN doorways therefore fall back to the face-on horizontal open leaf via
  // `generatedKeysFor`. Accepted; do not attempt to regenerate here.
  openVertical: 'tile-door-open-side-v1-var-0',
} as const satisfies Record<string, string>;

/** Kenney Tiny Dungeon spritesheet key (placeholder fallback art). */
export const DOOR_SHEET_KEY = 'kenney-tiny-dungeon';

/** Kenney Tiny Dungeon frame: brown arched wooden door, shut. */
export const DOOR_CLOSED_FRAME = 46;

/** Kenney Tiny Dungeon frame: door swung open, clear passage. */
export const DOOR_OPEN_FRAME = 34;

/**
 * How a single door tile should be rendered, chosen by
 * {@link resolveDoorRenderMode}. `generated` and the Kenney frames stamp an
 * Image; `color` fills a solid rect (its `open` flag picks the palette).
 */
export type DoorRenderMode =
  | { readonly kind: 'pack'; readonly textureKey: string }
  | {
      readonly kind: 'generated';
      readonly textureKey: string;
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
 * texture width.
 *
 * @param isOpen Whether the door tile is currently passable (open).
 * @param opts.orientation Which way the containing wall run travels.
 * @param opts.availableGeneratedKeys Generated door texture keys that are loaded
 *   AND have a usable (>0) width, so they can be scaled to fill a tile's width.
 * @param opts.hasSheet The Kenney Tiny Dungeon spritesheet is loaded.
 * @param opts.packDoorTextureKey Active terrain-pack door texture key for this
 *   exact open/closed × orientation state, when available and loaded.
 */
export function resolveDoorRenderMode(
  isOpen: boolean,
  opts: {
    readonly orientation: DoorOrientation;
    readonly availableGeneratedKeys: ReadonlySet<string>;
    readonly hasSheet: boolean;
    readonly packDoorTextureKey?: string;
  },
): DoorRenderMode {
  if (typeof opts.packDoorTextureKey === 'string' && opts.packDoorTextureKey.length > 0) {
    return { kind: 'pack', textureKey: opts.packDoorTextureKey };
  }
  for (const key of generatedKeysFor(isOpen, opts.orientation)) {
    if (opts.availableGeneratedKeys.has(key)) {
      return {
        kind: 'generated',
        textureKey: key,
      };
    }
  }
  if (opts.hasSheet) {
    return isOpen ? { kind: 'kenney-open' } : { kind: 'kenney-closed' };
  }
  return { kind: 'color', open: isOpen };
}
