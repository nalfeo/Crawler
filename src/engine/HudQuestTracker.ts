/**
 * HudQuestTracker — Skyrim/WoW-style quest tracker, fixed top-right.
 *
 * Reads the quest log (`world.questLog`) and renders up to MAX_ACTIVE_QUESTS
 * active quests inside a beveled pixel-UI panel with a gold "QUESTS" title
 * strip. The tracked quest is expanded with a per-objective checklist (☐ / ☑);
 * other active quests collapse to their title only. Public `sync`/`destroy`
 * contract is unchanged.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import {
  getActiveQuests,
  getQuestObjectiveViews,
  type QuestObjectiveView,
} from '../core/systems/questSystem.js';
import { getQuestDef, MAX_ACTIVE_QUESTS } from '../shared/quest-types.js';
import { PIXEL_UI_DEPTH, PIXEL_ICON, createBeveledPanel, addPixelIcon } from './pixel-ui.js';
import { applyCrispText, getUiScale, type ScreenBounds } from './ui-scale.js';
import { BLUE_STEEL, hex } from './ui-theme.js';
import {
  NAV_QUEST_MAX_HEIGHT,
  NAV_QUEST_WIDTH,
  resolveNavigationHudLayout,
} from './navigation-hud-layout.js';

const PAD = 12;
const TITLE_H = 26;
const MAX_BODY_LINES = 9;
const MAX_LINE_CHARS = 32;
const FONT_FAMILY = '"Press Start 2P", "Courier New", monospace';

const COLORS = {
  panel: BLUE_STEEL.panelBg,
  border: BLUE_STEEL.panelBorder,
  titleStrip: BLUE_STEEL.sectionHeader,
  title: '#fcd34d',
  objective: hex(BLUE_STEEL.textPrimary),
  objectiveDone: '#6ee7b7',
} as const;

const COLLAPSE_STORAGE_KEY = 'crawler:quest-tracker-collapsed';

function readCollapsedPref(): boolean {
  try {
    return globalThis.localStorage?.getItem(COLLAPSE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsedPref(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(COLLAPSE_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // Ignore storage failures (private mode, headless, etc.).
  }
}

export function fitQuestTrackerLines(
  lines: readonly string[],
  maxChars = MAX_LINE_CHARS,
  maxLines = MAX_BODY_LINES,
): string[] {
  const wrapped: string[] = [];
  for (const rawLine of lines) {
    const indent = rawLine.match(/^\s*/)?.[0] ?? '';
    const contIndent = `${indent}  `;
    // Use the tighter continuation budget so every pre-split chunk fits on
    // both a primary and a continuation line without overflowing.
    const tokenBudget = Math.max(1, maxChars - contIndent.length);
    // Expand words: hard-split any token that exceeds the budget.
    const rawWords = rawLine.trim().split(/\s+/).filter(Boolean);
    const words: string[] = [];
    for (const w of rawWords) {
      for (let i = 0; i < w.length; i += tokenBudget) {
        words.push(w.slice(i, i + tokenBudget));
      }
    }
    let current = indent;
    for (const word of words) {
      const candidate = current.trim().length === 0 ? `${indent}${word}` : `${current} ${word}`;
      if (candidate.length <= maxChars) {
        current = candidate;
        continue;
      }
      wrapped.push(current);
      current = `${contIndent}${word}`;
    }
    if (current.trim().length > 0) {
      wrapped.push(current);
    }
  }
  if (wrapped.length <= maxLines) {
    return wrapped;
  }
  const visible = wrapped.slice(0, maxLines);
  visible[maxLines - 1] =
    `${visible[maxLines - 1]!.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  return visible;
}

export function createHudQuestTracker(
  scene: Phaser.Scene,
  options: { parent?: Phaser.GameObjects.Container } = {},
): {
  sync(world: GameWorld, playerEid?: number): void;
  setVisible(visible: boolean): void;
  getBounds(): ScreenBounds | null;
  destroy(): void;
} {
  const root = scene.add.container(0, 0).setScrollFactor(0).setDepth(PIXEL_UI_DEPTH.panel);
  options.parent?.add(root);
  const panel = createBeveledPanel(scene, 0, 0, NAV_QUEST_WIDTH, TITLE_H + PAD, {
    fill: COLORS.panel,
    highlight: COLORS.border,
    parent: root,
  });

  const titleStrip = scene.add
    .rectangle(2, 2, NAV_QUEST_WIDTH - 4, TITLE_H, COLORS.titleStrip, 1)
    .setOrigin(0, 0)
    .setScrollFactor(0)
    // 0.5 places the strip between panel chrome (999) and content (1000) so
    // root.sort('depth') renders: panel → strip → icon/text.
    .setDepth(PIXEL_UI_DEPTH.panel + 0.5);

  const titleIcon = addPixelIcon(scene, PIXEL_ICON.quest, 14, 2 + TITLE_H / 2, {
    depth: PIXEL_UI_DEPTH.content,
    scale: 0.85,
    parent: root,
  });

  const titleText = scene.add
    .text(28, 2 + TITLE_H / 2, 'QUEST LOG', {
      fontFamily: FONT_FAMILY,
      fontSize: '10px',
      fontStyle: 'bold',
      color: COLORS.title,
      padding: { top: 3, bottom: 2 },
    })
    .setOrigin(0, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.content);

  // Collapse/expand chevron, right-aligned inside the title strip.
  const chevron = scene.add
    .text(NAV_QUEST_WIDTH - PAD, 2 + TITLE_H / 2, '▾', {
      fontFamily: 'monospace',
      fontSize: '14px',
      fontStyle: 'bold',
      color: COLORS.title,
    })
    .setOrigin(1, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.content);

  const body = scene.add
    .text(PAD, TITLE_H + 14, '', {
      fontFamily: FONT_FAMILY,
      fontSize: '9px',
      color: COLORS.objective,
      align: 'left',
      lineSpacing: 8,
      padding: { top: 3, bottom: 2 },
    })
    .setOrigin(0, 0)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.content);
  root.add([titleStrip, titleText, chevron, body]);
  root.sort('depth');
  const detachCrispText = applyCrispText(scene, [titleText, chevron, body]);

  let collapsed = readCollapsedPref();
  let activeVisible = false;
  let masterVisible = true;
  let panelHeight = TITLE_H + PAD;
  let currentScale = 1;
  let lastWorld: GameWorld | null = null;
  let lastPlayerEid: number | undefined;
  chevron.setText(collapsed ? '▸' : '▾');

  // Tapping the title strip collapses/expands the tracker (mobile-friendly).
  titleStrip.setInteractive({ useHandCursor: true });
  titleStrip.on('pointerdown', () => {
    collapsed = !collapsed;
    writeCollapsedPref(collapsed);
    chevron.setText(collapsed ? '▸' : '▾');
    if (lastWorld) {
      sync(lastWorld, lastPlayerEid);
    }
  });

  function applyVisibility(): void {
    const visible = masterVisible && activeVisible;
    root.setVisible(visible);
    panel.setVisible(visible);
    titleStrip.setVisible(visible);
    titleIcon.setVisible(visible);
    titleText.setVisible(visible);
    chevron.setVisible(visible);
    body.setVisible(visible && !collapsed);
  }

  function setVisible(visible: boolean): void {
    masterVisible = visible;
    applyVisibility();
  }

  function applyLayout(floor: number): void {
    const layout = resolveNavigationHudLayout(getUiScale(scene), floor);
    currentScale = layout.questScale;
    root.setScale(currentScale).setPosition(layout.questPosition.x, layout.questPosition.y);
  }

  function formatObjective(view: QuestObjectiveView): string {
    const box = view.complete ? '☑' : '☐';
    const showCount =
      (view.def.kind === 'counter' || view.def.kind === 'collect') && view.target > 1;
    const count = showCount ? ` (${Math.min(view.current, view.target)}/${view.target})` : '';
    return `  ${box} ${view.def.label}${count}`;
  }

  function sync(world: GameWorld, playerEid?: number): void {
    lastWorld = world;
    lastPlayerEid = playerEid;
    // Hidden quests are tracked mechanically but never shown to the player.
    const active = getActiveQuests(world)
      .filter((q) => !getQuestDef(q.questId)?.hidden)
      .slice(0, MAX_ACTIVE_QUESTS);
    if (active.length === 0) {
      body.setText('');
      activeVisible = false;
      applyVisibility();
      return;
    }
    activeVisible = true;
    applyLayout(world.floor);
    applyVisibility();

    const lines: string[] = [];
    for (const quest of active) {
      const def = getQuestDef(quest.questId);
      if (!def) {
        continue;
      }
      const marker = quest.tracked ? '◆' : '◇';
      lines.push(`${marker} ${def.title}`);
      if (quest.tracked) {
        const views = getQuestObjectiveViews(world, quest, playerEid);
        for (const view of views) {
          if (view.hidden) {
            continue;
          }
          lines.push(formatObjective(view));
        }
      }
    }
    body.setText(fitQuestTrackerLines(lines).join('\n'));

    panelHeight = collapsed
      ? TITLE_H + PAD
      : Math.min(NAV_QUEST_MAX_HEIGHT, TITLE_H + 14 + Math.ceil(body.height) + PAD + 8);
    panel.setPosition(0, 0);
    panel.setSize(NAV_QUEST_WIDTH, panelHeight);
    titleStrip.setPosition(2, 2).setSize(NAV_QUEST_WIDTH - 4, TITLE_H);
    body.setVisible(masterVisible && activeVisible && !collapsed);
  }

  function getBounds(): ScreenBounds | null {
    if (!masterVisible || !activeVisible) {
      return null;
    }
    return {
      x: root.x,
      y: root.y,
      width: NAV_QUEST_WIDTH * currentScale,
      height: panelHeight * currentScale,
    };
  }

  function destroy(): void {
    detachCrispText();
    panel.destroy();
    titleStrip.destroy();
    titleIcon.destroy();
    titleText.destroy();
    chevron.destroy();
    body.destroy();
    root.destroy();
  }

  return { sync, setVisible, getBounds, destroy };
}
