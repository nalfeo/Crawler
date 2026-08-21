/**
 * UI Probe Lab — an e2e/automation harness that mounts the *real* canvas UI
 * components (InventoryUI, EquipmentUI, HudMinimap, LevelUpUI) over a synthetic
 * safe-room world and exposes a typed `window.__uiProbe` automation API.
 *
 * Why this lab exists
 * -------------------
 * These components render to the Phaser WebGL canvas, not the DOM, so a
 * Playwright test cannot query them with `data-testid` selectors. This lab is
 * the instrumentation seam: it opens each surface on demand and reports the
 * world-space hit-rects of the controls that mobile users tap (the minimap
 * close button, the level-up −/+ buttons, inventory cells) plus small pieces of
 * observable state (open flags, tooltip visible/pinned, effective Charisma).
 * The `tests/e2e/inventory-flow.test.ts` and `tests/e2e/mobile-hit-targets.test.ts`
 * suites drive this API. Labs are unrestricted, so this test wiring stays out of
 * the shipped engine layer.
 *
 * Uses `Phaser.Scale.FIT` (mirroring the shipped game) so the scene keeps its
 * 1280×720 design space — the probe reports stable design-space hit-rects while
 * the canvas is letterbox-scaled to the viewport, which lets the mobile suite
 * exercise both portrait and landscape without the controls leaving the canvas.
 */
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { createGameWorld, spawnPlayer, type GameWorld } from '../../core/index.js';
import { FloorMap } from '../../core/map/FloorMap.js';
import { TileMap } from '../../core/map/TileMap.js';
import { RoomGraph } from '../../core/map/RoomGraph.js';
import { BiomeType, RoomRole, TerrainType, TilePresets } from '../../shared/map-types.js';
import {
  equip,
  equipFromBag,
  addGeneratedEquipmentToBag,
  getEffectiveStats,
  getEquipmentState,
  initializeBaseStats,
} from '../../core/systems/equipmentSystem.js';
import { createGeneratedEquipmentInstance } from '../../core/generated-equipment-registry.js';
import { createInventoryUI } from '../../engine/InventoryUI.js';
import { createEquipmentUI } from '../../engine/EquipmentUI.js';
import type { EquipmentTextRasterMetadata, EquipmentTextRun } from '../../engine/EquipmentUI.js';
import { createHudMinimap } from '../../engine/HudMinimap.js';
import { createLevelUpUI } from '../../engine/LevelUpUI.js';
import type { ScreenBounds } from '../../engine/ui-scale.js';
import {
  GENERATED_SPRITE_REGISTRY_KEY,
  fetchGeneratedSpriteRegistry,
  preloadGeneratedSprites,
} from '../../engine/generatedAssets/index.js';
import { buildGeneratedSpriteRegistry } from '../../shared/generated-assets.js';
import { getEquipmentDefForItem, MERCHANTS_CHARM_DEF } from '../../shared/equipmentDefs.js';
import equipmentDefsTestSeams from '../../shared/equipmentDefs.test-seams.js';
import { GAME } from '../../shared/constants.js';
import {
  addItem,
  createInventoryBag,
  type GeneratedEquipmentInventoryEntry,
} from '../../shared/inventory.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  type GeneratedEquipmentInstanceKey,
} from '../../shared/generated-equipment-types.js';
import { PIXELS_PER_FOOT, pxToFt } from '../../shared/units.js';
import { PRIMARY_STATS, type PrimaryStatId } from '../../shared/stats.js';
import { SLOT_REGISTRY, type EquipmentSlotId } from '../../shared/equipment-slots.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const LAB_ID = 'ui-probe-lab';
const SCENE_KEY = 'UiProbeScene';
const LAB_SEED = 4242;

/** On-screen grid pitch in canvas pixels (this lab reasons in CSS/canvas px). */
const TILE = 64;
const GW = Math.ceil(GAME.WIDTH / TILE);
const GH = Math.ceil(GAME.HEIGHT / TILE);

/** Texture key for the synthetic inventory icon (guarantees a sprite renders). */
const PROBE_ICON_TEXTURE = 'ui_probe_item_icon';
const PROBE_THEMED_ICON_TEXTURE = 'ui_probe_item_icon_themed';
const PROBE_BAT_TEXTURE = 'baseball-bat-var-0';

/** Bounds of a stat row's −/+ controls, in world/scene coordinates. */
export interface StatControlBounds {
  readonly stat: PrimaryStatId;
  readonly minus: ScreenBounds;
  readonly plus: ScreenBounds;
}

