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
import { BootScene } from './BootScene.js';
import {
  INTRO_DATA_REGISTRY_KEY,
  DEFAULT_PLAYER_NAME,
  DEFAULT_PLAYER_GENDER,
  type PlayerGender,
} from '../../shared/intro-config.js';

export type { PlayerGender };

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
const BUTTON_DEFAULT_COLOR = 0x1e293b;
const BUTTON_SELECTED_COLOR = 0x3b4f72;
const BUTTON_TEXT_DEFAULT = '#94a3b8';
const BUTTON_TEXT_SELECTED = '#f8fafc';
const CONFIRM_COLOR = 0x1e4620;
const CONFIRM_HOVER_COLOR = 0x276129;
const CONFIRM_TEXT = '#86efac';
const DIRECTOR_LABEL = 'DIRECTOR';

const PANEL_W = 640;
const PANEL_H = 420;
const PANEL_X = (GAME.WIDTH - PANEL_W) / 2;
const PANEL_Y = (GAME.HEIGHT - PANEL_H) / 2;
const DEPTH = 2000;

export class IntroScene extends Phaser.Scene {
  static readonly KEY = 'IntroScene';

  private nameInput?: HTMLInputElement;
  private selectedGender: PlayerGender = DEFAULT_PLAYER_GENDER;
  private genderButtons: Array<{
    bg: Phaser.GameObjects.Rectangle;
    label: Phaser.GameObjects.Text;
    id: PlayerGender;
  }> = [];

  constructor() {
    super({ key: IntroScene.KEY });
  }

  create(): void {
    // Auto-skip when running inside a lab or headless environment.
    if (isLabContext()) {
      this.advanceToGame();
      return;
    }

    this.buildUI();
  }

  shutdown(): void {
    this.removeNameInput();
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
      .text(cx, y, 'THE CRAWLER', {
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

    // Gender selection buttons.
    this.createGenderButtons(boxX, y, boxW);

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

  private removeNameInput(): void {
    if (this.nameInput) {
      this.nameInput.remove();
      this.nameInput = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Gender buttons
  // ---------------------------------------------------------------------------

  private createGenderButtons(startX: number, y: number, totalW: number): void {
    const count = GENDER_OPTIONS.length;
    const gap = 8;
    const btnW = Math.floor((totalW - gap * (count - 1)) / count);
    const btnH = 34;

    GENDER_OPTIONS.forEach((opt, i) => {
      const bx = startX + i * (btnW + gap);
      const isSelected = opt.id === DEFAULT_PLAYER_GENDER;

      const bg = this.add
        .rectangle(bx, y, btnW, btnH, isSelected ? BUTTON_SELECTED_COLOR : BUTTON_DEFAULT_COLOR, 1)
        .setOrigin(0, 0)
        .setDepth(DEPTH + 1)
        .setStrokeStyle(1, isSelected ? 0x4a6fa5 : 0x1e293b, 1)
        .setInteractive({ useHandCursor: true });

      const label = this.add
        .text(bx + btnW / 2, y + btnH / 2, opt.label, {
          fontFamily: 'monospace',
          fontSize: '13px',
          color: isSelected ? BUTTON_TEXT_SELECTED : BUTTON_TEXT_DEFAULT,
        })
        .setOrigin(0.5, 0.5)
        .setDepth(DEPTH + 2);

      bg.on('pointerdown', () => this.selectGender(opt.id));
      bg.on('pointerover', () => {
        if (opt.id !== this.selectedGender) {
          bg.setFillStyle(0x253448, 1);
        }
      });
      bg.on('pointerout', () => {
        if (opt.id !== this.selectedGender) {
          bg.setFillStyle(BUTTON_DEFAULT_COLOR, 1);
        }
      });

      this.genderButtons.push({ bg, label, id: opt.id });
    });
  }

  private selectGender(id: PlayerGender): void {
    this.selectedGender = id;
    for (const btn of this.genderButtons) {
      const selected = btn.id === id;
      btn.bg.setFillStyle(selected ? BUTTON_SELECTED_COLOR : BUTTON_DEFAULT_COLOR, 1);
      btn.bg.setStrokeStyle(1, selected ? 0x4a6fa5 : 0x1e293b, 1);
      btn.label.setColor(selected ? BUTTON_TEXT_SELECTED : BUTTON_TEXT_DEFAULT);
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
    this.removeNameInput();
    this.scene.start(BootScene.KEY);
  }
}
