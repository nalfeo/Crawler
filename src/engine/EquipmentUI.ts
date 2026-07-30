/**
 * EquipmentUI — Phaser-based paper-doll equipment panel.
 *
 * Features:
 * - 16-slot paper doll laid out from SLOT_REGISTRY uiPositions
 * - Each slot shows the equipped item (rarity-coloured) or an empty-slot icon
 * - Click an occupied slot to unequip (item returns to the bag)
 * - Live effective-stats readout with buffed stats highlighted
 * - Toggle handled by caller (scene keybind / on-screen Gear button)
 *
 * Layer note: imports only from core + shared (never game/labs), so the panel
 * drives equip/unequip directly through the equipment system.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { fitScaleForBox, fitUiScale, getTextResolution, type ScreenBounds } from './ui-scale.js';
import { getRenderScale } from './render-scale.js';
import { GAME } from '../shared/constants.js';
import {
  unequip,
  equipFromBag,
  getEffectiveStats,
  getEquipmentState,
  previewEquipDelta,
  resolveEquipmentInstance,
  type EquipDeltaPreview,
} from '../core/systems/equipmentSystem.js';
import { getGeneratedEquipmentInstance } from '../core/generated-equipment-registry.js';
import { SLOT_REGISTRY, type EquipmentSlotId } from '../shared/equipment-slots.js';
import { PRIMARY_STATS, SECONDARY_STATS, ALL_STAT_IDS, type StatId } from '../shared/stats.js';
import { getEntityEncumbranceSnapshot } from '../core/encumbrance.js';
import {
  addItem,
  filterByEquipmentSlot,
  filterEquippable,
  inventoryEntryIdentity,
} from '../shared/inventory.js';
import type {
  GeneratedInventoryEntryResolver,
  InventoryBag,
  InventoryBagEntry,
} from '../shared/inventory.js';
import { getItemById, ItemRarity, RARITY_COLORS, type ItemDef } from '../shared/items.js';
import type { EquipmentItemDef } from '../shared/equipment-types.js';
import {
  emptyGeneratedSpriteRegistry,
  type GeneratedSpriteEntry,
  type GeneratedSpriteRegistry,
} from '../shared/generated-assets.js';
import { resolveItemSprite } from '../shared/item-sprites.js';
import { hashStringToSeed } from '../shared/random.js';
import { GENERATED_SPRITE_REGISTRY_KEY } from './generatedAssets/index.js';
import { BLUE_STEEL, hex, MIN_TEXT_RESOLUTION } from './ui-theme.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PANEL_PADDING = 22;
const FONT_FAMILY = '"Press Start 2P", "Courier New", monospace';
const SLOT_W = 64;
const SLOT_H = 64;
const SLOT_SPREAD_X = 1;
const SLOT_SPREAD_Y = 1;

// Fixed sub-region widths. The paper-doll and stats column keep their proven
// (heavily-iterated) geometry regardless of the wider panel; the leftover space
// on the right becomes the integrated equippable-bag column. Decoupling these
// from panelWidth is what lets us add the bag without disturbing slot layout.
const DOLL_W = 570;
const STATS_W = 250;
// Bag grid cells (mirrors InventoryUI's cell metrics for visual consistency).
const BAG_CELL = 60;
const BAG_GAP = 12;
const BAG_COLS = 4;

const COLORS = {
  ...BLUE_STEEL,
  dollBg: 0x394c74,
  panelInset: 0x2b3c61,
  slotBg: 0x445c89,
  slotHover: 0x5472ab,
  slotSelected: 0x4a6699,
  slotSelectedBorder: 0xf2c14e,
  slotEmptyBorder: 0x90a7ca,
  statBuff: 0x49d06f,
  statNerf: 0xe8695b,
} as const;

function generatedRarityColor(rarity: string): number {
  switch (rarity) {
    case 'common':
      return RARITY_COLORS[ItemRarity.Common];
    case 'uncommon':
      return RARITY_COLORS[ItemRarity.Uncommon];
    case 'rare':
      return RARITY_COLORS[ItemRarity.Rare];
    case 'epic':
      return RARITY_COLORS[ItemRarity.Epic];
    default:
      return RARITY_COLORS[ItemRarity.Legendary];
  }
}

function formatStatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatStatLabel(statId: StatId): string {
  return statId
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function formatWeightLb(value: number): string {
  return `${formatStatValue(value)} lb`;
}

function formatEncumbranceBandLabel(band: string): string {
  return band.toUpperCase();
}

// ---------------------------------------------------------------------------
// EquipmentUI
// ---------------------------------------------------------------------------

export interface EquipmentUIConfig {
  width?: number;
  height?: number;
  onSlotFilterChange?: (slotId: EquipmentSlotId | null) => void;
  /**
   * Notification fired after the panel mutates the bag/equipment (equip from the
   * integrated bag, or unequip a slot), so the scene can refresh a separately
   * open full-inventory panel. The panel refreshes itself regardless.
   */
  onInventoryChanged?: () => void;
}

