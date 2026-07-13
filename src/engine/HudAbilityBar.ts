import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { ACTIVE_ABILITY_SLOT_LIMIT } from '../shared/abilities.js';
import { getAbilityPresentation } from '../shared/ability-presentation.js';
import { GAME } from '../shared/constants.js';
import { isAbilitySlotCastFlashing } from './ability-bar-flash-state.js';
import { getAbilityIconEntry } from './ability-icon.js';
import { createBeveledPanel } from './pixel-ui.js';
import { BLUE_STEEL, hex } from './ui-theme.js';
import { applyCrispText, fitScaleForBox, type ScreenBounds } from './ui-scale.js';

const DEPTH = 1000;
const SLOT_WIDTH = 54;
const SLOT_HEIGHT = 58;
const SLOT_GAP = 6;
const BAR_WIDTH =
  ACTIVE_ABILITY_SLOT_LIMIT * SLOT_WIDTH + (ACTIVE_ABILITY_SLOT_LIMIT - 1) * SLOT_GAP;
const BAR_X = Math.max(16, Math.round((GAME.WIDTH - BAR_WIDTH) / 2));
const BAR_Y = GAME.HEIGHT - 140;
const PANEL_PADDING = 8;
const PANEL_TOP = BAR_Y - 30;
const PANEL_HEIGHT = SLOT_HEIGHT + 38;

const COLORS = {
  ...BLUE_STEEL,
  slotBg: 0x111a2d,
  slotBorder: 0x34496f,
  slotActive: 0x2d456f,
  slotActiveBorder: 0x8fa9cf,
  combat: 0xc65353,
  defense: 0x4f83c2,
  utility: 0x8f68b5,
  slotCastFlash: 0xf0f9ff,
  slotCastFlashBorder: 0x22d3ee,
  cooldownRing: 0xfbbf24,
} as const;

function abilityAccent(id: string): number {
  const category = getAbilityPresentation(id)?.category;
  if (category === 'combat') return COLORS.combat;
  if (category === 'defense') return COLORS.defense;
  return COLORS.utility;
}

