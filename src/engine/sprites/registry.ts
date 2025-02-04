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

const KENNEY_ROGUELIKE_CHARS = 'kenney-roguelike-characters';
const KENNEY_TINY_DUNGEON = 'kenney-tiny-dungeon';
const KENNEY_TINY_TOWN = 'kenney-tiny-town';
const KENNEY_TINY_BATTLE = 'kenney-tiny-battle';
const KENNEY_TINY_SKI = 'kenney-tiny-ski';
const KENNEY_ROGUELIKE_RPG = 'kenney-roguelike-rpg-pack';
const CUSTOM_PIXEL_SPRITES = 'custom-pixel-sprites';

type ImportMetaWithEnv = ImportMeta & { env?: { BASE_URL?: string } };
const ENV_BASE_PATH = (import.meta as ImportMetaWithEnv).env?.BASE_URL;
const BROWSER_BASE_PATH =
  typeof document === 'undefined' ? undefined : new URL('.', document.baseURI).pathname;

function withBasePath(path: string): string {
  const base = ENV_BASE_PATH ?? BROWSER_BASE_PATH ?? '/';
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
  if (base === '/') {
    return `/${normalizedPath}`;
  }
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  return `${normalizedBase}${normalizedPath}`;
}

export const SHEETS: ReadonlyArray<SpriteSheetDef> = [
  {
    key: KENNEY_ROGUELIKE_CHARS,
    path: withBasePath('/assets/kenney/roguelike-characters/spritesheet.png'),
    frameWidth: 16,
    frameHeight: 16,
    margin: 0,
    spacing: 1,
    cols: 54,
    rows: 12,
    description: 'Kenney Roguelike Characters (CC0). 918x203, 16x16 tiles, 1px gap.',
  },
  {
    key: KENNEY_TINY_DUNGEON,
    path: withBasePath('/assets/kenney/tiny-dungeon/spritesheet.png'),
    frameWidth: 16,
    frameHeight: 16,
    margin: 0,
    spacing: 1,
    cols: 12,
    rows: 11,
    description:
      'Kenney Tiny Dungeon (CC0). 203x186, 132 tiles (12x11). ' +
      'Characters, weapons, items, dungeon terrain, projectiles.',
  },
  {
    key: KENNEY_TINY_TOWN,
    path: withBasePath('/assets/kenney/tiny-town/spritesheet.png'),
    frameWidth: 16,
    frameHeight: 16,
    margin: 0,
    spacing: 1,
    cols: 12,
    rows: 11,
    description:
      'Kenney Tiny Town (CC0). 203x186, 132 tiles (12x11). ' +
      'Outdoor terrain, buildings, trees, NPCs, animals.',
  },
  {
    key: KENNEY_TINY_BATTLE,
    path: withBasePath('/assets/kenney/tiny-battle/spritesheet.png'),
    frameWidth: 16,
    frameHeight: 16,
    margin: 0,
    spacing: 1,
    cols: 18,
    rows: 11,
    description:
      'Kenney Tiny Battle (CC0). 305x186, 198 tiles (18x11). ' +
      'Soldiers, vehicles, military props.',
  },
  {
    key: KENNEY_TINY_SKI,
    path: withBasePath('/assets/kenney/tiny-ski/spritesheet.png'),
    frameWidth: 16,
    frameHeight: 16,
    margin: 0,
    spacing: 1,
    cols: 12,
    rows: 11,
    description: 'Kenney Tiny Ski (CC0). 203x186, 132 tiles (12x11). Winter biome.',
  },
  {
    key: KENNEY_ROGUELIKE_RPG,
    path: withBasePath('/assets/kenney/roguelike-rpg-pack/spritesheet.png'),
    frameWidth: 16,
    frameHeight: 16,
    margin: 0,
    spacing: 1,
    cols: 57,
    rows: 31,
    description:
      'Kenney Roguelike/RPG Pack (CC0). 968x526, ~1767 tiles (57x31). ' +
      'Floors, walls, roofs, flora, doors, furniture, mining, banners, UI.',
  },
  {
    key: CUSTOM_PIXEL_SPRITES,
    path: withBasePath('/assets/generated/custom-pixel-sprites.png'),
    frameWidth: 16,
    frameHeight: 16,
    margin: 1,
    spacing: 1,
    cols: 19,
    rows: 1,
    description: 'Custom generated pixel art sprites. 16x16 with 1px margin/spacing.',
  },
];

