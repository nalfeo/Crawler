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
import { getAchievementIconEntry } from './achievement-icon.js';
import {
  createRewardChest,
  rewardChestTier,
  rewardChestBounds,
  LOOT_TIER_HEX,
} from './reward-chest.js';

const PANEL_PADDING = 20;
const FONT_FAMILY = 'Segoe UI, Arial, sans-serif';
const ROW_HEIGHT = 132;
const ROW_GAP = 10;
const ROW_SCROLL_STEP = ROW_HEIGHT + ROW_GAP;
const DRAG_SLOP = 8;
const ACHIEVEMENT_ICON_SIZE = 32;
const ACHIEVEMENT_ICON_GAP = 10;
/** Chest glyph edge length inside the reward column. */
const CHEST_SIZE = 58;
/** Height of the filter chip row, including its bottom margin. */
const FILTER_ROW_H = 30;
/** Width reserved on the right edge for the scrollbar track, whether or not it
 * is currently visible, so rows never resize when scroll state toggles and
 * the reward column can never overlap the thumb. */
const SCROLLBAR_GUTTER = 16;

/** Flavor text longer than this (chars) gets a collapse/expand toggle. */
const FLAVOR_EXPAND_THRESHOLD = 120;
/** Approx line height for flavor text (12 px font + spacing). */
const FLAVOR_LINE_H = 18;
/** Number of lines to show in collapsed state. */
const FLAVOR_COLLAPSED_LINES = 4;
/** Maximum lines shown when a long flavor text is expanded. */
const FLAVOR_EXPANDED_LINES = 8;
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
  btnBg: 0x3a3a68,
  btnHover: 0x5252a0,
  btnTopBevel: 0x6e6ec4,
  btnBottomBevel: 0x1c1c38,
  claimed: 0x22c55e,
  chipBg: 0x1b1b34,
  chipActiveBg: 0x3a3a68,
  chipBorder: 0x3d3d66,
} as const;

/**
 * Scope filters. `current_run` achievements apply to the whole run rather than
 * one floor, so they are surfaced as "Global"; everything else is bucketed by
 * the floor it belongs to.
 */
const FILTER_ALL = 'all';
const FILTER_GLOBAL = 'global';
type AwardsFilter = typeof FILTER_ALL | typeof FILTER_GLOBAL | `floor:${number}`;

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
        ? `${reward.tier} loot`
        : reward.tier;
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
      return 'Opened';
    case 'item':
      return 'Opened';
    case 'directorMessage':
      return `Director: ${reward.message}`;
    case 'none':
      return 'No reward';
  }
}

export interface AchievementsUIConfig {
  width?: number;
  height?: number;
  /** Notifies the scene so gameplay input can be cleared when the panel opens. */
  onVisibilityChange?: (visible: boolean) => void;
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
  setFilterForProbe(filter: AwardsFilter): void;
  setExpandedForProbe(achievementId: string, expanded: boolean): void;
  setScrollIndexForProbe(index: number): void;
  isOpen(): boolean;
  getScrollIndex(): number;
  /**
   * Rendered geometry for the visible surface, in design space. Consumed by the
   * visual-review setup file so the judge measures REAL boxes (and the
   * deterministic sensors can assert chest-in-row containment) instead of a
   * single hand-written panel rectangle.
   */
  getLayoutRegions(): {
    id: string;
    box: { x: number; y: number; width: number; height: number };
    kind: string;
    parentId?: string;
  }[];
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
  let dragPointerId: number | null = null;
  let dragLastY: number | null = null;
  let dragRemainder = 0;
  let dragTravel = 0;
  let draggedPointerId: number | null = null;
  const expandedIds = new Set<string>();
  let activeFilter: AwardsFilter = FILTER_ALL;
  /** Chip objects are rebuilt per render alongside rows. */
  const filterObjects: Phaser.GameObjects.GameObject[] = [];
  /** Geometry published for visual-review sensors; rebuilt every render. */
  let layoutRegions: {
    id: string;
    box: { x: number; y: number; width: number; height: number };
    kind: string;
    parentId?: string;
  }[] = [];
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

