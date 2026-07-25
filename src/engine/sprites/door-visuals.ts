/**
 * door-visuals — pure precedence logic for which art a dungeon door tile renders.
 *
 * Doors are NOT part of the terrain RenderTexture bake; MainGameScene draws them
 * per-frame in `updateDoorOverlay()` (they animate open/closed and sit above the
 * baked floor at depth -19). This module owns ONLY the branch-selection decision
 * — which render mode, and which Kenney frame — kept pure and Phaser-free so it
 * is unit-testable in isolation. The renderer maps the returned mode to a
 * concrete Image and derives the generated texture's scale from its ACTUAL
 * loaded width (never a hardcoded asset dimension), mirroring terrain-renderer.
 *
 * Precedence when a terrain-pack door variant is available: pack door art wins
 * (for both open/closed × orientation), so pack-using floors render their
 * authored `doorSet` textures. Fallback precedence for non-pack or missing-pack
 * cases stays unchanged:
 *   - CLOSED: approved GENERATED closed-door art → Kenney closed frame → color.
 *   - OPEN: Kenney open frame → color (generated remains unreachable for open).
 */

/**
 * Approved generated closed-door texture key. Auto-loaded at boot under its bare
 * manifest key (256² single PNG, human-approved).
 */
export const GENERATED_DOOR_TEXTURE_KEY = 'tile-door-v1-var-0';

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
  | { readonly kind: 'generated' }
  | { readonly kind: 'kenney-closed' }
  | { readonly kind: 'kenney-open' }
  | { readonly kind: 'color'; readonly open: boolean };

/**
 * Decide how a door tile renders, by precedence. Pure: no Phaser, no asset
 * dimensions, no frame math beyond the exported constants — the caller maps the
 * returned mode to a concrete Image and derives scale from the actual loaded
 * texture width.
 *
 * @param isOpen Whether the door tile is currently passable (open).
 * @param opts.packDoorTextureKey Active terrain-pack door texture key for this
 *   exact open/closed × orientation state, when available and loaded.
 * @param opts.hasGeneratedClosed The generated closed-door texture is loaded AND
 *   has a usable (>0) width, so it can be scaled to fill a tile.
 * @param opts.hasSheet The Kenney Tiny Dungeon spritesheet is loaded.
 */
export function resolveDoorRenderMode(
  isOpen: boolean,
  opts: {
    readonly hasGeneratedClosed: boolean;
    readonly hasSheet: boolean;
    readonly packDoorTextureKey?: string;
  },
): DoorRenderMode {
  if (typeof opts.packDoorTextureKey === 'string' && opts.packDoorTextureKey.length > 0) {
    return { kind: 'pack', textureKey: opts.packDoorTextureKey };
  }
  if (isOpen) {
    // Non-destructive: the open state stays on Kenney art. No approved generated
    // open-door variant exists, so generated is unreachable for open doors.
    return opts.hasSheet ? { kind: 'kenney-open' } : { kind: 'color', open: true };
  }
  // Closed: approved generated art wins, then the Kenney closed frame, then color.
  if (opts.hasGeneratedClosed) {
    return { kind: 'generated' };
  }
  return opts.hasSheet ? { kind: 'kenney-closed' } : { kind: 'color', open: false };
}
