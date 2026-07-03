import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { ACTIVE_ABILITY_SLOT_LIMIT } from '../shared/abilities.js';
import { GAME } from '../shared/constants.js';
import { applyCrispText } from './ui-scale.js';
import { isAbilitySlotCastFlashing } from './ability-bar-flash-state.js';

const DEPTH = 1000;
const SLOT_SIZE = 64;
const SLOT_GAP = 8;
const BAR_WIDTH =
  ACTIVE_ABILITY_SLOT_LIMIT * SLOT_SIZE + (ACTIVE_ABILITY_SLOT_LIMIT - 1) * SLOT_GAP;
const BAR_X = Math.max(16, Math.round((GAME.WIDTH - BAR_WIDTH) / 2));
const BAR_Y = GAME.HEIGHT - 148;

const COLORS = {
  slotBg: 0x0f172a,
  slotBorder: 0x334155,
  slotActive: 0x1d4ed8,
  slotActiveBorder: 0x93c5fd,
  // Cast-flash uses a distinctly cool palette (near-white fill + cyan border)
  // so it cannot visually collide with the warm-yellow cooldown bar rendered
  // at the bottom of the slot immediately after the trigger.
  slotCastFlash: 0xf0f9ff,
  slotCastFlashBorder: 0x22d3ee,
  cooldownRing: 0xfbbf24,
} as const;

function shortAbilityLabel(id: string): string {
  const [head] = id.split('-');
  if (!head) return id.slice(0, 3).toUpperCase();
  return head.slice(0, 3).toUpperCase();
}

export function createHudAbilityBar(
  scene: Phaser.Scene,
  options: { parent?: Phaser.GameObjects.Container } = {},
): {
  sync(world: GameWorld, playerEid: number): void;
  destroy(): void;
} {
  const parent = options.parent;
  const slots: Phaser.GameObjects.Rectangle[] = [];
  const labels: Phaser.GameObjects.Text[] = [];
  const cooldownBars: Phaser.GameObjects.Rectangle[] = [];
  const title = scene.add
    .text(BAR_X, BAR_Y - 22, 'ABILITIES [B]', {
      fontFamily: 'Arial, sans-serif',
      fontSize: '12px',
      fontStyle: 'bold',
      color: '#94a3b8',
    })
    .setScrollFactor(0)
    .setDepth(DEPTH)
    .setOrigin(0, 1);
  parent?.add(title);

  for (let i = 0; i < ACTIVE_ABILITY_SLOT_LIMIT; i += 1) {
    const x = BAR_X + i * (SLOT_SIZE + SLOT_GAP);
    const y = BAR_Y;

    const slot = scene.add
      .rectangle(x + SLOT_SIZE / 2, y + SLOT_SIZE / 2, SLOT_SIZE, SLOT_SIZE, COLORS.slotBg, 0.88)
      .setStrokeStyle(2, COLORS.slotBorder)
      .setScrollFactor(0)
      .setDepth(DEPTH);

    const label = scene.add
      .text(x + SLOT_SIZE / 2, y + SLOT_SIZE / 2, '-', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '14px',
        fontStyle: 'bold',
        color: '#cbd5e1',
      })
      .setScrollFactor(0)
      .setDepth(DEPTH + 1)
      .setOrigin(0.5, 0.5);

    const cooldownBar = scene.add
      .rectangle(x + 2, y + SLOT_SIZE - 2, SLOT_SIZE - 4, 4, COLORS.cooldownRing, 0.8)
      .setScrollFactor(0)
      .setDepth(DEPTH + 2)
      .setOrigin(0, 1)
      .setVisible(false);

    slots.push(slot);
    labels.push(label);
    cooldownBars.push(cooldownBar);
  }

  parent?.add([...slots, ...labels, ...cooldownBars]);
  const detachCrispText = applyCrispText(scene, [title, ...labels]);
  const setVisible = (visible: boolean): void => {
    title.setVisible(visible);
    for (const node of slots) node.setVisible(visible);
    for (const node of labels) node.setVisible(visible);
    for (const node of cooldownBars) node.setVisible(false);
  };
  setVisible(false);

  function sync(world: GameWorld, playerEid: number): void {
    const visible = world.featureUnlocks.spells === true;
    setVisible(visible);
    if (!visible) {
      return;
    }
    const state = world.abilityStatesByEntity.get(playerEid);
    const equipped = state?.equippedActiveAbilityIds ?? [];
    const cooldowns = state?.cooldownByAbilityId ?? new Map();
    const cooldownFrames = state?.cooldownFramesByAbilityId ?? new Map();

    for (let i = 0; i < ACTIVE_ABILITY_SLOT_LIMIT; i += 1) {
      const id = equipped[i] ?? null;
      const slot = slots[i]!;
      const label = labels[i]!;
      const cooldownBar = cooldownBars[i]!;

      if (id) {
        const lastTriggerFrame = cooldowns.get(id);
        const cooldownDuration = cooldownFrames.get(id) ?? 0;
        // Cast-flash: right after a trigger, the slot flashes with a cool
        // near-white fill + cyan border (COLORS.slotCastFlash /
        // slotCastFlashBorder) so the fire is unmistakable in the HUD while
        // staying visually distinct from the warm-yellow cooldown bar. Falls
        // back to the normal active colour once the flash window elapses.
        const flashing = isAbilitySlotCastFlashing(world.frameCount, lastTriggerFrame);
        if (flashing) {
          slot
            .setFillStyle(COLORS.slotCastFlash, 0.98)
            .setStrokeStyle(3, COLORS.slotCastFlashBorder);
          label.setColor('#0c4a6e');
        } else {
          slot.setFillStyle(COLORS.slotActive, 0.92).setStrokeStyle(2, COLORS.slotActiveBorder);
          label.setColor('#f8fafc');
        }
        label.setText(shortAbilityLabel(id));

        if (lastTriggerFrame !== undefined && cooldownDuration > 0) {
          const elapsedFrames = Math.max(0, world.frameCount - lastTriggerFrame);
          const remainingRatio = Math.max(0, 1 - elapsedFrames / cooldownDuration);
          if (remainingRatio > 0) {
            cooldownBar.setVisible(true);
            cooldownBar.setSize((SLOT_SIZE - 4) * remainingRatio, 4);
          } else {
            cooldownBar.setVisible(false);
          }
        } else {
          cooldownBar.setVisible(false);
        }
      } else {
        slot.setFillStyle(COLORS.slotBg, 0.88).setStrokeStyle(2, COLORS.slotBorder);
        label.setText('-').setColor('#64748b');
        cooldownBar.setVisible(false);
      }
    }
  }

  function destroy(): void {
    detachCrispText();
    title.destroy();
    for (const node of slots) node.destroy();
    for (const node of labels) node.destroy();
    for (const node of cooldownBars) node.destroy();
  }

  return { sync, destroy };
}
