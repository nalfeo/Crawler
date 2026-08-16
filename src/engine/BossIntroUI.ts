/**
 * BossIntroUI — the boss-battle introduction lore sheet.
 *
 * Opened by `MainGameScene` the moment a boss encounter starts (see
 * `boss-intro-state.ts` for the trigger rules). While it is open the fixed
 * simulation step freezes — exactly like `LevelUpUI`/`RewardOpeningUI` — so the
 * player reads The Director's billing before taking a single hit.
 *
 * Presentation only: it never mutates world state. The caller owns the
 * "already introduced" bookkeeping and resumes the run from `onDismiss`.
 *
 * Input lock: a full-screen interactive backdrop swallows pointer events so
 * clicks never reach the world underneath, and `Space`/`Enter`/`Escape`
 * dismiss the sheet. A pointer only dismisses on release and only when it did
 * not travel — a vertical drag/swipe scrolls the copy instead, so touch-only
 * players can reach overflow lore that has no wheel or keyboard to scroll it.
 *
 * The portrait resolves through `resolveRenderKindPortraitTexture`, i.e. the
 * SAME art precedence the live renderer uses, so the sheet can never show a
 * different sprite than the boss the player is about to fight.
 *
 * The sheet is a FIXED size (`SHEET_WIDTH` x `SHEET_HEIGHT`): it never grows or
 * shrinks with the copy, so the frame does not jump between bosses. A Director
 * monologue longer than the flavour viewport scrolls a line at a time (mouse
 * wheel, arrow keys, page keys) behind a scrollbar instead of overflowing the
 * frame or shrinking the font until it is unreadable. An earlier draft clipped
 * its last paragraph through the footer; `getLayout()` exposes the measured
 * boxes so `tests/e2e/boss-intro-observation.test.ts` can assert containment
 * deterministically instead of relying on someone eyeballing a screenshot.
 */
import Phaser from 'phaser';
import { GAME } from '../shared/constants.js';
import type { BossIntroContent } from '../shared/boss-intro.js';
import { getRenderScale } from './render-scale.js';
import type { ScreenBounds } from './ui-scale.js';
import { resolveRenderKindPortraitTexture } from './PhaserBridge.js';
import { computeScrollThumb, computeScrollWindow } from './boss-intro-scroll.js';

const FONT_FAMILY = 'Segoe UI, Arial, sans-serif';

/** Sheet geometry, in the fixed GAME.WIDTH/HEIGHT design space. */
const SHEET_WIDTH = 680;
const PORTRAIT_BOX = 192;
const PADDING = 26;
/** Gap between the portrait column and the text column. */
const COLUMN_GAP = 22;
/** Fixed sheet height — the frame never resizes with the copy. */
const SHEET_HEIGHT = 340;
/** Vertical band reserved for the dismiss prompt at the bottom of the sheet. */
const FOOTER_BAND = 34;
const FLAVOR_FONT_SIZE = 14;
const FLAVOR_LINE_SPACING = 4;
/** Column reserved at the right of the text block for the scrollbar. */
const SCROLLBAR_GUTTER = 14;
const SCROLLBAR_WIDTH = 4;
/**
 * Pointer travel (design px) still treated as a tap rather than a swipe. Below
 * this a click/tap dismisses; above it the gesture only scrolls.
 */
const TAP_SLOP = 8;
const DEPTH = 6100;

export interface OpenBossIntroParams {
  /** Lore-sheet content for the boss being introduced. */
  readonly content: BossIntroContent;
  /**
   * The boss entity's appearance key, when it has one. Render kinds shared by
   * several bosses (every Floor 2 family boss is `enemy_family_boss`) resolve
   * their art through this key, so the portrait matches the sprite in the
   * arena instead of the render kind's default.
   */
  readonly appearanceKey?: string;
  /** Skip the entrance tween when the player prefers reduced motion. */
  readonly reducedMotion?: boolean;
  /** Fired exactly once per `open()`, when the sheet is dismissed. */
  readonly onDismiss: () => void;
}