/**
 * Automation surface attached to `window.__uiProbe` by this lab. Every geometry
 * value is in Phaser scene/world coordinates; e2e callers convert to CSS pixels
 * via the canvas bounding rect and {@link UiProbeApi.getGameSize}.
 */
export interface UiProbeApi {
  /** True once the scene has finished building all UI surfaces. */
  ready(): boolean;
  /** Current Phaser game size (scene coordinate space). */
  getGameSize(): { width: number; height: number };

  // Inventory ---------------------------------------------------------------
  openInventory(): void;
  closeOverlays(): void;
  isInventoryOpen(): boolean;
  getInventoryCellBounds(index: number): ScreenBounds | null;
  /** Render-order index of the first visible cell holding `itemId`, or null. */
  getInventoryCellIndexForItem(itemId: string): number | null;
  isTooltipVisible(): boolean;
  isTooltipPinned(): boolean;

  // Equipment ---------------------------------------------------------------
  openEquipment(): void;
  openEquipmentOnly(): void;
  useThemedEquipmentReviewSprites(): void;
  /**
   * Swap the synthetic probe registry for the REAL generated-sprite manifest,
   * loading each entry's PNG through the shipped boot path
   * ({@link fetchGeneratedSpriteRegistry} + {@link preloadGeneratedSprites}).
   * Lets visual review observe real approved/placeholder art, not just the
   * themed synthetic icon. Resolves once textures finish loading.
   */
  useRealGeneratedSprites(): Promise<void>;
  isEquipmentOpen(): boolean;
  getEquipmentPanelBounds(): ScreenBounds;
  getEquipmentHeaderBounds(): ScreenBounds | null;
  getEquipmentHeaderFrameBounds(): ScreenBounds | null;
  getEquipmentDollBounds(): ScreenBounds | null;
  getEquipmentSlotBounds(slotId: EquipmentSlotId): ScreenBounds | null;
  getEquipmentSlotIconBounds(slotId: EquipmentSlotId): ScreenBounds | null;
  getEquipmentEmptySlotCue(slotId: EquipmentSlotId): EquipmentSlotId | null;
  getEquipmentTooltipBounds(): ScreenBounds | null;
  isEquipmentTooltipVisible(): boolean;
  isEquipmentTooltipTopmost(): boolean;
  /** Render the same inspector content as hovering a paper-doll slot. */
  previewEquipmentSlot(slotId: EquipmentSlotId): boolean;
  selectEquipmentSlot(slotId: EquipmentSlotId | null): boolean;
  getEquipmentSlotFilter(): EquipmentSlotId | null;
  getInventorySlotFilter(): EquipmentSlotId | null;
  // Integrated equippable-bag column (inside the equipment panel) -----------
  /** Item ids currently listed in the equipment panel's bag column, in order. */
  getEquipmentBagItemIds(): string[];
  /** Screen bounds of the bag cell at `index` (aligned to getEquipmentBagItemIds). */
  getEquipmentBagCellBounds(index: number): ScreenBounds | null;
  /** Screen bounds of the whole integrated bag column (for wheel targeting). */
  getEquipmentBagColumnBounds(): ScreenBounds | null;
  /** Scroll the integrated bag column by whole rows (programmatic seam for wheel). */
  scrollEquipmentBag(rows: number): void;
  /** Current top row of the integrated bag column. */
  getEquipmentBagScrollRow(): number;
  /** Maximum scrollable row of the integrated bag column (0 when it fits). */
  getEquipmentBagMaxScrollRow(): number;
  /** Replace the bag with `count` equippable slots to force the column to overflow. */
  seedOverflowBag(count: number): void;
  /** Deterministically show/clear the equip-delta preview for a bag item. */
  previewEquipmentBagItem(itemId: string | null): void;
  /** Show the comparison preview for a generated bag item. */
  previewGeneratedEquipmentBagItem(instanceKey: GeneratedEquipmentInstanceKey | null): void;
  /** Add a deterministic, stronger chest candidate for comparison captures. */
  addGeneratedChestReplacement(): GeneratedEquipmentInstanceKey | null;
  /** Equip a bag item straight from the integrated bag column. */
  equipFromEquipmentBag(itemId: string): boolean;
  /** Unequip whatever is in `slotId`, returning it to the bag. */
  unequipEquipmentSlot(slotId: EquipmentSlotId): void;
  /** Screen bounds of the stats column background. */
  getEquipmentStatsBounds(): ScreenBounds | null;
  /** Screen bounds of the inspector strip background. */
  getEquipmentInspectorBounds(): ScreenBounds | null;
  /** Every visible text run in the equipment panel, tagged by owning region. */
  getEquipmentTextRuns(): EquipmentTextRun[];
  /** Resolved equipment-font and pixel-alignment state from the live Phaser UI. */
  getEquipmentTextRasterMetadata(): EquipmentTextRasterMetadata | null;
  /** Paper-doll slots the active preview would fill (empty when no preview). */
  getEquipmentPreviewTargetSlots(): EquipmentSlotId[];
  /** Screen bounds of the preview target marker drawn over `slotId`. */
  getEquipmentTargetMarkerBounds(slotId: EquipmentSlotId): ScreenBounds | null;
  /** Effective Charisma of the player (base + equipment bonuses). */
  getCharisma(): number;
  /** Equip the merchant's charm via the real equipment system (safe-room). */
  equipCharm(): boolean;
  /** Equip a bag item by slug via the real equip-from-bag orchestration. */
  equipInventoryItem(itemId: string): boolean;
  /** Re-add one of every placeholder gear item to the bag. */
  seedAllGear(): void;
  /** Slot ids currently filled on the paper-doll (deduped, in registry order). */
  getEquippedSlotIds(): EquipmentSlotId[];

