import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { GAME } from '../shared/constants.js';
import { xpRequiredForLevel } from '../shared/xpMath.js';

const BAR_X = 16;
const BAR_Y = GAME.HEIGHT - 82;
const BAR_WIDTH = 220;
const BAR_HEIGHT = 14;
const BORDER = 2;
const DEPTH = 1000;

const COLORS = {
  shell: 0x1e1b4b,
  shellBorder: 0x312e81,
  fill: 0x60a5fa,
  label: '#dbeafe',
  icon: '#93c5fd',
} as const;

export function createHudExperienceBar(scene: Phaser.Scene): {
  sync(world: GameWorld): void;
  destroy(): void;
} {
  const shell = scene.add
    .rectangle(
      BAR_X + BAR_WIDTH / 2,
      BAR_Y + BAR_HEIGHT / 2,
      BAR_WIDTH + BORDER * 2,
      BAR_HEIGHT + BORDER * 2,
      COLORS.shell,
    )
    .setStrokeStyle(1, COLORS.shellBorder)
    .setScrollFactor(0)
    .setDepth(DEPTH);

  const fill = scene.add
    .rectangle(BAR_X, BAR_Y + BAR_HEIGHT / 2, BAR_WIDTH, BAR_HEIGHT, COLORS.fill)
    .setOrigin(0, 0.5)
    .setScrollFactor(0)
    .setDepth(DEPTH + 1);

  const label = scene.add
    .text(BAR_X + BAR_WIDTH + 10, BAR_Y + BAR_HEIGHT / 2, '', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: COLORS.label,
      backgroundColor: '#0f172acc',
      padding: { x: 6, y: 3 },
    })
    .setOrigin(0, 0.5)
    .setScrollFactor(0)
    .setDepth(DEPTH + 1);

  const icon = scene.add
    .text(BAR_X, BAR_Y - 14, '✦ XP', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: COLORS.icon,
    })
    .setScrollFactor(0)
    .setDepth(DEPTH);

  function setVisible(visible: boolean): void {
    shell.setVisible(visible);
    fill.setVisible(visible);
    label.setVisible(visible);
    icon.setVisible(visible);
  }

  function sync(world: GameWorld): void {
    const unlocked = world.goalFlags.get('floor1-xp-unlocked') === true;
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
    fill.setSize(Math.max(1, Math.round(BAR_WIDTH * pct)), BAR_HEIGHT);
    label.setText(`Lv ${level}  ${xpIntoLevel}/${needed}`);
  }

  function destroy(): void {
    shell.destroy();
    fill.destroy();
    label.destroy();
    icon.destroy();
  }

  return { sync, destroy };
}
