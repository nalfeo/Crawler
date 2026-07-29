/**
 * The single wall/not-wall alpha cut used everywhere a silhouette is compared.
 *
 * Four separate places need to agree on "is this pixel wall?": the rebuild's
 * block lighting, the accent clip, the cross-pack silhouette comparison, and
 * the tests that audit the committed sheet. When each carried its own literal
 * `128` they could drift apart silently — a pixel counted as wall by lighting
 * and as open space by validation, which is exactly the class of disagreement
 * that let a 16-shape silhouette ship as if it were 47.
 */
export const WALL_OPACITY_THRESHOLD = 128;

/** True when a silhouette alpha counts as wall. */
export function isWallAlpha(alpha: number): boolean {
  return alpha >= WALL_OPACITY_THRESHOLD;
}

/**
 * True only where the silhouette is FULLY opaque.
 *
 * Binary-alpha overlays (the wall accents) must clip against this, not against
 * `isWallAlpha`. An anti-aliased rounded corner runs through partial alphas;
 * keeping a hard 255 accent pixel on top of a 128-254 wall pixel paints the
 * curve back into a square and defeats the anti-aliasing it sits on.
 */
export function isFullyOpaqueWallAlpha(alpha: number): boolean {
  return alpha === 255;
}
