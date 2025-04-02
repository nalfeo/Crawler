/**
 * Sprite anchor — a 2D pixel coordinate, in a sprite's native frame, that marks
 * where the sprite "attaches" to a holder. For a hand-held weapon this is the
 * grip; the renderer pins this pixel to the player's hand for equip/rotation.
 *
 * Anchors are integer pixel coordinates, with `x` in `[0, frameWidth)` and `y`
 * in `[0, frameHeight)`. This module deliberately stays portable (no Phaser or
 * engine imports) so both engine code and any future item/equipment layer can
 * share the same type.
 */

export interface SpriteAnchor {
  readonly x: number;
  readonly y: number;
}

export interface SpriteAnchors {
  readonly hold: SpriteAnchor;
  readonly centerOfGravity: SpriteAnchor;
  /**
   * Optional weapon-attachment anchor. Marks where a weapon fires from (ranged)
   * or attaches to (melee). When absent the consumer falls back to the mob's
   * ECS/visual pivot. Not defaulted to `hold` — having no weapon anchor is
   * semantically different from having one that coincides with the grip.
   */
  readonly weapon?: SpriteAnchor;
}

/**
 * Default anchor for **hand-held items on a 16x16 frame**: bottom-center, one
 * pixel above the bottom edge. Matches the default used by weapon briefs in the
 * sprite-generation pipeline so the runtime grip lands where the pipeline says
 * it should. **Not** a universal sprite default — helmets, rings, projectiles,
 * tiles, and VFX have different natural anchors.
 */
export const DEFAULT_HANDHELD_SPRITE_ANCHOR: SpriteAnchor = Object.freeze({ x: 8, y: 14 });

/**
 * Return the supplied anchor, or {@link DEFAULT_HANDHELD_SPRITE_ANCHOR} if it
 * is omitted. Use this anywhere a sprite without a declared anchor needs to be
 * pinned to a hand-held 16x16 frame.
 */
export function resolveHandheldAnchor(anchor?: SpriteAnchor): SpriteAnchor {
  return anchor ?? DEFAULT_HANDHELD_SPRITE_ANCHOR;
}

export function resolveSpriteAnchors(
  anchors?: Partial<SpriteAnchors>,
  fallback?: SpriteAnchor,
): SpriteAnchors {
  const hold = anchors?.hold ?? fallback ?? DEFAULT_HANDHELD_SPRITE_ANCHOR;
  const centerOfGravity = anchors?.centerOfGravity ?? hold;
  // weapon is intentionally NOT defaulted — absence means "no explicit anchor, use
  // the mob's ECS pivot as fallback" which is semantically different from a weapon
  // anchor that happens to coincide with the hold/grip point.
  return {
    hold,
    centerOfGravity,
    ...(anchors?.weapon !== undefined ? { weapon: anchors.weapon } : {}),
  };
}

/**
 * Validate that an anchor lies inside the given frame. Both the anchor
 * coordinates AND the frame dimensions must be positive integers; the anchor
 * must then be non-negative and strictly less than the frame dimension.
 * Returns `false` for non-finite, fractional, or out-of-bounds values on
 * either the anchor or the frame (so e.g. `Infinity` as a frame dimension
 * cannot be used to sneak a bogus anchor through).
 */
export function isValidAnchor(
  anchor: SpriteAnchor,
  frameWidth: number,
  frameHeight: number,
): boolean {
  return (
    Number.isInteger(frameWidth) &&
    Number.isInteger(frameHeight) &&
    frameWidth > 0 &&
    frameHeight > 0 &&
    Number.isInteger(anchor.x) &&
    Number.isInteger(anchor.y) &&
    anchor.x >= 0 &&
    anchor.y >= 0 &&
    anchor.x < frameWidth &&
    anchor.y < frameHeight
  );
}
