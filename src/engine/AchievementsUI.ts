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
  ALL_ACHIEVEMENTS,
  type AchievementDef,
  type AchievementDifficulty,
  type AchievementReward,
} from '../shared/achievements.js';
import {
  claimAchievementReward,
  getPendingAchievementRewardPresentation,
  acknowledgeAchievementRewardPresentation,
} from '../core/systems/achievementRewards.js';
import type { RewardOpeningUI } from './RewardOpeningUI.js';
import { prefersReducedMotion } from './reduced-motion.js';

const PANEL_PADDING = 16;
const FONT_FAMILY = 'Segoe UI, Arial, sans-serif';
const ROW_HEIGHT = 98;
const ROW_GAP = 8;

/** Flavor text longer than this (chars) gets a collapse/expand toggle. */
const FLAVOR_EXPAND_THRESHOLD = 120;
/** Approx line height for flavor text (12 px font + spacing). */
const FLAVOR_LINE_H = 16;
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
  flavor: 0xd6d9f1,
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
      return reward.lootTable === 'floor2-generated-equipment'
        ? `${reward.tier} loot box`
        : `${reward.tier} box`;
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
  /**
   * Invoked when a claim's grant fails (e.g. the player's inventory is full),
   * so the caller can surface feedback — the panel button gives no other
   * indication that the click did nothing (the achievement is not marked
   * claimed, so the claim stays retryable).
   */
  onGrantFailed?: (reason: string) => void;
  /**
   * Fired only when this UI has drained its own pending-presentation queue and
   * the shared RewardOpeningUI is now closed, so the caller can resume another
   * reward source through the same modal.
   */
  onPresentationQueueDrained?: (world: GameWorld) => void;
}