export function createHudAbilityBar(
  scene: Phaser.Scene,
  options: { parent?: Phaser.GameObjects.Container } = {},
): {
  sync(world: GameWorld, playerEid: number): void;
  getPanelScreenBounds(): ScreenBounds;
  getSlotScreenBounds(index: number): ScreenBounds | null;
  destroy(): void;
} {
  const parent = options.parent;
  const slots: Phaser.GameObjects.Rectangle[] = [];
  const accentBars: Phaser.GameObjects.Rectangle[] = [];
  const keyLabels: Phaser.GameObjects.Text[] = [];
  const abilityLabels: Phaser.GameObjects.Text[] = [];
  const abilityIcons: Phaser.GameObjects.Image[] = [];
  const cooldownLabels: Phaser.GameObjects.Text[] = [];
  const cooldownBars: Phaser.GameObjects.Rectangle[] = [];

  const panel = createBeveledPanel(
    scene,
    BAR_X - PANEL_PADDING,
    PANEL_TOP,
    BAR_WIDTH + PANEL_PADDING * 2,
    PANEL_HEIGHT,
    { fill: COLORS.panelBg, fillAlpha: 0.94, depth: DEPTH - 1, parent },
  );
  const title = scene.add
    .text(BAR_X, PANEL_TOP + 8, 'AUTO ABILITIES', {
      fontFamily: 'monospace',
      fontSize: '13px',
      fontStyle: 'bold',
      color: hex(COLORS.textSecondary),
    })
    .setScrollFactor(0)
    .setDepth(DEPTH)
    .setOrigin(0, 0);
  const manageHint = scene.add
    .text(BAR_X + BAR_WIDTH, PANEL_TOP + 8, '[B] MANAGE', {
      fontFamily: 'monospace',
      fontSize: '12px',
      fontStyle: 'bold',
      color: hex(COLORS.accent),
    })
    .setScrollFactor(0)
    .setDepth(DEPTH)
    .setOrigin(1, 0);
  parent?.add([title, manageHint]);

  for (let i = 0; i < ACTIVE_ABILITY_SLOT_LIMIT; i += 1) {
    const x = BAR_X + i * (SLOT_WIDTH + SLOT_GAP);
    const y = BAR_Y;
    const slot = scene.add
      .rectangle(
        x + SLOT_WIDTH / 2,
        y + SLOT_HEIGHT / 2,
        SLOT_WIDTH,
        SLOT_HEIGHT,
        COLORS.slotBg,
        0.92,
      )
      .setStrokeStyle(2, COLORS.slotBorder)
      .setScrollFactor(0)
      .setDepth(DEPTH);
    const accentBar = scene.add
      .rectangle(x + 2, y + 2, 3, SLOT_HEIGHT - 4, COLORS.utility, 0.15)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(DEPTH + 1);
    const keyLabel = scene.add
      .text(x + 7, y + 5, i === 9 ? '0' : String(i + 1), {
        fontFamily: 'monospace',
        fontSize: '10px',
        fontStyle: 'bold',
        color: '#53647f',
      })
      .setScrollFactor(0)
      .setDepth(DEPTH + 2)
      .setOrigin(0, 0);
    const abilityLabel = scene.add
      .text(x + SLOT_WIDTH / 2, y + 29, '—', {
        fontFamily: 'monospace',
        fontSize: '18px',
        fontStyle: 'bold',
        color: '#52637e',
      })
      .setScrollFactor(0)
      .setDepth(DEPTH + 2)
      .setOrigin(0.5);
    const abilityIcon = scene.add
      .image(x + SLOT_WIDTH / 2, y + 28, '__WHITE')
      .setScrollFactor(0)
      .setDepth(DEPTH + 2)
      .setVisible(false);
    const cooldownLabel = scene.add
      .text(x + SLOT_WIDTH - 6, y + SLOT_HEIGHT - 8, '', {
        fontFamily: 'monospace',
        fontSize: '9px',
        fontStyle: 'bold',
        color: '#fff0b3',
      })
      .setScrollFactor(0)
      .setDepth(DEPTH + 3)
      .setOrigin(1, 1)
      .setVisible(false);
    const cooldownBar = scene.add
      .rectangle(x + 2, y + SLOT_HEIGHT - 2, SLOT_WIDTH - 4, 4, COLORS.cooldownRing, 0.9)
      .setScrollFactor(0)
      .setDepth(DEPTH + 3)
      .setOrigin(0, 1)
      .setVisible(false);

    slots.push(slot);
    accentBars.push(accentBar);
    keyLabels.push(keyLabel);
    abilityLabels.push(abilityLabel);
    abilityIcons.push(abilityIcon);
    cooldownLabels.push(cooldownLabel);
    cooldownBars.push(cooldownBar);
  }

  parent?.add([
    ...slots,
    ...accentBars,
    ...keyLabels,
    ...abilityLabels,
    ...abilityIcons,
    ...cooldownLabels,
    ...cooldownBars,
  ]);
  const detachCrispText = applyCrispText(scene, [
    title,
    manageHint,
    ...keyLabels,
    ...abilityLabels,
    ...cooldownLabels,
  ]);

  const setVisible = (visible: boolean): void => {
    panel.setVisible(visible);
    title.setVisible(visible);
    manageHint.setVisible(visible);
    for (const node of slots) node.setVisible(visible);
    for (const node of accentBars) node.setVisible(visible);
    for (const node of keyLabels) node.setVisible(visible);
    for (const node of abilityLabels) node.setVisible(visible);
    for (const node of abilityIcons) node.setVisible(false);
    for (const node of cooldownLabels) node.setVisible(false);
    for (const node of cooldownBars) node.setVisible(false);
  };
  setVisible(false);

  function sync(world: GameWorld, playerEid: number): void {
    const visible = world.featureUnlocks.spells === true;
    setVisible(visible);
    if (!visible) return;

    const state = world.abilityStatesByEntity.get(playerEid);
    const equipped = state?.equippedActiveAbilityIds ?? [];
    const cooldowns = state?.cooldownByAbilityId ?? new Map();
    const cooldownFrames = state?.cooldownFramesByAbilityId ?? new Map();

    for (let i = 0; i < ACTIVE_ABILITY_SLOT_LIMIT; i += 1) {
      const id = equipped[i] ?? null;
      const slot = slots[i]!;
      const accentBar = accentBars[i]!;
      const keyLabel = keyLabels[i]!;
      const abilityLabel = abilityLabels[i]!;
      const abilityIcon = abilityIcons[i]!;
      const cooldownLabel = cooldownLabels[i]!;
      const cooldownBar = cooldownBars[i]!;

      if (!id) {
        slot.setFillStyle(COLORS.slotBg, 0.92).setStrokeStyle(2, COLORS.slotBorder);
        accentBar.setFillStyle(COLORS.utility, 0.15);
        keyLabel.setColor('#53647f');
        abilityLabel.setText('—').setFontSize(18).setColor('#52637e');
        abilityLabel.setVisible(true);
        abilityIcon.setVisible(false);
        cooldownBar.setVisible(false);
        cooldownLabel.setVisible(false);
        continue;
      }

      const presentation = getAbilityPresentation(id);
      const iconEntry = getAbilityIconEntry(scene, id);
      const lastTriggerFrame = cooldowns.get(id);
      const cooldownDuration = cooldownFrames.get(id) ?? 0;
      const flashing = isAbilitySlotCastFlashing(world.frameCount, lastTriggerFrame);
      if (flashing) {
        slot.setFillStyle(COLORS.slotCastFlash, 0.98).setStrokeStyle(3, COLORS.slotCastFlashBorder);
        abilityLabel.setColor('#0c4a6e');
        keyLabel.setColor('#0c4a6e');
      } else {
        slot.setFillStyle(COLORS.slotActive, 0.96).setStrokeStyle(2, COLORS.slotActiveBorder);
        abilityLabel.setColor('#f4f7fb');
        keyLabel.setColor('#b8c7dc');
      }
      accentBar.setFillStyle(abilityAccent(id), 1);
      abilityLabel.setText(presentation?.shortLabel ?? id.slice(0, 5).toUpperCase());
      abilityLabel.setFontSize(11);
      abilityLabel.setVisible(iconEntry === null);
      if (iconEntry) {
        abilityIcon.setTexture(iconEntry.textureKey);
        abilityIcon
          .setScale(fitScaleForBox(abilityIcon.width, abilityIcon.height, 30))
          .setVisible(true);
      } else {
        abilityIcon.setVisible(false);
      }

      if (lastTriggerFrame !== undefined && cooldownDuration > 0) {
        const elapsedFrames = Math.max(0, world.frameCount - lastTriggerFrame);
        const remainingRatio = Math.max(0, 1 - elapsedFrames / cooldownDuration);
        if (remainingRatio > 0) {
          cooldownBar.setVisible(true).setSize((SLOT_WIDTH - 4) * remainingRatio, 4);
          cooldownLabel
            .setText(`${Math.max(1, Math.ceil((cooldownDuration - elapsedFrames) / 60))}s`)
            .setVisible(true);
        } else {
          cooldownBar.setVisible(false);
          cooldownLabel.setVisible(false);
        }
      } else {
        cooldownBar.setVisible(false);
        cooldownLabel.setVisible(false);
      }
    }
  }

  function destroy(): void {
    detachCrispText();
    panel.destroy();
    title.destroy();
    manageHint.destroy();
    for (const node of slots) node.destroy();
    for (const node of accentBars) node.destroy();
    for (const node of keyLabels) node.destroy();
    for (const node of abilityLabels) node.destroy();
    for (const node of abilityIcons) node.destroy();
    for (const node of cooldownLabels) node.destroy();
    for (const node of cooldownBars) node.destroy();
  }

  return {
    sync,
    getPanelScreenBounds: () => ({
      x: BAR_X - PANEL_PADDING,
      y: PANEL_TOP,
      width: BAR_WIDTH + PANEL_PADDING * 2,
      height: PANEL_HEIGHT,
    }),
    getSlotScreenBounds: (index: number) =>
      index >= 0 && index < ACTIVE_ABILITY_SLOT_LIMIT
        ? {
            x: BAR_X + index * (SLOT_WIDTH + SLOT_GAP),
            y: BAR_Y,
            width: SLOT_WIDTH,
            height: SLOT_HEIGHT,
          }
        : null,
    destroy,
  };
}
