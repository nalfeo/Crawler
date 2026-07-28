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
 * Approved generated door texture keys, by open state × orientation. Each is
 * auto-loaded at boot under its bare manifest key when the art is approved; a key
 * with no approved art simply never appears in the renderer's available set and
 * the fallback chain takes over.
 */
export const GENERATED_DOOR_TEXTURE_KEYS = {
  closedHorizontal: 'tile-door-v1-var-0',
  closedVertical: 'tile-door-side-v1-var-0',
  openHorizontal: 'tile-door-open-v1-var-0',
  openVertical: 'tile-door-open-side-v1-var-0',
} as const satisfies Record<string, string>;

/** Every generated door texture key, for the renderer to probe at load time. */
export const ALL_GENERATED_DOOR_TEXTURE_KEYS: readonly string[] = Object.values(
  GENERATED_DOOR_TEXTURE_KEYS,
);

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
  | { readonly kind: 'generated'; readonly textureKey: string }
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
      return { kind: 'generated', textureKey: key };
    }
  }
  if (opts.hasSheet) {
    return isOpen ? { kind: 'kenney-open' } : { kind: 'kenney-closed' };
  }
  return { kind: 'color', open: isOpen };
}