  const title = crispText(0, 0, '🏆 AWARDS', {
    fontFamily: FONT_FAMILY,
    fontSize: '20px',
    color: hex(COLORS.textPrimary),
  });
  container.add(title);

  const hint = crispText(0, 0, '[V]/[ESC] close', {
    fontFamily: FONT_FAMILY,
    fontSize: '13px',
    color: hex(COLORS.textSecondary),
  });
  hint.setOrigin(1, 0);
  container.add(hint);

  const summary = crispText(0, 0, '', {
    fontFamily: FONT_FAMILY,
    fontSize: '12px',
    color: hex(COLORS.textSecondary),
  });
  container.add(summary);

  const headerRule = scene.add.rectangle(
    0,
    0,
    panelWidth - PANEL_PADDING * 2,
    1,
    COLORS.panelBorder,
    1,
  );
  container.add(headerRule);

  const listTop = (): number => panelY + PANEL_PADDING + 62 + FILTER_ROW_H;
  const filterTop = (): number => panelY + PANEL_PADDING + 62;
  const listBottom = (): number => panelY + panelHeight - PANEL_PADDING;

  const rowObjects: Phaser.GameObjects.GameObject[] = [];
  let scrollbarTrack: Phaser.GameObjects.Rectangle | null = null;
  let scrollbarThumb: Phaser.GameObjects.Rectangle | null = null;

  function clearRows(): void {
    for (const obj of rowObjects) obj.destroy();
    rowObjects.length = 0;
    for (const obj of filterObjects) obj.destroy();
    filterObjects.length = 0;
  }

  /** True when `def` belongs in the currently selected filter bucket. */
  function matchesFilter(def: AchievementDef, filter: AwardsFilter): boolean {
    if (filter === FILTER_ALL) return true;
    if (filter === FILTER_GLOBAL) return def.scope === 'current_run';
    return def.scope !== 'current_run' && `floor:${def.floor}` === filter;
  }

  /**
   * Unlocked achievements, with unopened loot-box rewards sorted to the top
   * (catalog order preserved within each group via a stable sort) so the
   * player sees actionable "Open reward" boxes before already-claimed rows.
   */
  function unlockedDefs(world: GameWorld): AchievementDef[] {
    const unlocked = ALL_ACHIEVEMENTS.filter(
      (a) => world.achievements.unlockedIds.has(a.id) && matchesFilter(a, activeFilter),
    );
    const rank = (def: AchievementDef): number => {
      const isUnopenedBox =
        def.reward.type === 'lootBox' && !world.achievements.claimedIds.has(def.id);
      return isUnopenedBox ? 0 : 1;
    };
    return [...unlocked].sort((a, b) => rank(a) - rank(b));
  }

  function computeSignature(world: GameWorld): string {
    const unlocked = unlockedDefs(world)
      .map((a) => a.id)
      .join(',');
    const claimed = [...world.achievements.claimedIds].sort().join(',');
    const expanded = [...expandedIds].sort().join(';');
    return `${unlocked}|${claimed}|${scrollIndex}|${expanded}|${activeFilter}`;
  }

