/**
 * DialogueBox — a reusable, pixel-themed NPC dialogue panel.
 *
 * Renders a raised beveled panel (matching `pixel-ui` HUD chrome) with a gold
 * speaker name plate, wrapped body text, and a small beveled close button. The
 * whole thing lives inside a single container so depth-based camera masking
 * treats it as one screen-space UI object.
 *
 * Used by the main game scene (replacing the old flat dialogue text) and by the
 * UX snapshot lab so both render identical chrome.
 *
 * Engine layer only (Phaser allowed). No imports from core/game/labs.
 */
import Phaser from 'phaser';

import { PIXEL_UI } from './pixel-ui.js';
import { getUiScale, onUiScaleChange } from './ui-scale.js';
import { getSafeAreaInsets, onSafeAreaChange } from './safe-area.js';
import { getRenderScale } from './render-scale.js';
import { GAME } from '../shared/constants.js';

export interface DialogueBoxOptions {
  /** Panel width in px. Defaults to a readable width clamped to the screen. */
  width?: number;
  /** Container depth. Must sit in the UI band for camera masking. */
  depth?: number;
  /** Horizontal centre of the panel (screen space). Defaults to screen centre. */
  anchorX?: number;
  /** Bottom edge of the panel (screen space). Defaults near the screen bottom. */
  bottomY?: number;
  /** Invoked when the close button is clicked. */
  onClose?: () => void;
  /** Invoked when the player taps the panel body to advance the dialogue. */
  onAdvance?: () => void;
}

export interface DialogueBox {
  /** Set the speaker + line and show the panel body (close button unaffected). */
  showLine(speaker: string, line: string): void;
  /** Toggle the panel body (background + name plate + text). */
  setBodyVisible(visible: boolean): void;
  /** Toggle the close button independently of the body. */
  setCloseVisible(visible: boolean): void;
  /** Set the footer hint (e.g. "Tap to continue"). Pass null to hide it. */
  setHint(hint: string | null): void;
  /** Hide the whole box (body + close button). */
  hide(): void;
  /** Show/hide the entire container. */
  setVisible(visible: boolean): void;
  destroy(): void;
  readonly container: Phaser.GameObjects.Container;
}

const PAD = 14;
const NAME_H = 22;
const GAP = 8;
const NAME_COLOR = '#1a1206';
const BODY_COLOR = '#e8eefc';

