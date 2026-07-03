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
import type { GameWorld } from '../core/world.js';
import { fitScaleForBox, fitUiScale, type ScreenBounds } from './ui-scale.js';
import { getRenderScale } from './render-scale.js';
import { GAME } from '../shared/constants.js';
import type { InventoryBag, InventorySlot, TabPreferences } from '../shared/inventory.js';
import {
  createTabPreferences,
  filterByTag,
  getVisibleTabs,
  search,
  sortSlots,
  type SortField,
} from '../shared/inventory.js';
import { type ItemDef, type ItemTag, RARITY_COLORS, getItemById } from '../shared/items.js';
import {
  emptyGeneratedSpriteRegistry,
  pickGeneratedVariant,
  type GeneratedSpriteEntry,
  type GeneratedSpriteRegistry,
} from '../shared/generated-assets.js';
import { hashStringToSeed } from '../shared/random.js';
import { GENERATED_SPRITE_REGISTRY_KEY } from './generatedAssets/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PANEL_PADDING = 16;
const TAB_HEIGHT = 36;
const TAB_GAP = 4;
const SEARCH_HEIGHT = 36;
const CELL_SIZE = 64;
const CELL_GAP = 4;
const COLS = 5;
const BORDER_WIDTH = 2;
const FONT_FAMILY = 'Segoe UI, Arial, sans-serif';

const COLORS = {
  panelBg: 0x0d0d1a,
  panelBorder: 0x2a2a4a,
  tabBg: 0x1a1a30,
  tabActive: 0x3a3a6a,
  tabText: 0xc9d4ff,
  tabTextActive: 0xffffff,
  searchBg: 0x111122,
  searchBorder: 0x333355,
  cellBg: 0x15152a,
  cellHover: 0x22224a,
  textPrimary: 0xf8fafc,
  textSecondary: 0x9ca3af,
  tooltipBg: 0x0a0a16,
  tooltipBorder: 0x444466,
} as const;

// ---------------------------------------------------------------------------
// InventoryUI
// ---------------------------------------------------------------------------

