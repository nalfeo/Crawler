/**
 * HudFloorTimer — fixed-position floor number + atomization countdown timer.
 *
 * Positioned top-center. Reads from world.floor1 (Floor 1) with a generic
 * FLOOR.MAX_DURATION_S fallback for future floors.
 * Visual states: neutral → amber (<60 s) → red+pulse (<30 s).
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { GAME, FLOOR } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const CENTER_X = GAME.WIDTH / 2;
const TOP_Y = 16;
const DEPTH = 1000;

const COLORS = {
  neutral: '#e5e7eb',
  amber: '#f59e0b',
  red: '#ef4444',
  bg: '#111827cc',
} as const;

const AMBER_THRESHOLD_MS = 60_000;
const RED_THRESHOLD_MS = 30_000;

export function createHudFloorTimer(scene: Phaser.Scene): {
  sync(world: GameWorld): void;
  setAlpha(alpha: number): void;
  destroy(): void;
} {
  const timerText = scene.add
    .text(CENTER_X, TOP_Y, '', {
      fontFamily: 'monospace',
      fontSize: '18px',
      color: COLORS.neutral,
      backgroundColor: COLORS.bg,
      padding: { x: 14, y: 8 },
      align: 'center',
    })
    .setOrigin(0.5, 0)
    .setScrollFactor(0)
    .setDepth(DEPTH);

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
      remainingMs = Math.max(0, world.floor1.objective.atomizationDeadlineMs - world.elapsedMs);
    } else {
      const maxMs = FLOOR.MAX_DURATION_S * 1000;
      remainingMs = Math.max(0, maxMs - world.elapsedMs);
    }

    const timerStr = formatTimer(remainingMs);
    timerText.setText(`Floor ${world.floor}  Atomization in ${timerStr}`);

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
    pulseTween?.stop();
    timerText.destroy();
  }

  function setAlpha(alpha: number): void {
    timerText.setAlpha(alpha);
  }

  return { sync, setAlpha, destroy };
}