export function createDialogueBox(
  scene: Phaser.Scene,
  options: DialogueBoxOptions = {},
): DialogueBox {
  const screenW = GAME.WIDTH;
  const screenH = GAME.HEIGHT;
  // Responsive UI: the dialogue box is built in local (design) coordinates and
  // the whole container is scaled by uiScale so its text and close button grow
  // on small screens. The panel width is clamped to the *virtual* viewport
  // (real width ÷ uiScale) so the scaled box never overflows the canvas.
  let uiScale = getUiScale(scene);
  const baseResolution = getRenderScale(scene);
  const virtualWidth = (): number => screenW / uiScale;
  const width = Math.round(options.width ?? Math.min(560, virtualWidth() - 48));
  const depth = options.depth ?? 1100;
  const anchorX = options.anchorX ?? screenW / 2;
  // Bottom anchor, lifted clear of the home-indicator band on notched devices
  // (`getSafeAreaInsets` is zero on desktop and when the band misses the canvas).
  const bottomY = (): number => (options.bottomY ?? screenH - 88) - getSafeAreaInsets(scene).bottom;

  const container = scene.add.container(0, 0).setDepth(depth).setScrollFactor(0).setVisible(false);

  // Beveled panel body (origin top-left, local coords inside the container).
  const body = scene.add
    .rectangle(0, 0, width, 80, PIXEL_UI.panelFill, 0.97)
    .setOrigin(0, 0)
    .setStrokeStyle(2, PIXEL_UI.border, 1);
  const bevelTop = scene.add.rectangle(0, 0, width, 2, PIXEL_UI.bevelLight).setOrigin(0, 0);
  const bevelLeft = scene.add.rectangle(0, 0, 2, 80, PIXEL_UI.bevelLight).setOrigin(0, 0);
  const bevelBottom = scene.add.rectangle(0, 78, width, 2, PIXEL_UI.bevelDark).setOrigin(0, 0);
  const bevelRight = scene.add.rectangle(width - 2, 0, 2, 80, PIXEL_UI.bevelDark).setOrigin(0, 0);

  // Gold speaker name plate (raised tab, dark text).
  const namePlate = scene.add
    .rectangle(PAD, PAD, 80, NAME_H, PIXEL_UI.gold, 1)
    .setOrigin(0, 0)
    .setStrokeStyle(1, PIXEL_UI.border, 1);
  const nameText = scene.add
    .text(PAD + 8, PAD + NAME_H / 2, '', {
      fontFamily: 'monospace',
      fontSize: '13px',
      fontStyle: 'bold',
      color: NAME_COLOR,
    })
    .setOrigin(0, 0.5)
    .setResolution(Math.max(1, Math.round(baseResolution * uiScale)));

  // Wrapped body line.
  const bodyText = scene.add
    .text(PAD, PAD + NAME_H + GAP, '', {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: BODY_COLOR,
      wordWrap: { width: width - PAD * 2 },
      lineSpacing: 3,
    })
    .setOrigin(0, 0)
    .setResolution(Math.max(1, Math.round(baseResolution * uiScale)));

  // Footer hint (e.g. "Tap to continue ▶") — bottom-right, dim gold.
  const hintText = scene.add
    .text(width - PAD, 0, '', {
      fontFamily: 'monospace',
      fontSize: '12px',
      fontStyle: 'bold',
      color: '#fcd34d',
    })
    .setOrigin(1, 1)
    .setResolution(Math.max(1, Math.round(baseResolution * uiScale)))
    .setVisible(false);

  // Beveled close button (top-right of the panel).
  const closeW = 64;
  const closeH = 22;
  const closeBg = scene.add
    .rectangle(width - PAD - closeW, PAD, closeW, closeH, 0x6e1f24, 1)
    .setOrigin(0, 0)
    .setStrokeStyle(1, PIXEL_UI.border, 1)
    .setInteractive({ useHandCursor: true });
  const closeBevelTop = scene.add
    .rectangle(width - PAD - closeW, PAD, closeW, 2, 0xd0626a)
    .setOrigin(0, 0);
  const closeBevelBottom = scene.add
    .rectangle(width - PAD - closeW, PAD + closeH - 2, closeW, 2, 0x3a0d10)
    .setOrigin(0, 0);
  const closeText = scene.add
    .text(width - PAD - closeW / 2, PAD + closeH / 2, 'Close', {
      fontFamily: 'monospace',
      fontSize: '12px',
      fontStyle: 'bold',
      color: '#ffe2e2',
    })
    .setOrigin(0.5, 0.5)
    .setResolution(Math.max(1, Math.round(baseResolution * uiScale)));

  closeBg.on('pointerover', () => closeBg.setFillStyle(0x8c2a30));
  closeBg.on('pointerout', () => closeBg.setFillStyle(0x6e1f24));
  closeBg.on('pointerdown', () => options.onClose?.());

  const closeParts: Phaser.GameObjects.GameObject[] = [
    closeBg,
    closeBevelTop,
    closeBevelBottom,
    closeText,
  ];

  // Tapping the panel body advances the dialogue (mobile-friendly target).
  if (options.onAdvance) {
    body.setInteractive({ useHandCursor: true });
    body.on('pointerdown', () => options.onAdvance?.());
  }

  container.add([
    body,
    bevelTop,
    bevelLeft,
    bevelBottom,
    bevelRight,
    namePlate,
    nameText,
    bodyText,
    hintText,
    ...closeParts,
  ]);

  let closeVisible = false;

  const HINT_RESERVE = 18;

  function relayout(): void {
    const hintReserve = hintText.visible ? HINT_RESERVE : 0;
    const h = Math.round(PAD + NAME_H + GAP + bodyText.height + hintReserve + PAD);
    body.setSize(width, h);
    bevelTop.setSize(width, 2);
    bevelLeft.setSize(2, h);
    bevelBottom.setPosition(0, h - 2).setSize(width, 2);
    bevelRight.setPosition(width - 2, 0).setSize(2, h);
    hintText.setPosition(width - PAD, h - PAD + 2);
    // Scale the whole box, then anchor its (scaled) bottom-centre at the target.
    container.setScale(uiScale);
    container.setPosition(
      Math.round(anchorX - (width * uiScale) / 2),
      Math.round(bottomY() - h * uiScale),
    );
  }

  relayout();

  const unsubscribeSafeArea = onSafeAreaChange(scene, () => {
    relayout();
  });

  const unsubscribeScale = onUiScaleChange(scene, (next) => {
    uiScale = next;
    const resolution = Math.max(1, Math.round(baseResolution * uiScale));
    nameText.setResolution(resolution);
    bodyText.setResolution(resolution);
    closeText.setResolution(resolution);
    hintText.setResolution(resolution);
    relayout();
  });

  function setCloseVisible(visible: boolean): void {
    closeVisible = visible;
    for (const part of closeParts) {
      (part as unknown as { setVisible(v: boolean): void }).setVisible(visible);
    }
  }
  setCloseVisible(false);

  return {
    container,
    showLine(speaker: string, line: string): void {
      nameText.setText(speaker);
      namePlate.setSize(Math.max(48, nameText.width + 16), NAME_H);
      bodyText.setText(line);
      relayout();
      container.setVisible(true);
    },
    setBodyVisible(visible: boolean): void {
      if (visible) {
        container.setVisible(true);
      } else {
        container.setVisible(false);
        setCloseVisible(false);
      }
    },
    setCloseVisible,
    setHint(hint: string | null): void {
      if (hint) {
        hintText.setText(hint).setVisible(true);
      } else {
        hintText.setVisible(false);
      }
      relayout();
    },
    hide(): void {
      setCloseVisible(false);
      container.setVisible(false);
    },
    setVisible(visible: boolean): void {
      container.setVisible(visible);
      if (!visible) setCloseVisible(false);
      else if (!closeVisible) setCloseVisible(false);
    },
    destroy(): void {
      unsubscribeScale();
      unsubscribeSafeArea();
      container.destroy();
    },
  };
}
