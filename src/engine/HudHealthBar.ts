/**
 * HudHealthBar — fixed-position health bar rendered in the Phaser scene.
 *
 * Uses two Rectangle GameObjects (shell + fill) to avoid per-frame Graphics
 * redraws. Color transitions: green > yellow > red. Low-HP pulse via Phaser tween.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { GAME } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const BAR_X = 16;
const BAR_Y = GAME.HEIGHT - 52;
const BAR_WIDTH = 220;
const BAR_HEIGHT = 20;
const BORDER = 2;
const LABEL_OFFSET_X = BAR_WIDTH + 10;
const DEPTH = 1000;

const COLORS = {
  shell: 0x1e293b,
  shellBorder: 0x334155,
  barHigh: 0x22c55e, // > 50 %
  barMid: 0xf59e0b, // 25–50 %
  barLow: 0xef4444, // < 25 %
  labelText: '#f8fafc',
  labelBg: 0x0f172a,
} as const;

const LOW_HP_THRESHOLD = 0.25;

export interface HudHealthBarOptions {
  /** Horizontal position of left edge. Defaults to 16. */
  x?: number;
  /** Vertical position of top edge. Defaults to bottom-left corner. */
  y?: number;
}

export function createHudHealthBar(
  scene: Phaser.Scene,
  options: HudHealthBarOptions = {},
): {
  sync(world: GameWorld, playerEid: number): void;
  setAlpha(alpha: number): void;
  destroy(): void;
} {
  const x = options.x ?? BAR_X;
  const y = options.y ?? BAR_Y;

  // Shell (background track)
  const shell = scene.add
    .rectangle(
      x + BAR_WIDTH / 2,
      y + BAR_HEIGHT / 2,
      BAR_WIDTH + BORDER * 2,
      BAR_HEIGHT + BORDER * 2,
      COLORS.shell,
    )
    .setStrokeStyle(1, COLORS.shellBorder)
    .setScrollFactor(0)
    .setDepth(DEPTH);

  // Fill rectangle — anchored left, scaled by width
  const fill = scene.add
    .rectangle(x, y + BAR_HEIGHT / 2, BAR_WIDTH, BAR_HEIGHT, COLORS.barHigh)
    .setOrigin(0, 0.5)
    .setScrollFactor(0)
    .setDepth(DEPTH + 1);

  // HP text label
  const label = scene.add
    .text(x + LABEL_OFFSET_X, y + BAR_HEIGHT / 2, '', {
      fontFamily: 'monospace',
      fontSize: '13px',
      color: COLORS.labelText,
      backgroundColor: `#${COLORS.labelBg.toString(16).padStart(6, '0')}cc`,
      padding: { x: 6, y: 3 },
    })
    .setOrigin(0, 0.5)
    .setScrollFactor(0)
    .setDepth(DEPTH + 1);

  // Icon label "♥ HP"
  const icon = scene.add
    .text(x, y - 16, '♥ HP', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#94a3b8',
    })
    .setScrollFactor(0)
    .setDepth(DEPTH);

  let pulseTween: Phaser.Tweens.Tween | undefined;
  let wasPulsing = false;

  function startPulse(): void {
    if (wasPulsing) return;
    wasPulsing = true;
    pulseTween?.stop();
    pulseTween = scene.tweens.add({
      targets: fill,
      alpha: { from: 1, to: 0.5 },
      duration: 400,
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
    fill.setAlpha(1);
  }

  function sync(world: GameWorld, playerEid: number): void {
    if (playerEid < 0) return;

    const current = world.stores.health.current[playerEid] ?? 0;
    const max = world.stores.health.max[playerEid] ?? 1;
    const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;

    const fillWidth = Math.round(pct * BAR_WIDTH);
    fill.setSize(Math.max(1, fillWidth), BAR_HEIGHT);

    const color = pct > 0.5 ? COLORS.barHigh : pct >= 0.25 ? COLORS.barMid : COLORS.barLow;
    fill.setFillStyle(color);

    label.setText(`${Math.ceil(current)} / ${Math.ceil(max)}`);

    if (pct < LOW_HP_THRESHOLD) {
      startPulse();
    } else {
      stopPulse();
    }
  }

  function destroy(): void {
    pulseTween?.stop();
    shell.destroy();
    fill.destroy();
    label.destroy();
    icon.destroy();
  }

  function setAlpha(alpha: number): void {
    shell.setAlpha(alpha);
    fill.setAlpha(alpha);
    label.setAlpha(alpha);
    icon.setAlpha(alpha);
  }

  return { sync, setAlpha, destroy };
}
