/**
 * IntroScene — Director welcome + player identity (name & gender).
 *
 * Shown once before the game boots, in the shipped game only. Labs and
 * headless runs skip this scene automatically:
 *   - URL contains `?lab=` or pathname ends with `lab.html` → skip.
 *   - Headless Node.js runs never create a Phaser game, so this never fires.
 *
 * On confirm the chosen name and gender are stored in the Phaser game
 * registry under `INTRO_DATA_REGISTRY_KEY` and the BootScene is started.
 * MainGameScene reads that key in its `create()` and applies the values to
 * the world.
 */
import Phaser from 'phaser';
import { GAME } from '../../shared/constants.js';
import { createBeveledButton, createBeveledPanel, PIXEL_UI } from '../pixel-ui.js';
import { getRenderScale } from '../render-scale.js';
import { applyCrispText } from '../ui-scale.js';
import { MIN_TEXT_RESOLUTION } from '../ui-theme.js';
import { BootScene } from './BootScene.js';
import {
  INTRO_DATA_REGISTRY_KEY,
  DEFAULT_PLAYER_NAME,
  DEFAULT_PLAYER_GENDER,
  type PlayerGender,
} from '../../shared/intro-config.js';

declare global {
  interface Window {
    __introDebug?: {
      getState: () => {
        renderScale: number;
        cameraZoom: number;
        cameraOriginX: number;
        cameraOriginY: number;
        selectedGender: PlayerGender;
      };
    };
  }
}

const GENDER_OPTIONS: ReadonlyArray<{ id: PlayerGender; label: string }> = [
  { id: 'female', label: 'She / Her' },
  { id: 'male', label: 'He / Him' },
  { id: 'other', label: 'They / Them' },
];

/** Director introduction text shown at the top of the screen. */
const DIRECTOR_WELCOME =
  'Welcome, Contestant. The dungeon cameras are hot and the\n' +
  'audience is watching. Before you descend, tell us who you\n' +
  'are, and how you want the show to address you.';

/**
 * Rounds a CSS pixel value to the nearest integer. Native DOM elements
 * (the name `<input>` and pronoun `<fieldset>`) are positioned/sized from
 * fractional canvas-scale math; fractional CSS pixel values force the
 * browser into sub-pixel font rendering, which reads as blurry text even
 * though Phaser's own crisp-text pipeline is unaffected (that only covers
 * canvas-rendered text, not overlaid HTML elements).
 */
function px(value: number): number {
  return Math.round(value);
}

