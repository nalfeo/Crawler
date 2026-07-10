/**
 * AchievementsUI — safe-room panel for reviewing earned achievements.
 *
 * Lists every achievement the player has unlocked this run. Each row shows the
 * title, the unlock condition, the Director's flavor line, and an "Open reward"
 * button. Opening a reward is reveal-only: it marks the achievement claimed and
 * reveals the loot-box tier / item / message — no loot is granted yet.
 *
 * Layer note: imports only from core + shared (never game/labs). The catalog and
 * claim helper are shared/game-systems, so the panel drives claims directly.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { fitUiScale } from './ui-scale.js';
import { getRenderScale } from './render-scale.js';
import { GAME } from '../shared/constants.js';
import {
  FLOOR1_ACHIEVEMENTS,
  type AchievementDef,
  type AchievementDifficulty,
  type AchievementReward,
} from '../shared/achievements.js';
import { claimAchievementReward } from '../core/systems/achievementRewards.js';

const PANEL_PADDING = 16;
const FONT_FAMILY = 'Segoe UI, Arial, sans-serif';
const ROW_HEIGHT = 84;
const ROW_GAP = 8;

/** Flavor text longer than this (chars) gets a collapse/expand toggle. */
const FLAVOR_EXPAND_THRESHOLD = 120;
/** Line height for 11 px flavor font. */
const FLAVOR_LINE_H = 15;
/** Number of lines to show in collapsed state. */
const FLAVOR_COLLAPSED_LINES = 2;
/** Height of the expand/collapse button row. */
const EXPANDER_BTN_H = 18;

const COLORS = {
  panelBg: 0x0d0d1a,
  panelBorder: 0x2a2a4a,
  rowBg: 0x15152a,
  rowHover: 0x22224a,
  rowBorder: 0x333355,
  textPrimary: 0xf8fafc,
  textSecondary: 0x9ca3af,
  flavor: 0xc9b8ff,
  btnBg: 0x2a2a4a,
  btnHover: 0x3a3a6a,
  claimed: 0x22c55e,
} as const;

const DIFFICULTY_HEX: Record<AchievementDifficulty, number> = {
  basic: 0x9ca3af,
  standard: 0x22c55e,
  hard: 0x3b82f6,
  brutal: 0xf59e0b,
};

function hex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

function rewardLabel(reward: AchievementReward): string {
  switch (reward.type) {
    case 'lootBox':
      return `${reward.tier} box`;
    case 'item':
      return reward.itemId;
    case 'directorMessage':
      return 'message';
    case 'none':
      return 'no reward';
  }
}

function rewardReveal(reward: AchievementReward): string {
  switch (reward.type) {
    case 'lootBox':
      return `Opened: ${reward.tier} loot box`;
    case 'item':
      return `Opened: ${reward.itemId}`;
    case 'directorMessage':
      return `Director: ${reward.message}`;
    case 'none':
      return 'No reward';
  }
}

export interface AchievementsUIConfig {
  width?: number;
  height?: number;
}

