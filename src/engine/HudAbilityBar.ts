import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { ACTIVE_ABILITY_SLOT_LIMIT } from '../shared/abilities.js';
import { GAME } from '../shared/constants.js';

const DEPTH = 1000;
const SLOT_WIDTH = 56;
const SLOT_HEIGHT = 26;
const SLOT_GAP = 4;
const BAR_WIDTH =
  ACTIVE_ABILITY_SLOT_LIMIT * SLOT_WIDTH + (ACTIVE_ABILITY_SLOT_LIMIT - 1) * SLOT_GAP;
const BAR_X = Math.max(16, Math.round((GAME.WIDTH - BAR_WIDTH) / 2));
const BAR_Y = GAME.HEIGHT - 28;

const COLORS = {
  slotBg: 0x0f172a,
  slotBorder: 0x334155,
  slotActive: 0x1d4ed8,
  slotActiveBorder: 0x93c5fd,
} as const;

function shortAbilityLabel(id: string): string {
  const [head] = id.split('-');
  if (!head) return id.slice(0, 6).toUpperCase();
  return head.slice(0, 6).toUpperCase();
}

export function createHudAbilityBar(scene: Phaser.Scene): {
  sync(world: GameWorld, playerEid: number): void;
  destroy(): void;
} {
  const slots: Phaser.GameObjects.Rectangle[] = [];
  const labels: Phaser.GameObjects.Text[] = [];
  const indices: Phaser.GameObjects.Text[] = [];
  const title = scene.add
    .text(BAR_X, BAR_Y - 14, 'ABILITIES [B]', {
      fontFamily: 'monospace',
      fontSize: '10px',
      color: '#94a3b8',
    })
    .setScrollFactor(0)
    .setDepth(DEPTH);

  for (let i = 0; i < ACTIVE_ABILITY_SLOT_LIMIT; i += 1) {
    const x = BAR_X + i * (SLOT_WIDTH + SLOT_GAP);
    const slot = scene.add
      .rectangle(
        x + SLOT_WIDTH / 2,
        BAR_Y + SLOT_HEIGHT / 2,
        SLOT_WIDTH,
        SLOT_HEIGHT,
        COLORS.slotBg,
        0.88,
      )
      .setStrokeStyle(1, COLORS.slotBorder)
      .setScrollFactor(0)
      .setDepth(DEPTH);
    const label = scene.add
      .text(x + 4, BAR_Y + 9, '-', {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#cbd5e1',
      })
      .setScrollFactor(0)
      .setDepth(DEPTH + 1);
    const index = scene.add
      .text(x + SLOT_WIDTH - 10, BAR_Y + 2, `${i + 1}`, {
        fontFamily: 'monospace',
        fontSize: '9px',
        color: '#64748b',
      })
      .setScrollFactor(0)
      .setDepth(DEPTH + 1);
    slots.push(slot);
    labels.push(label);
    indices.push(index);
  }

  const setVisible = (visible: boolean): void => {
    title.setVisible(visible);
    for (const node of slots) node.setVisible(visible);
    for (const node of labels) node.setVisible(visible);
    for (const node of indices) node.setVisible(visible);
  };
  setVisible(false);

  function sync(world: GameWorld, playerEid: number): void {
    const visible = world.featureUnlocks.spells === true;
    setVisible(visible);
    if (!visible) {
      return;
    }
    const equipped = world.abilityStatesByEntity.get(playerEid)?.equippedActiveAbilityIds ?? [];
    for (let i = 0; i < ACTIVE_ABILITY_SLOT_LIMIT; i += 1) {
      const id = equipped[i] ?? null;
      const slot = slots[i]!;
      const label = labels[i]!;
      if (id) {
        slot.setFillStyle(COLORS.slotActive, 0.92).setStrokeStyle(1, COLORS.slotActiveBorder);
        label.setText(shortAbilityLabel(id)).setColor('#f8fafc');
      } else {
        slot.setFillStyle(COLORS.slotBg, 0.88).setStrokeStyle(1, COLORS.slotBorder);
        label.setText('-').setColor('#64748b');
      }
    }
  }

  function destroy(): void {
    title.destroy();
    for (const node of slots) node.destroy();
    for (const node of labels) node.destroy();
    for (const node of indices) node.destroy();
  }

  return { sync, destroy };
}
