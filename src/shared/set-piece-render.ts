/**
 * Render sidecar for stamped set-piece props.
 *
 * A set piece is authored as themed props, each with an ordered stack of sprite
 * `layers`. When a set piece is stamped into a real floor, the stamping pass
 * flattens each prop into ONE render-only instance per draw layer and appends
 * them, in draw order, to the `world.setPieceProps` list.
 *
 * These instances are deliberately NOT ECS entities. Set-piece dressing is
 * purely cosmetic, and turning every layer into a `createEntity` would allocate
 * entity ids ahead of the run's gameplay spawns (ambient mobs, drops, …),
 * shifting their ids and thereby perturbing collision-pair enumeration order and
 * the global RNG draw order — a real, seed-visible gameplay change for content
 * that must have none. Keeping props off the entity space mirrors how this
 * codebase already treats other render-only concerns (VFX are events on
 * `world.vfxEvents`, never entities), and guarantees the headless simulation and
 * the rendered game agree byte-for-byte regardless of how much dressing a floor
 * carries.
 *
 * The PhaserBridge renders this list in a dedicated pass (after the ECS Prop
 * pass), honouring each layer's own sprite, per-layer depth (already straddling
 * the entity plane via `setPieceZToDepth`), footprint, and tint — enabling
 * composites like a rug UNDER a banner UNDER the NPC, and a desk IN FRONT of the
 * NPC.
 *
 * These types live in `src/shared` (the leaf layer) so both `src/core`
 * (the stamping pass + world state) and `src/engine` (the renderer) can import
 * them without crossing a layer boundary.
 */

import type { SpriteRef } from './set-piece-types.js';

/** Per-layer render instructions for a single stamped set-piece prop layer. */
export interface SetPiecePropRender {
  /** The layer's sprite reference (catalog | sheet | custom). */
  readonly sprite: SpriteRef;
  /**
   * Final Phaser render depth for this layer. Computed at stamp time as
   * `setPieceZToDepth(prop.z)` plus a tiny per-layer epsilon so stacked layers
   * keep a stable order without crossing a depth band boundary.
   */
  readonly depth: number;
  /** True horizontal width in feet (renderer multiplies by PIXELS_PER_FOOT). */
  readonly widthFt: number;
  /**
   * Apparent VERTICAL height in feet — how tall the object stands, not its
   * depth across the floor. Crawler's prop art is front-elevation, so a
   * sprite's vertical pixels are the object's height. See `SpriteLayer`.
   */
  readonly heightFt: number;
  /**
   * True when the prop lies IN the floor plane (rug, stain, tape, seam), so both
   * declared feet are real ground extents and the renderer must honour both via
   * an aspect-preserving contain-fit. Upright props are height-authoritative
   * instead: their width follows the art, so a tall object can never be silently
   * flattened by a conservative declared width.
   */
  readonly floorPlane?: boolean;
  /** Anchor by bottom-centre (object stands on its position) instead of centre. */
  readonly anchorBase?: boolean;
  /** Optional uniform scale multiplier applied on top of the footprint (1 = native). */
  readonly scale?: number;
  /** Mirror the sprite horizontally / vertically at render time. */
  readonly flipX?: boolean;
  readonly flipY?: boolean;
  /** Optional clockwise rotation in degrees. */
  readonly rotationDeg?: number;
  /** Optional tint as `#rrggbb`, applied to the sprite or placeholder. */
  readonly tintHex?: string;
  /** Human-readable label used for the placeholder fallback + debugging. */
  readonly label?: string;
}

/**
 * A single render-only set-piece prop instance held on `world.setPieceProps`.
 *
 * One entry per flattened set-piece draw layer, in draw order. Carries the
 * layer's world-space position (feet) alongside its {@link SetPiecePropRender}
 * so the renderer needs no ECS `Position` lookup — these instances are NOT
 * entities and consume no entity ids (see the module doc for why).
 */
export interface SetPiecePropInstance {
  /** World X in feet (footprint centre + layer offset). */
  readonly x: number;
  /** World Y in feet (footprint centre + layer offset). */
  readonly y: number;
  /** Render instructions consumed by the engine's set-piece prop pass. */
  readonly render: SetPiecePropRender;
}
