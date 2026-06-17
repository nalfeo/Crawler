/**
 * Engine-only sprite registry.
 *
 * Single source of truth for every CC0 Kenney sprite the engine knows
 * how to load. Both `BootScene.preload()` and `PhaserBridge` consume
 * this module so the loader and the renderer cannot drift out of sync.
 *
 * No imports from `src/core/`, `src/game/`, or `src/labs/`.
 *
 * Conventions
 * -----------
 * * Logical IDs are dotted strings (`'player'`, `'enemy.goblin'`).
 * * Every sprite belongs to exactly one *sheet*. A sheet has a
 *   stable Phaser texture key, a public/-relative `path`, and the
 *   geometry needed for `Phaser.Loader.LoaderPlugin#spritesheet`.
 * * Every sprite picks one frame index inside its sheet. For a
 *   spritesheet with N columns the frame index is `row * N + col`.
 * * Adding a new sprite is data-only: extend `SHEETS` and/or
 *   `SPRITES`. No code changes elsewhere required for a sprite to
 *   become loadable.
 */
import type { SpriteAnchor } from '../../shared/sprite-anchor.js';
export type { SpriteAnchor } from '../../shared/sprite-anchor.js';
/**
 * Geometry of a Kenney spritesheet, fed verbatim to Phaser's
 * `load.spritesheet()` config plus our own `cols` for index math.
 */
export interface SpriteSheetDef {
  /** Stable Phaser texture key. */
  readonly key: string;
  /** URL path served by Vite's `public/`. */
  readonly path: string;
  /** Tile width in pixels. */
  readonly frameWidth: number;
  /** Tile height in pixels. */
  readonly frameHeight: number;
  /** Outer margin around the sheet, in pixels. */
  readonly margin: number;
  /** Gap between tiles, in pixels. */
  readonly spacing: number;
  /** Number of tile columns. Used to translate (col, row) -> frame index. */
  readonly cols: number;
  /** Number of tile rows. Used together with cols for frame-bounds validation. */
  readonly rows: number;
  /** Human-readable note about the sheet, surfaced in the lab. */
  readonly description: string;
}
/** A single logical sprite resolved to (sheet, frame). */
export interface SpriteDef {
  /** Logical sprite ID, e.g. `'player'` or `'enemy.goblin'`. */
  readonly id: string;
  /** Key into {@link SHEETS}. */
  readonly sheetKey: string;
  /** Frame index inside the sheet. */
  readonly frame: number;
  /**
   * Optional 2D pixel anchor in the sprite's native frame. Marks the pixel that
   * pins to a holder — typically the grip on a hand-held weapon. Coordinates
   * are integers in `[0, frameWidth)` × `[0, frameHeight)`. When omitted, the
   * renderer should fall back to the bottom-center default (8, 14) for
   * hand-held 16x16 sprites via `resolveHandheldAnchor()` from
   * `src/shared/sprite-anchor`.
   *
   * No runtime consumer reads this yet — equipped-item rendering is still on
   * the roadmap. The field exists so sprite-registry data can declare anchors
   * alongside the (sheet, frame) they describe, matching the brief schema in
   * the sprite-generation pipeline.
   */
  readonly anchor?: SpriteAnchor;
  /** Optional human-readable note for documentation purposes. */
  readonly note?: string;
}
export declare const SHEETS: ReadonlyArray<SpriteSheetDef>;
export declare const SPRITES: ReadonlyArray<SpriteDef>;
/** Returns the sprite with the given logical ID, or undefined. */
export declare function getSprite(id: string): SpriteDef | undefined;
/** Returns the sheet with the given Phaser texture key, or undefined. */
export declare function getSheet(key: string): SpriteSheetDef | undefined;
//# sourceMappingURL=registry.d.ts.map
