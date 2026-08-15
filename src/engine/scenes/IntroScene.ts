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
import { PIXEL_UI } from '../pixel-ui.js';
import { getRenderScale } from '../render-scale.js';
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
  'Welcome, Contestant. The dungeon cameras are hot and\n' +
  'the audience is watching. Before you descend, tell us\n' +
  'who you are.';

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
const DIRECTOR_LABEL = 'DIRECTOR';
const BUTTON_DEFAULT_BORDER = '#1e293b';
const BUTTON_SELECTED_BORDER = '#4a6fa5';
const BUTTON_DEFAULT_BACKGROUND = '#1e293b';
const BUTTON_SELECTED_BACKGROUND = '#3b4f72';
const NAME_INPUT_ARIA_LABEL = 'Player name';
const GENDER_GROUP_ARIA_LABEL = 'Player gender';

const PANEL_W = 640;
const PANEL_H = 420;
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
    this.buildUI();
    this.installDebugProbe();
  }

  // ---------------------------------------------------------------------------
  // UI construction
  // ---------------------------------------------------------------------------

  private buildUI(): void {
    const cx = GAME.WIDTH / 2;

    // Full-screen dark backdrop.
    this.add.rectangle(0, 0, GAME.WIDTH, GAME.HEIGHT, BG_COLOR, 1).setOrigin(0, 0).setDepth(DEPTH);

    // Panel background.
    this.add
      .rectangle(PANEL_X, PANEL_Y, PANEL_W, PANEL_H, PANEL_COLOR, PANEL_ALPHA)
      .setOrigin(0, 0)
      .setDepth(DEPTH + 1)
      .setStrokeStyle(1, BORDER_COLOR, 1);

    let y = PANEL_Y + 26;

    // Title.
    this.add
      .text(cx, y, 'Crawler', {
        fontFamily: 'monospace',
        fontSize: '28px',
        fontStyle: 'bold',
        color: GOLD_COLOR,
      })
      .setOrigin(0.5, 0)
      .setDepth(DEPTH + 2);

    y += 46;

    // Director commentary box.
    const boxX = PANEL_X + 24;
    const boxW = PANEL_W - 48;
    this.add
      .rectangle(boxX, y, boxW, 92, 0x0d1520, 1)
      .setOrigin(0, 0)
      .setDepth(DEPTH + 1)
      .setStrokeStyle(1, 0x1e3354, 1);

    this.add
      .text(boxX + 10, y + 8, DIRECTOR_LABEL, {
        fontFamily: 'monospace',
        fontSize: '11px',
        fontStyle: 'bold',
        color: GOLD_COLOR,
      })
      .setOrigin(0, 0)
      .setDepth(DEPTH + 2);

    this.add
      .text(boxX + 10, y + 24, DIRECTOR_WELCOME, {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: SLATE_LIGHT,
        wordWrap: { width: boxW - 20 },
        lineSpacing: 3,
      })
      .setOrigin(0, 0)
      .setDepth(DEPTH + 2);

    y += 108;

    // Name label.
    this.add
      .text(boxX, y, 'What is your name?', {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: SLATE_LIGHT,
      })
      .setOrigin(0, 0)
      .setDepth(DEPTH + 2);

    y += 22;

    // Name input — native HTML <input> positioned over the canvas.
    this.createNameInput(boxX, y, boxW);

    y += 50;

    // Gender label.
    this.add
      .text(boxX, y, 'How do you identify?', {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: SLATE_LIGHT,
      })
      .setOrigin(0, 0)
      .setDepth(DEPTH + 2);

    y += 24;

    // Gender selection radios.
    this.createGenderControls(boxX, y, boxW);

    y += 52;

    // Confirm button.
    this.createConfirmButton(cx, y);
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

    // Position the input element over the canvas area.
    Object.assign(input.style, {
      position: 'fixed',
      left: `${canvasRect.left + gameX * scaleX}px`,
      top: `${canvasRect.top + gameY * scaleY}px`,
      width: `${gameW * scaleX}px`,
      height: `${34 * scaleY}px`,
      background: INPUT_BG,
      color: SLATE_LIGHT,
      border: '1px solid #1e3354',
      padding: '0 8px',
      fontFamily: 'monospace',
      fontSize: `${14 * Math.min(scaleX, scaleY)}px`,
      outline: 'none',
      boxSizing: 'border-box',
      zIndex: '10000',
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
      left: `${canvasRect.left + startX * scaleX}px`,
      top: `${canvasRect.top + gameY * scaleY}px`,
      width: `${totalW * scaleX}px`,
      margin: '0',
      padding: '0',
      border: '0',
      display: 'grid',
      gridTemplateColumns: `repeat(${GENDER_OPTIONS.length}, 1fr)`,
      gap: `${8 * scaleX}px`,
      zIndex: '10000',
    });

    const legend = document.createElement('legend');
    legend.textContent = 'How do you identify?';
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
        minHeight: `${34 * scaleY}px`,
        padding: '0 8px',
        fontFamily: 'monospace',
        fontSize: `${13 * Math.min(scaleX, scaleY)}px`,
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

  private createConfirmButton(cx: number, y: number): void {
    const btnW = 260;
    const btnH = 42;
    const bx = cx - btnW / 2;

    const bg = this.add
      .rectangle(bx, y, btnW, btnH, CONFIRM_COLOR, 1)
      .setOrigin(0, 0)
      .setDepth(DEPTH + 1)
      .setStrokeStyle(1, 0x276129, 1)
      .setInteractive({ useHandCursor: true });

    this.add
      .text(cx, y + btnH / 2, 'ENTER THE DUNGEON', {
        fontFamily: 'monospace',
        fontSize: '15px',
        fontStyle: 'bold',
        color: CONFIRM_TEXT,
      })
      .setOrigin(0.5, 0.5)
      .setDepth(DEPTH + 2);

    bg.on('pointerover', () => bg.setFillStyle(CONFIRM_HOVER_COLOR, 1));
    bg.on('pointerout', () => bg.setFillStyle(CONFIRM_COLOR, 1));
    bg.on('pointerdown', () => this.handleConfirm());

    // Dim hint text.
    this.add
      .text(cx, y + btnH + 8, '(or press Enter)', {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: SLATE_DIM,
      })
      .setOrigin(0.5, 0)
      .setDepth(DEPTH + 2);
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
