/**
 * HudFloorTimer — fixed-position floor number + countdown timer.
 *
 * Positioned top-center inside a beveled pixel-UI panel that auto-sizes to the
 * text. Reads from world.floor1 (Floor 1) with a generic FLOOR.MAX_DURATION_S
 * fallback. Visual states: neutral → amber (<60 s) → red+pulse (<30 s).
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { GAME, FLOOR } from '../shared/constants.js';
import { PIXEL_UI_DEPTH, createBeveledPanel } from './pixel-ui.js';
import { applyCrispText } from './ui-scale.js';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const CENTER_X = GAME.WIDTH / 2;
const TOP_Y = 14;

const COLORS = {
  neutral: '#e5e7eb',
  amber: '#f2b542',
  red: '#e23b3b',
} as const;

const AMBER_THRESHOLD_MS = 60_000;
const RED_THRESHOLD_MS = 30_000;

export function createHudFloorTimer(
  scene: Phaser.Scene,
  options: { parent?: Phaser.GameObjects.Container } = {},
): {
  sync(world: GameWorld): void;
  destroy(): void;
} {
  const parent = options.parent;
  const panel = createBeveledPanel(scene, CENTER_X - 80, TOP_Y, 160, 38, { parent });

  const timerText = scene.add
    .text(CENTER_X, TOP_Y + 19, '', {
      fontFamily: 'monospace',
      fontSize: '18px',
      color: COLORS.neutral,
      stroke: '#02040a',
      strokeThickness: 3,
      align: 'center',
    })
    .setOrigin(0.5, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.content);
  parent?.add(timerText);
  const detachCrispText = applyCrispText(scene, [timerText]);

  let pulseTween: Phaser.Tweens.Tween | undefined;
  let wasPulsing = false;

  function startPulse(): void {
    if (wasPulsing) return;
    wasPulsing = true;
    pulseTween?.stop();
    pulseTween = scene.tweens.add({
      targets: timerText,
      alpha: { from: 1, to: 0.55 },
      duration: 500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  function stopPulse(): void {
    if (!wasPulsing) return;
    wasPulsing = false;
    pulseTween?.stop();
    pulseTween = undefined;
    timerText.setAlpha(1);
  }

  function formatTimer(ms: number): string {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
  }

  function sync(world: GameWorld): void {
    let remainingMs: number;

    if (world.floor1?.objective) {
      remainingMs = Math.max(0, world.floor1.objective.deadlineMs - world.elapsedMs);
    } else {
      const maxMs = FLOOR.MAX_DURATION_S * 1000;
      remainingMs = Math.max(0, maxMs - world.elapsedMs);
    }

    const timerStr = formatTimer(remainingMs);
    timerText.setText(`Floor ${world.floor}   ${timerStr}`);

    // Resize the panel to hug the text.
    const w = Math.ceil(timerText.width) + 28;
    const h = 38;
    panel.setPosition(CENTER_X - w / 2, TOP_Y);
    panel.setSize(w, h);

    if (remainingMs <= RED_THRESHOLD_MS) {
      timerText.setColor(COLORS.red);
      startPulse();
    } else if (remainingMs <= AMBER_THRESHOLD_MS) {
      timerText.setColor(COLORS.amber);
      stopPulse();
    } else {
      timerText.setColor(COLORS.neutral);
      stopPulse();
    }
  }

  function destroy(): void {
    detachCrispText();
    pulseTween?.stop();
    panel.destroy();
    timerText.destroy();
  }

  return { sync, destroy };
}
