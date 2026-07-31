/**
 * InventoryUI — Phaser-based inventory overlay panel.
 *
 * Features:
 * - Dynamic tabs derived from held items' tags
 * - Search bar (filters by name/description)
 * - Grid with stack counts and rarity-colored borders
 * - Toggle handled by caller (for example lab or scene keybinds)
 * - Respects TabPreferences for tab ordering and hiding
 */
import Phaser from 'phaser';
import { getGeneratedEquipmentInstance } from '../core/generated-equipment-registry.js';
import type { GameWorld } from '../core/world.js';
import { fitScaleForBox, fitUiScale, getTextResolution, type ScreenBounds } from './ui-scale.js';
import { GAME } from '../shared/constants.js';
import type {
  GeneratedEquipmentInventoryEntry,
  InventoryBag,
  TabPreferences,
} from '../shared/inventory.js';
import {
  createTabPreferences,
  getVisibleTabs,
  listInventoryEntries,
  type SortField,
} from '../shared/inventory.js';
import { getSlotLabel, type EquipmentSlotId } from '../shared/equipment-slots.js';
import { getEquipmentDefForItem, isEquippableItem } from '../shared/equipmentDefs.js';
import {
  ItemRarity,
  type ItemDef,
  type ItemTag,
  RARITY_COLORS,
  getItemById,
} from '../shared/items.js';
import {
  emptyGeneratedSpriteRegistry,
  type GeneratedSpriteEntry,
  type GeneratedSpriteRegistry,
} from '../shared/generated-assets.js';
import { resolveItemSprite } from '../shared/item-sprites.js';
import { hashStringToSeed } from '../shared/random.js';
import { GENERATED_EQUIPMENT_RARITY_COLORS } from './generated-equipment-icon.js';
import { GENERATED_SPRITE_REGISTRY_KEY } from './generatedAssets/index.js';
import { renderItemTooltip } from './item-tooltip.js';
import { BLUE_STEEL, hex, MIN_TEXT_RESOLUTION } from './ui-theme.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PANEL_PADDING = 16;
const TAB_HEIGHT = 36;
const TAB_GAP = 4;
const SEARCH_HEIGHT = 48;
const CELL_SIZE = 64;
const CELL_GAP = 10;
const COLS = 5;
const BORDER_WIDTH = 2;
const FONT_FAMILY = '"Press Start 2P", "Courier New", monospace';

const COLORS = {
  ...BLUE_STEEL,
  tabBg: 0x394c74,
  tabActive: 0x4a6699,
  tabActiveBorder: 0xf2c14e,
  tabText: 0xaebdd5,
  tabTextActive: 0xd9e2ef,
  searchBg: 0x2b3c61,
  searchBorder: 0x3f5f93,
  cellBg: 0x445c89,
  cellHover: 0x5472ab,
  emptyCellBg: 0x37496f,
  emptyCellBorder: 0x3f5f93,
} as const;

// ---------------------------------------------------------------------------
// InventoryUI
// ---------------------------------------------------------------------------

export interface InventoryUIConfig {
  /** Width of the panel. Default: auto-calculated from COLS. */
  width?: number;
  /** Height of the panel. Default: 480. */
  height?: number;
  /**
   * Equip intent. Fired when the user double-clicks an equippable inventory
   * cell (ARPG idiom; single click/tap still pins the tooltip). The coordinator
   * decides whether the equip is allowed (safe-room gate) and refreshes panes.
   */
  onEquipItem?: (item: string | GeneratedEquipmentInventoryEntry) => void;
}

/** Max ms between two clicks on the same cell to count as an equip double-click. */
const DOUBLE_CLICK_MS = 220;

const GENERATED_RARITY_ORDER: Readonly<Record<'common' | 'uncommon' | 'rare', number>> = {
  common: 0,
  uncommon: 1,
  rare: 2,
};

const GENERATED_RARITY_TO_ITEM_RARITY: Readonly<
  Record<'common' | 'uncommon' | 'rare', ItemRarity>
> = {
  common: ItemRarity.Common,
  uncommon: ItemRarity.Uncommon,
  rare: ItemRarity.Rare,
};

const ITEM_RARITY_ORDER: Readonly<Record<ItemDef['rarity'], number>> = {
  Common: 0,
  Uncommon: 1,
  Rare: 2,
  Epic: 3,
  Legendary: 4,
};

type RenderInventoryEntry = {
  readonly renderKey: string;
  readonly itemId: string;
  readonly quantity: number;
  readonly def: ItemDef;
  readonly rarityOrder: number;
  readonly rarityColor: number;
  readonly slotIds: readonly EquipmentSlotId[];
  readonly equipTarget: string | GeneratedEquipmentInventoryEntry;
};