  // Minimap -----------------------------------------------------------------
  openMinimapOverlay(): void;
  isMinimapOverlayOpen(): boolean;
  getMinimapCloseBounds(): ScreenBounds | null;
  /** Docked radar bounds when visible, or null when hidden by an open panel. */
  getMinimapDockedBounds(): ScreenBounds | null;

  // Level-up ----------------------------------------------------------------
  openLevelUp(points: number): void;
  isLevelUpOpen(): boolean;
  getStatControlBounds(): StatControlBounds[];
  getDraftAllocation(stat: PrimaryStatId): number;
  getRemainingPoints(): number;
}

/** Builds a revealed single-room safe floor so the minimap overlay has terrain. */
function buildProbeFloorMap(): FloorMap {
  const cfg = {
    widthTiles: GW,
    heightTiles: GH,
    tileSizeFt: TILE / PIXELS_PER_FOOT,
    biome: BiomeType.DUNGEON as BiomeType,
    seed: LAB_SEED,
    roomWidthRange: [4, 18] as [number, number],
    roomHeightRange: [4, 10] as [number, number],
    maxRooms: 1,
    floorDensity: 1,
  };

  const tileMap = new TileMap(GW, GH);
  const terrain = new Uint8Array(GW * GH);
  for (let r = 0; r < GH; r += 1) {
    for (let c = 0; c < GW; c += 1) {
      const idx = r * GW + c;
      const isBorder = c === 0 || r === 0 || c === GW - 1 || r === GH - 1;
      if (isBorder) {
        tileMap.flags[idx] = TilePresets.WALL;
        terrain[idx] = TerrainType.STONE_WALL;
      } else {
        tileMap.flags[idx] = TilePresets.FLOOR;
        terrain[idx] = TerrainType.SAFE_ROOM_FLOOR;
      }
    }
  }

  const graph = new RoomGraph();
  graph.add({ x: 1, y: 1, width: GW - 2, height: GH - 2 }, [], [], RoomRole.SAFE);

  const map = new FloorMap(cfg, tileMap, graph, terrain, {
    x: Math.floor(GW / 2),
    y: Math.floor(GH / 2),
  });
  map.revealAll();
  return map;
}

/** Synthetic generated-sprite registry mapping the charm to a baked texture. */
function buildProbeSpriteRegistry(
  textureKey: string = PROBE_ICON_TEXTURE,
): ReturnType<typeof buildGeneratedSpriteRegistry> {
  return buildGeneratedSpriteRegistry({
    version: 1,
    entries: {
      [PROBE_BAT_TEXTURE]: {
        briefId: 'baseball-bat',
        spriteName: PROBE_BAT_TEXTURE,
        assetPath: 'generated/baseball-bat-var-0.png',
        approvedAt: '2026-06-30T04:49:00.000Z',
        sourceRun: 'ui-probe-lab',
        variantIndex: 0,
        anchor: null,
        sensorScore: '1',
        judgeScore: null,
      },
      // The manifest map KEY becomes the registry `textureKey`, so it must be
      // the baked Phaser texture key. `briefId` stays the item id so the
      // InventoryUI lookup by `def.id` still resolves this entry.
      [textureKey]: {
        briefId: MERCHANTS_CHARM_DEF.id,
        spriteName: textureKey,
        assetPath: 'assets/generated/ui-probe-icon.png',
        approvedAt: '2026-01-01T00:00:00.000Z',
        sourceRun: 'ui-probe-lab',
        variantIndex: 0,
        anchor: null,
        sensorScore: '1',
        judgeScore: null,
      },
    },
  });
}