export function createAchievementsUI(
  scene: Phaser.Scene,
  rewardOpeningUI: RewardOpeningUI,
  config: AchievementsUIConfig = {},
): {
  toggle(world: GameWorld): void;
  refresh(world: GameWorld): void;
  resumePendingPresentation(world: GameWorld): void;
  /**
   * Claim an unlocked achievement's reward and open its reveal presentation —
   * the exact same code path the panel's "Open reward" button drives. Exposed
   * so automation (e.g. `main-scene-probe-lab`) can trigger a real claim
   * without synthesizing a pointer event on an internal, non-exported button.
   */
  claimReward(achievementId: string): void;
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
  /** Cache of measured full flavor text height keyed by achievement id. */
  const flavorHeightCache = new Map<string, number>();

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
  let scrollbarTrack: Phaser.GameObjects.Rectangle | null = null;
  let scrollbarThumb: Phaser.GameObjects.Rectangle | null = null;

  function clearRows(): void {
    for (const obj of rowObjects) obj.destroy();
    rowObjects.length = 0;
  }

  function unlockedDefs(world: GameWorld): AchievementDef[] {
    return ALL_ACHIEVEMENTS.filter((a) => world.achievements.unlockedIds.has(a.id));
  }

  function computeSignature(world: GameWorld): string {
    const unlocked = unlockedDefs(world)
      .map((a) => a.id)
      .join(',');
    const claimed = [...world.achievements.claimedIds].sort().join(',');
    const expanded = [...expandedIds].sort().join(';');
    return `${unlocked}|${claimed}|${scrollIndex}|${expanded}`;
  }

  function presentAchievementReward(world: GameWorld, id: string): void {
    const presentation = getPendingAchievementRewardPresentation(world, id);
    if (!presentation) return;
    const def = ALL_ACHIEVEMENTS.find((a) => a.id === id);
    rewardOpeningUI.open({
      world,
      presentation,
      reducedMotion: prefersReducedMotion(),
      sourceLabel: def ? `Achievement: ${def.title}` : 'Achievement Reward',
      onAcknowledge: () => {
        acknowledgeAchievementRewardPresentation(world, id);
        lastSignature = null;
        refresh(world);
        resumePendingPresentation(world);
        if (!rewardOpeningUI.isOpen()) {
          config.onPresentationQueueDrained?.(world);
        }
      },
    });
  }

  /**
   * Auto-resumes any achievement claim whose reward presentation hasn't been
   * shown yet (e.g. the game was reloaded between claiming and acknowledging
   * the reveal, or two achievements unlocked in the same frame). Deterministic:
   * scans in catalog order and opens at most one — `RewardOpeningUI` is a
   * single shared modal, and `presentAchievementReward`'s own `onAcknowledge`
   * chain calls back into this function so a save/frame with several pending
   * rewards surfaces every one of them in sequence, not just the first.
   */
  function resumePendingPresentation(world: GameWorld): void {
    if (rewardOpeningUI.isOpen()) return;
    for (const def of ALL_ACHIEVEMENTS) {
      if (getPendingAchievementRewardPresentation(world, def.id)) {
        presentAchievementReward(world, def.id);
        return;
      }
    }
  }

  function open(id: string): void {
    if (!lastWorld) return;
    const result = claimAchievementReward(lastWorld, id);
    lastSignature = null;
    refresh(lastWorld);
    if (!result.ok) {
      // `alreadyClaimed`/`unknown`/`locked` are not real failures the player
      // needs to hear about (stale click, race with another claim path); only
      // `grantFailed` (e.g. full inventory) is an actionable, silent no-op.
      if (result.reason === 'grantFailed') config.onGrantFailed?.(result.reason);
      return;
    }
    presentAchievementReward(lastWorld, id);
  }

  function makeRow(def: AchievementDef, x: number, y: number, w: number): number {
    const isExpanded = expandedIds.has(def.id);
    const claimed = lastWorld?.achievements.claimedIds.has(def.id) === true;
    const rewardColumnWidth = 150;
    const detailsWidth = w - 180;
    const flavorWrapW = detailsWidth;
    const flavorStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: FONT_FAMILY,
      fontSize: '12px',
      color: hex(COLORS.flavor),
      lineSpacing: 2,
      wordWrap: { width: flavorWrapW },
    };
    const isLong = def.directorFlavor.length > FLAVOR_EXPAND_THRESHOLD;

    // Measure the full flavor text height. Results are cached so repeated renders
    // (scrolling, claiming) avoid redundant measurement objects.
    let fullFlavorH = flavorHeightCache.get(def.id);
    if (fullFlavorH === undefined) {
      // Create a temporary text object to measure rendered height. This runs
      // synchronously and is destroyed before the next draw call so it never
      // appears on screen.
      const tmpFlavor = crispText(x + 12, y + 50, def.directorFlavor, flavorStyle);
      fullFlavorH = Math.max(FLAVOR_LINE_H, tmpFlavor.height);
      tmpFlavor.destroy();
      flavorHeightCache.set(def.id, fullFlavorH);
    }

    const collapsedFlavorH = FLAVOR_COLLAPSED_LINES * FLAVOR_LINE_H;
    const flavorH = isLong && !isExpanded ? collapsedFlavorH : fullFlavorH;
    const expanderH = isLong ? EXPANDER_BTN_H : 0;
    const rowHeight = Math.max(ROW_HEIGHT, 50 + flavorH + expanderH + 8);

    const box = scene.add.rectangle(x + w / 2, y + rowHeight / 2, w, rowHeight, COLORS.rowBg, 0.9);
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
      fontSize: '13px',
      color: hex(COLORS.textSecondary),
      wordWrap: { width: detailsWidth },
    });
    container.add(crit);
    rowObjects.push(crit);

    const flavor = crispText(x + 12, y + 50, def.directorFlavor, {
      ...flavorStyle,
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
    const btn = crispText(x + w - 12, y + 14, btnLabel, {
      fontFamily: FONT_FAMILY,
      fontSize: '12px',
      fontStyle: 'bold',
      color: claimed ? hex(COLORS.claimed) : hex(COLORS.textPrimary),
      backgroundColor: claimed ? undefined : hex(COLORS.btnBg),
      padding: { x: 8, y: 6 },
      align: 'right',
      lineSpacing: 2,
      wordWrap: { width: rewardColumnWidth },
    });
    btn.setOrigin(1, 0);
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
      if (scrollbarTrack) scrollbarTrack.setVisible(false);
      if (scrollbarThumb) scrollbarThumb.setVisible(false);
      return;
    }

    if (scrollIndex > Math.max(0, defs.length - 1)) scrollIndex = Math.max(0, defs.length - 1);

    const bottom = listBottom();
    let currentY = listTop();
    let visibleCount = 0;
    for (let i = scrollIndex; i < defs.length; i++) {
      const def = defs[i];
      if (!def) break;
      const rowStartIndex = rowObjects.length;
      const rowH = makeRow(def, x, currentY, w);
      if (visibleCount > 0 && currentY + rowH > bottom) {
        for (let j = rowObjects.length - 1; j >= rowStartIndex; j -= 1) {
          const overflowObj = rowObjects[j];
          overflowObj?.destroy();
          rowObjects.pop();
        }
        break;
      }
      currentY += rowH + ROW_GAP;
      visibleCount++;
      if (currentY > bottom) break;
    }

    // Show scrollbar if there are items off-screen
    const needsScrollbar = scrollIndex > 0 || scrollIndex + visibleCount < defs.length;
    if (needsScrollbar) {
      const scrollbarX = panelX + panelWidth - PANEL_PADDING - 8;
      const scrollbarY = listTop();
      const scrollbarH = listBottom() - listTop();
      const trackW = 6;

      if (!scrollbarTrack) {
        scrollbarTrack = scene.add.rectangle(
          scrollbarX,
          scrollbarY + scrollbarH / 2,
          trackW,
          scrollbarH,
          COLORS.rowBorder,
          0.5,
        );
        container.add(scrollbarTrack);
      } else {
        scrollbarTrack.setPosition(scrollbarX, scrollbarY + scrollbarH / 2);
        scrollbarTrack.setSize(trackW, scrollbarH);
        scrollbarTrack.setVisible(true);
      }

      const thumbH = Math.max(20, (visibleCount / defs.length) * scrollbarH);
      const thumbRange = scrollbarH - thumbH;
      const scrollProgress = defs.length > 1 ? scrollIndex / (defs.length - 1) : 0;
      const thumbY = scrollbarY + scrollProgress * thumbRange + thumbH / 2;

      if (!scrollbarThumb) {
        scrollbarThumb = scene.add.rectangle(
          scrollbarX,
          thumbY,
          trackW,
          thumbH,
          COLORS.textSecondary,
          0.8,
        );
        container.add(scrollbarThumb);
      } else {
        scrollbarThumb.setPosition(scrollbarX, thumbY);
        scrollbarThumb.setSize(trackW, thumbH);
        scrollbarThumb.setVisible(true);
      }
    } else {
      if (scrollbarTrack) scrollbarTrack.setVisible(false);
      if (scrollbarThumb) scrollbarThumb.setVisible(false);
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
    flavorHeightCache.clear();
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
    resumePendingPresentation,
    claimReward: open,
    isOpen: () => visible,
    destroy() {
      scene.input.off('wheel', onWheel);
      scene.scale.off('resize', applyLayout);
      clearRows();
      if (scrollbarTrack) scrollbarTrack.destroy();
      if (scrollbarThumb) scrollbarThumb.destroy();
      container.destroy();
    },
  };
}
