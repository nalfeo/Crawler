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
import { GAME } from '../shared/constants.js';
import {
  getActiveQuests,
  getQuestObjectiveViews,
  type QuestObjectiveView,
} from '../core/systems/questSystem.js';
import { getQuestDef, MAX_ACTIVE_QUESTS } from '../shared/quest-types.js';
import { PIXEL_UI_DEPTH, PIXEL_ICON, createBeveledPanel, addPixelIcon } from './pixel-ui.js';

const RIGHT_X = GAME.WIDTH - 16;
// Sit below the top-right minimap panel (which ends at y≈190) so the two
// top-right HUD panels stack instead of overlapping.
const TOP_Y = 200;
const PAD = 10;
const TITLE_H = 22;
const MAX_WIDTH = 300;
const MIN_WIDTH = 150;

const COLORS = {
  title: '#fcd34d',
  trackedTitle: '#fde68a',
  objective: '#e5e7eb',
  objectiveDone: '#6ee7b7',
} as const;

export function createHudQuestTracker(
  scene: Phaser.Scene,
  options: { parent?: Phaser.GameObjects.Container } = {},
): {
  sync(world: GameWorld, playerEid?: number): void;
  destroy(): void;
} {
  const parent = options.parent;
  const panel = createBeveledPanel(scene, RIGHT_X - MIN_WIDTH, TOP_Y, MIN_WIDTH, TITLE_H + PAD, {
    parent,
  });

  const titleStrip = scene.add
    .rectangle(RIGHT_X - MIN_WIDTH + 2, TOP_Y + 2, MIN_WIDTH - 4, TITLE_H, 0x3a2f12, 1)
    .setOrigin(0, 0)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.panel + 1);

  const titleIcon = addPixelIcon(
    scene,
    PIXEL_ICON.quest,
    RIGHT_X - MIN_WIDTH + 14,
    TOP_Y + 2 + TITLE_H / 2,
    {
      depth: PIXEL_UI_DEPTH.content,
      scale: 0.85,
      parent,
    },
  );

  const titleText = scene.add
    .text(RIGHT_X - MIN_WIDTH + 26, TOP_Y + 2 + TITLE_H / 2, 'QUESTS', {
      fontFamily: 'monospace',
      fontSize: '12px',
      fontStyle: 'bold',
      color: COLORS.title,
    })
    .setOrigin(0, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.content);

  const body = scene.add
    .text(RIGHT_X - PAD, TOP_Y + TITLE_H + 6, '', {
      fontFamily: 'monospace',
      fontSize: '13px',
      color: COLORS.objective,
      align: 'left',
      lineSpacing: 3,
      wordWrap: { width: MAX_WIDTH },
    })
    .setOrigin(1, 0)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.content);
  parent?.add([titleStrip, titleText, body]);

  function setVisible(visible: boolean): void {
    panel.setVisible(visible);
    titleStrip.setVisible(visible);
    titleIcon.setVisible(visible);
    titleText.setVisible(visible);
    body.setVisible(visible);
  }

  function formatObjective(view: QuestObjectiveView): string {
    const box = view.complete ? '☑' : '☐';
    const showCount =
      (view.def.kind === 'counter' || view.def.kind === 'collect') && view.target > 1;
    const count = showCount ? ` (${Math.min(view.current, view.target)}/${view.target})` : '';
    return `  ${box} ${view.def.label}${count}`;
  }

  function sync(world: GameWorld, playerEid?: number): void {
    const active = getActiveQuests(world).slice(0, MAX_ACTIVE_QUESTS);
    if (active.length === 0) {
      body.setText('');
      setVisible(false);
      return;
    }
    setVisible(true);

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
    body.setText(lines.join('\n'));

    // Resize the panel + title strip to hug the content.
    const contentW = Math.max(MIN_WIDTH, Math.ceil(body.width) + PAD * 2);
    const contentH = TITLE_H + 6 + Math.ceil(body.height) + PAD;
    const panelX = RIGHT_X - contentW;
    panel.setPosition(panelX, TOP_Y);
    panel.setSize(contentW, contentH);
    titleStrip.setPosition(panelX + 2, TOP_Y + 2).setSize(contentW - 4, TITLE_H);
    titleIcon.setPosition(panelX + 14, TOP_Y + 2 + TITLE_H / 2);
    titleText.setPosition(panelX + 26, TOP_Y + 2 + TITLE_H / 2);
  }

  function destroy(): void {
    panel.destroy();
    titleStrip.destroy();
    titleIcon.destroy();
    titleText.destroy();
    body.destroy();
  }

  return { sync, destroy };
}