export function createEquipmentUI(
  scene: Phaser.Scene,
  config: EquipmentUIConfig = {},
): {
  toggle(world: GameWorld): void;
  refresh(world: GameWorld): void;
  isOpen(): boolean;
  getSelectedSlotFilter(): EquipmentSlotId | null;
  selectSlot(slotId: EquipmentSlotId | null): void;
  getPanelScreenBounds(): ScreenBounds;
  getSlotScreenBounds(slotId: EquipmentSlotId): ScreenBounds | null;
  getSlotIconScreenBounds(slotId: EquipmentSlotId): ScreenBounds | null;
  getTooltipScreenBounds(): ScreenBounds | null;
  isTooltipVisible(): boolean;
  isTooltipTopmost(): boolean;
  getBagItemIds(): string[];
  /** Render-order cell for one exact generated inventory instance. */
  getGeneratedBagCellScreenBounds(instanceKey: string): ScreenBounds | null;
  getBagCellScreenBounds(index: number): ScreenBounds | null;
  getBagColumnScreenBounds(): ScreenBounds;
  scrollBag(rows: number): boolean;
  getBagScrollRow(): number;
  getBagMaxScrollRow(): number;
  previewBagItem(itemId: string | null): void;
  equipBagItem(itemId: string): boolean;
  destroy(): void;
} {
  scene.cameras.main.roundPixels = true;

  const snap = (value: number): number => Math.round(value);
  let textResolution = Math.max(MIN_TEXT_RESOLUTION, getTextResolution(scene));
  const crispText = (
    x: number,
    y: number,
    text: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text =>
    scene.add.text(snap(x), snap(y), text, style).setResolution(textResolution);

  const panelWidth = config.width ?? 1240;
  const panelHeight = config.height ?? 680;

  let uiScale = fitUiScale(scene, panelWidth, panelHeight);
  textResolution = Math.max(MIN_TEXT_RESOLUTION, getTextResolution(scene));
  const viewWidth = (): number => GAME.WIDTH / uiScale;
  const viewHeight = (): number => GAME.HEIGHT / uiScale;

  let visible = false;
  let currentBag: InventoryBag | null = null;
  let playerEid = -1;
  let currentWorldSeed = 0;
  let selectedSlotFilter: EquipmentSlotId | null = null;
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
    1,
  );
  bg.setStrokeStyle(2, COLORS.panelBorder);
  container.add(bg);
  const cornerPixelPoints = [
    [panelX + 6, panelY + 6],
    [panelX + panelWidth - 6, panelY + 6],
    [panelX + 6, panelY + panelHeight - 6],
    [panelX + panelWidth - 6, panelY + panelHeight - 6],
  ] as const;
  const cornerPixels: Phaser.GameObjects.Rectangle[] = [];
  for (const [x, y] of cornerPixelPoints) {
    const pixel = scene.add.rectangle(x, y, 6, 6, COLORS.panelBorder, 1);
    container.add(pixel);
    cornerPixels.push(pixel);
  }

  const title = crispText(panelX + PANEL_PADDING, panelY + PANEL_PADDING + 2, 'EQUIPMENT', {
    fontFamily: FONT_FAMILY,
    fontSize: '16px',
    color: hex(COLORS.textPrimary),
    padding: { top: 4, bottom: 2 },
  });
  container.add(title);
  const titleFrame = scene.add.rectangle(
    panelX + PANEL_PADDING + 146,
    panelY + PANEL_PADDING + 10,
    296,
    28,
    0x355180,
    0.95,
  );
  titleFrame.setStrokeStyle(1, COLORS.panelBorder);
  container.addAt(titleFrame, 1);

  const hint = crispText(
    panelX + PANEL_PADDING,
    panelY + PANEL_PADDING + 28,
    'CLICK SLOT TO FILTER OR UNEQUIP',
    {
      fontFamily: FONT_FAMILY,
      fontSize: '8px',
      color: hex(COLORS.textSecondary),
      padding: { top: 3 },
    },
  );
  hint.setOrigin(0, 0);
  container.add(hint);

  // Paper-doll background panel — fixed width (proven geometry), left of stats.
  const dollX = panelX + PANEL_PADDING;
  const dollY = panelY + PANEL_PADDING + 58;
  const dollW = DOLL_W;
  const dollH = panelHeight - (PANEL_PADDING + 34) - PANEL_PADDING - 82;
  const dollBg = scene.add.rectangle(
    dollX + dollW / 2,
    dollY + dollH / 2,
    dollW,
    dollH,
    COLORS.dollBg,
    0.92,
  );
  dollBg.setStrokeStyle(1, COLORS.panelBorder);
  container.add(dollBg);
  const dollInset = scene.add.rectangle(
    dollX + dollW / 2,
    dollY + dollH / 2,
    dollW - 16,
    dollH - 16,
    COLORS.panelInset,
    0.92,
  );
  dollInset.setStrokeStyle(1, 0x4f6998, 0.9);
  container.add(dollInset);
  const dollPattern = scene.add.graphics();
  dollPattern.lineStyle(1, 0x2f4369, 0.45);
  for (let y = Math.floor(dollY + 34); y < dollY + dollH - 20; y += 18) {
    const offset = Math.floor((y / 18) % 2) * 12;
    for (let x = Math.floor(dollX + 18 - offset); x < dollX + dollW - 18; x += 24) {
      dollPattern.strokeRect(x, y, 24, 12);
      if (x + 20 < dollX + dollW - 18) {
        dollPattern.strokeRect(x + 6, y + 4, 12, 4);
      }
    }
  }
  container.add(dollPattern);
  // Fixed inspector strip pinned to the bottom of the paper-doll. Hovering a
  // slot populates it (empty → affordance, occupied → item detail). Because it
  // lives in a reserved region below the grid, its content can never overlap a
  // slot — this replaces the old floating tooltip, which had no collision-free
  // placement once the 3-column grid was full.
  const INSPECTOR_H = 72;
  const INSPECTOR_GAP = 12;
  const inspectorX = dollX + 10;
  const inspectorW = dollW - 20;
  const inspectorY = dollY + dollH - INSPECTOR_H - 10;
  const inspectorBg = scene.add.rectangle(
    inspectorX + inspectorW / 2,
    inspectorY + INSPECTOR_H / 2,
    inspectorW,
    INSPECTOR_H,
    0x1f2c47,
    0.98,
  );
  inspectorBg.setStrokeStyle(2, COLORS.slotEmptyBorder);
  container.add(inspectorBg);
  const inspectorPlaceholder = crispText(
    inspectorX + 14,
    inspectorY + INSPECTOR_H / 2,
    'HOVER A SLOT FOR DETAILS',
    { fontFamily: FONT_FAMILY, fontSize: '8px', color: hex(COLORS.textSecondary) },
  );
  inspectorPlaceholder.setOrigin(0, 0.5);
  container.add(inspectorPlaceholder);
  // Stats column (middle) — fixed compact width so the bag column has room.
  const statsX = dollX + dollW + PANEL_PADDING;
  const statsCenterX = statsX + STATS_W / 2;
  const divider = scene.add.line(
    0,
    0,
    dollX + dollW + PANEL_PADDING / 2,
    dollY,
    dollX + dollW + PANEL_PADDING / 2,
    dollY + dollH,
    COLORS.panelBorder,
    0.8,
  );
  divider.setLineWidth(1, 1);
  container.add(divider);
  const statsBg = scene.add.rectangle(
    statsCenterX,
    dollY + dollH / 2,
    STATS_W,
    dollH,
    0x31466f,
    0.92,
  );
  statsBg.setStrokeStyle(1, COLORS.panelBorder);
  container.addAt(statsBg, 3);
  const statsInset = scene.add.rectangle(
    statsCenterX,
    dollY + dollH / 2,
    STATS_W - 12,
    dollH - 16,
    COLORS.panelInset,
    0.92,
  );
  statsInset.setStrokeStyle(1, 0x4f6998, 0.9);
  container.addAt(statsInset, 4);
  const statsPattern = scene.add.graphics();
  statsPattern.fillStyle(0x2f4369, 0.28);
  for (let y = Math.floor(dollY + 18); y < dollY + dollH - 8; y += 16) {
    for (let x = Math.floor(statsX + 10); x < statsX + STATS_W - 8; x += 16) {
      if (((x + y) / 16) % 2 === 0) {
        statsPattern.fillRect(x, y, 4, 4);
      }
    }
  }
  container.addAt(statsPattern, 4);

  // Bag column (right) — the integrated equippable-inventory grid. Fills the
  // space left of the panel's right edge; decoupled from the doll/stats so it
  // never disturbs their proven layout.
  const bagX = statsX + STATS_W + PANEL_PADDING;
  const bagW = panelX + panelWidth - PANEL_PADDING - bagX;
  const bagY = dollY;
  const bagH = dollH;
  const bagDivider = scene.add.line(
    0,
    0,
    bagX - PANEL_PADDING / 2,
    dollY,
    bagX - PANEL_PADDING / 2,
    dollY + dollH,
    COLORS.panelBorder,
    0.8,
  );
  bagDivider.setLineWidth(1, 1);
  container.add(bagDivider);
  const bagBg = scene.add.rectangle(bagX + bagW / 2, bagY + bagH / 2, bagW, bagH, 0x31466f, 0.92);
  bagBg.setStrokeStyle(1, COLORS.panelBorder);
  container.addAt(bagBg, 3);
  const bagInset = scene.add.rectangle(
    bagX + bagW / 2,
    bagY + bagH / 2,
    bagW - 12,
    bagH - 16,
    COLORS.panelInset,
    0.92,
  );
  bagInset.setStrokeStyle(1, 0x4f6998, 0.9);
  container.addAt(bagInset, 4);

  // Object pools.
  const slotObjects: Phaser.GameObjects.GameObject[] = [];
  const statObjects: Phaser.GameObjects.GameObject[] = [];
  const tooltipObjects: Phaser.GameObjects.GameObject[] = [];
  const slotBounds = new Map<EquipmentSlotId, ScreenBounds>();
  const slotIconBounds = new Map<EquipmentSlotId, ScreenBounds>();
  const bagObjects: Phaser.GameObjects.GameObject[] = [];
  let bagCellBounds: (ScreenBounds | null)[] = [];
  let bagItemIds: string[] = [];
  let bagScrollRow = 0;
  let bagMaxScroll = 0;
  let previewEntryIdentity: string | null = null;
  let tooltipBounds: ScreenBounds | null = null;
  const getPanelScreenBounds = (): ScreenBounds => ({
    x: panelX,
    y: panelY,
    width: panelWidth,
    height: panelHeight,
  });

  function clearPool(pool: Phaser.GameObjects.GameObject[]): void {
    for (const obj of pool) {
      obj.destroy();
    }
    pool.length = 0;
  }

  function clearTooltip(): void {
    clearPool(tooltipObjects);
    tooltipBounds = null;
    refreshInspectorIdleText();
    inspectorPlaceholder.setVisible(true);
  }

  // Idle inspector text (shown when nothing is hovered). Lives in the persistent
  // placeholder, NOT the tooltip pool, so isTooltipVisible stays false when idle
  // (deterministic e2e contract). When a slot filter is active it surfaces the
  // filter state so the context isn't lost the moment the pointer leaves a slot.
  function refreshInspectorIdleText(): void {
    if (selectedSlotFilter) {
      const slot = SLOT_REGISTRY.find((entry) => entry.id === selectedSlotFilter);
      const label = (slot?.label ?? 'slot').toUpperCase();
      inspectorPlaceholder.setText(truncateToWidth(`FILTERING: ${label}`, 8));
      inspectorPlaceholder.setColor(hex(COLORS.accent));
    } else {
      inspectorPlaceholder.setText('HOVER A SLOT FOR DETAILS');
      inspectorPlaceholder.setColor(hex(COLORS.textSecondary));
    }
  }

  function measureTooltipBounds(
    objects: readonly Phaser.GameObjects.GameObject[],
  ): ScreenBounds | null {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const obj of objects) {
      const candidate = obj as unknown as {
        getBounds?: () => { x: number; y: number; width: number; height: number };
      };
      if (typeof candidate.getBounds !== 'function') continue;
      const bounds = candidate.getBounds();
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue;
      minX = Math.min(minX, bounds.x);
      minY = Math.min(minY, bounds.y);
      maxX = Math.max(maxX, bounds.x + bounds.width);
      maxY = Math.max(maxY, bounds.y + bounds.height);
    }
    if (
      !Number.isFinite(minX) ||
      !Number.isFinite(minY) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(maxY)
    ) {
      return null;
    }
    return {
      x: snap(minX),
      y: snap(minY),
      width: snap(maxX - minX),
      height: snap(maxY - minY),
    };
  }

  function isTooltipTopmost(): boolean {
    if (tooltipObjects.length === 0) return false;
    const list = container.list;
    const tooltipSet = new Set(tooltipObjects);
    let minTooltipIndex = Number.POSITIVE_INFINITY;
    let maxOtherIndex = -1;
    for (let i = 0; i < list.length; i += 1) {
      const obj = list[i];
      if (!obj) continue;
      if (tooltipSet.has(obj)) {
        minTooltipIndex = Math.min(minTooltipIndex, i);
      } else {
        maxOtherIndex = i;
      }
    }
    return Number.isFinite(minTooltipIndex) && minTooltipIndex > maxOtherIndex;
  }

  function getGeneratedRegistry(): GeneratedSpriteRegistry {
    const registry = scene.game?.registry?.get(GENERATED_SPRITE_REGISTRY_KEY) as
      | GeneratedSpriteRegistry
      | undefined;
    return registry ?? emptyGeneratedSpriteRegistry();
  }

  function selectGeneratedEntry(itemId: string): GeneratedSpriteEntry | null {
    return resolveItemSprite(
      getGeneratedRegistry(),
      itemId,
      (hashStringToSeed(itemId) ^ currentWorldSeed) | 0,
    );
  }

  function createItemIcon(
    itemId: string,
    itemDef: Pick<ItemDef, 'name'>,
    x: number,
    y: number,
    boxSize: number,
  ): Phaser.GameObjects.GameObject {
    const generatedEntry = selectGeneratedEntry(itemId);
    const textureLoaded =
      generatedEntry !== null && scene.textures?.exists(generatedEntry.textureKey) === true;
    if (generatedEntry && textureLoaded) {
      const image = scene.add.image(snap(x), snap(y), generatedEntry.textureKey);
      image.setOrigin(0.5, 0.5);
      image.setScale(fitScaleForBox(image.width, image.height, boxSize));
      return image;
    }
    const fallback = crispText(snap(x), snap(y), itemDef.name.substring(0, 2).toUpperCase(), {
      fontFamily: FONT_FAMILY,
      fontSize: '12px',
      color: '#9ca3af',
    });
    fallback.setOrigin(0.5, 0.5);
    return fallback;
  }

  function createGeneratedItemIcon(
    artKey: string,
    displayName: string,
    x: number,
    y: number,
    boxSize: number,
  ): Phaser.GameObjects.GameObject {
    if (scene.textures?.exists(artKey) === true) {
      const image = scene.add.image(snap(x), snap(y), artKey);
      image.setOrigin(0.5, 0.5);
      image.setScale(fitScaleForBox(image.width, image.height, boxSize));
      return image;
    }
    return createItemIcon(artKey, { name: displayName }, x, y, boxSize);
  }

  function createSlotPlaceholder(
    slotId: EquipmentSlotId,
    x: number,
    y: number,
  ): Phaser.GameObjects.Graphics {
    const icon = scene.add.graphics();
    // Drawn at absolute slot-centre coords (Phaser Graphics.getBounds only
    // reports a correct AABB for absolute geometry, not scaled transforms), and
    // kept within ±22px of centre so the AABB stays inside the 64px slot box
    // (the icon-containment probe enforces this). Each glyph is a recognizable
    // "ghost" equipment silhouette — light body + dark detail cuts — so an
    // empty slot reads as "put a <part> here", Diablo/Brotato style.
    const light = COLORS.slotEmptyBorder;
    const dark = 0x223350;
    const sx = snap(x);
    const sy = snap(y);
    const useLight = (): void => {
      icon.fillStyle(light, 0.9);
    };
    const useDark = (): void => {
      icon.fillStyle(dark, 1);
    };
    icon.lineStyle(2, light, 0.9);
    useLight();
    switch (slotId) {
      case 'head': // helm
        icon.fillRect(sx - 15, sy - 15, 30, 20);
        icon.fillRect(sx - 13, sy + 5, 26, 7);
        useDark();
        icon.fillRect(sx - 12, sy - 3, 24, 5);
        break;
      case 'face': // mask
        icon.fillRect(sx - 15, sy - 11, 30, 22);
        useDark();
        icon.fillRect(sx - 9, sy - 4, 6, 6);
        icon.fillRect(sx + 3, sy - 4, 6, 6);
        icon.fillRect(sx - 6, sy + 5, 12, 3);
        break;
      case 'neck': // amulet
        icon.lineStyle(3, light, 0.9);
        icon.beginPath();
        icon.moveTo(sx - 14, sy - 14);
        icon.lineTo(sx, sy + 2);
        icon.lineTo(sx + 14, sy - 14);
        icon.strokePath();
        useLight();
        icon.fillCircle(sx, sy + 8, 8);
        useDark();
        icon.fillCircle(sx, sy + 8, 3);
        break;
      case 'shoulders': // pauldrons
        icon.fillRect(sx - 18, sy - 4, 12, 12);
        icon.fillRect(sx + 6, sy - 4, 12, 12);
        icon.fillRect(sx - 16, sy - 8, 8, 5);
        icon.fillRect(sx + 8, sy - 8, 8, 5);
        break;
      case 'back': // cloak
        icon.fillRect(sx - 7, sy - 15, 14, 6);
        icon.fillTriangle(sx - 8, sy - 10, sx + 8, sy - 10, sx + 12, sy + 14);
        icon.fillTriangle(sx - 8, sy - 10, sx + 12, sy + 14, sx - 12, sy + 14);
        break;
      case 'chest': // breastplate
        icon.fillTriangle(sx - 13, sy - 12, sx + 13, sy - 12, sx + 13, sy + 4);
        icon.fillTriangle(sx - 13, sy - 12, sx + 13, sy + 4, sx, sy + 14);
        icon.fillTriangle(sx - 13, sy - 12, sx, sy + 14, sx - 13, sy + 4);
        useDark();
        icon.fillRect(sx - 1, sy - 10, 2, 20);
        break;
      case 'leftArm':
      case 'rightArm': // vambrace
        icon.fillTriangle(sx - 8, sy - 14, sx + 8, sy - 14, sx + 6, sy + 13);
        icon.fillTriangle(sx - 8, sy - 14, sx + 6, sy + 13, sx - 6, sy + 13);
        useDark();
        icon.fillRect(sx - 7, sy - 2, 14, 3);
        break;
      case 'leftWrist':
      case 'rightWrist': // bracelet
        icon.lineStyle(4, light, 0.9);
        icon.strokeCircle(sx, sy, 12);
        break;
      case 'mainHand':
      case 'offHand': // sword
        icon.fillRect(sx - 3, sy - 16, 6, 24);
        icon.fillRect(sx - 11, sy + 6, 22, 4);
        icon.fillRect(sx - 2, sy + 10, 4, 6);
        useDark();
        icon.fillRect(sx - 1, sy - 14, 2, 18);
        break;
      case 'belt':
        icon.fillRect(sx - 17, sy - 5, 34, 10);
        useDark();
        icon.fillRect(sx - 5, sy - 5, 10, 10);
        break;
      case 'gloves': // gauntlet
        icon.fillRect(sx - 10, sy - 5, 20, 15);
        icon.fillRect(sx - 9, sy - 13, 14, 9);
        icon.fillRect(sx + 6, sy - 8, 5, 9);
        break;
      case 'ringLeft':
      case 'ringRight': // ring + gem
        icon.lineStyle(4, light, 0.9);
        icon.strokeCircle(sx, sy + 4, 11);
        useLight();
        icon.fillTriangle(sx, sy - 16, sx + 7, sy - 9, sx, sy - 2);
        icon.fillTriangle(sx, sy - 16, sx, sy - 2, sx - 7, sy - 9);
        break;
      case 'legs': // greaves
        icon.fillRect(sx - 11, sy - 14, 22, 7);
        icon.fillRect(sx - 11, sy - 7, 9, 21);
        icon.fillRect(sx + 2, sy - 7, 9, 21);
        break;
      case 'feet': // boot
        icon.fillRect(sx - 6, sy - 14, 11, 20);
        icon.fillRect(sx - 14, sy + 4, 22, 8);
        break;
      default:
        icon.strokeCircle(sx, sy, 12);
        icon.fillCircle(sx, sy, 4);
        break;
    }
    return icon;
  }

  interface InspectorLine {
    text: string;
    color: number;
    size: number;
  }

  function truncateToWidth(text: string, fontPx: number): string {
    const budget = Math.max(4, Math.floor((inspectorW - 24) / (fontPx * 0.92)));
    if (text.length <= budget) return text;
    return `${text.slice(0, Math.max(1, budget - 1))}…`;
  }

  // Populate the fixed inspector strip. Content lives in the reserved region
  // below the grid, so it can never overlap a slot (unlike the old floating
  // tooltip). Text goes into the tooltip pool so isTooltipVisible/topmost and
  // the deterministic probes keep their existing contract.
  function renderInspector(lines: InspectorLine[]): void {
    clearTooltip();
    inspectorPlaceholder.setVisible(false);
    const lineH = 20;
    const blockH = (lines.length - 1) * lineH + 10;
    const yStart = inspectorY + Math.max(8, Math.round((INSPECTOR_H - blockH) / 2));
    lines.forEach((line, index) => {
      const text = crispText(inspectorX + 14, snap(yStart + index * lineH), line.text, {
        fontFamily: FONT_FAMILY,
        fontSize: `${line.size}px`,
        color: hex(line.color),
      });
      text.setOrigin(0, 0);
      container.add(text);
      container.bringToTop(text);
      tooltipObjects.push(text);
    });
    tooltipBounds = measureTooltipBounds(tooltipObjects);
  }

  function showTooltip(def: ItemDef, quantity: number): void {
    const rarityColor = RARITY_COLORS[def.rarity] ?? 0x9e9e9e;
    renderInspector([
      { text: truncateToWidth(def.name, 9), color: rarityColor, size: 9 },
      { text: truncateToWidth(def.description, 8), color: 0x9ca3af, size: 8 },
      {
        text: truncateToWidth(
          `${def.rarity.toUpperCase()} · x${quantity} · [${def.tags.join(', ')}]`,
          8,
        ),
        color: 0x8792ad,
        size: 8,
      },
    ]);
  }

  function showGeneratedEquipmentTooltip(def: EquipmentItemDef): void {
    const rarityColor =
      def.rarity === 'common'
        ? RARITY_COLORS[ItemRarity.Common]
        : def.rarity === 'uncommon'
          ? RARITY_COLORS[ItemRarity.Uncommon]
          : def.rarity === 'rare'
            ? RARITY_COLORS[ItemRarity.Rare]
            : def.rarity === 'epic'
              ? RARITY_COLORS[ItemRarity.Epic]
              : RARITY_COLORS[ItemRarity.Legendary];
    renderInspector([
      { text: truncateToWidth(def.name, 9), color: rarityColor, size: 9 },
      { text: 'GENERATED EQUIPMENT', color: COLORS.textSecondary, size: 8 },
      {
        text: truncateToWidth(`${def.rarity.toUpperCase()} · [${(def.tags ?? []).join(', ')}]`, 8),
        color: 0x8792ad,
        size: 8,
      },
    ]);
  }

  function showEmptySlotTooltip(slotLabel: string): void {
    renderInspector([
      { text: slotLabel.toUpperCase(), color: COLORS.textPrimary, size: 9 },
      { text: 'EMPTY SLOT', color: COLORS.textSecondary, size: 8 },
      { text: 'CLICK TO FILTER INVENTORY', color: COLORS.accent, size: 8 },
    ]);
  }

  function formatSignedStatDelta(statId: StatId, delta: number): string {
    const magnitude = formatStatValue(Math.abs(delta));
    const sign = delta > 0 ? '+' : '-';
    return `${formatStatLabel(statId)} ${sign}${magnitude}`;
  }

  // Diablo-style equip preview: shows the item plus the NET stat change from
  // equipping it (including stats lost by unequipping the item(s) it replaces).
  function showEquipPreview(def: ItemDef, preview: EquipDeltaPreview): void {
    const rarityColor = RARITY_COLORS[def.rarity] ?? 0x9e9e9e;
    const changed = ALL_STAT_IDS.filter((statId) => Math.abs(preview.deltas[statId] ?? 0) > 1e-9);
    const lines: InspectorLine[] = [
      { text: truncateToWidth(def.name, 9), color: rarityColor, size: 9 },
    ];
    if (changed.length === 0) {
      lines.push({ text: 'NO STAT CHANGE', color: COLORS.textSecondary, size: 8 });
    } else {
      // Pack the deltas onto one compact line, colour-coded by net direction.
      const netUp = changed.every((statId) => (preview.deltas[statId] ?? 0) >= 0);
      const netDown = changed.every((statId) => (preview.deltas[statId] ?? 0) <= 0);
      const deltaColor = netDown && !netUp ? COLORS.statNerf : COLORS.statBuff;
      const parts = changed.map((statId) =>
        formatSignedStatDelta(statId, preview.deltas[statId] ?? 0),
      );
      lines.push({ text: truncateToWidth(parts.join('  '), 8), color: deltaColor, size: 8 });
    }
    if (preview.swappedOut.length > 0) {
      const names = preview.swappedOut
        .map((swapped) => getItemById(swapped.id)?.name ?? swapped.name)
        .join(', ');
      lines.push({ text: truncateToWidth(`REPLACES: ${names}`, 8), color: 0x8792ad, size: 8 });
    } else if (!preview.canEquip) {
      lines.push({ text: 'CANNOT EQUIP', color: COLORS.statNerf, size: 8 });
    } else {
      lines.push({ text: 'CLICK TO EQUIP', color: COLORS.accent, size: 8 });
    }
    renderInspector(lines);
  }

  // ---------------------------------------------------------------------------
  // Equip / unequip actions
  // ---------------------------------------------------------------------------

  function setSelectedSlotFilter(slotId: EquipmentSlotId | null): void {
    if (selectedSlotFilter === slotId) return;
    selectedSlotFilter = slotId;
    refreshInspectorIdleText();
    config.onSlotFilterChange?.(slotId);
    invalidate();
  }

  function unequipSlot(slotId: string): void {
    if (!currentBag || playerEid < 0 || !lastWorld) return;
    const result = unequip(lastWorld, playerEid, slotId);
    if (result.ok) {
      if (!result.bagUpdated) {
        addItem(currentBag, result.item.def.id, 1);
      }
      invalidate();
      config.onInventoryChanged?.();
    }
  }

  // Deterministic hover surface for the bag grid (also driven by probes/e2e):
  // renders the equip-delta preview for a bag item, or clears it when null.
  const generatedBagMetadata: GeneratedInventoryEntryResolver = (entry) => {
    if (!lastWorld) return undefined;
    const instance = getGeneratedEquipmentInstance(lastWorld, entry.instanceKey);
    if (!instance) return undefined;
    return {
      name: instance.frozen.displayName,
      description: '',
      tags: [],
      rarity: instance.rarity,
      slots: instance.frozen.slots,
    };
  };

  function showGeneratedBagPreview(
    entry: Extract<InventoryBagEntry, { kind: 'generated-instance' }>,
  ): void {
    if (!lastWorld) return;
    const instance = getGeneratedEquipmentInstance(lastWorld, entry.instanceKey);
    if (!instance) {
      clearTooltip();
      return;
    }
    const bonuses = Object.entries(instance.frozen.statBonuses)
      .filter(([, value]) => value !== 0)
      .map(([stat, value]) => `${value! >= 0 ? '+' : ''}${value} ${stat.toUpperCase()}`)
      .join('  ');
    renderInspector([
      {
        text: truncateToWidth(instance.frozen.displayName, 9),
        color: generatedRarityColor(instance.rarity),
        size: 9,
      },
      {
        text: truncateToWidth(
          instance.frozen.slots.map((slot) => slot.toUpperCase()).join(' / '),
          8,
        ),
        color: COLORS.textSecondary,
        size: 8,
      },
      {
        text: truncateToWidth(bonuses || 'NO STAT BONUS', 8),
        color: bonuses ? COLORS.statBuff : COLORS.textSecondary,
        size: 8,
      },
      { text: 'CLICK TO EQUIP', color: COLORS.accent, size: 8 },
    ]);
  }

  function previewBagEntry(entry: InventoryBagEntry | null): void {
    previewEntryIdentity = entry ? inventoryEntryIdentity(entry) : null;
    if (entry === null || !lastWorld || playerEid < 0) {
      clearTooltip();
      return;
    }
    if (entry.kind === 'generated-instance') {
      showGeneratedBagPreview(entry);
      return;
    }
    const itemId = entry.itemId;
    const def = getItemById(itemId);
    const preview = previewEquipDelta(lastWorld, playerEid, itemId);
    if (!def || !preview) {
      clearTooltip();
      return;
    }
    showEquipPreview(def, preview);
  }

  function previewBagItem(itemId: string | null): void {
    previewBagEntry(
      itemId === null ? null : { kind: 'stackable-static-item', itemId, quantity: 1 },
    );
  }

  // Equip an item straight from the integrated bag (atomic Diablo-style swap in
  // the core). Real play is safe-context-gated by equipFromBag; the lab/e2e
  // force it. Refreshes this panel and notifies the scene to sync any separate
  // inventory panel.
  function equipBagEntry(entry: InventoryBagEntry): boolean {
    if (!currentBag || playerEid < 0 || !lastWorld) return false;
    const result =
      entry.kind === 'generated-instance'
        ? equipFromBag(lastWorld, playerEid, entry)
        : equipFromBag(lastWorld, playerEid, entry.itemId);
    if (result.ok) {
      previewEntryIdentity = null;
      invalidate();
      config.onInventoryChanged?.();
    }
    return result.ok;
  }

  function equipBagItem(itemId: string): boolean {
    return equipBagEntry({ kind: 'stackable-static-item', itemId, quantity: 1 });
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function renderSlots(): void {
    clearPool(slotObjects);
    clearTooltip();
    slotBounds.clear();
    slotIconBounds.clear();
    if (!lastWorld || playerEid < 0) return;
    const state = getEquipmentState(lastWorld, playerEid);
    const innerPadX = 22;
    const innerPadY = 10;
    const usableW = dollW - SLOT_W - innerPadX * 2;
    // Reserve the bottom strip for the fixed inspector so slots never extend
    // into (or overlap) the detail panel below the grid.
    const usableH = dollH - SLOT_H - innerPadY * 2 - (INSPECTOR_H + INSPECTOR_GAP);
    const spreadNorm = (value: number, spread: number): number =>
      Math.max(0, Math.min(1, 0.5 + (value - 0.5) * spread));

    for (const slot of SLOT_REGISTRY) {
      const px = spreadNorm(slot.uiPosition.x, SLOT_SPREAD_X);
      const py = spreadNorm(slot.uiPosition.y, SLOT_SPREAD_Y);
      const cx = dollX + innerPadX + SLOT_W / 2 + px * usableW;
      const cy = dollY + innerPadY + SLOT_H / 2 + py * usableH;

      const instId = state?.equipped[slot.id] ?? null;
      const instance =
        instId !== null && state
          ? (resolveEquipmentInstance(lastWorld, state, instId) ?? null)
          : null;
      const generatedInstance =
        typeof instId === 'string' ? getGeneratedEquipmentInstance(lastWorld, instId) : undefined;
      const slotBorderColor = instance ? COLORS.panelBorder : COLORS.slotEmptyBorder;
      const itemDef = instance ? getItemById(instance.def.id) : undefined;

      const isSelected = selectedSlotFilter === slot.id;
      const boxW = SLOT_W;
      const boxH = SLOT_H;
      const baseFill = isSelected ? COLORS.slotSelected : COLORS.slotBg;
      const box = scene.add.rectangle(snap(cx), snap(cy), boxW, boxH, baseFill, 0.95);
      box.setStrokeStyle(
        isSelected ? 3 : 2,
        isSelected ? COLORS.slotSelectedBorder : slotBorderColor,
      );
      box.setInteractive({ useHandCursor: true });
      const b = box.getBounds();
      slotBounds.set(slot.id, { x: b.x, y: b.y, width: b.width, height: b.height });
      const pipColor = isSelected ? COLORS.slotSelectedBorder : COLORS.panelBorder;
      const cornerPips = [
        scene.add.rectangle(
          snap(cx - SLOT_W / 2 + 4),
          snap(cy - SLOT_H / 2 + 4),
          4,
          4,
          pipColor,
          1,
        ),
        scene.add.rectangle(
          snap(cx + SLOT_W / 2 - 4),
          snap(cy - SLOT_H / 2 + 4),
          4,
          4,
          pipColor,
          1,
        ),
        scene.add.rectangle(
          snap(cx - SLOT_W / 2 + 4),
          snap(cy + SLOT_H / 2 - 4),
          4,
          4,
          pipColor,
          1,
        ),
        scene.add.rectangle(
          snap(cx + SLOT_W / 2 - 4),
          snap(cy + SLOT_H / 2 - 4),
          4,
          4,
          pipColor,
          1,
        ),
      ];

      const slotInnerW = boxW - 4;
      const slotInnerH = boxH - 6;
      const inset = scene.add.rectangle(
        snap(cx),
        snap(cy + 1),
        slotInnerW,
        slotInnerH,
        0x2e4167,
        0.98,
      );
      inset.setStrokeStyle(1, 0x5b76aa, 0.8);
      const bevelLeft = scene.add.rectangle(
        snap(cx - slotInnerW / 2 + 1),
        snap(cy + 1),
        2,
        slotInnerH,
        0x8ca8d2,
        0.9,
      );
      const bevelTop = scene.add.rectangle(
        snap(cx),
        snap(cy + 1 - slotInnerH / 2 + 1),
        slotInnerW,
        2,
        0xb9cae5,
        0.92,
      );
      const bevelRight = scene.add.rectangle(
        snap(cx + slotInnerW / 2 - 1),
        snap(cy + 1),
        2,
        slotInnerH,
        0x1f2d48,
        0.95,
      );
      const bevelBottom = scene.add.rectangle(
        snap(cx),
        snap(cy + 1 + slotInnerH / 2 - 1),
        slotInnerW,
        2,
        0x1f2d48,
        0.95,
      );
      const iconObject = generatedInstance
        ? createGeneratedItemIcon(
            generatedInstance.frozen.artKey,
            generatedInstance.frozen.displayName,
            cx,
            cy,
            boxH - 4,
          )
        : instance
          ? createItemIcon(instance.def.id, itemDef ?? instance.def, cx, cy, boxH - 4)
          : createSlotPlaceholder(slot.id, cx, cy + 2);
      const occupiedFill =
        instance !== null
          ? scene.add.rectangle(
              snap(cx),
              snap(cy + 2),
              slotInnerW - 10,
              slotInnerH - 10,
              0x5d7fb7,
              0.24,
            )
          : null;

      box.on('pointerover', () => {
        box.setFillStyle(COLORS.slotHover);
        if (itemDef) {
          showTooltip(itemDef, 1);
        } else if (instance) {
          showGeneratedEquipmentTooltip(instance.def);
        } else {
          showEmptySlotTooltip(slot.label);
        }
      });
      box.on('pointerout', () => {
        box.setFillStyle(baseFill);
        clearTooltip();
      });
      box.on('pointerdown', () => {
        if (selectedSlotFilter !== slot.id) {
          setSelectedSlotFilter(slot.id);
          return;
        }
        if (instance) {
          unequipSlot(slot.id);
          return;
        }
        setSelectedSlotFilter(null);
      });

      container.add(box);
      container.add(inset);
      container.add(bevelLeft);
      container.add(bevelTop);
      container.add(bevelRight);
      container.add(bevelBottom);
      for (const pip of cornerPips) {
        container.add(pip);
        slotObjects.push(pip);
      }
      if (occupiedFill) {
        container.add(occupiedFill);
        slotObjects.push(occupiedFill);
      }
      container.add(iconObject);
      slotObjects.push(iconObject);
      if ('getBounds' in iconObject && typeof iconObject.getBounds === 'function') {
        const ib = iconObject.getBounds();
        slotIconBounds.set(slot.id, { x: ib.x, y: ib.y, width: ib.width, height: ib.height });
      }
      slotObjects.push(box, inset, bevelLeft, bevelTop, bevelRight, bevelBottom);
    }
  }

  function renderStats(): void {
    clearPool(statObjects);
    if (!lastWorld || playerEid < 0) return;

    const effective = getEffectiveStats(lastWorld, playerEid);
    const baseStore = lastWorld.stores.baseStats;

    const heading = crispText(statsX + 10, dollY + 26, 'STATS', {
      fontFamily: FONT_FAMILY,
      fontSize: '16px',
      color: hex(COLORS.accent),
    });
    container.add(heading);
    statObjects.push(heading);
    const headingFrame = scene.add.rectangle(
      statsX + 96,
      dollY + 26,
      172,
      30,
      COLORS.sectionHeader,
      0.95,
    );
    headingFrame.setStrokeStyle(1, COLORS.panelBorder);
    container.addAt(headingFrame, 5);
    statObjects.push(headingFrame);

    let rowY = dollY + 68;
    const colW = STATS_W - 14;
    const ENCUMBRANCE_ROW_COUNT = 3; // equipped weight, total mass, band status
    const totalStatRows = PRIMARY_STATS.length + SECONDARY_STATS.length + ENCUMBRANCE_ROW_COUNT;
    const reservedSectionSpace = 18 * 3 + 4; // PRIMARY + SECONDARY + MASS section headers
    const rowsEndY = dollY + dollH - 12;
    const rowStep = Math.max(
      20,
      Math.floor((rowsEndY - rowY - reservedSectionSpace) / totalStatRows),
    );
    const drawSection = (titleText: string): void => {
      const sectionTitle = crispText(statsX + 10, rowY + 1, titleText, {
        fontFamily: FONT_FAMILY,
        fontSize: '8px',
        color: hex(COLORS.accent),
      });
      sectionTitle.setOrigin(0, 0);
      const sectionRule = scene.add.line(
        0,
        0,
        statsX + 112,
        rowY + 14,
        statsX + colW,
        rowY + 14,
        COLORS.panelBorder,
        0.9,
      );
      sectionRule.setLineWidth(1, 1);
      container.add(sectionTitle);
      container.add(sectionRule);
      statObjects.push(sectionTitle, sectionRule);
      rowY += 20;
    };

    const drawStat = (statId: StatId): void => {
      const value = effective[statId] ?? 0;
      const base = baseStore[statId]?.[playerEid] ?? 0;
      const buffed = value > base;
      const rowBg = scene.add.rectangle(
        statsX + colW / 2 + 6,
        rowY + Math.floor(rowStep / 2),
        colW - 8,
        Math.max(20, rowStep - 2),
        rowY % 48 === 0 ? 0x2f4369 : 0x38507d,
        0.92,
      );
      rowBg.setStrokeStyle(1, 0x5f7db0, 0.7);
      const name = crispText(statsX + 10, rowY + 6, formatStatLabel(statId), {
        fontFamily: FONT_FAMILY,
        fontSize: '8px',
        color: hex(COLORS.textPrimary),
      });
      name.setOrigin(0, 0);
      const val = crispText(statsX + colW, rowY + 6, formatStatValue(value), {
        fontFamily: FONT_FAMILY,
        fontSize: '8px',
        color: buffed ? hex(COLORS.statBuff) : hex(COLORS.textPrimary),
        fontStyle: buffed ? 'bold' : 'normal',
      });
      val.setOrigin(1, 0);
      container.add(rowBg);
      container.add(name);
      container.add(val);
      statObjects.push(rowBg, name, val);
      rowY += rowStep;
    };

    // Encumbrance rows share the same row chrome as `drawStat` but display
    // pre-formatted label/value text instead of resolving a StatId — equipped
    // weight/total mass/band aren't EffectiveStats fields (encumbrance is
    // computed from Weight + equipped gear + effective Strength, see
    // core/encumbrance.ts), yet the plan requires them UI-visible even while
    // fully inert (the shipped catalog's weightLb is all 0).
    const drawInfoRow = (label: string, valueText: string, highlighted: boolean): void => {
      const rowBg = scene.add.rectangle(
        statsX + colW / 2 + 6,
        rowY + Math.floor(rowStep / 2),
        colW - 8,
        Math.max(20, rowStep - 2),
        rowY % 48 === 0 ? 0x2f4369 : 0x38507d,
        0.92,
      );
      rowBg.setStrokeStyle(1, 0x5f7db0, 0.7);
      const name = crispText(statsX + 10, rowY + 6, label, {
        fontFamily: FONT_FAMILY,
        fontSize: '8px',
        color: hex(COLORS.textPrimary),
      });
      name.setOrigin(0, 0);
      const val = crispText(statsX + colW, rowY + 6, valueText, {
        fontFamily: FONT_FAMILY,
        fontSize: '8px',
        color: highlighted ? hex(COLORS.statNerf) : hex(COLORS.textPrimary),
        fontStyle: highlighted ? 'bold' : 'normal',
      });
      val.setOrigin(1, 0);
      container.add(rowBg);
      container.add(name);
      container.add(val);
      statObjects.push(rowBg, name, val);
      rowY += rowStep;
    };

    drawSection('PRIMARY');
    for (const statId of PRIMARY_STATS) {
      drawStat(statId);
    }
    rowY += 4;
    drawSection('SECONDARY');
    for (const statId of SECONDARY_STATS) {
      drawStat(statId);
    }
    rowY += 4;
    drawSection('MASS');
    const encumbrance = getEntityEncumbranceSnapshot(lastWorld, playerEid);
    drawInfoRow('EQUIPPED', formatWeightLb(encumbrance.equippedWeightLb), false);
    drawInfoRow('TOTAL MASS', formatWeightLb(encumbrance.totalMassLb), false);
    drawInfoRow(
      'STATUS',
      formatEncumbranceBandLabel(encumbrance.band),
      encumbrance.band !== 'unburdened',
    );
  }

  function render(): void {
    renderSlots();
    renderStats();
    renderBag();
    const forcedTooltipSlot = (globalThis as { __forceEquipmentTooltipSlot?: string })
      .__forceEquipmentTooltipSlot;
    if (forcedTooltipSlot) {
      const bounds = slotBounds.get(forcedTooltipSlot);
      const slot = SLOT_REGISTRY.find((entry) => entry.id === forcedTooltipSlot);
      if (bounds && slot) {
        showEmptySlotTooltip(slot.label);
      }
    }
  }

  // Integrated equippable-bag grid (right column). Lists the bag's equippable
  // items — filtered to the selected paper-doll slot when a filter is active —
  // as a scroll-sliced grid. Hover previews the equip delta; click equips.
  function renderBag(): void {
    clearPool(bagObjects);
    bagCellBounds = [];
    bagItemIds = [];
    if (!currentBag) return;

    const entries: InventoryBagEntry[] = selectedSlotFilter
      ? filterByEquipmentSlot(currentBag, selectedSlotFilter, generatedBagMetadata)
      : filterEquippable(currentBag, generatedBagMetadata);
    bagItemIds = entries
      .filter(
        (entry): entry is Extract<InventoryBagEntry, { kind: 'stackable-static-item' }> =>
          entry.kind === 'stackable-static-item',
      )
      .map((entry) => entry.itemId);
    bagCellBounds = new Array(entries.length).fill(null);

    // Header row.
    const heading = crispText(bagX + 12, dollY + 26, 'BAG', {
      fontFamily: FONT_FAMILY,
      fontSize: '16px',
      color: hex(COLORS.accent),
    });
    heading.setOrigin(0, 0.5);
    const headingFrame = scene.add.rectangle(
      bagX + bagW / 2,
      dollY + 26,
      bagW - 20,
      30,
      COLORS.sectionHeader,
      0.95,
    );
    headingFrame.setStrokeStyle(1, COLORS.panelBorder);
    container.addAt(headingFrame, 5);
    const filterLabel = selectedSlotFilter
      ? (SLOT_REGISTRY.find((entry) => entry.id === selectedSlotFilter)?.label ?? '').toUpperCase()
      : 'EQUIPPABLE';
    const subHeading = crispText(
      bagX + bagW - 12,
      dollY + 26,
      `${filterLabel} · ${entries.length}`,
      {
        fontFamily: FONT_FAMILY,
        fontSize: '8px',
        color: hex(COLORS.textSecondary),
      },
    );
    subHeading.setOrigin(1, 0.5);
    container.add(heading);
    container.add(subHeading);
    bagObjects.push(heading, headingFrame, subHeading);

    // Grid geometry.
    const cell = BAG_CELL;
    const gap = BAG_GAP;
    const cols = BAG_COLS;
    const headerH = 48;
    const gridW = cols * cell + (cols - 1) * gap;
    const gridX = bagX + Math.round((bagW - gridW) / 2);
    const gridTop = bagY + headerH;
    const availH = bagH - headerH - 10;
    const rowsVisible = Math.max(1, Math.floor((availH + gap) / (cell + gap)));
    const totalRows = Math.ceil(entries.length / cols);
    const maxScroll = Math.max(0, totalRows - rowsVisible);
    if (bagScrollRow > maxScroll) bagScrollRow = maxScroll;
    if (bagScrollRow < 0) bagScrollRow = 0;
    bagMaxScroll = maxScroll;

    if (entries.length === 0) {
      const empty = crispText(
        bagX + bagW / 2,
        gridTop + 40,
        selectedSlotFilter ? 'NO MATCHING GEAR' : 'NO EQUIPPABLE ITEMS',
        { fontFamily: FONT_FAMILY, fontSize: '8px', color: hex(COLORS.textSecondary) },
      );
      empty.setOrigin(0.5, 0.5);
      container.add(empty);
      bagObjects.push(empty);
      return;
    }

    const startIndex = bagScrollRow * cols;
    const endIndex = Math.min(entries.length, startIndex + rowsVisible * cols);
    for (let index = startIndex; index < endIndex; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      const generated =
        entry.kind === 'generated-instance' && lastWorld
          ? getGeneratedEquipmentInstance(lastWorld, entry.instanceKey)
          : undefined;
      const itemId = entry.kind === 'stackable-static-item' ? entry.itemId : entry.instanceKey;
      const def = entry.kind === 'stackable-static-item' ? getItemById(itemId) : undefined;
      const local = index - startIndex;
      const col = local % cols;
      const row = Math.floor(local / cols);
      const cx = gridX + col * (cell + gap) + cell / 2;
      const cy = gridTop + row * (cell + gap) + cell / 2;
      const rarityColor = generated
        ? generatedRarityColor(generated.rarity)
        : def
          ? (RARITY_COLORS[def.rarity] ?? COLORS.panelBorder)
          : COLORS.panelBorder;

      const box = scene.add.rectangle(snap(cx), snap(cy), cell, cell, COLORS.slotBg, 0.95);
      box.setStrokeStyle(2, rarityColor);
      box.setInteractive({ useHandCursor: true });
      const b = box.getBounds();
      bagCellBounds[index] = { x: b.x, y: b.y, width: b.width, height: b.height };
      const inset = scene.add.rectangle(snap(cx), snap(cy + 1), cell - 6, cell - 8, 0x2e4167, 0.98);
      inset.setStrokeStyle(1, 0x5b76aa, 0.8);
      const icon = generated
        ? createGeneratedItemIcon(
            generated.frozen.artKey,
            generated.frozen.displayName,
            cx,
            cy,
            cell - 12,
          )
        : def
          ? createItemIcon(itemId, def, cx, cy, cell - 12)
          : crispText(snap(cx), snap(cy), '?', {
              fontFamily: FONT_FAMILY,
              fontSize: '12px',
              color: '#9ca3af',
            });
      if (!def && 'setOrigin' in icon) {
        (icon as Phaser.GameObjects.Text).setOrigin(0.5, 0.5);
      }

      box.on('pointerover', () => {
        box.setFillStyle(COLORS.slotHover);
        previewBagEntry(entry);
      });
      box.on('pointerout', () => {
        box.setFillStyle(COLORS.slotBg);
        if (previewEntryIdentity === inventoryEntryIdentity(entry)) previewBagEntry(null);
      });
      box.on('pointerdown', () => {
        equipBagEntry(entry);
      });

      container.add(box);
      container.add(inset);
      container.add(icon);
      bagObjects.push(box, inset, icon);

      if (entry.kind === 'stackable-static-item' && entry.quantity > 1) {
        const qty = crispText(
          snap(cx + cell / 2 - 4),
          snap(cy + cell / 2 - 4),
          `x${entry.quantity}`,
          {
            fontFamily: FONT_FAMILY,
            fontSize: '8px',
            color: hex(COLORS.textPrimary),
          },
        );
        qty.setOrigin(1, 1);
        container.add(qty);
        bagObjects.push(qty);
      }
    }
  }

  function computeSignature(): string {
    if (!lastWorld || playerEid < 0) return 'none';
    const state = getEquipmentState(lastWorld, playerEid);
    let signature = '';
    if (state) {
      for (const slot of SLOT_REGISTRY) {
        const instId = state.equipped[slot.id] ?? null;
        const inst =
          instId !== null ? resolveEquipmentInstance(lastWorld, state, instId) : undefined;
        const itemId = inst?.def.id ?? '';
        const generated =
          typeof instId === 'string' ? getGeneratedEquipmentInstance(lastWorld, instId) : undefined;
        const entry = generated ? null : itemId ? selectGeneratedEntry(itemId) : null;
        const artKey = generated?.frozen.artKey ?? entry?.textureKey ?? '';
        const iconReady = artKey !== '' && scene.textures?.exists(artKey) === true;
        signature += `${slot.id}:${inst ? inst.def.id : '-'}:${artKey}:${iconReady ? 1 : 0}|`;
      }
    }
    signature += `slot:${selectedSlotFilter ?? '-'}|`;
    const bag = currentBag;
    if (bag) {
      const world = lastWorld;
      const equippable: InventoryBagEntry[] = selectedSlotFilter
        ? filterByEquipmentSlot(bag, selectedSlotFilter, generatedBagMetadata)
        : filterEquippable(bag, generatedBagMetadata);
      signature += `bag:${equippable
        .map((entry) => {
          if (entry.kind === 'stackable-static-item') {
            const sprite = selectGeneratedEntry(entry.itemId);
            const iconReady = sprite !== null && scene.textures?.exists(sprite.textureKey) === true;
            return `${inventoryEntryIdentity(entry)}x${entry.quantity}:${sprite?.textureKey ?? ''}:${iconReady ? 1 : 0}`;
          }
          const artKey =
            getGeneratedEquipmentInstance(world, entry.instanceKey)?.frozen.artKey ?? '';
          const iconReady = artKey !== '' && scene.textures?.exists(artKey) === true;
          return `${inventoryEntryIdentity(entry)}:${artKey}:${iconReady ? 1 : 0}`;
        })
        .join(',')}|`;
      signature += `scroll:${bagScrollRow}|`;
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
    textResolution = Math.max(MIN_TEXT_RESOLUTION, getTextResolution(scene));
    container.setScale(uiScale);
    panelX = snap((viewWidth() - panelWidth) / 2);
    panelY = snap((viewHeight() - panelHeight) / 2);

    bg.setPosition(panelX + panelWidth / 2, panelY + panelHeight / 2);
    const nextCornerPoints = [
      [panelX + 6, panelY + 6],
      [panelX + panelWidth - 6, panelY + 6],
      [panelX + 6, panelY + panelHeight - 6],
      [panelX + panelWidth - 6, panelY + panelHeight - 6],
    ] as const;
    nextCornerPoints.forEach(([x, y], index) => cornerPixels[index]?.setPosition(x, y));
    titleFrame.setPosition(panelX + PANEL_PADDING + 146, panelY + PANEL_PADDING + 10);
    divider.setTo(
      dollX + dollW + PANEL_PADDING / 2,
      dollY,
      dollX + dollW + PANEL_PADDING / 2,
      dollY + dollH,
    );
    bagDivider.setTo(bagX - PANEL_PADDING / 2, dollY, bagX - PANEL_PADDING / 2, dollY + dollH);
    title
      .setPosition(panelX + PANEL_PADDING, panelY + PANEL_PADDING + 2)
      .setResolution(textResolution);
    hint
      .setPosition(panelX + PANEL_PADDING, panelY + PANEL_PADDING + 28)
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
    currentWorldSeed = world.seed | 0;
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
      setSelectedSlotFilter(null);
      lastSignature = null;
      refresh(world);
    } else {
      setSelectedSlotFilter(null);
      clearTooltip();
    }
  }

  // Scroll the integrated bag column by whole rows, clamped to the last render's
  // range. The integrated bag can exceed its visible rows (BAG_COLS=4), so
  // without this the overflow was unreachable and could trap items off-screen.
  function scrollBag(rows: number): boolean {
    if (rows === 0) return false;
    const next = Math.min(bagMaxScroll, Math.max(0, bagScrollRow + rows));
    if (next === bagScrollRow) return false;
    bagScrollRow = next;
    invalidate();
    return true;
  }

  const handleWheel = (
    pointer: Phaser.Input.Pointer,
    _currentlyOver: Phaser.GameObjects.GameObject[],
    _deltaX: number,
    deltaY: number,
  ): void => {
    if (!visible || bagMaxScroll <= 0 || deltaY === 0) return;
    // Phaser pointer coords live in backing-store space (`[0, design × S]` after
    // the HiDPI supersample); bagBg.getBounds() is design space. Convert the
    // pointer to design space before hit-testing, or on HiDPI displays (S >= 2 —
    // the common case) the wheel misses the bag entirely and fires over an
    // unrelated centre region. Identity at S=1. Mirrors HudMinimap.toDesignSpace.
    const s = getRenderScale(scene);
    if (!Phaser.Geom.Rectangle.Contains(bagBg.getBounds(), pointer.x / s, pointer.y / s)) return;
    scrollBag(deltaY > 0 ? 1 : -1);
  };
  scene.input.on('wheel', handleWheel);

  scene.scale.on('resize', applyLayout);

  return {
    toggle,
    refresh,
    isOpen: () => visible,
    getSelectedSlotFilter: () => selectedSlotFilter,
    selectSlot: (slotId: EquipmentSlotId | null) => setSelectedSlotFilter(slotId),
    getPanelScreenBounds,
    getSlotScreenBounds: (slotId: EquipmentSlotId) => slotBounds.get(slotId) ?? null,
    getSlotIconScreenBounds: (slotId: EquipmentSlotId) => slotIconBounds.get(slotId) ?? null,
    getTooltipScreenBounds: () => tooltipBounds,
    isTooltipVisible: () => tooltipObjects.length > 0,
    isTooltipTopmost,
    getBagItemIds: () => [...bagItemIds],
    getGeneratedBagCellScreenBounds: (instanceKey: string) => {
      if (!currentBag) return null;
      const entries: InventoryBagEntry[] = selectedSlotFilter
        ? filterByEquipmentSlot(currentBag, selectedSlotFilter, generatedBagMetadata)
        : filterEquippable(currentBag, generatedBagMetadata);
      const index = entries.findIndex(
        (entry) => entry.kind === 'generated-instance' && entry.instanceKey === instanceKey,
      );
      return index < 0 ? null : (bagCellBounds[index] ?? null);
    },
    getBagCellScreenBounds: (index: number) => bagCellBounds[index] ?? null,
    getBagColumnScreenBounds: (): ScreenBounds => {
      const b = bagBg.getBounds();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    },
    scrollBag: (rows: number) => scrollBag(rows),
    getBagScrollRow: () => bagScrollRow,
    getBagMaxScrollRow: () => bagMaxScroll,
    previewBagItem: (itemId: string | null) => previewBagItem(itemId),
    equipBagItem: (itemId: string) => equipBagItem(itemId),
    destroy() {
      scene.scale.off('resize', applyLayout);
      scene.input.off('wheel', handleWheel);
      clearPool(slotObjects);
      clearPool(statObjects);
      clearPool(bagObjects);
      clearPool(tooltipObjects);
      tooltipBounds = null;
      slotBounds.clear();
      slotIconBounds.clear();
      bagCellBounds = [];
      bagItemIds = [];
      container.destroy();
    },
  };
}