function emptyCoreStats(): Record<PrimaryStatId, number> {
  const stats = {} as Record<PrimaryStatId, number>;
  for (const stat of PRIMARY_STATS) {
    stats[stat] = 0;
  }
  return stats;
}

function createUiProbeLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }
  const labGui: GUI = gui;

  const root = document.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.background = '#05050a';

  const gameHost = document.createElement('div');
  gameHost.style.width = '100%';
  gameHost.style.height = '100%';
  root.append(gameHost);
  canvasHost.append(root);

  const hint = document.createElement('p');
  hint.textContent =
    'Automation harness for inventory + mobile e2e tests. Use the buttons to open each UI surface; tests drive window.__uiProbe.';
  hint.style.marginTop = '12px';
  hint.style.color = '#7ee0ff';
  hint.style.lineHeight = '1.6';
  controls.append(hint);

  const probeWindow = window as unknown as { __uiProbe?: UiProbeApi };

  class UiProbeScene extends Phaser.Scene {
    private world!: GameWorld;

    private playerEid = -1;

    private inventoryUI?: ReturnType<typeof createInventoryUI>;

    private equipmentUI?: ReturnType<typeof createEquipmentUI>;

    private minimap?: ReturnType<typeof createHudMinimap>;

    // Mirrors MainGameScene: hide the minimap while a full-screen character
    // panel is open so it never punches through the wide equipment panel.
    private hudHiddenForPanel = false;

    private levelUpUI?: ReturnType<typeof createLevelUpUI>;

    private built = false;

    constructor() {
      super({ key: SCENE_KEY });
    }

    preload(): void {
      if (!this.textures.exists(PROBE_BAT_TEXTURE)) {
        this.load.image(PROBE_BAT_TEXTURE, 'assets/generated/baseball-bat-var-0.png');
      }
    }

    create(): void {
      this.cameras.main.setBackgroundColor('#05050a');

      // Bake the synthetic inventory icon so at least one cell renders a sprite
      // (deterministic, independent of the real generated-sprite manifest). Baked
      // at 64×64 — the real approved-art resolution (e.g. classified-dossier-v1),
      // larger than the ~48px cell target — so the e2e exercises the "resize
      // higher-resolution art down to fit the cell" path, not just 1:1 icons.
      if (!this.textures.exists(PROBE_ICON_TEXTURE)) {
        const g = this.add.graphics();
        g.fillStyle(0xff2fd0, 1);
        g.fillRect(0, 0, 64, 64);
        g.fillStyle(0xffffff, 1);
        g.fillRect(20, 20, 24, 24);
        g.generateTexture(PROBE_ICON_TEXTURE, 64, 64);
        g.destroy();
      }
      if (!this.textures.exists(PROBE_THEMED_ICON_TEXTURE)) {
        const g = this.add.graphics();
        g.fillStyle(0x3a2814, 1);
        g.fillRect(0, 0, 64, 64);
        g.fillStyle(0xc18f3a, 1);
        g.fillRect(8, 8, 48, 48);
        g.fillStyle(0x2a180b, 1);
        g.fillRect(18, 14, 28, 36);
        g.fillStyle(0xf4dfaa, 1);
        g.fillRect(28, 18, 8, 16);
        g.generateTexture(PROBE_THEMED_ICON_TEXTURE, 64, 64);
        g.destroy();
      }
      this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, buildProbeSpriteRegistry());

      // Synthetic safe-room world: equipment changes require a safe context.
      this.world = createGameWorld({
        seed: LAB_SEED,
        generatedEquipmentRunKey: 'ui-probe-lab-visual-review',
      });
      this.world.floor = 1;
      this.world.state = 'safe_room';
      this.world.floorMap = buildProbeFloorMap();
      // Spawn at the room centre in FEET (pxToFt of the canvas centre) so the
      // minimap dot lands mid-map; tileSizeFt = TILE/PIXELS_PER_FOOT.
      this.playerEid = spawnPlayer(this.world, pxToFt(GAME.WIDTH / 2), pxToFt(GAME.HEIGHT / 2));
      initializeBaseStats(this.world, this.playerEid);
      const probeBatDef = getEquipmentDefForItem('bone-club');
      if (!probeBatDef) {
        throw new Error('ui-probe-lab expected bone-club equipment def to exist');
      }
      equip(this.world, this.playerEid, probeBatDef, { force: true });

      const bag = this.world.inventories.get(this.playerEid);
      if (bag) {
        addItem(bag, MERCHANTS_CHARM_DEF.id, 1);
        // Seed placeholder gear for every non-weapon slot so the paper-doll is
        // fully fillable and the double-click equip flow is exercisable across
        // all 18 slots directly in the lab.
        for (const gearId of equipmentDefsTestSeams.GEAR_ITEM_IDS) {
          addItem(bag, gearId, 1);
        }
      }

      this.inventoryUI = createInventoryUI(this, {
        // Double-clicking an equippable inventory cell routes through the real
        // core orchestration (swap + atomic rollback), then both panes refresh.
        onEquipItem: (item) => this.equipInventoryItem(item),
      });
      this.equipmentUI = createEquipmentUI(this, {
        onSlotFilterChange: (slotId) => this.inventoryUI?.setEquipmentSlotFilter(slotId),
        onInventoryChanged: () => this.inventoryUI?.refresh(this.world),
      });
      this.minimap = createHudMinimap(this);
      this.levelUpUI = createLevelUpUI(this, { onConfirm: () => undefined });

      this.minimap.sync(this.world, this.playerEid);

      this.attachProbe();
      this.installGuiControls();

      this.events.once('shutdown', () => {
        if (probeWindow.__uiProbe) {
          delete probeWindow.__uiProbe;
        }
        this.inventoryUI?.destroy();
        this.equipmentUI?.destroy();
        this.minimap?.destroy();
        this.levelUpUI?.destroy();
        this.inventoryUI = undefined;
        this.equipmentUI = undefined;
        this.minimap = undefined;
        this.levelUpUI = undefined;
      });

      this.built = true;
    }

    update(): void {
      if (!this.built) return;
      // Hide the docked minimap while a character panel is open (mirrors
      // MainGameScene). Skip minimap.sync() while hidden, otherwise it re-shows
      // the radar every frame.
      const panelOpen =
        (this.inventoryUI?.isOpen() ?? false) || (this.equipmentUI?.isOpen() ?? false);
      if (panelOpen !== this.hudHiddenForPanel) {
        this.hudHiddenForPanel = panelOpen;
        this.minimap?.setHudVisible(!panelOpen);
      }
      if (this.inventoryUI?.isOpen()) {
        this.inventoryUI.refresh(this.world);
      }
      if (this.equipmentUI?.isOpen()) {
        this.equipmentUI.refresh(this.world);
      }
      if (!panelOpen) {
        this.minimap?.sync(this.world, this.playerEid);
      }
    }

    private closeOverlays(): void {
      if (this.inventoryUI?.isOpen()) this.inventoryUI.toggle(this.world);
      if (this.equipmentUI?.isOpen()) this.equipmentUI.toggle(this.world);
      if (this.minimap?.isOverlayOpen()) this.minimap.toggle();
      if (this.levelUpUI?.isOpen()) this.levelUpUI.close();
    }

    /** Equip a bag item through the real core orchestration and refresh panes. */
    private equipInventoryItem(item: string | GeneratedEquipmentInventoryEntry): boolean {
      const result = equipFromBag(this.world, this.playerEid, item);
      if (result.ok) {
        this.inventoryUI?.refresh(this.world);
        this.equipmentUI?.refresh(this.world);
      }
      return result.ok;
    }

    /** Re-add one of every placeholder gear item (top-up after equipping). */
    private seedAllGear(): void {
      const bag = this.world.inventories.get(this.playerEid);
      if (!bag) return;
      for (const gearId of equipmentDefsTestSeams.GEAR_ITEM_IDS) {
        addItem(bag, gearId, 1);
      }
      this.inventoryUI?.refresh(this.world);
    }

    private addGeneratedChestReplacement(): GeneratedEquipmentInstanceKey | null {
      const instance = createGeneratedEquipmentInstance(this.world, {
        baseId: 'armor.ui-probe-chain-hauberk',
        itemLevel: 1,
        rarity: 'common',
        enhancementLevel: 0,
        resolvedEffects: [],
        frozen: {
          schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
          displayName: 'Runed Chain Hauberk',
          artKey: 'equipment/ui-probe-chain-hauberk',
          slots: ['chest'],
          tags: ['armor'],
          weightLb: 14,
          statBonuses: { armor: 6, constitution: 2 },
          abilityGrants: [],
          passiveGrants: [],
          activeWeaponSnapshot: null,
        },
      });
      if (!addGeneratedEquipmentToBag(this.world, this.playerEid, instance.instanceId).ok)
        return null;
      this.equipmentUI?.refresh(this.world);
      return instance.instanceId;
    }

    /**
     * Replace the bag contents with exactly `count` equippable slots so the
     * integrated bag column overflows its visible rows. Each pushed slot is a
     * distinct cell (filterEquippable keeps one entry per slot), so this is a
     * deterministic way to reach the scroll path.
     */
    private seedOverflowBag(count: number): void {
      const currentBag = this.world.inventories.get(this.playerEid);
      if (!currentBag) return;
      const bag = createInventoryBag();
      if (currentBag.generatedEquipmentCapacity !== undefined) {
        bag.generatedEquipmentCapacity = currentBag.generatedEquipmentCapacity;
      }
      const gearId = equipmentDefsTestSeams.GEAR_ITEM_IDS[0]!;
      for (let i = 0; i < count; i += 1) {
        addItem(bag, gearId, 1);
      }
      this.world.inventories.set(this.playerEid, bag);
      this.inventoryUI?.refresh(this.world);
      this.equipmentUI?.refresh(this.world);
    }

    private attachProbe(): void {
      const api: UiProbeApi = {
        ready: () => this.built,
        getGameSize: () => ({ width: this.scale.width, height: this.scale.height }),

        openInventory: () => {
          this.closeOverlays();
          if (this.inventoryUI && !this.inventoryUI.isOpen()) {
            this.inventoryUI.toggle(this.world);
          }
          this.inventoryUI?.refresh(this.world);
        },
        closeOverlays: () => this.closeOverlays(),
        isInventoryOpen: () => this.inventoryUI?.isOpen() ?? false,
        getInventoryCellBounds: (index: number) =>
          this.inventoryUI?.getCellScreenBounds(index) ?? null,
        getInventoryCellIndexForItem: (itemId: string) =>
          this.inventoryUI?.getCellIndexForItem(itemId) ?? null,
        isTooltipVisible: () => this.inventoryUI?.isTooltipVisible() ?? false,
        isTooltipPinned: () => this.inventoryUI?.isTooltipPinned() ?? false,

        openEquipment: () => {
          this.closeOverlays();
          if (this.inventoryUI && !this.inventoryUI.isOpen()) {
            this.inventoryUI.toggle(this.world);
          }
          if (this.equipmentUI && !this.equipmentUI.isOpen()) {
            this.equipmentUI.toggle(this.world);
          }
          this.inventoryUI?.refresh(this.world);
          this.equipmentUI?.refresh(this.world);
        },
        openEquipmentOnly: () => {
          this.closeOverlays();
          if (this.equipmentUI && !this.equipmentUI.isOpen()) {
            this.equipmentUI.toggle(this.world);
          }
          this.inventoryUI?.refresh(this.world);
          this.equipmentUI?.refresh(this.world);
        },
        useThemedEquipmentReviewSprites: () => {
          this.game.registry.set(
            GENERATED_SPRITE_REGISTRY_KEY,
            buildProbeSpriteRegistry(PROBE_THEMED_ICON_TEXTURE),
          );
          this.inventoryUI?.refresh(this.world);
          this.equipmentUI?.refresh(this.world);
        },
        useRealGeneratedSprites: async () => {
          const registry = await fetchGeneratedSpriteRegistry();
          this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, registry);
          if (registry.size > 0 && this.load) {
            const queued = preloadGeneratedSprites(this.load, registry);
            if (queued.length > 0) {
              await new Promise<void>((resolve) => {
                this.load.once(Phaser.Loader.Events.COMPLETE, () => resolve());
                this.load.start();
              });
            }
          }
          this.inventoryUI?.refresh(this.world);
          this.equipmentUI?.refresh(this.world);
        },
        isEquipmentOpen: () => this.equipmentUI?.isOpen() ?? false,
        getEquipmentPanelBounds: () =>
          this.equipmentUI?.getPanelScreenBounds() ?? { x: 0, y: 0, width: 0, height: 0 },
        getEquipmentHeaderBounds: () => this.equipmentUI?.getHeaderScreenBounds() ?? null,
        getEquipmentHeaderFrameBounds: () => this.equipmentUI?.getHeaderFrameScreenBounds() ?? null,
        getEquipmentDollBounds: () => this.equipmentUI?.getDollScreenBounds() ?? null,
        getEquipmentSlotBounds: (slotId: EquipmentSlotId) =>
          this.equipmentUI?.getSlotScreenBounds(slotId) ?? null,
        getEquipmentSlotIconBounds: (slotId: EquipmentSlotId) =>
          this.equipmentUI?.getSlotIconScreenBounds(slotId) ?? null,
        getEquipmentEmptySlotCue: (slotId: EquipmentSlotId) =>
          this.equipmentUI?.getEmptySlotCue(slotId) ?? null,
        getEquipmentTooltipBounds: () => this.equipmentUI?.getTooltipScreenBounds() ?? null,
        isEquipmentTooltipVisible: () => this.equipmentUI?.isTooltipVisible() ?? false,
        isEquipmentTooltipTopmost: () => this.equipmentUI?.isTooltipTopmost() ?? false,
        previewEquipmentSlot: (slotId: EquipmentSlotId) => {
          if (!this.equipmentUI || !this.equipmentUI.isOpen()) {
            return false;
          }
          this.equipmentUI.previewSlot(slotId);
          return true;
        },
        selectEquipmentSlot: (slotId: EquipmentSlotId | null) => {
          if (!this.equipmentUI || !this.equipmentUI.isOpen()) {
            return false;
          }
          this.equipmentUI.selectSlot(slotId);
          this.inventoryUI?.refresh(this.world);
          return true;
        },
        getEquipmentSlotFilter: () => this.equipmentUI?.getSelectedSlotFilter() ?? null,
        getInventorySlotFilter: () => this.inventoryUI?.getEquipmentSlotFilter() ?? null,
        getEquipmentBagItemIds: () => this.equipmentUI?.getBagItemIds() ?? [],
        getEquipmentBagCellBounds: (index: number) =>
          this.equipmentUI?.getBagCellScreenBounds(index) ?? null,
        getEquipmentBagColumnBounds: () => this.equipmentUI?.getBagColumnScreenBounds() ?? null,
        scrollEquipmentBag: (rows: number) => {
          this.equipmentUI?.scrollBag(rows);
        },
        getEquipmentBagScrollRow: () => this.equipmentUI?.getBagScrollRow() ?? 0,
        getEquipmentBagMaxScrollRow: () => this.equipmentUI?.getBagMaxScrollRow() ?? 0,
        seedOverflowBag: (count: number) => this.seedOverflowBag(count),
        previewEquipmentBagItem: (itemId: string | null) =>
          this.equipmentUI?.previewBagItem(itemId),
        previewGeneratedEquipmentBagItem: (instanceKey: GeneratedEquipmentInstanceKey | null) =>
          this.equipmentUI?.previewGeneratedBagItem(instanceKey),
        equipFromEquipmentBag: (itemId: string) => this.equipmentUI?.equipBagItem(itemId) ?? false,
        unequipEquipmentSlot: (slotId: EquipmentSlotId) => {
          this.equipmentUI?.unequipSlot(slotId);
        },
        getEquipmentStatsBounds: () => this.equipmentUI?.getStatsColumnScreenBounds() ?? null,
        getEquipmentInspectorBounds: () => this.equipmentUI?.getInspectorScreenBounds() ?? null,
        getEquipmentTextRuns: () => this.equipmentUI?.getTextRuns() ?? [],
        getEquipmentTextRasterMetadata: () => this.equipmentUI?.getTextRasterMetadata() ?? null,
        getEquipmentPreviewTargetSlots: () => this.equipmentUI?.getPreviewTargetSlots() ?? [],
        getEquipmentTargetMarkerBounds: (slotId: EquipmentSlotId) =>
          this.equipmentUI?.getPreviewTargetMarkerScreenBounds(slotId) ?? null,
        getCharisma: () => getEffectiveStats(this.world, this.playerEid).charisma,
        equipCharm: () => {
          const result = equip(this.world, this.playerEid, MERCHANTS_CHARM_DEF);
          if (result.ok) {
            this.equipmentUI?.refresh(this.world);
          }
          return result.ok;
        },
        equipInventoryItem: (itemId: string) => this.equipInventoryItem(itemId),
        seedAllGear: () => this.seedAllGear(),
        addGeneratedChestReplacement: () => this.addGeneratedChestReplacement(),
        getEquippedSlotIds: () => {
          const state = getEquipmentState(this.world, this.playerEid);
          if (!state) return [];
          return SLOT_REGISTRY.map((s) => s.id).filter((id) => state.equipped[id] !== null);
        },

        openMinimapOverlay: () => {
          this.closeOverlays();
          this.minimap?.sync(this.world, this.playerEid);
          if (this.minimap && !this.minimap.isOverlayOpen()) {
            this.minimap.toggle();
          }
        },
        isMinimapOverlayOpen: () => this.minimap?.isOverlayOpen() ?? false,
        getMinimapCloseBounds: () => this.minimap?.getOverlayCloseBounds() ?? null,
        getMinimapDockedBounds: () => this.minimap?.getDockedBounds() ?? null,

        openLevelUp: (points: number) => {
          this.closeOverlays();
          this.levelUpUI?.open({
            level: 2,
            available: points,
            currentStats: emptyCoreStats(),
          });
        },
        isLevelUpOpen: () => this.levelUpUI?.isOpen() ?? false,
        getStatControlBounds: () => this.levelUpUI?.getStatControlBounds() ?? [],
        getDraftAllocation: (stat: PrimaryStatId) =>
          this.levelUpUI?.getDraftAllocations()?.[stat] ?? 0,
        getRemainingPoints: () => this.levelUpUI?.getRemainingPoints() ?? 0,
      };
      probeWindow.__uiProbe = api;
    }

    private installGuiControls(): void {
      const actions = {
        openInventory: () => probeWindow.__uiProbe?.openInventory(),
        openEquipment: () => probeWindow.__uiProbe?.openEquipment(),
        openEquipmentOnly: () => probeWindow.__uiProbe?.openEquipmentOnly(),
        openMinimap: () => probeWindow.__uiProbe?.openMinimapOverlay(),
        openLevelUp: () => probeWindow.__uiProbe?.openLevelUp(3),
        equipCharm: () => probeWindow.__uiProbe?.equipCharm(),
        seedAllGear: () => probeWindow.__uiProbe?.seedAllGear(),
        useRealSprites: () => {
          void probeWindow.__uiProbe?.useRealGeneratedSprites();
        },
        closeOverlays: () => probeWindow.__uiProbe?.closeOverlays(),
      };
      const folder = labGui.addFolder('UI Surfaces');
      folder.add(actions, 'openInventory').name('Open Inventory');
      folder.add(actions, 'openEquipment').name('Open Equipment (Gear)');
      folder.add(actions, 'openEquipmentOnly').name('Open Equipment Only');
      folder.add(actions, 'openMinimap').name('Open Minimap Overlay');
      folder.add(actions, 'openLevelUp').name('Open Level-Up (3 pts)');
      folder.add(actions, 'equipCharm').name('Equip Charm');
      folder.add(actions, 'seedAllGear').name('Seed All Gear');
      folder.add(actions, 'useRealSprites').name('Use Real Sprites');
      folder.add(actions, 'closeOverlays').name('Close Overlays');
    }
  }

  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: gameHost,
    width: GAME.WIDTH,
    height: GAME.HEIGHT,
    autoRound: true,
    roundPixels: true,
    backgroundColor: '#05050a',
    scene: [UiProbeScene],
    // FIT mirrors the shipped game (Phaser.Scale.FIT): the scene keeps its
    // 1280×720 design space (so the probe reports stable design-space hit-rects)
    // while the canvas element is letterbox-scaled to the host. e2e callers
    // convert design coords to CSS pixels via the live canvas bounding rect.
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  };

  const game = new Phaser.Game(config);
  // FIT auto-refits on window resize; refresh on container-only changes (e.g.
  // tests hiding the lab chrome to grow the canvas) so the canvas tracks its host.
  const resizeObserver = new ResizeObserver(() => {
    game.scale.refresh();
  });
  resizeObserver.observe(gameHost);

  return () => {
    resizeObserver.disconnect();
    game.destroy(true);
    hint.remove();
    root.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Meta' as LabCategory,
  name: 'UI Probe Lab',
  description:
    'Automation harness mounting the real InventoryUI, EquipmentUI, HudMinimap, and LevelUpUI over a synthetic safe-room world. Exposes window.__uiProbe for inventory + mobile e2e/visual-regression tests.',
  create: createUiProbeLab,
});
