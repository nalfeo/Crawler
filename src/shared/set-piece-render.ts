/**
 * Render sidecar for stamped set-piece props.
 *
 * A set piece is authored as themed props, each with an ordered stack of sprite
 * `layers`. When a set piece is stamped into a real floor, the stamping pass
 * spawns ONE visual-only prop entity per flattened draw layer and records that
 * entity's render instructions here (keyed by entity id) on `world.setPieceProps`.
 *
 * The PhaserBridge prop pass consults this sidecar BEFORE the decoration-def
 * path so authored set pieces render with their own sprite, per-layer depth
 * (already straddling the entity plane via `setPieceZToDepth`), footprint, and
 * tint — enabling composites like a rug UNDER a banner UNDER the NPC, and a desk
 * IN FRONT of the NPC.
 *
 * These entities are deliberately visual-only: the stamping pass gives them
 * Position + Prop + Sprite + an immovable-tier Weight but NO Size, so they never
 * enter the collision grid and thus never participate in collision, knockback, or
 * pathing. (Weight is present because ADR 0044 makes positive Weight a universal
 * invariant for every Prop; it is inert here since a Size-less prop is never a
 * knockback target.) Set-piece dressing is purely cosmetic and must not affect
 * gameplay or balance.
 *
 * This type lives in `src/shared` (the leaf layer) so both `src/core`
 * (the stamping pass + world state) and `src/engine` (the renderer) can import
 * it without crossing a layer boundary.
 */

import type { SpriteRef } from './set-piece-types.js';

/** Per-entity render instructions for a single stamped set-piece prop layer. */
export interface SetPiecePropRender {
  /** The layer's sprite reference (catalog | sheet | custom). */
  readonly sprite: SpriteRef;
  /**
   * Final Phaser render depth for this layer. Computed at stamp time as
   * `setPieceZToDepth(prop.z)` plus a tiny per-layer epsilon so stacked layers
   * keep a stable order without crossing a depth band boundary.
   */
  readonly depth: number;
  /** Display width in feet (renderer multiplies by PIXELS_PER_FOOT). */
  readonly widthFt: number;
  /** Display height in feet. */
  readonly heightFt: number;
  /** Optional uniform scale multiplier applied on top of the footprint (1 = native). */
  readonly scale?: number;
  /** Optional tint as `#rrggbb`, applied to the sprite or placeholder. */
  readonly tintHex?: string;
  /** Human-readable label used for the placeholder fallback + debugging. */
  readonly label?: string;
}
