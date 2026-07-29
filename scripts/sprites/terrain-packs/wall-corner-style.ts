/**
 * Which wall-corner silhouette style a terrain pack is built with.
 *
 * The blob47 quadrant kit (`quadrant-kit.ts`) is shared by every authored pack,
 * so a pack's wall SHAPE is not a property of its art — it is a property of the
 * geometry the art is composited onto. This module is the single source of
 * truth for that choice, so the compositor
 * (`gen/compose-pack.ts`), the exact-silhouette validator (`validate.ts`) and
 * the committed-art tests can never disagree about what a pack should look like.
 *
 * Style semantics:
 *
 *  - `rounded` — exposed corners are quarter-disc arcs. Caves and caverns are
 *    ERODED, so their silhouettes carry no sharp 90-degree corners. This is the
 *    default and the historical behaviour.
 *  - `square` — exposed corners are hard 90-degree rectilinear cuts, with no
 *    anti-aliased fringe anywhere in the silhouette. Dungeons are CUT and built,
 *    not eroded: masonry corridors read as mason work only if their corners are
 *    square.
 *
 * Only the corner treatment differs. `WALL_INSET_PX` and the cardinal-edge
 * coverage rule are identical across styles, so the 100% edge-compatibility
 * invariant that makes blob47 tiling provable holds for both.
 */

export type WallCornerStyle = 'rounded' | 'square';

/** The default style for any pack that does not explicitly opt out. */
export const DEFAULT_WALL_CORNER_STYLE: WallCornerStyle = 'rounded';

/**
 * The declared corner style of every SHIPPED pack, stated explicitly.
 *
 * This is deliberately exhaustive rather than an opt-in set of exceptions. An
 * opt-in set has a silent failure mode: a future `floor3-dungeon` that nobody
 * remembers to add would inherit eroded cave geometry and ship the exact defect
 * this module exists to prevent, with no gate firing. Listing every pack turns
 * that into a test failure instead — `terrain-pack-corners.test.ts` asserts that
 * every directory under `public/assets/terrain-packs/` appears here, so adding a
 * pack forces an explicit, reviewed geometry decision.
 *
 * The fallback below still exists for ad-hoc/synthetic pack ids used by tests
 * and fixtures, which have no committed atlas to protect.
 */
const WALL_CORNER_STYLE_BY_PACK: ReadonlyMap<string, WallCornerStyle> = new Map<
  string,
  WallCornerStyle
>([
  // Cut masonry — square.
  ['floor1-dungeon', 'square'],
  // Eroded rock — rounded. These have committed atlases that must stay
  // byte-identical, which is why `rounded` is also the default.
  ['floor1-cave', 'rounded'],
  ['industrial-cave', 'rounded'],
  ['caeles-fixture', 'rounded'],
]);

/** Pack ids with an explicitly declared corner style. */
export const DECLARED_WALL_CORNER_STYLE_PACK_IDS: readonly string[] = [
  ...WALL_CORNER_STYLE_BY_PACK.keys(),
];

/**
 * Resolve the wall-corner style a pack's silhouettes are built with.
 *
 * Backed by a `Map`, not a plain object: `ComposePackInput.id` is an arbitrary
 * string, and indexing an object literal with `'constructor'` / `'toString'` /
 * `'__proto__'` returns an inherited value that is not nullish, so the `??`
 * fallback would be skipped and a truthy non-`WallCornerStyle` would flow into
 * the geometry branch.
 */
export function wallCornerStyleForPack(packId: string): WallCornerStyle {
  return WALL_CORNER_STYLE_BY_PACK.get(packId) ?? DEFAULT_WALL_CORNER_STYLE;
}