/** Measured boxes of every rendered part of the sheet (design space). */
export interface BossIntroLayoutSnapshot {
  readonly panel: ScreenBounds;
  readonly portrait: ScreenBounds;
  readonly header: ScreenBounds;
  readonly name: ScreenBounds;
  readonly subtitle: ScreenBounds;
  /** The flavour VIEWPORT (fixed), not the full copy — long copy scrolls in it. */
  readonly flavor: ScreenBounds;
  readonly footer: ScreenBounds;
}

/** Scroll state of the flavour viewport, for labs/tests. */
export interface BossIntroScrollState {
  readonly scrollable: boolean;
  readonly index: number;
  readonly maxIndex: number;
  readonly visibleLines: number;
  readonly totalLines: number;
}

export interface BossIntroUI {
  open(params: OpenBossIntroParams): void;
  isOpen(): boolean;
  /** Dismiss the sheet, firing `onDismiss`. No-op while closed. */
  dismiss(): void;
  /** Test/automation affordance: intro id currently shown, or null. */
  getIntroId(): string | null;
  /** Test/automation affordance: measured layout, or null while closed. */
  getLayout(): BossIntroLayoutSnapshot | null;
  /** Test/automation affordance: flavour scroll state, or null while closed. */
  getScrollState(): BossIntroScrollState | null;
  /** Scroll the flavour copy by `delta` lines. No-op while closed. */
  scrollBy(delta: number): void;
  destroy(): void;
}