export interface InventoryUIConfig {
  /** Width of the panel. Default: auto-calculated from COLS. */
  width?: number;
  /** Height of the panel. Default: 480. */
  height?: number;
}

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
  /** Test/automation affordance: true while a hover/pin tooltip is rendered. */
  isTooltipVisible(): boolean;
  /** Test/automation affordance: true while a tooltip is pinned (click/tap). */
  isTooltipPinned(): boolean;
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

  const basePanelWidth = COLS * (CELL_SIZE + CELL_GAP) + CELL_GAP + PANEL_PADDING * 2;
  const panelWidth = config.width ?? Math.max(basePanelWidth, 520);
  const panelHeight = config.height ?? 480;

  // Responsive UI: lay the panel out in a "virtual" viewport (real size ÷
  // uiScale) and scale the whole container up by uiScale so the inventory grid,
  // tabs and text grow on small screens while staying centred and on-canvas.
  let uiScale = fitUiScale(scene, panelWidth, panelHeight);
  textResolution = Math.max(1, Math.round(baseResolution * uiScale));
  const viewWidth = (): number => GAME.WIDTH / uiScale;
  const viewHeight = (): number => GAME.HEIGHT / uiScale;

  let visible = false;
  let activeTag: ItemTag | null = null;
  let searchQuery = '';
  let currentBag: InventoryBag | null = null;
  let currentSortBy: SortField = 'rarity';
  const tabPrefs: TabPreferences = createTabPreferences();
  let playerEid = -1;

  // Signature of the last rendered grid state. The scene calls refresh() every
  // frame while the panel is open; re-running renderItems() each frame would
  // destroy and recreate every cell (and any open tooltip), which breaks hover
  // because Phaser only fires `pointerover` on pointer movement — not when a
  // fresh object appears under a stationary cursor. Gating re-render behind this
  // signature keeps cells (and the tooltip) alive between content changes.
  let lastRenderSignature: string | null = null;

  // Currently "pinned" tooltip (via click/tap). Stays visible after the pointer
  // leaves the cell until the item is clicked again or another item is clicked.
  let pinned: { def: ItemDef; slot: InventorySlot; x: number; y: number } | null = null;

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
   * Choose which approved generated-sprite variant to render for an item.
   * Deterministic per (itemId, run): the same item keeps the same variant for
   * the whole run (no per-frame flicker) but may differ across runs/items.
   * Returns null when the item has no approved generated sprite.
   */
  const selectGeneratedEntry = (itemId: string): GeneratedSpriteEntry | null =>
    pickGeneratedVariant(
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
    0.95,
  );
  bg.setStrokeStyle(2, COLORS.panelBorder);
  container.add(bg);

  // Title
  const title = crispText(panelX + PANEL_PADDING, panelY + PANEL_PADDING, 'INVENTORY', {
    fontFamily: FONT_FAMILY,
    fontSize: '20px',
    color: '#f8fafc',
  });
  container.add(title);

  // Sort button
  const sortBtn = scene.add
    .text(snap(panelX + panelWidth - PANEL_PADDING), snap(panelY + PANEL_PADDING), '⇅ Rarity', {
      fontFamily: FONT_FAMILY,
      fontSize: '14px',
      color: '#9ca3af',
    })
    .setOrigin(1, 0)
    .setInteractive({ useHandCursor: true });

  sortBtn.on('pointerdown', () => {
    const sortFields: SortField[] = ['rarity', 'name', 'quantity'];
    const idx = sortFields.indexOf(currentSortBy);
    currentSortBy = sortFields[(idx + 1) % sortFields.length]!;
    sortBtn.setText(`⇅ ${currentSortBy.charAt(0).toUpperCase() + currentSortBy.slice(1)}`);
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
    panelX + PANEL_PADDING + 8,
    searchY + SEARCH_HEIGHT / 2,
    '🔍 Type to search...',
    {
      fontFamily: FONT_FAMILY,
      fontSize: '14px',
      color: '#666688',
    },
  );
  searchText.setOrigin(0, 0.5);
  container.add(searchText);

  function applyLayout(): void {
    uiScale = fitUiScale(scene, panelWidth, panelHeight);
    textResolution = Math.max(1, Math.round(baseResolution * uiScale));
    container.setScale(uiScale);
    panelX = snap((viewWidth() - panelWidth) / 2);
    panelY = snap((viewHeight() - panelHeight) / 2);
    tabY = snap(panelY + PANEL_PADDING + 28);
    searchY = snap(tabY + TAB_HEIGHT + TAB_GAP);
    gridY = snap(searchY + SEARCH_HEIGHT + TAB_GAP + 4);
    gridHeight = panelY + panelHeight - gridY - PANEL_PADDING;

    bg.setPosition(panelX + panelWidth / 2, panelY + panelHeight / 2);
    title.setPosition(panelX + PANEL_PADDING, panelY + PANEL_PADDING).setResolution(textResolution);
    sortBtn
      .setPosition(panelX + panelWidth - PANEL_PADDING, panelY + PANEL_PADDING)
      .setResolution(textResolution);
    searchBg.setPosition(panelX + panelWidth / 2, searchY + SEARCH_HEIGHT / 2);
    searchText
      .setPosition(panelX + PANEL_PADDING + 8, searchY + SEARCH_HEIGHT / 2)
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

    const tabs = getVisibleTabs(currentBag, tabPrefs);
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
      tabBg.setStrokeStyle(1, isActive ? 0x5555aa : COLORS.panelBorder);
      tabBg.setInteractive({ useHandCursor: true });
      tabBg.on('pointerdown', () => {
        activeTag = tag;
        renderTabs();
        renderItems();
      });

      const tabLabel = crispText(tabX + tabWidth / 2, tabY + TAB_HEIGHT / 2, displayLabel, {
        fontFamily: FONT_FAMILY,
        fontSize: '13px',
        color: isActive ? '#ffffff' : '#c9d4ff',
      });
      tabLabel.setOrigin(0.5, 0.5);

      container.add(tabBg);
      container.add(tabLabel);
      tabObjects.push(tabBg, tabLabel);

      tabX += tabWidth + TAB_GAP;
    }
  }

  function getFilteredSlots(): InventorySlot[] {
    if (!currentBag) return [];

    let slots: InventorySlot[];

    if (searchQuery) {
      slots = search(currentBag, searchQuery);
    } else if (activeTag) {
      slots = filterByTag(currentBag, activeTag);
    } else {
      slots = currentBag.slots;
    }

    // Sort
    const tempBag = { slots };
    return sortSlots(tempBag, currentSortBy);
  }

  function renderItems(): void {
    clearCellObjects();
    clearTooltip();
    if (!currentBag) return;

    const slots = getFilteredSlots();
    const maxRows = Math.floor(gridHeight / (CELL_SIZE + CELL_GAP));
    const maxVisible = maxRows * COLS;

    for (let i = 0; i < Math.min(slots.length, maxVisible); i++) {
      const slot = slots[i]!;
      const def = getItemById(slot.itemId);
      if (!def) continue;

      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const cellX = snap(panelX + PANEL_PADDING + col * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2);
      const cellY = snap(gridY + row * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2);

      const rarityColor = RARITY_COLORS[def.rarity] ?? 0x9e9e9e;

      // Cell background
      const cellBg = scene.add.rectangle(cellX, cellY, CELL_SIZE, CELL_SIZE, COLORS.cellBg);
      cellBg.setStrokeStyle(BORDER_WIDTH, rarityColor);
      cellBg.setInteractive({ useHandCursor: true });

      // Keep the pinned cell highlighted and its coordinates fresh across
      // re-renders (item order/position can shift when the bag changes).
      if (pinned !== null && pinned.slot.itemId === slot.itemId) {
        pinned = { def, slot, x: cellX, y: cellY };
        cellBg.setFillStyle(COLORS.cellHover);
      }

      cellBg.on('pointerover', () => {
        cellBg.setFillStyle(COLORS.cellHover);
        showTooltip(def, slot, cellX, cellY);
      });
      cellBg.on('pointerout', () => {
        const stillPinned = pinned !== null && pinned.slot.itemId === slot.itemId;
        cellBg.setFillStyle(stillPinned ? COLORS.cellHover : COLORS.cellBg);
        clearTooltip();
        // Restore the pinned tooltip when leaving a non-pinned cell.
        if (pinned !== null) {
          showTooltip(pinned.def, pinned.slot, pinned.x, pinned.y);
        }
      });
      // Click/tap toggles a pinned tooltip so touch users (no hover) can read it.
      cellBg.on('pointerdown', () => {
        if (pinned !== null && pinned.slot.itemId === slot.itemId) {
          pinned = null;
        } else {
          pinned = { def, slot, x: cellX, y: cellY };
        }
        clearTooltip();
        showTooltip(def, slot, cellX, cellY);
        cellBg.setFillStyle(COLORS.cellHover);
      });

      // Item icon: prefer the approved generated sprite when the item's
      // icon (or id when no override) matches a manifest entry's briefId and
      // Phaser has loaded the texture. When a brief has multiple approved
      // variants, one is chosen deterministically per (item, run). Falls back
      // to the 2-character placeholder otherwise.
      const generatedEntry = selectGeneratedEntry(def.icon);
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
        const iconScale = fitScaleForBox(iconImage.width, iconImage.height, CELL_SIZE * 0.75);
        iconImage.setScale(iconScale);
        iconObject = iconImage;
      } else {
        // Item icon placeholder (first 2 chars of name)
        const iconText = crispText(cellX, cellY - 6, def.name.substring(0, 2).toUpperCase(), {
          fontFamily: FONT_FAMILY,
          fontSize: '16px',
          color: `#${rarityColor.toString(16).padStart(6, '0')}`,
        });
        iconText.setOrigin(0.5, 0.5);
        iconObject = iconText;
      }

      // Stack count
      if (slot.quantity > 1) {
        const countText = crispText(
          cellX + CELL_SIZE / 2 - 4,
          cellY + CELL_SIZE / 2 - 4,
          `${slot.quantity}`,
          {
            fontFamily: FONT_FAMILY,
            fontSize: '12px',
            color: '#ffffff',
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
    }

    // Item count footer
    const countFooter = crispText(
      panelX + PANEL_PADDING,
      panelY + panelHeight - PANEL_PADDING,
      `${slots.length} item${slots.length !== 1 ? 's' : ''}`,
      {
        fontFamily: FONT_FAMILY,
        fontSize: '12px',
        color: '#666688',
      },
    );
    countFooter.setOrigin(0, 1);
    container.add(countFooter);
    cellObjects.push(countFooter);

    // Re-show (or drop) the pinned tooltip after rebuilding the grid.
    if (pinned !== null) {
      const stillPresent = slots.some((s) => s.itemId === pinned!.slot.itemId);
      if (stillPresent) {
        showTooltip(pinned.def, pinned.slot, pinned.x, pinned.y);
      } else {
        pinned = null;
      }
    }
  }

  function showTooltip(def: ItemDef, slot: InventorySlot, cellX: number, cellY: number): void {
    clearTooltip();

    const tooltipWidth = 200;
    const tooltipHeight = 110;
    const tx = snap(Math.min(cellX + CELL_SIZE / 2 + 8, panelX + panelWidth - tooltipWidth - 8));
    const ty = snap(Math.max(cellY - tooltipHeight / 2, panelY + 8));

    const tooltipBg = scene.add.rectangle(
      tx + tooltipWidth / 2,
      ty + tooltipHeight / 2,
      tooltipWidth,
      tooltipHeight,
      COLORS.tooltipBg,
      0.95,
    );
    tooltipBg.setStrokeStyle(1, COLORS.tooltipBorder);

    const rarityColor = RARITY_COLORS[def.rarity] ?? 0x9e9e9e;
    const nameText = crispText(tx + 8, ty + 8, def.name, {
      fontFamily: FONT_FAMILY,
      fontSize: '15px',
      color: `#${rarityColor.toString(16).padStart(6, '0')}`,
      wordWrap: { width: tooltipWidth - 16 },
    });

    const descText = crispText(tx + 8, ty + 26, def.description, {
      fontFamily: FONT_FAMILY,
      fontSize: '12px',
      color: '#9ca3af',
      wordWrap: { width: tooltipWidth - 16 },
    });

    const metaText = crispText(
      tx + 8,
      ty + tooltipHeight - 16,
      `${def.rarity} · x${slot.quantity} · [${def.tags.join(', ')}]`,
      {
        fontFamily: FONT_FAMILY,
        fontSize: '11px',
        color: '#666688',
      },
    );

    container.add(tooltipBg);
    container.add(nameText);
    container.add(descText);
    container.add(metaText);
    tooltipObjects.push(tooltipBg, nameText, descText, metaText);
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
      searchText.setText(`🔍 ${searchQuery}`);
      searchText.setColor('#c9d4ff');
    } else {
      searchText.setText('🔍 Type to search...');
      searchText.setColor('#666688');
    }
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
    currentWorldSeed = world.seed | 0;
    if (!visible) {
      return;
    }
    // Only rebuild the grid when the rendered state actually changes. Without
    // this guard the per-frame refresh would destroy/recreate every cell and
    // tooltip, breaking hover (see lastRenderSignature comment above).
    const signature = computeRenderSignature();
    if (signature !== lastRenderSignature) {
      renderTabs();
      renderItems();
      lastRenderSignature = signature;
    }
  }

  function computeRenderSignature(): string {
    const slots = currentBag?.slots ?? [];
    let signature = `${activeTag ?? '*'}|${searchQuery}|${currentSortBy}`;
    for (const slot of slots) {
      // Fold in the *selected* generated icon variant and whether its texture is
      // loaded yet, so the grid re-renders once async sprite warm-loading
      // finishes (the slot contents alone are unchanged, so without this the
      // cells would stay on their text fallback until the next inventory
      // mutation). Selecting via the same path as the icon keeps them in sync.
      const iconBriefId = getItemById(slot.itemId)?.icon ?? slot.itemId;
      const entry = selectGeneratedEntry(iconBriefId);
      const iconReady = entry !== null && scene.textures?.exists(entry.textureKey) === true;
      signature += `;${slot.itemId}:${slot.quantity}:${entry?.textureKey ?? ''}:${iconReady ? 1 : 0}`;
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
    isTooltipVisible: () => tooltipObjects.length > 0,
    isTooltipPinned: () => pinned !== null,
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
