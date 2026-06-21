/**
 * HudExperienceBar — fixed-position XP progress bar.
 *
 * Mirrors the health bar's pixel-UI styling: a beveled panel with an XP-spark
 * icon and an inset blue progress bar with a glossy shine. Visible only after
 * the `floor1-drops-unlocked` goal flag is set. Public `sync`/`destroy` unchanged.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { GAME } from '../shared/constants.js';
import { xpRequiredForLevel } from '../shared/xpMath.js';
import {
  PIXEL_UI,
  PIXEL_UI_DEPTH,
  PIXEL_ICON,
  createBeveledPanel,
  createStatBar,
  addPixelIcon,
} from './pixel-ui.js';

const PAD = 7;
const ICON_SIZE = 16;
const BAR_WIDTH = 200;
const BAR_HEIGHT = 12;
const PANEL_W = PAD + ICON_SIZE + 6 + BAR_WIDTH + PAD;
const PANEL_H = PAD + BAR_HEIGHT + PAD;

const BAR_X = 16;
const BAR_Y = GAME.HEIGHT - 84;

export function createHudExperienceBar(
  scene: Phaser.Scene,
  options: { parent?: Phaser.GameObjects.Container } = {},
): {
  sync(world: GameWorld): void;
  destroy(): void;
} {
  const parent = options.parent;
  const panelX = BAR_X;
  const panelY = BAR_Y + BAR_HEIGHT / 2 - PANEL_H / 2;

  const panel = createBeveledPanel(scene, panelX, panelY, PANEL_W, PANEL_H, { parent });

  const iconCx = panelX + PAD + ICON_SIZE / 2;
  const iconCy = panelY + PANEL_H / 2;
  const icon = addPixelIcon(scene, PIXEL_ICON.xp, iconCx, iconCy, {
    depth: PIXEL_UI_DEPTH.overlay,
    parent,
  });

  const innerBarX = panelX + PAD + ICON_SIZE + 6;
  const innerBarY = panelY + (PANEL_H - BAR_HEIGHT) / 2;

  const bar = createStatBar(scene, innerBarX, innerBarY, BAR_WIDTH, BAR_HEIGHT, {
    fill: PIXEL_UI.xpFill,
    depth: PIXEL_UI_DEPTH.content,
    parent,
  });

  const label = scene.add
    .text(innerBarX + BAR_WIDTH / 2, innerBarY + BAR_HEIGHT / 2, '', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#eaf6ff',
      stroke: '#02040a',
      strokeThickness: 3,
    })
    .setOrigin(0.5, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.overlay);
  parent?.add(label);

  function setVisible(visible: boolean): void {
    panel.setVisible(visible);
    bar.setVisible(visible);
    label.setVisible(visible);
    icon.setVisible(visible);
  }

  function sync(world: GameWorld): void {
    const unlocked = world.goalFlags.get('floor1-drops-unlocked') === true;
    setVisible(unlocked);
    if (!unlocked) {
      return;
    }

    const level = Math.max(0, world.playerLevel.level);
    const totalXp = Math.max(0, world.playerLevel.xp);
    const currentLevelXp = xpRequiredForLevel(level);
    const nextLevelXp = xpRequiredForLevel(level + 1);
    const xpIntoLevel = Math.max(0, totalXp - currentLevelXp);
    const needed = Math.max(1, nextLevelXp - currentLevelXp);
    const pct = Math.max(0, Math.min(1, xpIntoLevel / needed));
    bar.setPercent(pct);
    label.setText(`Lv ${level}  ${xpIntoLevel}/${needed}`);
  }

  function destroy(): void {
    panel.destroy();
    bar.destroy();
    label.destroy();
    icon.destroy();
  }

  return { sync, destroy };
}