  function presentAchievementReward(world: GameWorld, id: string): void {
    const presentation = getPendingAchievementRewardPresentation(world, id);
    if (!presentation) return;
    const def = ALL_ACHIEVEMENTS.find((a) => a.id === id);
    const next = nextOpenableLootBoxDef(world, id);
    rewardOpeningUI.open({
      world,
      presentation,
      reducedMotion: prefersReducedMotion(),
      sourceLabel: def ? `Achievement: ${def.title}` : 'Achievement Reward',
      nextReward: next
        ? { label: rewardLabel(next.reward), open: () => claimAndPresent(world, next.id) }
        : undefined,
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
   * The next unlocked-but-unclaimed achievement whose reward actually opens a
   * box (`lootBox` — the only reward type that produces a reveal
   * presentation), in catalog order. Drives the summary screen's "Open next"
   * chain so several boxes can be opened back to back. `item`/
   * `directorMessage`/`none` rewards are skipped rather than chained into:
   * claiming one produces no presentation, so chaining would silently claim it
   * and close the overlay with nothing shown.
   */
  function nextOpenableLootBoxDef(world: GameWorld, excludeId: string): AchievementDef | null {
    for (const def of ALL_ACHIEVEMENTS) {
      if (def.id === excludeId) continue;
      if (def.reward.type !== 'lootBox') continue;
      if (!world.achievements.unlockedIds.has(def.id)) continue;
      if (world.achievements.claimedIds.has(def.id)) continue;
      return def;
    }
    return null;
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

  function claimAndPresent(world: GameWorld, id: string): void {
    const result = claimAchievementReward(world, id);
    lastSignature = null;
    refresh(world);
    if (!result.ok) {
      // `alreadyClaimed`/`unknown`/`locked` are not real failures the player
      // needs to hear about (stale click, race with another claim path); only
      // `grantFailed` (e.g. full inventory) is an actionable, silent no-op.
      if (result.reason === 'grantFailed') config.onGrantFailed?.(result.reason);
      return;
    }
    presentAchievementReward(world, id);
  }

  function open(id: string): void {
    if (!lastWorld) return;
    claimAndPresent(lastWorld, id);
  }

  function makeRow(def: AchievementDef, x: number, y: number, w: number): number {
    const isExpanded = expandedIds.has(def.id);
    const claimed = lastWorld?.achievements.claimedIds.has(def.id) === true;
    const rewardColumnWidth = 170;
    const iconEntry = getAchievementIconEntry(scene, def);
    const textLeft = x + 12 + ACHIEVEMENT_ICON_SIZE + ACHIEVEMENT_ICON_GAP;
    const detailsWidth = w - (textLeft - x) - rewardColumnWidth - 18;
    const flavorWrapW = detailsWidth;
    const flavorStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: FONT_FAMILY,
      fontSize: '13px',
      color: hex(COLORS.flavor),
      lineSpacing: 3,
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
      const tmpFlavor = crispText(textLeft, y + 50, def.directorFlavor, flavorStyle);
      fullFlavorH = Math.max(FLAVOR_LINE_H, tmpFlavor.height);
      tmpFlavor.destroy();
      flavorHeightCache.set(def.id, fullFlavorH);
    }

    const collapsedFlavorH = FLAVOR_COLLAPSED_LINES * FLAVOR_LINE_H;
    const expandedFlavorH = FLAVOR_EXPANDED_LINES * FLAVOR_LINE_H;
    const flavorH = isLong ? (isExpanded ? expandedFlavorH : collapsedFlavorH) : fullFlavorH;
    const expanderH = isLong ? EXPANDER_BTN_H : 0;
    const titleMeasure = crispText(textLeft, y, def.title, {
      fontFamily: FONT_FAMILY,
      fontSize: '15px',
      fontStyle: 'bold',
      color: hex(DIFFICULTY_HEX[def.difficulty]),
    });
    const titleH = titleMeasure.height;
    titleMeasure.destroy();
    const criteriaMeasure = crispText(textLeft, y, def.unlockCriteria, {
      fontFamily: FONT_FAMILY,
      fontSize: '14px',
      color: hex(COLORS.textSecondary),
      wordWrap: { width: detailsWidth },
    });
    const criteriaH = criteriaMeasure.height;
    criteriaMeasure.destroy();
    const titleY = y + 8;
    const criteriaY = titleY + titleH + 4;
    const flavorY = criteriaY + criteriaH + 6;
    // The reward column (chest + tier label + button) is often taller than the
    // text column; the row must reserve whichever is larger or the chest leaks.
    const rewardColumnH = 10 + rewardChestBounds(0, 0, CHEST_SIZE).height + 4 + 18 + 30 + 10;
    const rowHeight = Math.max(ROW_HEIGHT, flavorY - y + flavorH + expanderH + 8, rewardColumnH);

    const box = scene.add.rectangle(x + w / 2, y + rowHeight / 2, w, rowHeight, COLORS.rowBg, 0.9);
    box.setStrokeStyle(1, DIFFICULTY_HEX[def.difficulty]);
    if (claimed) box.setFillStyle(COLORS.panelBg, 0.72);
    container.add(box);
    rowObjects.push(box);

    const rowId = `row:${def.id}`;
    layoutRegions.push({
      id: rowId,
      box: { x, y, width: w, height: rowHeight },
      kind: 'row',
      parentId: 'awards-panel',
    });
    layoutRegions.push({
      id: `${rowId}.icon`,
      box: {
        x: x + 12,
        y: y + 10,
        width: ACHIEVEMENT_ICON_SIZE,
        height: ACHIEVEMENT_ICON_SIZE,
      },
      kind: 'icon',
      parentId: rowId,
    });

    // The framed icon box always renders so the row keeps a stable left rail;
    // the sprite is layered in only when art exists for this achievement.
    const iconBg = scene.add.rectangle(
      x + 12 + ACHIEVEMENT_ICON_SIZE / 2,
      y + 10 + ACHIEVEMENT_ICON_SIZE / 2,
      ACHIEVEMENT_ICON_SIZE,
      ACHIEVEMENT_ICON_SIZE,
      COLORS.panelBg,
      0.9,
    );
    iconBg.setStrokeStyle(1, COLORS.rowBorder);
    container.add(iconBg);
    rowObjects.push(iconBg);

    if (iconEntry) {
      const iconSprite = scene.add
        .image(
          x + 12 + ACHIEVEMENT_ICON_SIZE / 2,
          y + 10 + ACHIEVEMENT_ICON_SIZE / 2,
          iconEntry.textureKey,
        )
        .setDisplaySize(ACHIEVEMENT_ICON_SIZE - 4, ACHIEVEMENT_ICON_SIZE - 4);
      container.add(iconSprite);
      rowObjects.push(iconSprite);
    } else {
      // Placeholder glyph keeps the frame from reading as a broken image.
      const placeholder = crispText(
        x + 12 + ACHIEVEMENT_ICON_SIZE / 2,
        y + 10 + ACHIEVEMENT_ICON_SIZE / 2,
        '🏆',
        { fontFamily: FONT_FAMILY, fontSize: '16px', color: hex(COLORS.textSecondary) },
      );
      placeholder.setOrigin(0.5, 0.5);
      container.add(placeholder);
      rowObjects.push(placeholder);
    }

    const t = crispText(textLeft, titleY, def.title, {
      fontFamily: FONT_FAMILY,
      fontSize: '15px',
      fontStyle: 'bold',
      color: hex(DIFFICULTY_HEX[def.difficulty]),
    });
    container.add(t);
    rowObjects.push(t);

    const crit = crispText(textLeft, criteriaY, def.unlockCriteria, {
      fontFamily: FONT_FAMILY,
      fontSize: '14px',
      color: hex(COLORS.textSecondary),
      wordWrap: { width: detailsWidth },
    });
    container.add(crit);
    rowObjects.push(crit);

    const flavor = crispText(textLeft, flavorY, def.directorFlavor, {
      ...flavorStyle,
      maxLines: isLong ? (isExpanded ? FLAVOR_EXPANDED_LINES : FLAVOR_COLLAPSED_LINES) : 0,
    });
    container.add(flavor);
    rowObjects.push(flavor);

    if (isLong) {
      const expanderY = flavorY + flavorH + 2;
      const expanderLabel = isExpanded ? '▲ Show less' : '▼ Show more';
      const expander = crispText(textLeft, expanderY, expanderLabel, {
        fontFamily: FONT_FAMILY,
        fontSize: '14px',
        fontStyle: 'bold',
        color: hex(COLORS.btnTopBevel),
      });
      expander
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', onPointerDown)
        .on('pointerup', (pointer: Phaser.Input.Pointer) => {
          if (pointer.id === draggedPointerId) return;
          if (expandedIds.has(def.id)) expandedIds.delete(def.id);
          else expandedIds.add(def.id);
          lastSignature = null;
          if (lastWorld) refresh(lastWorld);
        });
      container.add(expander);
      rowObjects.push(expander);
    }

    // ---- Reward column: chest glyph above a beveled, center-aligned button. ----
    const colRight = x + w - 18;
    const colCx = colRight - rewardColumnWidth / 2;
    const chestTier = rewardChestTier(def.reward);
    const accent = LOOT_TIER_HEX[chestTier];

    const chestTop = y + 10;
    const chestBox = rewardChestBounds(colCx, chestTop, CHEST_SIZE);

    const chestParts = createRewardChest(scene, {
      x: colCx,
      y: chestTop,
      size: CHEST_SIZE,
      tier: chestTier,
      open: claimed,
    });
    for (const part of chestParts) {
      container.add(part);
      rowObjects.push(part);
    }
    // Declared as an `icon` bound to the row: the deterministic "icon escapes
    // tile" sensor then fails the exact chest-leaking-out-of-its-row defect.
    layoutRegions.push({
      id: `${rowId}.chest`,
      box: chestBox,
      kind: 'icon',
      parentId: rowId,
    });

    const tierLabel = crispText(colCx, chestBox.y + chestBox.height + 4, rewardLabel(def.reward), {
      fontFamily: FONT_FAMILY,
      fontSize: '12px',
      fontStyle: 'bold',
      color: hex(accent),
    });
    tierLabel.setOrigin(0.5, 0);
    container.add(tierLabel);
    rowObjects.push(tierLabel);

    const btnW = rewardColumnWidth - 8;
    const btnH = 30;
    const btnCy = chestBox.y + chestBox.height + 4 + 18 + btnH / 2;
    layoutRegions.push({
      id: `${rowId}.cta`,
      box: { x: colCx - btnW / 2, y: btnCy - btnH / 2, width: btnW, height: btnH },
      kind: claimed ? 'label' : 'button',
      parentId: rowId,
    });

    if (claimed) {
      const claimedText = crispText(colCx, btnCy, `✔ ${rewardReveal(def.reward)}`, {
        fontFamily: FONT_FAMILY,
        fontSize: '13px',
        fontStyle: 'bold',
        color: hex(COLORS.claimed),
        align: 'center',
        wordWrap: { width: btnW },
      });
      claimedText.setOrigin(0.5, 0.5);
      container.add(claimedText);
      rowObjects.push(claimedText);
    } else {
      // Bevel: a lit top edge and a dark bottom edge give the face real depth
      // rather than the flat text-background the button used to be.
      const bottomBevel = scene.add.rectangle(
        colCx,
        btnCy + 2,
        btnW,
        btnH,
        COLORS.btnBottomBevel,
        1,
      );
      container.add(bottomBevel);
      rowObjects.push(bottomBevel);

      const face = scene.add.rectangle(colCx, btnCy, btnW, btnH, COLORS.btnBg, 1);
      // Neutral border: rarity color already reads via the chest + tier label,
      // so the CTA itself stays a consistent shape regardless of reward tier.
      face.setStrokeStyle(1, COLORS.btnTopBevel, 0.6);
      container.add(face);
      rowObjects.push(face);

      const topBevel = scene.add.rectangle(
        colCx,
        btnCy - btnH / 2 + 2,
        btnW - 4,
        2,
        COLORS.btnTopBevel,
        0.75,
      );
      container.add(topBevel);
      rowObjects.push(topBevel);

      const btn = crispText(colCx, btnCy, 'OPEN', {
        fontFamily: FONT_FAMILY,
        fontSize: '15px',
        fontStyle: 'bold',
        color: hex(COLORS.textPrimary),
        align: 'center',
      });
      btn.setOrigin(0.5, 0.5);
      container.add(btn);
      rowObjects.push(btn);

      face
        .setInteractive({ useHandCursor: true })
        .on('pointerover', () => {
          face.setFillStyle(COLORS.btnHover, 1);
          // Pressing the face down into the bevel sells the depth on hover.
          topBevel.setVisible(true);
        })
        .on('pointerout', () => face.setFillStyle(COLORS.btnBg, 1))
        .on('pointerdown', onPointerDown)
        .on('pointerup', (pointer: Phaser.Input.Pointer) => {
          if (pointer.id !== draggedPointerId) open(def.id);
        });
    }

    return rowHeight;
  }

  /** Renders the scope filter chips and returns nothing; chips drive re-render. */
  function renderFilters(world: GameWorld, x: number, w: number): void {
    const floors = [
      ...new Set(
        ALL_ACHIEVEMENTS.filter(
          (a) => world.achievements.unlockedIds.has(a.id) && a.scope !== 'current_run',
        ).map((a) => a.floor),
      ),
    ].sort((a, b) => a - b);

    const chips: { id: AwardsFilter; label: string }[] = [
      { id: FILTER_ALL, label: 'All' },
      { id: FILTER_GLOBAL, label: 'Global' },
      ...floors.map((floor) => ({ id: `floor:${floor}` as AwardsFilter, label: `Floor ${floor}` })),
    ];

    let chipX = x;
    const chipY = filterTop();
    const chipH = 22;
    for (const chip of chips) {
      const isActive = activeFilter === chip.id;
      const label = crispText(0, 0, chip.label, {
        fontFamily: FONT_FAMILY,
        fontSize: '13px',
        fontStyle: isActive ? 'bold' : 'normal',
        color: hex(isActive ? COLORS.textPrimary : COLORS.textSecondary),
      });
      const chipW = label.width + 22;
      if (chipX + chipW > x + w) break;

      const bgRect = scene.add.rectangle(
        chipX + chipW / 2,
        chipY + chipH / 2,
        chipW,
        chipH,
        isActive ? COLORS.chipActiveBg : COLORS.chipBg,
        1,
      );
      bgRect.setStrokeStyle(1, isActive ? COLORS.btnTopBevel : COLORS.chipBorder, 1);
      container.add(bgRect);
      filterObjects.push(bgRect);

      label.setPosition(snap(chipX + chipW / 2), snap(chipY + chipH / 2)).setOrigin(0.5, 0.5);
      container.add(label);
      filterObjects.push(label);

      bgRect
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', onPointerDown)
        .on('pointerup', (pointer: Phaser.Input.Pointer) => {
          if (pointer.id === draggedPointerId) return;
          if (activeFilter === chip.id) return;
          activeFilter = chip.id;
          scrollIndex = 0;
          lastSignature = null;
          if (lastWorld) refresh(lastWorld);
        });

      chipX += chipW + 8;
    }
  }

  function render(): void {
    clearRows();
    layoutRegions = [];
    if (!lastWorld) return;
    const defs = unlockedDefs(lastWorld);
    const x = panelX + PANEL_PADDING;
    const w = panelWidth - PANEL_PADDING * 2 - SCROLLBAR_GUTTER;

    renderFilters(lastWorld, x, w);

    if (defs.length === 0) {
      const empty = crispText(
        x,
        listTop(),
        activeFilter === FILTER_ALL
          ? 'No achievements unlocked yet — go earn some on Floor 1.'
          : 'No awards in this filter yet.',
        {
          fontFamily: FONT_FAMILY,
          fontSize: '16px',
          fontStyle: 'bold',
          color: hex(COLORS.textPrimary),
        },
      );
      container.add(empty);
      rowObjects.push(empty);
      summary.setText('0 unlocked  ·  0 rewards ready');
      if (scrollbarTrack) scrollbarTrack.setVisible(false);
      if (scrollbarThumb) scrollbarThumb.setVisible(false);
      layoutRegions.unshift({
        id: 'awards-panel',
        box: { x: panelX, y: panelY, width: panelWidth, height: panelHeight },
        kind: 'panel',
      });
      return;
    }

    const openCount = defs.filter(
      (def) => def.reward.type === 'lootBox' && !lastWorld?.achievements.claimedIds.has(def.id),
    ).length;
    summary.setText(
      `${defs.length} unlocked  ·  ${openCount} reward${openCount === 1 ? '' : 's'} ready`,
    );

    if (scrollIndex > Math.max(0, defs.length - 1)) scrollIndex = Math.max(0, defs.length - 1);

    const bottom = listBottom();
    let currentY = listTop();
    let visibleCount = 0;
    for (let i = scrollIndex; i < defs.length; i++) {
      const def = defs[i];
      if (!def) break;
      const rowStartIndex = rowObjects.length;
      const rowRegionStartIndex = layoutRegions.length;
      const rowH = makeRow(def, x, currentY, w);
      if (visibleCount > 0 && currentY + rowH > bottom) {
        for (let j = rowObjects.length - 1; j >= rowStartIndex; j -= 1) {
          const overflowObj = rowObjects[j];
          overflowObj?.destroy();
          rowObjects.pop();
        }
        // Drop the discarded row's published geometry too, or the sensors see a
        // row that overruns the panel even though nothing is drawn there.
        layoutRegions.length = rowRegionStartIndex;
        break;
      }
      currentY += rowH + ROW_GAP;
      visibleCount++;
      if (currentY > bottom) break;
    }

    // Collapse the panel to its content so a short list does not leave a large
    // empty band below the last row. Full height is still the ceiling.
    const contentBottom = currentY - ROW_GAP + PANEL_PADDING;
    const fittedHeight = Math.min(panelHeight, Math.max(240, contentBottom - panelY));
    bg.setSize(panelWidth, fittedHeight);
    bg.setPosition(panelX + panelWidth / 2, panelY + fittedHeight / 2);
    // Panel first so it is the parent of every row region already collected.
    layoutRegions.unshift({
      id: 'awards-panel',
      box: { x: panelX, y: panelY, width: panelWidth, height: fittedHeight },
      kind: 'panel',
    });

    // Show scrollbar if there are items off-screen
    const needsScrollbar = scrollIndex > 0 || scrollIndex + visibleCount < defs.length;
    if (needsScrollbar) {
      const rowRight = x + w;
      // Center the bar in the reserved gutter so it can never collide with a
      // row's right edge, no matter how the reward column is sized.
      const scrollbarX = rowRight + SCROLLBAR_GUTTER / 2;
      const scrollbarY = listTop();
      // Track the FITTED frame, not the full-height one, or the bar overhangs
      // the bottom edge of a collapsed panel.
      const scrollbarH = panelY + fittedHeight - PANEL_PADDING - scrollbarY;
      const trackW = 8;

      if (!scrollbarTrack) {
        scrollbarTrack = scene.add.rectangle(
          scrollbarX,
          scrollbarY + scrollbarH / 2,
          trackW,
          scrollbarH,
          COLORS.rowBg,
          0.6,
        );
        scrollbarTrack.setStrokeStyle(1, COLORS.rowBorder, 0.8);
        container.add(scrollbarTrack);
      } else {
        scrollbarTrack.setPosition(scrollbarX, scrollbarY + scrollbarH / 2);
        scrollbarTrack.setSize(trackW, scrollbarH);
        scrollbarTrack.setVisible(true);
      }

      const thumbH = Math.max(24, (visibleCount / defs.length) * scrollbarH);
      const thumbRange = scrollbarH - thumbH;
      const scrollProgress = defs.length > 1 ? scrollIndex / (defs.length - 1) : 0;
      const thumbY = scrollbarY + scrollProgress * thumbRange + thumbH / 2;

      if (!scrollbarThumb) {
        // A beveled thumb with a lit accent stroke matches the button
        // language instead of reading as a flat gray bar.
        scrollbarThumb = scene.add.rectangle(scrollbarX, thumbY, trackW, thumbH, COLORS.btnBg, 1);
        scrollbarThumb.setStrokeStyle(1, COLORS.btnTopBevel, 0.9);
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
    summary
      .setPosition(panelX + PANEL_PADDING, panelY + PANEL_PADDING + 30)
      .setResolution(textResolution);
    headerRule.setPosition(panelX + panelWidth / 2, panelY + PANEL_PADDING + 52);
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
    config.onVisibilityChange?.(visible);
    if (visible) {
      scrollIndex = 0;
      expandedIds.clear();
      activeFilter = FILTER_ALL;
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
  function onPointerDown(pointer: Phaser.Input.Pointer): void {
    if (!visible || !bg.getBounds().contains(pointer.x, pointer.y)) return;
    dragPointerId = pointer.id;
    dragLastY = pointer.y;
    dragRemainder = 0;
    dragTravel = 0;
    draggedPointerId = null;
  }
  const onPointerMove = (pointer: Phaser.Input.Pointer): void => {
    if (!visible || !lastWorld || pointer.id !== dragPointerId || dragLastY === null) return;
    const deltaY = (dragLastY - pointer.y) / uiScale;
    dragLastY = pointer.y;
    dragTravel += Math.abs(deltaY);
    if (dragTravel < DRAG_SLOP) return;
    draggedPointerId = pointer.id;
    dragRemainder += deltaY;
    const previousScrollIndex = scrollIndex;
    while (dragRemainder >= ROW_SCROLL_STEP) {
      dragRemainder -= ROW_SCROLL_STEP;
      scrollIndex += 1;
    }
    while (dragRemainder <= -ROW_SCROLL_STEP) {
      dragRemainder += ROW_SCROLL_STEP;
      scrollIndex -= 1;
    }
    scrollIndex = Math.max(0, Math.min(scrollIndex, unlockedDefs(lastWorld).length - 1));
    if (scrollIndex === previousScrollIndex) return;
    lastSignature = null;
    refresh(lastWorld);
  };
  const onPointerUp = (pointer: Phaser.Input.Pointer): void => {
    if (pointer.id !== dragPointerId) return;
    dragPointerId = null;
    dragLastY = null;
    dragRemainder = 0;
    dragTravel = 0;
  };
  scene.input.on('pointerdown', onPointerDown);
  scene.input.on('wheel', onWheel);
  scene.input.on('pointermove', onPointerMove);
  scene.input.on('pointerup', onPointerUp);
  scene.input.on('pointerupoutside', onPointerUp);
  scene.scale.on('resize', applyLayout);

  return {
    toggle,
    refresh,
    resumePendingPresentation,
    claimReward: open,
    setFilterForProbe(filter: AwardsFilter) {
      activeFilter = filter;
      scrollIndex = 0;
      lastSignature = null;
      if (lastWorld) refresh(lastWorld);
    },
    setExpandedForProbe(achievementId: string, expanded: boolean) {
      if (expanded) expandedIds.add(achievementId);
      else expandedIds.delete(achievementId);
      lastSignature = null;
      if (lastWorld) refresh(lastWorld);
    },
    setScrollIndexForProbe(index: number) {
      const max = Math.max(0, lastWorld ? unlockedDefs(lastWorld).length - 1 : 0);
      scrollIndex = Math.max(0, Math.min(index, max));
      lastSignature = null;
      if (lastWorld) refresh(lastWorld);
    },
    isOpen: () => visible,
    getScrollIndex: () => scrollIndex,
    getLayoutRegions: () => layoutRegions.map((region) => ({ ...region, box: { ...region.box } })),
    destroy() {
      scene.input.off('wheel', onWheel);
      scene.input.off('pointerdown', onPointerDown);
      scene.input.off('pointermove', onPointerMove);
      scene.input.off('pointerup', onPointerUp);
      scene.input.off('pointerupoutside', onPointerUp);
      scene.scale.off('resize', applyLayout);
      clearRows();
      if (scrollbarTrack) scrollbarTrack.destroy();
      if (scrollbarThumb) scrollbarThumb.destroy();
      container.destroy();
    },
  };
}
