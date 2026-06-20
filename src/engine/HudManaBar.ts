/**
 * HudManaBar — fixed-position mana (MP) bar rendered in the Phaser scene.
 *
 * Uses two Rectangle GameObjects (shell + fill) to match the health bar pattern.
 * Only visible when spells feature is unlocked. Color: blue gradient.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { GAME } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const BAR_X = 16;
const BAR_Y = GAME.HEIGHT - 24;
const BAR_WIDTH = 220;
const BAR_HEIGHT = 16;
const BORDER = 2;
const LABEL_OFFSET_X = BAR_WIDTH + 10;
const DEPTH = 1000;

const COLORS = {
  shell: 0x1e293b,
  shellBorder: 0x334155,
  barFull: 0x3b82f6, // blue
  labelText: '#f8fafc',
  labelBg: 0x0f172a,
} as const;

export interface HudManaBarOptions {
  /** Horizontal position of left edge. Defaults to 16. */
  x?: number;
  /** Vertical position of top edge. Defaults to below health bar. */
  y?: number;
}

export function createHudManaBar(
  scene: Phaser.Scene,
  options: HudManaBarOptions = {},
): {
  sync(world: GameWorld): void;
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
    .rectangle(x, y + BAR_HEIGHT / 2, BAR_WIDTH, BAR_HEIGHT, COLORS.barFull)
    .setOrigin(0, 0.5)
    .setScrollFactor(0)
    .setDepth(DEPTH + 1);

  // MP text label
  const label = scene.add
    .text(x + LABEL_OFFSET_X, y + BAR_HEIGHT / 2, '', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: COLORS.labelText,
      backgroundColor: `#${COLORS.labelBg.toString(16).padStart(6, '0')}cc`,
      padding: { x: 6, y: 2 },
    })
    .setOrigin(0, 0.5)
    .setScrollFactor(0)
    .setDepth(DEPTH + 1);

  // Icon label "⚡ MP"
  const icon = scene.add
    .text(x, y - 14, '⚡ MP', {
      fontFamily: 'monospace',
      fontSize: '10px',
      color: '#94a3b8',
    })
    .setScrollFactor(0)
    .setDepth(DEPTH);

  // Initially hidden until feature unlock
  shell.setVisible(false);
  fill.setVisible(false);
  label.setVisible(false);
  icon.setVisible(false);

  function sync(world: GameWorld): void {
    // Only show mana bar when spells feature is unlocked
    const isVisible = world.featureUnlocks.spells;

    if (!isVisible) {
      shell.setVisible(false);
      fill.setVisible(false);
      label.setVisible(false);
      icon.setVisible(false);
      return;
    }

    shell.setVisible(true);
    fill.setVisible(true);
    label.setVisible(true);
    icon.setVisible(true);

    const current = world.playerMp;
    const max = world.playerMaxMp;
    const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;

    const fillWidth = Math.round(pct * BAR_WIDTH);
    fill.setSize(Math.max(1, fillWidth), BAR_HEIGHT);

    label.setText(`${Math.ceil(current)} / ${Math.ceil(max)}`);
  }

  function destroy(): void {
    shell.destroy();
    fill.destroy();
    label.destroy();
    icon.destroy();
  }

  return { sync, destroy };
}
