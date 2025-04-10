/**
 * pixel-ui — shared pixel-art UI theme + builders for the HUD.
 *
 * Centralises the look of HUD chrome so health/XP/timer/quest panels read as a
 * single cohesive "modern pixel game" UI rather than flat debug rectangles:
 *   - a dark slate palette with crisp light/dark bevels (raised-panel look)
 *   - inset stat bars with a glossy top shine and segment ticks
 *   - small generated pixel-art icon textures (heart, XP spark, gem, coin,
 *     potion, quest scroll)
 *
 * All builders return plain `{ destroy() }`-style handles and never own world
 * state, so HUD factories keep their existing `sync`/`destroy` contracts.
 *
 * Engine layer only (Phaser allowed). No imports from core/game/labs.
 */
import Phaser from 'phaser';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export const PIXEL_UI = {
  /** Panel body fill. */
  panelFill: 0x161c2c,
  /** Inset track (behind bar fills). */
  trackFill: 0x0a0e18,
  /** Top/left bevel highlight. */
  bevelLight: 0x4a5878,
  /** Bottom/right bevel shadow. */
  bevelDark: 0x080b14,
  /** Outer 1px border. */
  border: 0x02040a,
  /** Glossy shine overlaid on bar fills. */
  shine: 0xffffff,
  /** Accent gold for titles/markers. */
  gold: 0xfcd34d,
  /** Bar fill colours. */
  hpHigh: 0x46d369,
  hpMid: 0xf2b542,
  hpLow: 0xe23b3b,
  xpFill: 0x4ea8ff,
} as const;

/** Standard depth band for HUD chrome. Panels sit just behind bars/text. */
export const PIXEL_UI_DEPTH = {
  panel: 999,
  content: 1000,
  overlay: 1001,
} as const;

// ---------------------------------------------------------------------------
// Beveled panel
// ---------------------------------------------------------------------------

export interface BeveledPanelOptions {
  fill?: number;
  fillAlpha?: number;
  highlight?: number;
  shadow?: number;
  border?: number;
  depth?: number;
  scrollFactor?: number;
  /** Optional container to parent all created rectangles into (for group scaling). */
  parent?: Phaser.GameObjects.Container;
}

export interface BeveledPanel {
  readonly visible: boolean;
  setVisible(visible: boolean): void;
  getBounds(): { x: number; y: number; width: number; height: number };
  /** Move the top-left corner. */
  setPosition(x: number, y: number): void;
  /** Resize (origin stays at the panel's top-left corner). */
  setSize(width: number, height: number): void;
  destroy(): void;
}

/**
 * Build a raised pixel panel from rectangles: a filled body with a 1px dark
 * border, a light top/left bevel, and a dark bottom/right bevel. Origin is the
 * top-left corner, so callers position with screen coords directly.
 */
