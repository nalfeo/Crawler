/**
 * EquipmentUI — Phaser-based paper-doll equipment panel.
 *
 * Features:
 * - 16-slot paper doll laid out from SLOT_REGISTRY uiPositions
 * - Each slot shows the equipped item (rarity-coloured) or its slot label
 * - Click an occupied slot to unequip (item returns to the bag)
 * - "Available gear" row lists equippable items held in the bag; click to equip
 * - Live effective-stats readout with buffed stats highlighted
 * - Toggle handled by caller (scene keybind / on-screen Gear button)
 *
 * Layer note: imports only from core + shared (never game/labs), so the panel
 * drives equip/unequip directly through the equipment system.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { fitUiScale } from './ui-scale.js';
import {
  equip,
  unequip,
  getEffectiveStats,
  getEquipmentState,
} from '../core/systems/equipmentSystem.js';
import { SLOT_REGISTRY } from '../shared/equipment-slots.js';
import { getEquipmentDefForItem, isEquippableItem } from '../shared/equipmentDefs.js';
import type { EquipmentItemDef, ItemRarity } from '../shared/equipment-types.js';
import { PRIMARY_STATS, SECONDARY_STATS, type StatId } from '../shared/stats.js';
import { addItem, removeItem } from '../shared/inventory.js';
import type { InventoryBag } from '../shared/inventory.js';
import { getItemById } from '../shared/items.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PANEL_PADDING = 16;
const FONT_FAMILY = 'Segoe UI, Arial, sans-serif';
const SLOT_W = 78;
const SLOT_H = 38;

const COLORS = {
  panelBg: 0x0d0d1a,
  panelBorder: 0x2a2a4a,
  dollBg: 0x111126,
  slotBg: 0x15152a,
  slotHover: 0x22224a,
  slotEmptyBorder: 0x333355,
  textPrimary: 0xf8fafc,
  textSecondary: 0x9ca3af,
  statBuff: 0x22c55e,
  chipBg: 0x1a1a30,
  chipHover: 0x3a3a6a,
} as const;

const RARITY_HEX: Record<ItemRarity, number> = {
  common: 0x9ca3af,
  uncommon: 0x22c55e,
  rare: 0x3b82f6,
  epic: 0xa855f7,
  legendary: 0xf59e0b,
};

function hex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

function formatStatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// ---------------------------------------------------------------------------
// EquipmentUI
// ---------------------------------------------------------------------------

export interface EquipmentUIConfig {
  width?: number;
  height?: number;
}

export function createEquipmentUI(
  scene: Phaser.Scene,
  config: EquipmentUIConfig = {},
): {
  toggle(world: GameWorld): void;
  refresh(world: GameWorld): void;
  isOpen(): boolean;
  destroy(): void;
} {
  scene.cameras.main.roundPixels = true;

  const snap = (value: number): number => Math.round(value);
  const baseResolution = Math.max(1, Math.round(window.devicePixelRatio || 1));
  let textResolution = baseResolution;
  const crispText = (
    x: number,
    y: number,
    text: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text =>
    scene.add.text(snap(x), snap(y), text, style).setResolution(textResolution);

  const panelWidth = config.width ?? 660;
  const panelHeight = config.height ?? 520;

  let uiScale = fitUiScale(scene, panelWidth, panelHeight);
  textResolution = Math.max(1, Math.round(baseResolution * uiScale));
  const viewWidth = (): number => scene.scale.width / uiScale;
  const viewHeight = (): number => scene.scale.height / uiScale;

  let visible = false;
  let currentBag: InventoryBag | null = null;
  let playerEid = -1;
  let lastSignature: string | null = null;
  let lastWorld: GameWorld | null = null;

  const container = scene.add.container(0, 0);
  container.setDepth(1000);
  container.setVisible(false);

  let panelX = snap((viewWidth() - panelWidth) / 2);
  let panelY = snap((viewHeight() - panelHeight) / 2);

  const bg = scene.add.rectangle(
    panelX + panelWidth / 2,
    panelY + panelHeight / 2,
    panelWidth,
    panelHeight,
    COLORS.panelBg,
    0.96,
  );
  bg.setStrokeStyle(2, COLORS.panelBorder);
  container.add(bg);

  const title = crispText(panelX + PANEL_PADDING, panelY + PANEL_PADDING, 'EQUIPMENT', {
    fontFamily: FONT_FAMILY,
    fontSize: '20px',
    color: hex(COLORS.textPrimary),
  });
  container.add(title);

  const hint = crispText(
    panelX + panelWidth - PANEL_PADDING,
    panelY + PANEL_PADDING + 2,
    'Click gear below to equip · click a slot to remove',
    { fontFamily: FONT_FAMILY, fontSize: '12px', color: hex(COLORS.textSecondary) },
  );
  hint.setOrigin(1, 0);
  container.add(hint);

  // Paper-doll background panel (left ~58% of the panel).
  const dollX = panelX + PANEL_PADDING;
  const dollY = panelY + PANEL_PADDING + 34;
  const dollW = Math.round(panelWidth * 0.56);
  const dollH = panelHeight - (PANEL_PADDING + 34) - PANEL_PADDING - 96;
  const dollBg = scene.add.rectangle(dollX + dollW / 2, dollY + dollH / 2, dollW, dollH, COLORS.dollBg, 0.6);
  dollBg.setStrokeStyle(1, COLORS.panelBorder);
  container.add(dollBg);

  // Stats column (right side).
  const statsX = dollX + dollW + PANEL_PADDING;

  // Object pools.
  const slotObjects: Phaser.GameObjects.GameObject[] = [];
  const statObjects: Phaser.GameObjects.GameObject[] = [];
  const gearObjects: Phaser.GameObjects.GameObject[] = [];

  function clearPool(pool: Phaser.GameObjects.GameObject[]): void {
    for (const obj of pool) {
      obj.destroy();
    }
    pool.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Equip / unequip actions
  // ---------------------------------------------------------------------------

  function equipFromBag(itemId: string): void {
    if (!currentBag || playerEid < 0 || !lastWorld) return;
    const def: EquipmentItemDef | undefined = getEquipmentDefForItem(itemId);
    if (!def) return;
    const result = equip(lastWorld, playerEid, def);
    if (result.ok) {
      removeItem(currentBag, itemId, 1);
      invalidate();
    }
  }

  function unequipSlot(slotId: string): void {
    if (!currentBag || playerEid < 0 || !lastWorld) return;
    const result = unequip(lastWorld, playerEid, slotId);
    if (result.ok) {
      addItem(currentBag, result.item.def.id, 1);
      invalidate();
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function renderSlots(): void {
    clearPool(slotObjects);
    if (!lastWorld || playerEid < 0) return;
    const state = getEquipmentState(lastWorld, playerEid);

    const innerPadX = 8;
    const innerPadY = 6;
    const usableW = dollW - SLOT_W - innerPadX * 2;
    const usableH = dollH - SLOT_H - innerPadY * 2;

    for (const slot of SLOT_REGISTRY) {
      const cx = dollX + innerPadX + SLOT_W / 2 + slot.uiPosition.x * usableW;
      const cy = dollY + innerPadY + SLOT_H / 2 + slot.uiPosition.y * usableH;

      const instId = state?.equipped[slot.id] ?? null;
      const instance = instId !== null ? (state?.instances.get(instId) ?? null) : null;
      const rarityColor = instance ? RARITY_HEX[instance.def.rarity] : COLORS.slotEmptyBorder;

      const box = scene.add.rectangle(snap(cx), snap(cy), SLOT_W, SLOT_H, COLORS.slotBg, 0.95);
      box.setStrokeStyle(2, rarityColor);
      box.setInteractive({ useHandCursor: Boolean(instance) });

      const label = crispText(snap(cx), snap(cy - SLOT_H / 2 + 8), slot.label.toUpperCase(), {
        fontFamily: FONT_FAMILY,
        fontSize: '9px',
        color: hex(0x7ee0ff),
      });
      label.setOrigin(0.5, 0.5);

      const valueText = instance ? instance.def.name : '—';
      const value = crispText(snap(cx), snap(cy + 5), valueText, {
        fontFamily: FONT_FAMILY,
        fontSize: '11px',
        color: instance ? hex(rarityColor) : hex(0x555577),
        align: 'center',
        wordWrap: { width: SLOT_W - 8 },
      });
      value.setOrigin(0.5, 0.5);

      if (instance) {
        box.on('pointerover', () => box.setFillStyle(COLORS.slotHover));
        box.on('pointerout', () => box.setFillStyle(COLORS.slotBg));
        box.on('pointerdown', () => unequipSlot(slot.id));
      }

      container.add(box);
      container.add(label);
      container.add(value);
      slotObjects.push(box, label, value);
    }
  }

  function renderStats(): void {
    clearPool(statObjects);
    if (!lastWorld || playerEid < 0) return;

    const effective = getEffectiveStats(lastWorld, playerEid);
    const baseStore = lastWorld.stores.baseStats;

    const heading = crispText(statsX, dollY, 'STATS', {
      fontFamily: FONT_FAMILY,
      fontSize: '14px',
      color: hex(0x7ee0ff),
    });
    container.add(heading);
    statObjects.push(heading);

    let rowY = dollY + 22;
    const colW = panelWidth - (statsX - panelX) - PANEL_PADDING;

    const drawStat = (statId: StatId): void => {
      const value = effective[statId] ?? 0;
      const base = baseStore[statId]?.[playerEid] ?? 0;
      const buffed = value > base;
      const name = crispText(statsX, rowY, statId, {
        fontFamily: FONT_FAMILY,
        fontSize: '12px',
        color: hex(COLORS.textSecondary),
      });
      name.setOrigin(0, 0);
      const val = crispText(statsX + colW, rowY, formatStatValue(value), {
        fontFamily: FONT_FAMILY,
        fontSize: '12px',
        color: buffed ? hex(COLORS.statBuff) : hex(COLORS.textPrimary),
        fontStyle: buffed ? 'bold' : 'normal',
      });
      val.setOrigin(1, 0);
      container.add(name);
      container.add(val);
      statObjects.push(name, val);
      rowY += 17;
    };

    for (const statId of PRIMARY_STATS) {
      drawStat(statId);
    }
    rowY += 6;
    for (const statId of SECONDARY_STATS) {
      drawStat(statId);
    }
  }

  function renderGear(): void {
    clearPool(gearObjects);
    if (!currentBag) return;

    const gearY = dollY + dollH + 12;
    const heading = crispText(dollX, gearY, 'AVAILABLE GEAR', {
      fontFamily: FONT_FAMILY,
      fontSize: '13px',
      color: hex(0x7ee0ff),
    });
    container.add(heading);
    gearObjects.push(heading);

    const equippable = currentBag.slots.filter((slot) => isEquippableItem(slot.itemId));

    if (equippable.length === 0) {
      const none = crispText(dollX, gearY + 22, 'No equippable gear in your bag.', {
        fontFamily: FONT_FAMILY,
        fontSize: '12px',
        color: hex(0x555577),
      });
      container.add(none);
      gearObjects.push(none);
      return;
    }

    let chipX = dollX;
    const chipY = gearY + 22;
    const chipH = 30;
    const maxX = panelX + panelWidth - PANEL_PADDING;

    for (const slot of equippable) {
      const def = getItemById(slot.itemId);
      const equipDef = getEquipmentDefForItem(slot.itemId);
      if (!def || !equipDef) continue;

      const labelText = slot.quantity > 1 ? `${def.name} ×${slot.quantity}` : def.name;
      const chipW = Math.min(220, labelText.length * 7 + 24);
      if (chipX + chipW > maxX) {
        chipX = dollX; // simple single-extra-row wrap is unlikely; reset just in case
      }

      const rarityColor = RARITY_HEX[equipDef.rarity];
      const chip = scene.add.rectangle(
        snap(chipX + chipW / 2),
        snap(chipY + chipH / 2),
        chipW,
        chipH,
        COLORS.chipBg,
        0.95,
      );
      chip.setStrokeStyle(1, rarityColor);
      chip.setInteractive({ useHandCursor: true });
      chip.on('pointerover', () => chip.setFillStyle(COLORS.chipHover));
      chip.on('pointerout', () => chip.setFillStyle(COLORS.chipBg));
      chip.on('pointerdown', () => equipFromBag(slot.itemId));

      const chipLabel = crispText(snap(chipX + chipW / 2), snap(chipY + chipH / 2), labelText, {
        fontFamily: FONT_FAMILY,
        fontSize: '12px',
        color: hex(rarityColor),
      });
      chipLabel.setOrigin(0.5, 0.5);

      container.add(chip);
      container.add(chipLabel);
      gearObjects.push(chip, chipLabel);

      chipX += chipW + 8;
    }
  }

  function render(): void {
    renderSlots();
    renderStats();
    renderGear();
  }

  function computeSignature(): string {
    if (!lastWorld || playerEid < 0) return 'none';
    const state = getEquipmentState(lastWorld, playerEid);
    let signature = '';
    if (state) {
      for (const slot of SLOT_REGISTRY) {
        const instId = state.equipped[slot.id] ?? null;
        const inst = instId !== null ? state.instances.get(instId) : null;
        signature += `${slot.id}:${inst ? inst.def.id : '-'}|`;
      }
    }
    const bagSlots = currentBag?.slots ?? [];
    for (const slot of bagSlots) {
      if (isEquippableItem(slot.itemId)) {
        signature += `${slot.itemId}x${slot.quantity};`;
      }
    }
    return signature;
  }

  function invalidate(): void {
    lastSignature = null;
    if (visible) {
      render();
      lastSignature = computeSignature();
    }
  }

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

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
    // dollBg/statsX are derived from panelX/panelY captured at construction; for
    // simplicity we re-render against the originals, which stay valid because the
    // panel size is fixed. Re-render to reposition pooled objects.
    if (visible) {
      lastSignature = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function findPlayerEid(world: GameWorld): number {
    for (const [eid] of world.inventories) {
      return eid;
    }
    return -1;
  }

  function refresh(world: GameWorld): void {
    lastWorld = world;
    playerEid = findPlayerEid(world);
    currentBag = playerEid >= 0 ? (world.inventories.get(playerEid) ?? null) : null;
    if (!visible) {
      return;
    }
    const signature = computeSignature();
    if (signature !== lastSignature) {
      render();
      lastSignature = signature;
    }
  }

  function toggle(world: GameWorld): void {
    visible = !visible;
    container.setVisible(visible);
    if (visible) {
      applyLayout();
      lastSignature = null;
      refresh(world);
    }
  }

  scene.scale.on('resize', applyLayout);

  return {
    toggle,
    refresh,
    isOpen: () => visible,
    destroy() {
      scene.scale.off('resize', applyLayout);
      clearPool(slotObjects);
      clearPool(statObjects);
      clearPool(gearObjects);
      container.destroy();
    },
  };
}