/** `0xRRGGBB` -> `#rrggbb` for Phaser text styles. */
function cssColor(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

interface MeasurableObject {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly originX?: number;
  readonly originY?: number;
}

function boundsOf(object: MeasurableObject): ScreenBounds {
  const originX = object.originX ?? 0;
  const originY = object.originY ?? 0;
  return {
    x: object.x - object.width * originX,
    y: object.y - object.height * originY,
    width: object.width,
    height: object.height,
  };
}

export function createBossIntroUI(scene: Phaser.Scene): BossIntroUI {
  const baseResolution = getRenderScale(scene);
  const centerX = GAME.WIDTH / 2;
  const centerY = GAME.HEIGHT / 2;
  const sheetLeft = centerX - SHEET_WIDTH / 2;
  const textLeft = sheetLeft + PADDING + PORTRAIT_BOX + COLUMN_GAP;
  const textWidth = SHEET_WIDTH - PADDING * 2 - PORTRAIT_BOX - COLUMN_GAP;
  /** Flavour copy wraps narrower than the column so the scrollbar has room. */
  const flavorWidth = textWidth - SCROLLBAR_GUTTER;
  const sheetTop = centerY - SHEET_HEIGHT / 2;

  const crispText = (
    x: number,
    y: number,
    text: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text =>
    scene.add.text(Math.round(x), Math.round(y), text, style).setResolution(baseResolution);

  const container = scene.add.container(0, 0).setDepth(DEPTH).setVisible(false).setScrollFactor(0);

  const backdrop = scene.add.rectangle(centerX, centerY, GAME.WIDTH, GAME.HEIGHT, 0x04060d, 0.86);
  backdrop.setInteractive();
  container.add(backdrop);

  const sheet = scene.add.rectangle(centerX, centerY, SHEET_WIDTH, SHEET_HEIGHT, 0x11131f, 0.98);
  sheet.setStrokeStyle(2, 0xffc65c, 0.9);
  container.add(sheet);

  const portraitFrame = scene.add.rectangle(
    sheetLeft + PADDING + PORTRAIT_BOX / 2,
    centerY,
    PORTRAIT_BOX,
    PORTRAIT_BOX,
    0x05070f,
    0.95,
  );
  portraitFrame.setStrokeStyle(1, 0xffc65c, 0.6);
  container.add(portraitFrame);

  const portrait = scene.add.image(portraitFrame.x, portraitFrame.y, '__cw_enemy_boss');
  portrait.setVisible(false);
  container.add(portrait);

  const header = crispText(textLeft, 0, '', {
    fontFamily: FONT_FAMILY,
    fontSize: '13px',
    color: '#ffc65c',
    wordWrap: { width: textWidth },
  });
  header.setOrigin(0, 0);
  container.add(header);

  const name = crispText(textLeft, 0, '', {
    fontFamily: FONT_FAMILY,
    fontSize: '26px',
    fontStyle: 'bold',
    color: '#f8fafc',
    wordWrap: { width: textWidth },
  });
  name.setOrigin(0, 0);
  container.add(name);

  const subtitle = crispText(textLeft, 0, '', {
    fontFamily: FONT_FAMILY,
    fontSize: '13px',
    color: '#9ca3af',
    wordWrap: { width: textWidth },
  });
  subtitle.setOrigin(0, 0);
  container.add(subtitle);

  const rule = scene.add.rectangle(textLeft, 0, textWidth, 1, 0xffc65c, 0.55).setOrigin(0, 0.5);
  container.add(rule);

  const flavor = crispText(textLeft, 0, '', {
    fontFamily: FONT_FAMILY,
    fontSize: `${FLAVOR_FONT_SIZE}px`,
    color: '#d6d9f1',
    lineSpacing: FLAVOR_LINE_SPACING,
    wordWrap: { width: flavorWidth },
  });
  flavor.setOrigin(0, 0);
  container.add(flavor);

  const scrollbarX = textLeft + textWidth - SCROLLBAR_WIDTH / 2;
  const scrollbarTrack = scene.add
    .rectangle(scrollbarX, 0, SCROLLBAR_WIDTH, 0, 0xffffff, 0.12)
    .setOrigin(0.5, 0);
  scrollbarTrack.setVisible(false);
  container.add(scrollbarTrack);

  const scrollbarThumb = scene.add
    .rectangle(scrollbarX, 0, SCROLLBAR_WIDTH, 0, 0xffc65c, 0.85)
    .setOrigin(0.5, 0);
  scrollbarThumb.setVisible(false);
  container.add(scrollbarThumb);

  const footer = crispText(centerX, 0, '', {
    fontFamily: FONT_FAMILY,
    fontSize: '12px',
    color: '#9ca3af',
  });
  footer.setOrigin(0.5, 0.5);
  container.add(footer);

  let openContent: BossIntroContent | null = null;
  let onDismissCallback: (() => void) | null = null;
  /** Wrapped flavour lines for the open sheet. */
  let flavorLines: readonly string[] = [];
  let flavorViewport: ScreenBounds = { x: textLeft, y: 0, width: flavorWidth, height: 0 };
  let visibleFlavorLines = 1;
  let scrollIndex = 0;
  /** Y of the last pointer sample while a pointer is down, else null. */
  let dragLastY: number | null = null;
  /** Total absolute pointer travel of the current gesture (design px). */
  let dragTravel = 0;
  /** Drag distance not yet converted into whole scrolled lines. */
  let dragRemainder = 0;

  /** Fit the boss art inside the portrait frame without distorting it. */
  function layoutPortrait(content: BossIntroContent, appearanceKey: string | undefined): void {
    const resolved = resolveRenderKindPortraitTexture(scene, content.renderKind, appearanceKey);
    if (scene.textures?.exists(resolved.key) !== true) {
      portrait.setVisible(false);
      return;
    }
    if (resolved.frame === undefined) {
      portrait.setTexture(resolved.key);
    } else {
      portrait.setTexture(resolved.key, resolved.frame);
    }
    const width = portrait.width;
    const height = portrait.height;
    if (width <= 0 || height <= 0) {
      // A degenerate texture would otherwise scale up into a giant blurry tile.
      portrait.setVisible(false);
      return;
    }
    const inner = PORTRAIT_BOX - 24;
    portrait.setScale(Math.min(inner / width, inner / height));
    portrait.setVisible(true);
  }

  /**
   * Largest number of leading lines that fit `viewportHeight`.
   *
   * Measured with the real Text object rather than derived from font metrics,
   * because line height depends on the resolved font and `lineSpacing`.
   */
  function measureVisibleLines(lines: readonly string[], viewportHeight: number): number {
    if (lines.length === 0) return 1;
    let fitting = 0;
    for (let count = 1; count <= lines.length; count++) {
      flavor.setText(lines.slice(0, count).join('\n'));
      if (flavor.height > viewportHeight) break;
      fitting = count;
    }
    return Math.max(1, fitting);
  }

  /** Re-render the visible line window and the scrollbar for `scrollIndex`. */
  function renderScrollWindow(): void {
    const window = computeScrollWindow(flavorLines.length, visibleFlavorLines, scrollIndex);
    scrollIndex = window.index;
    flavor.setText(flavorLines.slice(window.index, window.index + window.visibleLines).join('\n'));
    flavor.setY(Math.round(flavorViewport.y));

    scrollbarTrack.setVisible(window.scrollable);
    scrollbarThumb.setVisible(window.scrollable);
    if (!window.scrollable) return;

    scrollbarTrack.setPosition(scrollbarX, Math.round(flavorViewport.y));
    scrollbarTrack.setSize(SCROLLBAR_WIDTH, Math.round(flavorViewport.height));
    const thumb = computeScrollThumb(
      flavorViewport.y,
      flavorViewport.height,
      window,
      flavorLines.length,
    );
    scrollbarThumb.setPosition(scrollbarX, Math.round(thumb.y));
    scrollbarThumb.setSize(SCROLLBAR_WIDTH, Math.round(thumb.height));
  }

  function scrollBy(delta: number): void {
    if (!openContent || delta === 0) return;
    const before = scrollIndex;
    scrollIndex += delta;
    renderScrollWindow();
    if (scrollIndex !== before) {
      footer.setText(footerText());
    }
  }

  function footerText(): string {
    return computeScrollWindow(flavorLines.length, visibleFlavorLines, scrollIndex).scrollable
      ? 'Scroll or swipe for more · Click or press [Space] to begin the fight'
      : 'Click or press [Space] to begin the fight';
  }

  function render(content: BossIntroContent, appearanceKey: string | undefined): void {
    sheet.setStrokeStyle(2, content.accentColor, 0.9);
    portraitFrame.setStrokeStyle(1, content.accentColor, 0.6);
    rule.setFillStyle(content.accentColor, 0.55);

    header.setText(content.title.toUpperCase()).setColor(cssColor(content.accentColor));
    name.setText(content.name);
    subtitle.setText(content.subtitle);

    const contentTop = sheetTop + PADDING;
    header.setY(Math.round(contentTop));
    name.setY(Math.round(header.y + header.height + 6));
    subtitle.setY(Math.round(name.y + name.height + 6));
    rule.setY(Math.round(subtitle.y + subtitle.height + 12));

    // The viewport is whatever vertical room is left between the rule and the
    // footer band of the FIXED sheet; copy longer than that scrolls.
    const viewportTop = rule.y + 12;
    const viewportBottom = sheetTop + SHEET_HEIGHT - PADDING - FOOTER_BAND;
    const viewportHeight = Math.max(0, viewportBottom - viewportTop);
    flavorViewport = {
      x: textLeft,
      y: viewportTop,
      width: flavorWidth,
      height: viewportHeight,
    };

    flavor.setText(content.flavorLines.join('\n\n'));
    flavorLines = flavor.getWrappedText();
    visibleFlavorLines = measureVisibleLines(flavorLines, viewportHeight);
    scrollIndex = 0;
    renderScrollWindow();
    footer.setText(footerText());

    portraitFrame.setY(Math.round(contentTop + PORTRAIT_BOX / 2));
    portrait.setY(portraitFrame.y);

    footer.setY(Math.round(sheetTop + SHEET_HEIGHT - FOOTER_BAND / 2 - 4));

    layoutPortrait(content, appearanceKey);
  }

  function close(): void {
    openContent = null;
    onDismissCallback = null;
    flavorLines = [];
    scrollIndex = 0;
    dragLastY = null;
    dragTravel = 0;
    dragRemainder = 0;
    scrollbarTrack.setVisible(false);
    scrollbarThumb.setVisible(false);
    container.setVisible(false);
    scene.tweens.killTweensOf(container);
    container.setAlpha(1);
  }

  function handleDismiss(): void {
    if (!openContent) return;
    const callback = onDismissCallback;
    close();
    callback?.();
  }

  /** Height of one flavour line, used to convert drag distance into lines. */
  function flavorLineHeight(): number {
    return Math.max(1, flavorViewport.height / Math.max(1, visibleFlavorLines));
  }

  const pointerDownListener = (pointer: Phaser.Input.Pointer): void => {
    if (!openContent) return;
    dragLastY = pointer.y;
    dragTravel = 0;
    dragRemainder = 0;
  };
  backdrop.on('pointerdown', pointerDownListener);

  /**
   * Drag/swipe scrolling. Dragging UP pulls the copy up, i.e. moves the window
   * further down, matching the direction of every touch scroll surface.
   */
  const pointerMoveListener = (pointer: Phaser.Input.Pointer): void => {
    if (!openContent || dragLastY === null) return;
    const dy = pointer.y - dragLastY;
    dragLastY = pointer.y;
    dragTravel += Math.abs(dy);
    dragRemainder -= dy;
    const lineHeight = flavorLineHeight();
    while (dragRemainder >= lineHeight) {
      dragRemainder -= lineHeight;
      scrollBy(1);
    }
    while (dragRemainder <= -lineHeight) {
      dragRemainder += lineHeight;
      scrollBy(-1);
    }
  };
  scene.input.on('pointermove', pointerMoveListener);

  /** A release that never travelled is a tap/click, so it dismisses. */
  const pointerUpListener = (): void => {
    if (!openContent || dragLastY === null) return;
    const wasTap = dragTravel <= TAP_SLOP;
    dragLastY = null;
    dragRemainder = 0;
    if (wasTap) {
      handleDismiss();
    }
  };
  scene.input.on('pointerup', pointerUpListener);
  scene.input.on('pointerupoutside', pointerUpListener);

  const wheelListener = (
    _pointer: Phaser.Input.Pointer,
    _objects: unknown,
    _dx: number,
    dy: number,
  ): void => {
    if (!openContent || dy === 0) return;
    scrollBy(dy > 0 ? 1 : -1);
  };
  scene.input.on('wheel', wheelListener);

  const keyListener = (event: KeyboardEvent): void => {
    if (!openContent) return;
    switch (event.code) {
      case 'Enter':
      case 'Space':
      case 'Escape':
        event.preventDefault();
        handleDismiss();
        break;
      case 'ArrowDown':
        event.preventDefault();
        scrollBy(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        scrollBy(-1);
        break;
      case 'PageDown':
        event.preventDefault();
        scrollBy(visibleFlavorLines);
        break;
      case 'PageUp':
        event.preventDefault();
        scrollBy(-visibleFlavorLines);
        break;
      default:
        break;
    }
  };
  scene.input.keyboard?.on('keydown', keyListener);

  return {
    open(params: OpenBossIntroParams): void {
      openContent = params.content;
      onDismissCallback = params.onDismiss;
      render(params.content, params.appearanceKey);
      container.setVisible(true);
      if (params.reducedMotion === true) {
        container.setAlpha(1);
      } else {
        container.setAlpha(0);
        scene.tweens.add({
          targets: container,
          alpha: 1,
          duration: 180,
          ease: 'Cubic.easeOut',
        });
      }
    },
    isOpen(): boolean {
      return openContent !== null;
    },
    dismiss: handleDismiss,
    getIntroId(): string | null {
      return openContent?.introId ?? null;
    },
    getLayout(): BossIntroLayoutSnapshot | null {
      if (!openContent) {
        return null;
      }
      return {
        panel: boundsOf(sheet),
        portrait: boundsOf(portraitFrame),
        header: boundsOf(header),
        name: boundsOf(name),
        subtitle: boundsOf(subtitle),
        flavor: { ...flavorViewport },
        footer: boundsOf(footer),
      };
    },
    getScrollState(): BossIntroScrollState | null {
      if (!openContent) {
        return null;
      }
      const window = computeScrollWindow(flavorLines.length, visibleFlavorLines, scrollIndex);
      return {
        scrollable: window.scrollable,
        index: window.index,
        maxIndex: window.maxIndex,
        visibleLines: window.visibleLines,
        totalLines: flavorLines.length,
      };
    },
    scrollBy,
    destroy(): void {
      backdrop.off('pointerdown', pointerDownListener);
      scene.input.off('pointermove', pointerMoveListener);
      scene.input.off('pointerup', pointerUpListener);
      scene.input.off('pointerupoutside', pointerUpListener);
      scene.input.off('wheel', wheelListener);
      scene.input.keyboard?.off('keydown', keyListener);
      close();
      container.destroy(true);
    },
  };
}