export function createBeveledPanel(
  scene: Phaser.Scene,
  x: number,
  y: number,
  width: number,
  height: number,
  options: BeveledPanelOptions = {},
): BeveledPanel {
  const fill = options.fill ?? PIXEL_UI.panelFill;
  const fillAlpha = options.fillAlpha ?? 0.92;
  const highlight = options.highlight ?? PIXEL_UI.bevelLight;
  const shadow = options.shadow ?? PIXEL_UI.bevelDark;
  const border = options.border ?? PIXEL_UI.border;
  const depth = options.depth ?? PIXEL_UI_DEPTH.panel;
  const scrollFactor = options.scrollFactor ?? 0;

  let px = x;
  let py = y;
  let pw = width;
  let ph = height;

  const body = scene.add
    .rectangle(px, py, pw, ph, fill, fillAlpha)
    .setOrigin(0, 0)
    .setStrokeStyle(2, border, 1)
    .setScrollFactor(scrollFactor)
    .setDepth(depth);

  const top = scene.add
    .rectangle(px, py, pw, 2, highlight)
    .setOrigin(0, 0)
    .setScrollFactor(scrollFactor)
    .setDepth(depth);
  const left = scene.add
    .rectangle(px, py, 2, ph, highlight)
    .setOrigin(0, 0)
    .setScrollFactor(scrollFactor)
    .setDepth(depth);
  const bottom = scene.add
    .rectangle(px, py + ph - 2, pw, 2, shadow)
    .setOrigin(0, 0)
    .setScrollFactor(scrollFactor)
    .setDepth(depth);
  const right = scene.add
    .rectangle(px + pw - 2, py, 2, ph, shadow)
    .setOrigin(0, 0)
    .setScrollFactor(scrollFactor)
    .setDepth(depth);

  options.parent?.add([body, top, left, bottom, right]);

  function reflow(): void {
    body.setPosition(px, py).setSize(pw, ph);
    top.setPosition(px, py).setSize(pw, 2);
    left.setPosition(px, py).setSize(2, ph);
    bottom.setPosition(px, py + ph - 2).setSize(pw, 2);
    right.setPosition(px + pw - 2, py).setSize(2, ph);
  }

  return {
    get visible(): boolean {
      return body.visible || top.visible || left.visible || bottom.visible || right.visible;
    },
    setVisible(visible: boolean): void {
      body.setVisible(visible);
      top.setVisible(visible);
      left.setVisible(visible);
      bottom.setVisible(visible);
      right.setVisible(visible);
    },
    getBounds(): { x: number; y: number; width: number; height: number } {
      return { x: px, y: py, width: pw, height: ph };
    },
    setPosition(nx: number, ny: number): void {
      px = nx;
      py = ny;
      reflow();
    },
    setSize(nw: number, nh: number): void {
      pw = nw;
      ph = nh;
      reflow();
    },
    destroy(): void {
      body.destroy();
      top.destroy();
      left.destroy();
      bottom.destroy();
      right.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Inset stat bar
// ---------------------------------------------------------------------------

export interface StatBarOptions {
  fill?: number;
  depth?: number;
  scrollFactor?: number;
  /** Pixel width of one segment tick gap. 0 disables ticks. */
  segment?: number;
  /** Optional container to parent all created objects into (for group scaling). */
  parent?: Phaser.GameObjects.Container;
}

export interface StatBar {
  readonly fill: Phaser.GameObjects.Rectangle;
  setPercent(pct: number): void;
  setColor(color: number): void;
  setVisible(visible: boolean): void;
  destroy(): void;
}

/**
 * Build an inset stat bar: a dark track, a coloured fill anchored left, a
 * glossy top shine, and optional vertical segment ticks. The fill object is
 * exposed so callers can drive their own pulse/flash tweens.
 */
export function createStatBar(
  scene: Phaser.Scene,
  x: number,
  y: number,
  width: number,
  height: number,
  options: StatBarOptions = {},
): StatBar {
  const fillColor = options.fill ?? PIXEL_UI.hpHigh;
  const depth = options.depth ?? PIXEL_UI_DEPTH.content;
  const scrollFactor = options.scrollFactor ?? 0;
  const segment = options.segment ?? 0;

  const innerW = width - 2;
  const innerH = height - 2;
  const innerX = x + 1;
  const innerY = y + 1;

  const track = scene.add
    .rectangle(x, y, width, height, PIXEL_UI.trackFill, 1)
    .setOrigin(0, 0)
    .setStrokeStyle(1, PIXEL_UI.border, 1)
    .setScrollFactor(scrollFactor)
    .setDepth(depth);

  const fill = scene.add
    .rectangle(innerX, innerY, innerW, innerH, fillColor, 1)
    .setOrigin(0, 0)
    .setScrollFactor(scrollFactor)
    .setDepth(depth + 1);

  // Glossy top shine across the top third of the fill.
  const shine = scene.add
    .rectangle(innerX, innerY, innerW, Math.max(1, Math.floor(innerH / 3)), PIXEL_UI.shine, 0.18)
    .setOrigin(0, 0)
    .setScrollFactor(scrollFactor)
    .setDepth(depth + 2);

  const ticks: Phaser.GameObjects.Rectangle[] = [];
  if (segment > 0) {
    for (let tx = innerX + segment; tx < innerX + innerW - 1; tx += segment) {
      ticks.push(
        scene.add
          .rectangle(Math.round(tx), innerY, 1, innerH, PIXEL_UI.border, 0.45)
          .setOrigin(0, 0)
          .setScrollFactor(scrollFactor)
          .setDepth(depth + 3),
      );
    }
  }

  let lastPct = 1;

  options.parent?.add([track, fill, shine, ...ticks]);

  function applyWidth(pct: number): void {
    const w = Math.max(0, Math.min(1, pct)) * innerW;
    const drawn = Math.max(1, Math.round(w));
    fill.setSize(drawn, innerH);
    shine.setSize(drawn, Math.max(1, Math.floor(innerH / 3)));
  }

  return {
    fill,
    setPercent(pct: number): void {
      lastPct = pct;
      applyWidth(pct);
    },
    setColor(color: number): void {
      fill.setFillStyle(color);
    },
    setVisible(visible: boolean): void {
      track.setVisible(visible);
      fill.setVisible(visible);
      shine.setVisible(visible);
      for (const t of ticks) t.setVisible(visible);
      if (visible) applyWidth(lastPct);
    },
    destroy(): void {
      track.destroy();
      fill.destroy();
      shine.destroy();
      for (const t of ticks) t.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Pixel icon textures
// ---------------------------------------------------------------------------

export const PIXEL_ICON = {
  heart: '__cw_ui_heart',
  xp: '__cw_ui_xp',
  gem: '__cw_ui_gem',
  coin: '__cw_ui_coin',
  potion: '__cw_ui_potion',
  quest: '__cw_ui_quest',
  junk: '__cw_ui_junk',
} as const;

/** Each glyph is an 8×8 grid drawn at `cell` px per pixel (→ 16×16 texture). */
const ICON_CELL = 2;

function drawPixels(
  g: Phaser.GameObjects.Graphics,
  rows: readonly string[],
  palette: Readonly<Record<string, number>>,
): void {
  for (let y = 0; y < rows.length; y += 1) {
    const row = rows[y]!;
    for (let x = 0; x < row.length; x += 1) {
      const color = palette[row[x]!];
      if (color === undefined) continue;
      g.fillStyle(color, 1);
      g.fillRect(x * ICON_CELL, y * ICON_CELL, ICON_CELL, ICON_CELL);
    }
  }
}

interface IconDef {
  key: string;
  rows: readonly string[];
  palette: Readonly<Record<string, number>>;
}

const ICONS: readonly IconDef[] = [
  {
    key: PIXEL_ICON.heart,
    rows: [
      ' kk  kk ',
      'kwwRkRRk',
      'kwRRRRRk',
      'kRRRRRRk',
      ' kRRRRk ',
      '  kRRk  ',
      '   kk   ',
      '        ',
    ],
    palette: { k: 0x4a0d12, R: 0xe23b3b, w: 0xff9aa2 },
  },
  {
    key: PIXEL_ICON.xp,
    rows: [
      '   bb   ',
      '   bb   ',
      'b  bb  b',
      'bbbwwbbb',
      'bbbwwbbb',
      'b  bb  b',
      '   bb   ',
      '   bb   ',
    ],
    palette: { b: 0x4ea8ff, w: 0xeaf6ff },
  },
  {
    key: PIXEL_ICON.gem,
    rows: [
      '  kkkk  ',
      ' klllhk ',
      'kllhhrrk',
      'klhhrrrk',
      'kdhrrrdk',
      ' kdrrdk ',
      '  kddk  ',
      '   kk   ',
    ],
    palette: { k: 0x0b3038, l: 0x9af0ff, h: 0x4fd6e8, r: 0x1f9fb8, d: 0x0e6173 },
  },
  {
    key: PIXEL_ICON.coin,
    rows: [
      '  kkkk  ',
      ' kwgggk ',
      'kwggggGk',
      'kggggGGk',
      'kgggGGGk',
      'kgGGGGGk',
      ' kGGGGk ',
      '  kkkk  ',
    ],
    palette: { k: 0x6b4a08, g: 0xffd24a, G: 0xd79320, w: 0xfff4c2 },
  },
  {
    key: PIXEL_ICON.potion,
    rows: [
      '   kk   ',
      '   kk   ',
      '  kwwk  ',
      ' kwrrwk ',
      ' krRRrk ',
      ' kRRRRk ',
      ' kRRRRk ',
      '  kkkk  ',
    ],
    palette: { k: 0x231018, w: 0xbfe9ff, r: 0xff6a6a, R: 0xd62f3a },
  },
  {
    key: PIXEL_ICON.quest,
    rows: [
      ' kkkkkk ',
      ' kppppk ',
      ' kpttpk ',
      ' kppppk ',
      ' kpttpk ',
      ' kppppk ',
      ' kkkkkk ',
      '        ',
    ],
    palette: { k: 0x5b4326, p: 0xf5e6c0, t: 0x9a7b45 },
  },
  {
    key: PIXEL_ICON.junk,
    rows: [
      '  hhhh  ',
      ' hDDDDh ',
      'hDDkkDDh',
      'hDkSSkDh',
      'hDkSSkDh',
      'hDDkkDDh',
      ' hDDDDh ',
      '  hhhh  ',
    ],
    palette: { h: 0x2a2e38, D: 0x8b94a3, k: 0x3a3f4a, S: 0xc2cad6 },
  },
];

/**
 * Generate the shared pixel-art icon textures once per scene. Safe to call
 * every time a HUD element is created — existing textures are left untouched.
 */
function ensurePixelUiTextures(scene: Phaser.Scene): void {
  const first = ICONS[0]!;
  if (scene.textures.exists(first.key)) return;

  const g = scene.add.graphics();
  for (const icon of ICONS) {
    if (scene.textures.exists(icon.key)) continue;
    g.clear();
    drawPixels(g, icon.rows, icon.palette);
    const size = icon.rows.length * ICON_CELL;
    g.generateTexture(icon.key, size, size);
  }
  g.destroy();
}

/**
 * Add a pixel icon image at the given position. Returns the image so the caller
 * can manage depth/visibility/lifecycle.
 */
export function addPixelIcon(
  scene: Phaser.Scene,
  key: string,
  x: number,
  y: number,
  options: {
    depth?: number;
    scrollFactor?: number;
    scale?: number;
    origin?: number;
    parent?: Phaser.GameObjects.Container;
  } = {},
): Phaser.GameObjects.Image {
  ensurePixelUiTextures(scene);
  const image = scene.add
    .image(x, y, key)
    .setOrigin(options.origin ?? 0.5, options.origin ?? 0.5)
    .setScale(options.scale ?? 1)
    .setScrollFactor(options.scrollFactor ?? 0)
    .setDepth(options.depth ?? PIXEL_UI_DEPTH.overlay);
  options.parent?.add(image);
  return image;
}