/** Returns true when the current page is a lab (skip intro). */
function isLabContext(): boolean {
  if (typeof window === 'undefined') {
    return true; // headless / non-browser
  }
  const params = new URLSearchParams(window.location.search);
  if (params.has('lab')) {
    return true;
  }
  // lab.html is the lab entry point
  if (window.location.pathname.endsWith('lab.html')) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Visual constants (matching the monospace HUD aesthetic)
// ---------------------------------------------------------------------------

const BG_COLOR = 0x080910;
const PANEL_COLOR = PIXEL_UI.panelFill;
const PANEL_ALPHA = 0.97;
const BORDER_COLOR = PIXEL_UI.border;
const GOLD_COLOR = '#fcd34d';
const SLATE_LIGHT = '#cbd5e1';
const SLATE_DIM = '#94a3b8';
const INPUT_BG = '#0a0e18';
const BUTTON_TEXT_DEFAULT = '#94a3b8';
const BUTTON_TEXT_SELECTED = '#f8fafc';
const CONFIRM_COLOR = 0x1e4620;
const CONFIRM_HOVER_COLOR = 0x276129;
const CONFIRM_TEXT = '#86efac';
const DIRECTOR_LABEL = 'Director';
const BUTTON_DEFAULT_BORDER = '#1e293b';
const BUTTON_SELECTED_BORDER = '#4a6fa5';
const BUTTON_DEFAULT_BACKGROUND = '#1e293b';
const BUTTON_SELECTED_BACKGROUND = '#3b4f72';
const NAME_INPUT_ARIA_LABEL = 'Player name';
const GENDER_GROUP_ARIA_LABEL = 'Player gender';

const PANEL_W = 700;
const PANEL_H = 476;
const PANEL_X = (GAME.WIDTH - PANEL_W) / 2;
const PANEL_Y = (GAME.HEIGHT - PANEL_H) / 2;
const DEPTH = 2000;

export class IntroScene extends Phaser.Scene {
  static readonly KEY = 'IntroScene';

  private nameInput?: HTMLInputElement;
  private genderFieldset?: HTMLFieldSetElement;
  private selectedGender: PlayerGender = DEFAULT_PLAYER_GENDER;
  private genderControls: Array<{
    input: HTMLInputElement;
    label: HTMLLabelElement;
    id: PlayerGender;
  }> = [];
  private unsubscribeCrispText?: () => void;

  constructor() {
    super({ key: IntroScene.KEY });
  }

  create(): void {
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.handleShutdown());

    // Auto-skip when running inside a lab or headless environment.
    if (isLabContext()) {
      this.advanceToGame();
      return;
    }

    const renderScale = getRenderScale(this);
    this.cameras.main.setOrigin(0, 0);
    this.cameras.main.setZoom(renderScale);
    this.cameras.main.roundPixels = true;
    this.buildUI();
    this.installDebugProbe();
  }

  // ---------------------------------------------------------------------------
  // UI construction
  // ---------------------------------------------------------------------------

  private buildUI(): void {
    const cx = GAME.WIDTH / 2;
    const texts: Phaser.GameObjects.Text[] = [];

    // Full-screen dark backdrop.
    this.add.rectangle(0, 0, GAME.WIDTH, GAME.HEIGHT, BG_COLOR, 1).setOrigin(0, 0).setDepth(DEPTH);

    // Panel background.
    createBeveledPanel(this, PANEL_X, PANEL_Y, PANEL_W, PANEL_H, {
      fill: PANEL_COLOR,
      fillAlpha: PANEL_ALPHA,
      highlight: PIXEL_UI.bevelLight,
      shadow: PIXEL_UI.bevelDark,
      border: BORDER_COLOR,
      depth: DEPTH + 1,
    });

    // Shared left edge for every label, box, and DOM control below.
    const boxX = PANEL_X + 24;
    const boxW = PANEL_W - 48;

    let y = PANEL_Y + 22;

    const title = this.add
      .text(cx, y, 'Character Select', {
        fontFamily: 'monospace',
        fontSize: '26px',
        fontStyle: 'bold',
        color: GOLD_COLOR,
      })
      .setOrigin(0.5, 0)
      .setDepth(DEPTH + 2);
    texts.push(title);

    y += 38;

    this.add
      .rectangle(boxX + 2, y, boxW - 4, 2, PIXEL_UI.gold, 0.8)
      .setOrigin(0, 0)
      .setDepth(DEPTH + 2);

    y += 16;

    // Director commentary box.
    this.add
      .rectangle(boxX, y, boxW, 96, 0x0d1520, 1)
      .setOrigin(0, 0)
      .setDepth(DEPTH + 1)
      .setStrokeStyle(1, 0x1e3354, 1);

    const directorLabel = this.add
      .text(boxX + 10, y + 8, DIRECTOR_LABEL, {
        fontFamily: 'monospace',
        fontSize: '13px',
        fontStyle: 'bold',
        color: GOLD_COLOR,
      })
      .setOrigin(0, 0)
      .setDepth(DEPTH + 2);
    texts.push(directorLabel);

    const directorBody = this.add
      .text(boxX + 12, y + 28, DIRECTOR_WELCOME, {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: SLATE_LIGHT,
        wordWrap: { width: boxW - 24 },
        lineSpacing: 8,
      })
      .setOrigin(0, 0)
      .setDepth(DEPTH + 2);
    texts.push(directorBody);

    y += 118;

    // Name label.
    const nameLabel = this.add
      .text(boxX, y, 'Contestant name', {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: SLATE_LIGHT,
      })
      .setOrigin(0, 0)
      .setDepth(DEPTH + 2);
    texts.push(nameLabel);

    y += 34;

    // Name input — native HTML <input> positioned over the canvas.
    this.createNameInput(boxX, y, boxW);

    y += 38 + 18;

    // Gender label.
    const genderLabel = this.add
      .text(boxX, y, 'Pronouns', {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: SLATE_LIGHT,
      })
      .setOrigin(0, 0)
      .setDepth(DEPTH + 2);
    texts.push(genderLabel);

    y += 34;

    // Gender selection radios.
    this.createGenderControls(boxX, y, boxW);

    y += 34 + 34;

    // Confirm button.
    this.createConfirmButton(cx, boxX, boxW, y, texts);

    this.unsubscribeCrispText = applyCrispText(this, texts, MIN_TEXT_RESOLUTION);
  }

  // ---------------------------------------------------------------------------
  // Name input (native DOM element, positioned over the Phaser canvas)
  // ---------------------------------------------------------------------------

  private createNameInput(gameX: number, gameY: number, gameW: number): void {
    const canvas = this.game.canvas;
    const canvasRect = canvas.getBoundingClientRect();
    const scaleX = canvasRect.width / GAME.WIDTH;
    const scaleY = canvasRect.height / GAME.HEIGHT;

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 32;
    input.value = DEFAULT_PLAYER_NAME;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', NAME_INPUT_ARIA_LABEL);

    // Position the input element over the canvas area. Every value is
    // rounded to a whole CSS pixel — fractional pixels force sub-pixel font
    // rendering in the browser, which reads as blurry text (see `px()`).
    Object.assign(input.style, {
      position: 'fixed',
      left: `${px(canvasRect.left + gameX * scaleX)}px`,
      top: `${px(canvasRect.top + gameY * scaleY)}px`,
      width: `${px(gameW * scaleX)}px`,
      height: `${px(38 * scaleY)}px`,
      background: INPUT_BG,
      color: SLATE_LIGHT,
      border: '1px solid #1e3354',
      padding: '4px 8px',
      fontFamily: 'monospace',
      fontSize: `${px(14 * Math.min(scaleX, scaleY))}px`,
      outline: 'none',
      boxSizing: 'border-box',
      zIndex: '10000',
      // Reset native input chrome: without this, some Chromium builds paint a
      // default white "auto" appearance strip over part of the custom
      // background, visible as a stray white bar inside the box.
      appearance: 'none',
      WebkitAppearance: 'none',
    });

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.handleConfirm();
      }
      e.stopPropagation();
    });

    document.body.appendChild(input);
    this.nameInput = input;
    // Focus after a brief delay to avoid stealing focus from Phaser.
    this.time.delayedCall(80, () => input.focus());
  }

  private removeDomControls(): void {
    if (this.nameInput) {
      this.nameInput.remove();
      this.nameInput = undefined;
    }
    if (this.genderFieldset) {
      this.genderFieldset.remove();
      this.genderFieldset = undefined;
    }
    this.genderControls.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Gender controls
  // ---------------------------------------------------------------------------

  private createGenderControls(startX: number, gameY: number, totalW: number): void {
    const canvasRect = this.game.canvas.getBoundingClientRect();
    const scaleX = canvasRect.width / GAME.WIDTH;
    const scaleY = canvasRect.height / GAME.HEIGHT;
    const fieldset = document.createElement('fieldset');
    fieldset.setAttribute('aria-label', GENDER_GROUP_ARIA_LABEL);
    Object.assign(fieldset.style, {
      position: 'fixed',
      left: `${px(canvasRect.left + startX * scaleX)}px`,
      top: `${px(canvasRect.top + gameY * scaleY)}px`,
      width: `${px(totalW * scaleX)}px`,
      margin: '0',
      padding: '0',
      border: '0',
      display: 'grid',
      gridTemplateColumns: `repeat(${GENDER_OPTIONS.length}, 1fr)`,
      gap: `${px(16 * scaleX)}px`,
      zIndex: '10000',
    });

    const legend = document.createElement('legend');
    legend.textContent = 'Pronouns';
    Object.assign(legend.style, {
      position: 'absolute',
      width: '1px',
      height: '1px',
      padding: '0',
      margin: '-1px',
      overflow: 'hidden',
      clip: 'rect(0 0 0 0)',
      whiteSpace: 'nowrap',
      border: '0',
    });
    fieldset.appendChild(legend);

    fieldset.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.handleConfirm();
      }
      event.stopPropagation();
    });

    for (const opt of GENDER_OPTIONS) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'player-gender';
      input.value = opt.id;
      input.checked = opt.id === DEFAULT_PLAYER_GENDER;
      Object.assign(input.style, {
        margin: '0',
        accentColor: BUTTON_SELECTED_BACKGROUND,
      });
      input.addEventListener('change', () => this.selectGender(opt.id));
      input.addEventListener('focus', () => this.updateGenderControlStyles());
      input.addEventListener('blur', () => this.updateGenderControlStyles());

      label.appendChild(input);
      label.append(opt.label);
      Object.assign(label.style, {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        minHeight: `${px(34 * scaleY)}px`,
        padding: '0 8px',
        fontFamily: 'monospace',
        fontSize: `${px(13 * Math.min(scaleX, scaleY))}px`,
        color: BUTTON_TEXT_DEFAULT,
        cursor: 'pointer',
        userSelect: 'none',
        boxSizing: 'border-box',
      });

      this.genderControls.push({ input, label, id: opt.id });
      fieldset.appendChild(label);
    }

    document.body.appendChild(fieldset);
    this.genderFieldset = fieldset;
    this.updateGenderControlStyles();
  }

  private selectGender(id: PlayerGender): void {
    this.selectedGender = id;
    for (const control of this.genderControls) {
      control.input.checked = control.id === id;
    }
    this.updateGenderControlStyles();
  }

  private updateGenderControlStyles(): void {
    for (const control of this.genderControls) {
      const selected = control.id === this.selectedGender;
      const focused = document.activeElement === control.input;
      Object.assign(control.label.style, {
        background: selected ? BUTTON_SELECTED_BACKGROUND : BUTTON_DEFAULT_BACKGROUND,
        border: `1px solid ${selected ? BUTTON_SELECTED_BORDER : BUTTON_DEFAULT_BORDER}`,
        color: selected ? BUTTON_TEXT_SELECTED : BUTTON_TEXT_DEFAULT,
        outline: focused ? `2px solid ${GOLD_COLOR}` : 'none',
        outlineOffset: '2px',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Confirm button
  // ---------------------------------------------------------------------------

  private createConfirmButton(
    cx: number,
    boxX: number,
    boxW: number,
    y: number,
    texts: Phaser.GameObjects.Text[],
  ): void {
    const btnW = 280;
    const btnH = 46;
    const bx = cx - btnW / 2;
    const buttonY = y + 22;

    const hint = this.add
      .text(boxX + boxW / 2, y, 'Press Enter to continue', {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: SLATE_DIM,
      })
      .setOrigin(0.5, 0)
      .setDepth(DEPTH + 2);
    texts.push(hint);

    const button = createBeveledButton(this, bx, buttonY, btnW, btnH, {
      fill: CONFIRM_COLOR,
      fillHover: CONFIRM_HOVER_COLOR,
      highlight: 0x3a8a3d,
      shadow: 0x0f2610,
      border: 0x276129,
      depth: DEPTH + 1,
    });

    const label = this.add
      .text(cx, buttonY + btnH / 2, 'Begin the descent', {
        fontFamily: 'monospace',
        fontSize: '15px',
        fontStyle: 'bold',
        color: CONFIRM_TEXT,
      })
      .setOrigin(0.5, 0.5)
      .setDepth(DEPTH + 2);
    texts.push(label);

    button.rectangle.on('pointerdown', () => this.handleConfirm());
  }

  // ---------------------------------------------------------------------------
  // Confirm handler
  // ---------------------------------------------------------------------------

  private handleConfirm(): void {
    const rawName = (this.nameInput?.value ?? '').trim();
    const playerName = rawName.length > 0 ? rawName : DEFAULT_PLAYER_NAME;
    const playerGender = this.selectedGender;

    this.game.registry.set(INTRO_DATA_REGISTRY_KEY, { playerName, playerGender });
    this.advanceToGame();
  }

  private advanceToGame(): void {
    this.removeDomControls();
    this.scene.start(BootScene.KEY);
  }

  private handleShutdown(): void {
    this.removeDomControls();
    this.unsubscribeCrispText?.();
    this.unsubscribeCrispText = undefined;
    if (typeof window !== 'undefined' && window.__introDebug) {
      delete window.__introDebug;
    }
  }

  private installDebugProbe(): void {
    if (typeof window === 'undefined' || !(import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
      return;
    }
    window.__introDebug = {
      getState: () => ({
        renderScale: getRenderScale(this),
        cameraZoom: this.cameras.main.zoom,
        cameraOriginX: this.cameras.main.originX,
        cameraOriginY: this.cameras.main.originY,
        selectedGender: this.selectedGender,
      }),
    };
  }
}