/** `(col, row) -> frame index` for a sheet with the given column count. */
function frameAt(cols: number, col: number, row: number): number {
  return row * cols + col;
}

// Derive column counts from SHEETS rather than re-declaring them so
// frame math can't drift if a sheet's metadata is edited.
const colsOf = (key: string): number => {
  const sheet = SHEETS.find((s) => s.key === key);
  if (!sheet) {
    throw new Error(`Unknown sheet key: ${key}`);
  }
  return sheet.cols;
};

const ROGUELIKE_COLS = colsOf(KENNEY_ROGUELIKE_CHARS);
const CUSTOM_COLS = colsOf(CUSTOM_PIXEL_SPRITES);
const TD_COLS = colsOf(KENNEY_TINY_DUNGEON);

export const SPRITES: ReadonlyArray<SpriteDef> = [
  {
    id: 'player',
    sheetKey: KENNEY_TINY_DUNGEON,
    frame: frameAt(TD_COLS, 0, 8),
    note: 'Tiny Dungeon knight (frame 96) — temp CC0 art.',
  },
  {
    id: 'enemy.goblin',
    sheetKey: KENNEY_TINY_DUNGEON,
    frame: frameAt(TD_COLS, 1, 10),
    note: 'Tiny Dungeon goblin (frame 121) — temp CC0 art.',
  },
  {
    id: 'enemy.orc',
    sheetKey: KENNEY_TINY_DUNGEON,
    frame: frameAt(TD_COLS, 1, 9),
    note: 'Tiny Dungeon brawler (frame 109) — temp CC0 art.',
  },
  {
    id: 'enemy.brigand',
    sheetKey: KENNEY_ROGUELIKE_CHARS,
    frame: frameAt(ROGUELIKE_COLS, 0, 7),
    note: 'Brown-cloaked humanoid.',
  },
  {
    id: 'enemy.ghost',
    sheetKey: KENNEY_ROGUELIKE_CHARS,
    frame: frameAt(ROGUELIKE_COLS, 1, 11),
    note: 'Pale spectral character (last row).',
  },
  {
    id: 'enemy.rat',
    sheetKey: KENNEY_TINY_DUNGEON,
    frame: frameAt(TD_COLS, 3, 10),
    note: 'Tiny Dungeon rat (frame 123) — temp CC0 art.',
  },
  {
    id: 'enemy.slime',
    sheetKey: KENNEY_TINY_DUNGEON,
    frame: frameAt(TD_COLS, 0, 9),
    note: 'Tiny Dungeon teal slime (frame 108) — temp CC0 art.',
  },
  {
    id: 'enemy.boss',
    sheetKey: KENNEY_TINY_DUNGEON,
    frame: frameAt(TD_COLS, 0, 10),
    note: 'Tiny Dungeon bat-beast (frame 120) — temp CC0 art.',
  },
  {
    id: 'npc.guide',
    sheetKey: KENNEY_TINY_DUNGEON,
    frame: frameAt(TD_COLS, 3, 8),
    note: 'Tiny Dungeon princess (frame 99) — temp CC0 art.',
  },
  {
    id: 'item.gem',
    sheetKey: CUSTOM_PIXEL_SPRITES,
    frame: frameAt(CUSTOM_COLS, 7, 0),
    note: 'Custom gem sprite.',
  },
  {
    id: 'effect.proj',
    sheetKey: CUSTOM_PIXEL_SPRITES,
    frame: frameAt(CUSTOM_COLS, 8, 0),
    note: 'Custom projectile sprite.',
  },
  {
    id: 'effect.enemy_proj',
    sheetKey: CUSTOM_PIXEL_SPRITES,
    frame: frameAt(CUSTOM_COLS, 9, 0),
    note: 'Custom enemy projectile sprite.',
  },
  {
    id: 'effect.aoe',
    sheetKey: CUSTOM_PIXEL_SPRITES,
    frame: frameAt(CUSTOM_COLS, 10, 0),
    note: 'Custom AoE sprite.',
  },
  {
    id: 'effect.enemy_aoe',
    sheetKey: CUSTOM_PIXEL_SPRITES,
    frame: frameAt(CUSTOM_COLS, 11, 0),
    note: 'Custom enemy AoE sprite.',
  },
  {
    id: 'weapon.returning',
    sheetKey: CUSTOM_PIXEL_SPRITES,
    frame: frameAt(CUSTOM_COLS, 12, 0),
    note: 'Custom returning weapon sprite.',
  },
  {
    id: 'effect.melee',
    sheetKey: CUSTOM_PIXEL_SPRITES,
    frame: frameAt(CUSTOM_COLS, 13, 0),
    note: 'Custom melee arc sprite.',
  },
  {
    id: 'effect.trap_arming',
    sheetKey: CUSTOM_PIXEL_SPRITES,
    frame: frameAt(CUSTOM_COLS, 14, 0),
    note: 'Custom trap arming sprite.',
  },
  {
    id: 'effect.trap_armed',
    sheetKey: CUSTOM_PIXEL_SPRITES,
    frame: frameAt(CUSTOM_COLS, 15, 0),
    note: 'Custom trap armed sprite.',
  },
  {
    id: 'effect.explosion',
    sheetKey: CUSTOM_PIXEL_SPRITES,
    frame: frameAt(CUSTOM_COLS, 16, 0),
    note: 'Custom explosion sprite.',
  },
  {
    id: 'effect.enemy_explosion',
    sheetKey: CUSTOM_PIXEL_SPRITES,
    frame: frameAt(CUSTOM_COLS, 17, 0),
    note: 'Custom enemy explosion sprite.',
  },
  {
    id: 'effect.dead',
    sheetKey: CUSTOM_PIXEL_SPRITES,
    frame: frameAt(CUSTOM_COLS, 18, 0),
    note: 'Custom dead marker sprite.',
  },
  // --- Weapon sprites (Kenney Tiny Dungeon CC0) ---
  {
    id: 'weapon.sword',
    sheetKey: KENNEY_TINY_DUNGEON,
    frame: frameAt(TD_COLS, 8, 8),
    note: 'Tiny Dungeon short sword — row 8 col 8 (frame 104).',
    anchor: { x: 8, y: 14 },
  },
  {
    id: 'weapon.bat',
    sheetKey: KENNEY_TINY_DUNGEON,
    frame: frameAt(TD_COLS, 9, 9),
    note: 'Tiny Dungeon wooden mallet used as baseball bat — row 9 col 9 (frame 117).',
    anchor: { x: 8, y: 14 },
  },
  {
    id: 'weapon.arrow',
    sheetKey: KENNEY_TINY_DUNGEON,
    frame: frameAt(TD_COLS, 11, 10),
    note: 'Tiny Dungeon arrow/bolt projectile — row 10 col 11 (frame 131).',
    anchor: { x: 8, y: 8 },
  },
];

const SPRITES_BY_ID: ReadonlyMap<string, SpriteDef> = new Map(SPRITES.map((s) => [s.id, s]));
const SHEETS_BY_KEY: ReadonlyMap<string, SpriteSheetDef> = new Map(SHEETS.map((s) => [s.key, s]));

/** Returns the sprite with the given logical ID, or undefined. */
export function getSprite(id: string): SpriteDef | undefined {
  return SPRITES_BY_ID.get(id);
}

/** Returns the sheet with the given Phaser texture key, or undefined. */
export function getSheet(key: string): SpriteSheetDef | undefined {
  return SHEETS_BY_KEY.get(key);
}