export function createAchievementsUI(
  scene: Phaser.Scene,
  config: AchievementsUIConfig = {},
): {
  toggle(world: GameWorld): void;
  refresh(world: GameWorld): void;
  isOpen(): boolean;
  destroy(): void;
} {
  scene.cameras.main.roundPixels = true;
  const snap = (value: number): number => Math.round(value);
  const baseResolution = getRenderScale(scene);
  let textResolution = baseResolution;
  const crispText = (
    x: number,
    y: number,
    text: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text =>
    scene.add.text(snap(x), snap(y), text, style).setResolution(textResolution);

  const panelWidth = config.width ?? 620;
  const panelHeight = config.height ?? 520;

  let uiScale = fitUiScale(scene, panelWidth, panelHeight);
  textResolution = Math.max(1, Math.round(baseResolution * uiScale));
  const viewWidth = (): number => GAME.WIDTH / uiScale;
  const viewHeight = (): number => GAME.HEIGHT / uiScale;

  let visible = false;
  let lastWorld: GameWorld | null = null;
  let lastSignature: string | null = null;
  let scrollIndex = 0;
  const expandedIds = new Set<string>();

  const container = scene.add.container(0, 0);
  container.setDepth(1000);
  container.setVisible(false);

  let panelX = snap((viewWidth() - panelWidth) / 2);
  let panelY = snap((viewHeight() - panelHeight) / 2);

  const bg = scene.add.rectangle(0, 0, panelWidth, panelHeight, COLORS.panelBg, 0.96);
  bg.setStrokeStyle(2, COLORS.panelBorder);
  container.add(bg);

  const title = crispText(0, 0, '🏆 ACHIEVEMENTS', {
    fontFamily: FONT_FAMILY,
    fontSize: '20px',
    color: hex(COLORS.textPrimary),
  });
  container.add(title);

  const hint = crispText(0, 0, 'Open a reward to reveal the box · scroll for more · [V] to close', {
    fontFamily: FONT_FAMILY,
    fontSize: '12px',
    color: hex(COLORS.textSecondary),
  });
  hint.setOrigin(1, 0);
  container.add(hint);

  const listTop = (): number => panelY + PANEL_PADDING + 40;
  const listBottom = (): number => panelY + panelHeight - PANEL_PADDING;

  const rowObjects: Phaser.GameObjects.GameObject[] = [];
  function clearRows(): void {
    for (const obj of rowObjects) obj.destroy();
    rowObjects.length = 0;
  }

  function unlockedDefs(world: GameWorld): AchievementDef[] {
    return FLOOR1_ACHIEVEMENTS.filter((a) => world.achievements.unlockedIds.has(a.id));
  }

  function computeSignature(world: GameWorld): string {
    const unlocked = unlockedDefs(world)
      .map((a) => a.id)
      .join(',');
    const claimed = [...world.achievements.claimedIds].sort().join(',');
    const expanded = [...expandedIds].sort().join(';');
    return `${unlocked}|${claimed}|${scrollIndex}|${expanded}`;
  }

  function open(id: string): void {
    if (!lastWorld) return;
    claimAchievementReward(lastWorld, id);
    lastSignature = null;
    refresh(lastWorld);
  }

  function makeRow(def: AchievementDef, x: number, y: number, w: number): number {
    const isExpanded = expandedIds.has(def.id);
    const claimed = lastWorld?.achievements.claimedIds.has(def.id) === true;
    const flavorWrapW = w - 150;
    const isLong = def.directorFlavor.length > FLAVOR_EXPAND_THRESHOLD;

    // Measure the full flavor text height by creating a temporary text object.
    // This runs synchronously and the object is destroyed before the next draw
    // call, so it never appears on screen.
    const tmpFlavor = crispText(x + 12, y + 50, def.directorFlavor, {
      fontFamily: FONT_FAMILY,
      fontSize: '11px',
      fontStyle: 'italic',
      color: hex(COLORS.flavor),
      wordWrap: { width: flavorWrapW },
    });
    const fullFlavorH = Math.max(FLAVOR_LINE_H, tmpFlavor.height);
    tmpFlavor.destroy();

    const collapsedFlavorH = FLAVOR_COLLAPSED_LINES * FLAVOR_LINE_H;
    const flavorH = isLong && !isExpanded ? collapsedFlavorH : fullFlavorH;
    const expanderH = isLong ? EXPANDER_BTN_H : 0;
    const rowHeight = Math.max(ROW_HEIGHT, 50 + flavorH + expanderH + 8);

    const box = scene.add.rectangle(
      x + w / 2,
      y + rowHeight / 2,
      w,
      rowHeight,
      COLORS.rowBg,
      0.9,
    );
    box.setStrokeStyle(1, DIFFICULTY_HEX[def.difficulty]);
    container.add(box);
    rowObjects.push(box);

    const t = crispText(x + 12, y + 8, def.title, {
      fontFamily: FONT_FAMILY,
      fontSize: '15px',
      fontStyle: 'bold',
      color: hex(DIFFICULTY_HEX[def.difficulty]),
    });
    container.add(t);
    rowObjects.push(t);

    const crit = crispText(x + 12, y + 30, def.unlockCriteria, {
      fontFamily: FONT_FAMILY,
      fontSize: '12px',
      color: hex(COLORS.textSecondary),
      wordWrap: { width: flavorWrapW },
    });
    container.add(crit);
    rowObjects.push(crit);

    const flavor = crispText(x + 12, y + 50, def.directorFlavor, {
      fontFamily: FONT_FAMILY,
      fontSize: '11px',
      fontStyle: 'italic',
      color: hex(COLORS.flavor),
      wordWrap: { width: flavorWrapW },
      maxLines: isLong && !isExpanded ? FLAVOR_COLLAPSED_LINES : 0,
    });
    container.add(flavor);
    rowObjects.push(flavor);

    if (isLong) {
      const expanderY = y + 50 + flavorH + 2;
      const expanderLabel = isExpanded ? '▲ less' : '▼ more';
      const expander = crispText(x + 12, expanderY, expanderLabel, {
        fontFamily: FONT_FAMILY,
        fontSize: '10px',
        color: hex(COLORS.textSecondary),
      });
      expander.setInteractive({ useHandCursor: true }).on('pointerdown', () => {
        if (expandedIds.has(def.id)) expandedIds.delete(def.id);
        else expandedIds.add(def.id);
        lastSignature = null;
        if (lastWorld) refresh(lastWorld);
      });
      container.add(expander);
      rowObjects.push(expander);
    }

    const btnLabel = claimed ? rewardReveal(def.reward) : `Open: ${rewardLabel(def.reward)}`;
    const btn = crispText(x + w - 12, y + ROW_HEIGHT / 2, btnLabel, {
      fontFamily: FONT_FAMILY,
      fontSize: '12px',
      fontStyle: 'bold',
      color: claimed ? hex(COLORS.claimed) : hex(COLORS.textPrimary),
      backgroundColor: claimed ? undefined : hex(COLORS.btnBg),
      padding: { x: 8, y: 6 },
      align: 'right',
      wordWrap: { width: 130 },
    });
    btn.setOrigin(1, 0.5);
    if (!claimed) {
      btn
        .setInteractive({ useHandCursor: true })
        .on('pointerover', () => btn.setBackgroundColor(hex(COLORS.btnHover)))
        .on('pointerout', () => btn.setBackgroundColor(hex(COLORS.btnBg)))
        .on('pointerdown', () => open(def.id));
    }
    container.add(btn);
    rowObjects.push(btn);

    return rowHeight;
  }

  function render(): void {
    clearRows();
    if (!lastWorld) return;
    const defs = unlockedDefs(lastWorld);
    const x = panelX + PANEL_PADDING;
    const w = panelWidth - PANEL_PADDING * 2;

    if (defs.length === 0) {
      const empty = crispText(
        x,
        listTop(),
        'No achievements unlocked yet — go earn some on Floor 1.',
        {
          fontFamily: FONT_FAMILY,
          fontSize: '14px',
          color: hex(COLORS.textSecondary),
        },
      );
      container.add(empty);
      rowObjects.push(empty);
      return;
    }

    if (scrollIndex > Math.max(0, defs.length - 1)) scrollIndex = Math.max(0, defs.length - 1);

    const bottom = listBottom();
    let currentY = listTop();
    for (let i = scrollIndex; i < defs.length; i++) {
      if (currentY + ROW_HEIGHT > bottom) break;
      const def = defs[i];
      if (!def) break;
      const rowH = makeRow(def, x, currentY, w);
      currentY += rowH + ROW_GAP;
    }
  }

  function applyLayout(): void {
    uiScale = fitUiScale(scene, panelWidth, panelHeight);
    textResolution = Math.max(1, Math.round(baseResolution * uiScale));
    container.setScale(uiScale);
    panelX = snap((viewWidth() - panelWidth) / 2);
    panelY = snap((viewHeight() - panelHeight) / 2);
    bg.setPosition(panelX + panelWidth / 2, panelY + panelHeight / 2);
    title.setPosition(panelX + PANEL_PADDING, panelY + PANEL_PADDING).setResolution(textResolution);
    hint
      .setPosition(panelX + panelWidth - PANEL_PADDING, panelY + PANEL_PADDING + 2)
      .setResolution(textResolution);
    if (visible) lastSignature = null;
  }

  function refresh(world: GameWorld): void {
    lastWorld = world;
    if (!visible) return;
    const signature = computeSignature(world);
    if (signature !== lastSignature) {
      render();
      lastSignature = signature;
    }
  }

  function toggle(world: GameWorld): void {
    visible = !visible;
    container.setVisible(visible);
    if (visible) {
      scrollIndex = 0;
      expandedIds.clear();
      applyLayout();
      lastSignature = null;
      refresh(world);
    }
  }

  const onWheel = (_p: unknown, _o: unknown, _dx: number, dy: number): void => {
    if (!visible || !lastWorld) return;
    scrollIndex = Math.max(0, scrollIndex + (dy > 0 ? 1 : -1));
    lastSignature = null;
    refresh(lastWorld);
  };
  scene.input.on('wheel', onWheel);
  scene.scale.on('resize', applyLayout);

  return {
    toggle,
    refresh,
    isOpen: () => visible,
    destroy() {
      scene.input.off('wheel', onWheel);
      scene.scale.off('resize', applyLayout);
      clearRows();
      container.destroy();
    },
  };
}
