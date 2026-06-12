/**
 * HudQuestTracker — Skyrim/WoW-style quest tracker, fixed top-right.
 *
 * Reads the quest log (`world.questLog`) and renders up to MAX_ACTIVE_QUESTS
 * active quests. The tracked quest is expanded with a per-objective checklist
 * (☐ / ☑); other active quests collapse to their title only. Multistep quests
 * reveal their objectives one step at a time (later steps stay hidden until the
 * current step completes).
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

const RIGHT_X = GAME.WIDTH - 16;
const TOP_Y = 16;
const DEPTH = 1000;
const MAX_WIDTH = 300;

const COLORS = {
  title: '#fcd34d',
  trackedTitle: '#fde68a',
  objective: '#e5e7eb',
  objectiveDone: '#6ee7b7',
  objectiveActive: '#ffffff',
  bg: '#111827d9',
} as const;

export function createHudQuestTracker(scene: Phaser.Scene): {
  sync(world: GameWorld, playerEid?: number): void;
  destroy(): void;
} {
  const text = scene.add
    .text(RIGHT_X, TOP_Y, '', {
      fontFamily: 'monospace',
      fontSize: '13px',
      color: COLORS.objective,
      backgroundColor: COLORS.bg,
      padding: { x: 12, y: 10 },
      align: 'left',
      wordWrap: { width: MAX_WIDTH },
    })
    .setOrigin(1, 0)
    .setScrollFactor(0)
    .setDepth(DEPTH);

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
      text.setText('');
      text.setVisible(false);
      return;
    }
    text.setVisible(true);

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
    text.setText(lines.join('\n'));
  }

  function destroy(): void {
    text.destroy();
  }

  return { sync, destroy };
}