export function createInventoryUI(
  scene: Phaser.Scene,
  config: InventoryUIConfig = {},
): {
  toggle(world: GameWorld): void;
  refresh(world: GameWorld): void;
  isOpen(): boolean;
  /**
   * Test/automation affordance: world-space bounds of the index-th inventory
   * cell background (in render order), or null when no such cell is rendered.
   * Lets e2e harnesses hover/click a specific canvas cell.
   */
  getCellScreenBounds(index: number): ScreenBounds | null;
  /**
   * Test/automation affordance: render-order index of the first visible cell
   * holding `itemId`, or null when absent. Lets e2e find a specific item's cell
   * without assuming a fixed sort position.
   */
  getCellIndexForItem(itemId: string): number | null;
  /** Test/automation affordance: visible rendered item ids in grid order. */
  getVisibleItemIds(): string[];
  /** Test/automation affordance: true while a hover/pin tooltip is rendered. */
  isTooltipVisible(): boolean;
  /** Test/automation affordance: true while a tooltip is pinned (click/tap). */
  isTooltipPinned(): boolean;
  setEquipmentSlotFilter(slotId: EquipmentSlotId | null): void;
  getEquipmentSlotFilter(): EquipmentSlotId | null;
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

  const basePanelWidth = COLS * (CELL_SIZE + CELL_GAP) + CELL_GAP + PANEL_PADDING * 2;
  const panelWidth = config.width ?? Math.max(basePanelWidth, 520);
  const panelHeight = config.height ?? 480;

  // Responsive UI: lay the panel out in a "virtual" viewport (real size ÷
  // uiScale) and scale the whole container up by uiScale so the inventory grid,
  // tabs and text grow on small screens while staying centred and on-canvas.
  let uiScale = fitUiScale(scene, panelWidth, panelHeight);
  textResolution = Math.max(MIN_TEXT_RESOLUTION, getTextResolution(scene));
  const viewWidth = (): number => GAME.WIDTH / uiScale;
  const viewHeight = (): number => GAME.HEIGHT / uiScale;

  let visible = false;
  let activeTag: ItemTag | null = null;
  let searchQuery = '';
  let externalSlotFilter: EquipmentSlotId | null = null;
  let currentBag: InventoryBag | null = null;
  let currentSortBy: SortField = 'rarity';
  const tabPrefs: TabPreferences = createTabPreferences();
  let playerEid = -1;

  // Double-click equip detection: remember the last cell click so a quick
  // second click on the same equippable item fires the equip intent while a
  // slow second click still just toggles the pinned tooltip.
  let lastClickItemKey: string | null = null;
  let lastClickTime = Number.NEGATIVE_INFINITY;

  // Signature of the last rendered grid state. The scene calls refresh() every
  // frame while the panel is open; re-running renderItems() each frame would
  // destroy and recreate every cell (and any open tooltip), which breaks hover
  // because Phaser only fires `pointerover` on pointer movement — not when a
  // fresh object appears under a stationary cursor. Gating re-render behind this
  // signature keeps cells (and the tooltip) alive between content changes.
  let lastRenderSignature: string | null = null;

  // Currently "pinned" tooltip (via click/tap). Stays visible after the pointer
  // leaves the cell until the item is clicked again or another item is clicked.
  let pinned: { entry: RenderInventoryEntry; x: number; y: number } | null = null;
  let currentWorld: GameWorld | null = null;

  /**
   * Resolve the generated sprite registry on demand. The boot scene sets
   * it before MainGameScene starts; reading it lazily makes the UI robust
   * to construction in tests where the boot scene never ran.
   */
  const getGeneratedRegistry = (): GeneratedSpriteRegistry => {
    const registry = scene.game?.registry?.get(GENERATED_SPRITE_REGISTRY_KEY) as
      | GeneratedSpriteRegistry
      | undefined;
    return registry ?? emptyGeneratedSpriteRegistry();
  };

  // Run seed captured from the world on refresh. Used to choose a stable
  // generated-sprite variant per item without consuming the gameplay RNG stream.
  let currentWorldSeed = 0;

  /**
   * Resolve which approved generated-sprite variant to render for an item.
   * Resolves by item id (crossing to the equipment `weaponId` when needed) and
   * prefers real approved art over the placeholder — see `resolveItemSprite`.
   * Deterministic per (itemId, run): the same item keeps the same variant for
   * the whole run (no per-frame flicker) but may differ across runs/items.
   * Returns null only when neither the item id nor its weaponId matches any
   * generated entry; when the sole match is a placeholder, that placeholder is
   * returned (real art is merely preferred) — see `resolveItemSprite`.
   */
  const selectGeneratedEntry = (itemId: string): GeneratedSpriteEntry | null =>
    resolveItemSprite(
      getGeneratedRegistry(),
      itemId,
      (hashStringToSeed(itemId) ^ currentWorldSeed) | 0,
    );

  // Container for the entire UI
  const container = scene.add.container(0, 0);
  container.setDepth(1000);
  container.setVisible(false);

  // Panel background
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

  // Corner pixel accent decorations (same idiom as EquipmentUI).
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

  // Title
  const TITLE_TEXT = 'INVENTORY';
  const title = crispText(panelX + PANEL_PADDING, panelY + PANEL_PADDING + 2, TITLE_TEXT, {
    fontFamily: FONT_FAMILY,
    fontSize: '16px',
    color: hex(COLORS.textPrimary),
    padding: { top: 4, bottom: 2 },
  });
  container.add(title);
  // Header chip behind the title. Sized to hug the title text rather than
  // reusing EquipmentUI's absolute 296px frame: that value was tuned for
  // Equipment's 1240px panel and spans ~57% of this 520px panel, leaving a large
  // dead gap to the right of "INVENTORY". Derived from the fixed title string at
  // 16px (Press Start 2P advance ~16.5px/char) so the chip stays correctly
  // proportioned regardless of async pixel-font load timing — a runtime
  // title.width read can measure the narrower fallback font before Press Start
  // 2P finishes loading.
  const titleChipTextW = Math.round(TITLE_TEXT.length * 16.5);
  const titleFrame = scene.add.rectangle(
    snap(panelX + PANEL_PADDING + titleChipTextW / 2),
    panelY + PANEL_PADDING + 10,
    titleChipTextW + 24,
    28,
    COLORS.sectionHeader,
    0.95,
  );
  titleFrame.setStrokeStyle(1, COLORS.panelBorder);
  container.addAt(titleFrame, 1);

  const slotFilterLabel = crispText(panelX + PANEL_PADDING + 138, panelY + PANEL_PADDING + 4, '', {
    fontFamily: FONT_FAMILY,
    fontSize: '12px',
    color: hex(COLORS.accent),
  });
  container.add(slotFilterLabel);

  // Sort button
  const sortBtn = crispText(
    panelX + panelWidth - PANEL_PADDING,
    panelY + PANEL_PADDING + 2,
    'Sort: Rarity',
    {
      fontFamily: FONT_FAMILY,
      fontSize: '12px',
      color: hex(COLORS.textSecondary),
      padding: { top: 4, bottom: 2 },
    },
  )
    .setOrigin(1, 0)
    .setInteractive({ useHandCursor: true });

  sortBtn.on('pointerdown', () => {
    const sortFields: SortField[] = ['rarity', 'name', 'quantity'];
    const idx = sortFields.indexOf(currentSortBy);
    currentSortBy = sortFields[(idx + 1) % sortFields.length]!;
    sortBtn.setText(`Sort: ${currentSortBy.charAt(0).toUpperCase() + currentSortBy.slice(1)}`);
    renderItems();
  });
  container.add(sortBtn);

  // Tab and content areas
  let tabY = snap(panelY + PANEL_PADDING + 28);
  let searchY = snap(tabY + TAB_HEIGHT + TAB_GAP);
  let gridY = snap(searchY + SEARCH_HEIGHT + TAB_GAP + 4);
  let gridHeight = panelY + panelHeight - gridY - PANEL_PADDING;

  // Tab objects pool
  const tabObjects: Phaser.GameObjects.GameObject[] = [];
  // Cell objects pool
  const cellObjects: Phaser.GameObjects.GameObject[] = [];
  // Cell background rectangles, in render order (test/automation hit-targets).
  const cellBackgrounds: Phaser.GameObjects.Rectangle[] = [];
  // Item id per render-order cell, parallel to cellBackgrounds (automation).
  const cellItemIds: string[] = [];
  // Tooltip objects
  const tooltipObjects: Phaser.GameObjects.GameObject[] = [];

  // Search input display
  const searchBg = scene.add.rectangle(
    panelX + panelWidth / 2,
    searchY + SEARCH_HEIGHT / 2,
    panelWidth - PANEL_PADDING * 2,
    SEARCH_HEIGHT,
    COLORS.searchBg,
  );
  searchBg.setStrokeStyle(1, COLORS.searchBorder);
  container.add(searchBg);

  const searchText = crispText(
    panelX + PANEL_PADDING + 10,
    searchY + SEARCH_HEIGHT / 2 + 3,
    'Type to search...',
    {
      fontFamily: FONT_FAMILY,
      fontSize: '12px',
      color: hex(COLORS.textSecondary),
    },
  );
  searchText.setOrigin(0, 0.5);
  container.add(searchText);

  function applyLayout(): void {
    uiScale = fitUiScale(scene, panelWidth, panelHeight);
    textResolution = Math.max(MIN_TEXT_RESOLUTION, getTextResolution(scene));
    container.setScale(uiScale);
    panelX = snap((viewWidth() - panelWidth) / 2);
    panelY = snap((viewHeight() - panelHeight) / 2);
    tabY = snap(panelY + PANEL_PADDING + 28);
    searchY = snap(tabY + TAB_HEIGHT + TAB_GAP);
    gridY = snap(searchY + SEARCH_HEIGHT + TAB_GAP + 4);
    gridHeight = panelY + panelHeight - gridY - PANEL_PADDING;

    bg.setPosition(panelX + panelWidth / 2, panelY + panelHeight / 2);
    const nextCornerPoints = [
      [panelX + 6, panelY + 6],
      [panelX + panelWidth - 6, panelY + 6],
      [panelX + 6, panelY + panelHeight - 6],
      [panelX + panelWidth - 6, panelY + panelHeight - 6],
    ] as const;
    nextCornerPoints.forEach(([x, y], index) => cornerPixels[index]?.setPosition(x, y));
    titleFrame.setPosition(
      snap(panelX + PANEL_PADDING + titleChipTextW / 2),
      panelY + PANEL_PADDING + 10,
    );
    title
      .setPosition(panelX + PANEL_PADDING, panelY + PANEL_PADDING + 2)
      .setResolution(textResolution);
    slotFilterLabel
      .setPosition(panelX + PANEL_PADDING + 138, panelY + PANEL_PADDING + 4)
      .setResolution(textResolution);
    sortBtn
      .setPosition(panelX + panelWidth - PANEL_PADDING, panelY + PANEL_PADDING + 2)
      .setResolution(textResolution);
    searchBg.setPosition(panelX + panelWidth / 2, searchY + SEARCH_HEIGHT / 2);
    searchText
      .setPosition(panelX + PANEL_PADDING + 10, searchY + SEARCH_HEIGHT / 2 + 3)
      .setResolution(textResolution);

    if (visible) {
      renderTabs();
      renderItems();
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function clearTabObjects(): void {
    for (const obj of tabObjects) {
      obj.destroy();
    }
    tabObjects.length = 0;
  }

  function clearCellObjects(): void {
    for (const obj of cellObjects) {
      obj.destroy();
    }
    cellObjects.length = 0;
    cellBackgrounds.length = 0;
    cellItemIds.length = 0;
  }

  function clearTooltip(): void {
    for (const obj of tooltipObjects) {
      obj.destroy();
    }
    tooltipObjects.length = 0;
  }

  function renderTabs(): void {
    clearTabObjects();
    if (!currentBag) return;

    const tagBag: InventoryBag = {
      slots: buildRenderEntries().map((entry) => ({
        itemId: entry.itemId,
        quantity: entry.quantity,
      })),
    };
    const tabs = getVisibleTabs(tagBag, tabPrefs);
    if (activeTag !== null && !tabs.includes(activeTag)) {
      activeTag = null;
    }

    // "All" tab
    const allTabs: (ItemTag | null)[] = [null, ...tabs];
    const labels = allTabs.map((tag) => tag ?? 'All');
    const rawWidths = labels.map((label) => label.length * 9 + 24);
    const availableWidth =
      panelWidth - PANEL_PADDING * 2 - TAB_GAP * Math.max(0, labels.length - 1);

    const fittedWidths = [...rawWidths];
    const minWidth = 56;
    const totalRawWidth = rawWidths.reduce((sum, width) => sum + width, 0);

    if (totalRawWidth > availableWidth) {
      const scale = availableWidth / totalRawWidth;
      for (let i = 0; i < fittedWidths.length; i += 1) {
        fittedWidths[i] = Math.max(minWidth, Math.floor(fittedWidths[i]! * scale));
      }

      let totalFitted = fittedWidths.reduce((sum, width) => sum + width, 0);
      while (totalFitted > availableWidth) {
        let reduced = false;
        for (let i = 0; i < fittedWidths.length && totalFitted > availableWidth; i += 1) {
          if (fittedWidths[i]! <= minWidth) {
            continue;
          }

          fittedWidths[i]! -= 1;
          totalFitted -= 1;
          reduced = true;
        }

        if (!reduced) {
          break;
        }
      }
    }

    let tabX = panelX + PANEL_PADDING;
    for (let i = 0; i < allTabs.length; i += 1) {
      const tag = allTabs[i]!;
      const label = labels[i]!;
      const isActive = tag === activeTag;
      const tabWidth = fittedWidths[i]!;
      const maxChars = Math.max(3, Math.floor((tabWidth - 16) / 8));
      const displayLabel =
        label.length > maxChars ? `${label.slice(0, Math.max(1, maxChars - 1))}…` : label;

      const tabBg = scene.add.rectangle(
        tabX + tabWidth / 2,
        tabY + TAB_HEIGHT / 2,
        tabWidth,
        TAB_HEIGHT - 4,
        isActive ? COLORS.tabActive : COLORS.tabBg,
        0.9,
      );
      tabBg.setStrokeStyle(1, isActive ? COLORS.tabActiveBorder : COLORS.panelBorder);
      tabBg.setInteractive({ useHandCursor: true });
      tabBg.on('pointerdown', () => {
        activeTag = tag;
        renderTabs();
        renderItems();
      });

      const tabLabel = crispText(tabX + tabWidth / 2, tabY + TAB_HEIGHT / 2, displayLabel, {
        fontFamily: FONT_FAMILY,
        fontSize: '10px',
        color: isActive ? hex(COLORS.tabTextActive) : hex(COLORS.tabText),
      });
      tabLabel.setOrigin(0.5, 0.5);

      container.add(tabBg);
      container.add(tabLabel);
      tabObjects.push(tabBg, tabLabel);

      tabX += tabWidth + TAB_GAP;
    }
  }

  function buildRenderEntries(): RenderInventoryEntry[] {
    if (!currentBag) return [];

    const entries: RenderInventoryEntry[] = [];
    for (const [index, bagEntry] of listInventoryEntries(currentBag).entries()) {
      if (bagEntry.kind === 'generated-instance') {
        if (!currentWorld) continue;
        const instance = getGeneratedEquipmentInstance(currentWorld, bagEntry.instanceKey);
        if (!instance) continue;
        const def =
          getItemById(instance.baseId) ??
          ({
            id: instance.baseId,
            name: instance.frozen.displayName,
            description: '',
            tags: [...instance.frozen.tags] as ItemTag[],
            rarity: GENERATED_RARITY_TO_ITEM_RARITY[instance.rarity],
            maxStack: 1,
          } satisfies ItemDef);
        entries.push({
          renderKey: `generated:${bagEntry.instanceKey}`,
          itemId: def.id,
          quantity: 1,
          def,
          rarityOrder: GENERATED_RARITY_ORDER[instance.rarity],
          rarityColor: GENERATED_EQUIPMENT_RARITY_COLORS[instance.rarity],
          slotIds: instance.frozen.slots,
          equipTarget: bagEntry,
        });
        continue;
      }

      const def = getItemById(bagEntry.itemId);
      if (!def) continue;
      entries.push({
        renderKey: `static:${bagEntry.itemId}:${index}`,
        itemId: bagEntry.itemId,
        quantity: bagEntry.quantity,
        def,
        rarityOrder: ITEM_RARITY_ORDER[def.rarity] ?? 0,
        rarityColor: RARITY_COLORS[def.rarity] ?? 0x9e9e9e,
        slotIds: getEquipmentDefForItem(bagEntry.itemId)?.slots ?? [],
        equipTarget: bagEntry.itemId,
      });
    }
    return entries;
  }

  function getFilteredEntries(): RenderInventoryEntry[] {
    let entries = buildRenderEntries();

    const slotFilter = externalSlotFilter;
    if (slotFilter !== null) {
      entries = entries.filter((entry) => entry.slotIds.includes(slotFilter));
    }

    if (searchQuery) {
      const lowerQuery = searchQuery.toLowerCase();
      entries = entries.filter(
        (entry) =>
          entry.def.name.toLowerCase().includes(lowerQuery) ||
          entry.def.description.toLowerCase().includes(lowerQuery),
      );
    } else {
      const tag = activeTag;
      if (tag !== null) {
        entries = entries.filter((entry) => entry.def.tags.includes(tag));
      }
    }

    return [...entries].sort((a, b) => {
      switch (currentSortBy) {
        case 'rarity': {
          const diff = b.rarityOrder - a.rarityOrder;
          return diff !== 0 ? diff : a.def.name.localeCompare(b.def.name);
        }
        case 'name':
          return a.def.name.localeCompare(b.def.name);
        case 'quantity':
          return b.quantity - a.quantity;
      }
    });
  }

  function renderItems(): void {
    clearCellObjects();
    clearTooltip();
    if (!currentBag) return;

    const entries = getFilteredEntries();
    const maxRows = Math.floor(gridHeight / (CELL_SIZE + CELL_GAP));
    const maxVisible = maxRows * COLS;
    // Center the fixed-width grid within the panel so the left/right padding is
    // symmetric. The panel is wider than the grid needs (its width is driven by
    // the header row), so a left-anchored grid would dump all the slack on the
    // right and read as broken.
    const gridPixelWidth = COLS * CELL_SIZE + (COLS - 1) * CELL_GAP;
    const gridLeft = snap(panelX + (panelWidth - gridPixelWidth) / 2);

    for (let i = 0; i < Math.min(entries.length, maxVisible); i++) {
      const entry = entries[i]!;
      const def = entry.def;

      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const cellX = snap(gridLeft + col * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2);
      const cellY = snap(gridY + row * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2);

      const rarityColor = entry.rarityColor;

      // Cell background
      const cellBg = scene.add.rectangle(cellX, cellY, CELL_SIZE, CELL_SIZE, COLORS.cellBg);
      cellBg.setStrokeStyle(BORDER_WIDTH, rarityColor);
      cellBg.setInteractive({ useHandCursor: true });

      // Keep the pinned cell highlighted and its coordinates fresh across
      // re-renders (item order/position can shift when the bag changes).
      if (pinned !== null && pinned.entry.renderKey === entry.renderKey) {
        pinned = { entry, x: cellX, y: cellY };
        cellBg.setFillStyle(COLORS.cellHover);
      }

      cellBg.on('pointerover', () => {
        cellBg.setFillStyle(COLORS.cellHover);
        showTooltip(entry, cellX, cellY);
      });
      cellBg.on('pointerout', () => {
        const stillPinned = pinned !== null && pinned.entry.renderKey === entry.renderKey;
        cellBg.setFillStyle(stillPinned ? COLORS.cellHover : COLORS.cellBg);
        clearTooltip();
        // Restore the pinned tooltip when leaving a non-pinned cell.
        if (pinned !== null) {
          showTooltip(pinned.entry, pinned.x, pinned.y);
        }
      });
      // Click/tap toggles a pinned tooltip so touch users (no hover) can read
      // it. A quick second click on the same equippable cell instead fires the
      // equip intent (ARPG double-click idiom).
      cellBg.on('pointerdown', () => {
        const now = scene.time.now;
        const isDoubleClick =
          lastClickItemKey === entry.renderKey && now - lastClickTime <= DOUBLE_CLICK_MS;
        lastClickTime = now;
        lastClickItemKey = entry.renderKey;

        if (isDoubleClick && config.onEquipItem && canEquipEntry(entry)) {
          // Equipping moves the item out of this cell; drop the pin/tooltip and
          // reset the click tracker so a follow-up click starts fresh.
          pinned = null;
          clearTooltip();
          lastClickItemKey = null;
          lastClickTime = Number.NEGATIVE_INFINITY;
          config.onEquipItem(entry.equipTarget);
          return;
        }

        if (pinned !== null && pinned.entry.renderKey === entry.renderKey) {
          pinned = null;
        } else {
          pinned = { entry, x: cellX, y: cellY };
        }
        clearTooltip();
        showTooltip(entry, cellX, cellY);
        cellBg.setFillStyle(COLORS.cellHover);
      });

      // Item icon: prefer the item's real approved generated sprite (resolved
      // by item id, placeholder-only as a last resort) when Phaser has loaded
      // the texture. When a concept has multiple approved variants, one is
      // chosen deterministically per (item, run). Falls back to the
      // 2-character placeholder text otherwise.
      const generatedEntry = selectGeneratedEntry(entry.itemId);
      const generatedTextureLoaded =
        generatedEntry !== null && scene.textures?.exists(generatedEntry.textureKey) === true;

      let iconObject: Phaser.GameObjects.GameObject;
      if (generatedEntry && generatedTextureLoaded) {
        const iconImage = scene.add.image(cellX, cellY - 6, generatedEntry.textureKey);
        iconImage.setOrigin(0.5, 0.5);
        // Fit the sprite to ~75% of the cell from its ACTUAL source size so the
        // rarity border stays visible — never assume a fixed source size.
        // Approved art ranges from 16×16 placeholders to 64×64 generated
        // sprites; the old hardcoded `/16` blew 64px art up 3× (192px) and
        // overflowed the 64px cell. fitScaleForBox keeps small pixel art crisp
        // (integer upscale) and shrinks higher-resolution art down to fit.
        const iconScale = fitScaleForBox(iconImage.width, iconImage.height, CELL_SIZE * 0.72);
        iconImage.setScale(iconScale);
        iconObject = iconImage;
      } else {
        // Item icon placeholder (first 2 chars of name)
        const iconText = crispText(cellX, cellY - 6, def.name.substring(0, 2).toUpperCase(), {
          fontFamily: FONT_FAMILY,
          fontSize: '16px',
          color: hex(rarityColor),
        });
        iconText.setOrigin(0.5, 0.5);
        iconObject = iconText;
      }

      // Stack count
      if (entry.quantity > 1) {
        const countText = crispText(
          cellX + CELL_SIZE / 2 - 4,
          cellY + CELL_SIZE / 2 - 4,
          `${entry.quantity}`,
          {
            fontFamily: FONT_FAMILY,
            fontSize: '10px',
            color: hex(COLORS.textPrimary),
          },
        );
        countText.setOrigin(1, 1);
        container.add(countText);
        cellObjects.push(countText);
      }

      container.add(cellBg);
      container.add(iconObject);
      cellObjects.push(cellBg, iconObject);
      cellBackgrounds.push(cellBg);
      cellItemIds.push(entry.itemId);
    }

    // Fill trailing cells of the final row with empty-slot backgrounds so the
    // grid always reads as a complete rectangle (no ragged last row) and unused
    // capacity has a clear affordance. Empty cells are decorative only — never
    // pushed to cellBackgrounds/cellItemIds, so automation item indices stay
    // stable.
    const filledCells = Math.min(entries.length, maxVisible);
    const rectCells = Math.min(Math.ceil(filledCells / COLS) * COLS, maxVisible);
    for (let i = filledCells; i < rectCells; i++) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const cellX = snap(gridLeft + col * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2);
      const cellY = snap(gridY + row * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2);
      const emptyCell = scene.add.rectangle(cellX, cellY, CELL_SIZE, CELL_SIZE, COLORS.emptyCellBg);
      emptyCell.setStrokeStyle(BORDER_WIDTH, COLORS.emptyCellBorder);
      container.add(emptyCell);
      cellObjects.push(emptyCell);
      // An inset inner frame gives the empty slot a clear "recessed well"
      // identity that reads unambiguously as unused capacity — more explicit
      // than a single flat placeholder mark.
      const emptyInset = scene.add.rectangle(cellX, cellY, CELL_SIZE - 22, CELL_SIZE - 22);
      emptyInset.setFillStyle(0, 0);
      emptyInset.setStrokeStyle(1, COLORS.emptyCellBorder, 0.9);
      container.add(emptyInset);
      cellObjects.push(emptyInset);
    }

    // Thin divider anchoring the count footer to the grid above it, so the
    // footer reads as part of the panel layout rather than floating loose.
    const footerDivider = scene.add.rectangle(
      gridLeft + gridPixelWidth / 2,
      panelY + panelHeight - PANEL_PADDING - 30,
      gridPixelWidth,
      2,
      COLORS.emptyCellBorder,
      0.7,
    );
    container.add(footerDivider);
    cellObjects.push(footerDivider);

    // Item count footer, left-aligned under the centered grid.
    const countFooter = crispText(
      gridLeft,
      panelY + panelHeight - PANEL_PADDING - 10,
      `${entries.length} item${entries.length !== 1 ? 's' : ''}`,
      {
        fontFamily: FONT_FAMILY,
        fontSize: '12px',
        color: hex(COLORS.textSecondary),
      },
    );
    countFooter.setOrigin(0, 1);
    container.add(countFooter);
    cellObjects.push(countFooter);

    // Re-show (or drop) the pinned tooltip after rebuilding the grid.
    if (pinned !== null) {
      const stillPresent = entries.some((entry) => entry.renderKey === pinned!.entry.renderKey);
      if (stillPresent) {
        showTooltip(pinned.entry, pinned.x, pinned.y);
      } else {
        pinned = null;
      }
    }
  }

  function canEquipEntry(entry: RenderInventoryEntry): boolean {
    return entry.slotIds.length > 0 || isEquippableItem(entry.itemId);
  }

  function showTooltip(entry: RenderInventoryEntry, cellX: number, cellY: number): void {
    clearTooltip();
    // Surface the equip affordance only when a coordinator is listening and the
    // item can actually be equipped.
    const footerHint =
      config.onEquipItem !== undefined && canEquipEntry(entry)
        ? 'DOUBLE-CLICK TO EQUIP'
        : undefined;
    tooltipObjects.push(
      ...renderItemTooltip({
        scene,
        container,
        panelX,
        panelY,
        panelWidth,
        panelHeight,
        anchorX: cellX,
        anchorY: cellY,
        anchorSize: CELL_SIZE,
        def: entry.def,
        quantity: entry.quantity,
        fontFamily: FONT_FAMILY,
        footerHint,
        crispText,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Keyboard input
  // ---------------------------------------------------------------------------

  function handleKeyDown(event: KeyboardEvent): void {
    if (!visible) return;

    if (event.key === 'Backspace') {
      event.preventDefault();
      searchQuery = searchQuery.slice(0, -1);
      updateSearchDisplay();
      renderItems();
    } else if (event.key === 'Escape') {
      // Will be handled by toggle
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      searchQuery += event.key;
      updateSearchDisplay();
      renderItems();
    }
  }

  function updateSearchDisplay(): void {
    if (searchQuery) {
      searchText.setText(searchQuery);
      searchText.setColor(hex(COLORS.textPrimary));
    } else {
      searchText.setText('Type to search...');
      searchText.setColor(hex(COLORS.textSecondary));
    }
  }

  function updateSlotFilterLabel(): void {
    if (externalSlotFilter === null) {
      slotFilterLabel.setText('');
      return;
    }
    slotFilterLabel.setText(`SLOT FILTER: ${getSlotLabel(externalSlotFilter)}`);
  }

  scene.input.keyboard?.on('keydown', handleKeyDown);
  scene.scale.on('resize', applyLayout);

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
    playerEid = findPlayerEid(world);
    currentBag = playerEid >= 0 ? (world.inventories.get(playerEid) ?? null) : null;
    currentWorld = world;
    currentWorldSeed = world.seed | 0;
    if (!visible) {
      return;
    }
    // Only rebuild the grid when the rendered state actually changes. Without
    // this guard the per-frame refresh would destroy/recreate every cell and
    // tooltip, breaking hover (see lastRenderSignature comment above).
    const signature = computeRenderSignature();
    if (signature !== lastRenderSignature) {
      updateSlotFilterLabel();
      renderTabs();
      renderItems();
      lastRenderSignature = signature;
    }
  }

  function computeRenderSignature(): string {
    const entries = buildRenderEntries();
    let signature = [activeTag ?? '*', searchQuery, currentSortBy, externalSlotFilter ?? '*'].join(
      '|',
    );
    for (const entry of entries) {
      // Fold in the *selected* generated icon variant and whether its texture is
      // loaded yet, so the grid re-renders once async sprite warm-loading
      // finishes (the slot contents alone are unchanged, so without this the
      // cells would stay on their text fallback until the next inventory
      // mutation). Selecting via the same path as the icon keeps them in sync.
      const iconEntry = selectGeneratedEntry(entry.itemId);
      const iconReady = iconEntry !== null && scene.textures?.exists(iconEntry.textureKey) === true;
      signature += `;${entry.renderKey}:${entry.quantity}:${entry.itemId}:${
        iconEntry?.textureKey ?? ''
      }:${iconReady ? 1 : 0}`;
    }
    return signature;
  }

  function toggle(world: GameWorld): void {
    visible = !visible;
    container.setVisible(visible);

    if (visible) {
      searchQuery = '';
      applyLayout();
      updateSearchDisplay();
      refresh(world);
    } else {
      clearTooltip();
      pinned = null;
      lastRenderSignature = null;
    }
  }

  return {
    toggle,
    refresh,
    isOpen: () => visible,
    getCellScreenBounds: (index: number): ScreenBounds | null => {
      const cell = cellBackgrounds[index];
      if (!cell) return null;
      const b = cell.getBounds();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    },
    getCellIndexForItem: (itemId: string): number | null => {
      const i = cellItemIds.indexOf(itemId);
      return i >= 0 ? i : null;
    },
    getVisibleItemIds: () => [...cellItemIds],
    isTooltipVisible: () => tooltipObjects.length > 0,
    isTooltipPinned: () => pinned !== null,
    setEquipmentSlotFilter: (slotId: EquipmentSlotId | null) => {
      if (externalSlotFilter === slotId) return;
      externalSlotFilter = slotId;
      lastRenderSignature = null;
      updateSlotFilterLabel();
    },
    getEquipmentSlotFilter: () => externalSlotFilter,
    destroy() {
      scene.input.keyboard?.off('keydown', handleKeyDown);
      scene.scale.off('resize', applyLayout);
      clearTabObjects();
      clearCellObjects();
      clearTooltip();
      container.destroy();
    },
  };
}
