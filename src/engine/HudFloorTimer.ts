/**
 * HudFloorTimer — fixed-position floor number + countdown timer.
 *
 * Positioned top-center inside a beveled pixel-UI panel that auto-sizes to the
 * text. Reads from world.floorScenario (Floor 1) with a generic FLOOR.MAX_DURATION_S
 * fallback. Visual states: neutral → amber (<60 s) → red+pulse (<30 s).
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { GAME } from '../shared/constants.js';
import { PIXEL_UI_DEPTH, createBeveledPanel } from './pixel-ui.js';
import { applyCrispText } from './ui-scale.js';
import type { ScreenBounds } from './ui-scale.js';
import { resolveFloorTimerRemainingMs } from './floor-timer-state.js';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const CENTER_X = GAME.WIDTH / 2;
const TOP_Y = 12;
const PANEL_HEIGHT = 42;
const MIN_PANEL_WIDTH = 184;

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
  getLayoutBounds(): { panel: ScreenBounds; text: ScreenBounds };
  destroy(): void;
} {
  const parent = options.parent;
  const panel = createBeveledPanel(
    scene,
    CENTER_X - MIN_PANEL_WIDTH / 2,
    TOP_Y,
    MIN_PANEL_WIDTH,
    PANEL_HEIGHT,
    { parent },
  );

  const urgencyRail = scene.add
    .rectangle(CENTER_X, TOP_Y + 4, MIN_PANEL_WIDTH - 8, 2, 0x4a5878)
    .setOrigin(0.5, 0)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.content);
  parent?.add(urgencyRail);

  const timerText = scene.add
    .text(CENTER_X, TOP_Y + PANEL_HEIGHT / 2, '', {
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
    if (world.hideFloorTimer) {
      panel.setVisible(false);
      urgencyRail.setVisible(false);
      timerText.setVisible(false);
      stopPulse();
      return;
    }
    panel.setVisible(true);
    urgencyRail.setVisible(true);
    timerText.setVisible(true);

    const remainingMs = resolveFloorTimerRemainingMs(world);

    const timerStr = formatTimer(remainingMs);
    timerText.setText(`Floor ${world.floor}   ${timerStr}`);

    // Resize the panel to hug the text.
    const w = Math.max(MIN_PANEL_WIDTH, Math.ceil(timerText.width) + 28);
    panel.setPosition(CENTER_X - w / 2, TOP_Y);
    panel.setSize(w, PANEL_HEIGHT);
    urgencyRail.setSize(w - 8, 2);

    if (remainingMs <= RED_THRESHOLD_MS) {
      timerText.setColor(COLORS.red);
      urgencyRail.setFillStyle(0xe23b3b);
      startPulse();
    } else if (remainingMs <= AMBER_THRESHOLD_MS) {
      timerText.setColor(COLORS.amber);
      urgencyRail.setFillStyle(0xf2b542);
      stopPulse();
    } else {
      timerText.setColor(COLORS.neutral);
      urgencyRail.setFillStyle(0x4a5878);
      stopPulse();
    }
  }

  function destroy(): void {
    detachCrispText();
    pulseTween?.stop();
    panel.destroy();
    urgencyRail.destroy();
    timerText.destroy();
  }

  function getLayoutBounds(): { panel: ScreenBounds; text: ScreenBounds } {
    const panelBounds = panel.getBounds();
    return {
      panel: panelBounds,
      text: {
        x: timerText.x - timerText.width / 2,
        y: timerText.y - timerText.height / 2,
        width: timerText.width,
        height: timerText.height,
      },
    };
  }

  return { sync, getLayoutBounds, destroy };
}
