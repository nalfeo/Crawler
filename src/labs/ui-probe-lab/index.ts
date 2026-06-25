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
  getEffectiveStats,
  initializeBaseStats,
} from '../../core/systems/equipmentSystem.js';
import { createInventoryUI } from '../../engine/InventoryUI.js';
import { createEquipmentUI } from '../../engine/EquipmentUI.js';
import { createHudMinimap } from '../../engine/HudMinimap.js';
import { createLevelUpUI } from '../../engine/LevelUpUI.js';
import type { ScreenBounds } from '../../engine/ui-scale.js';
import { GENERATED_SPRITE_REGISTRY_KEY } from '../../engine/generatedAssets/index.js';
import { buildGeneratedSpriteRegistry } from '../../shared/generated-assets.js';
import { MERCHANTS_CHARM_DEF } from '../../shared/equipmentDefs.js';
import { GAME } from '../../shared/constants.js';
import { PIXELS_PER_FOOT } from '../../shared/units.js';
import { addItem } from '../../shared/inventory.js';
import { PRIMARY_STATS, type PrimaryStatId } from '../../shared/stats.js';
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
  isTooltipVisible(): boolean;
  isTooltipPinned(): boolean;

  // Equipment ---------------------------------------------------------------
  openEquipment(): void;
  isEquipmentOpen(): boolean;
  /** Effective Charisma of the player (base + equipment bonuses). */
  getCharisma(): number;
  /** Equip the merchant's charm via the real equipment system (safe-room). */
  equipCharm(): boolean;

  // Minimap -----------------------------------------------------------------
  openMinimapOverlay(): void;
  isMinimapOverlayOpen(): boolean;
  getMinimapCloseBounds(): ScreenBounds | null;

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
  map.visible.fill(1);
  return map;
}

/** Synthetic generated-sprite registry mapping the charm to a baked texture. */
function buildProbeSpriteRegistry(): ReturnType<typeof buildGeneratedSpriteRegistry> {
  return buildGeneratedSpriteRegistry({
    version: 1,
    entries: {
      [MERCHANTS_CHARM_DEF.id]: {
        briefId: MERCHANTS_CHARM_DEF.id,
        spriteName: PROBE_ICON_TEXTURE,
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

    private levelUpUI?: ReturnType<typeof createLevelUpUI>;

    private built = false;

    constructor() {
      super({ key: SCENE_KEY });
    }

    create(): void {
      this.cameras.main.setBackgroundColor('#05050a');

      // Bake the synthetic inventory icon so at least one cell renders a sprite
      // (deterministic, independent of the real generated-sprite manifest).
      if (!this.textures.exists(PROBE_ICON_TEXTURE)) {
        const g = this.add.graphics();
        g.fillStyle(0xff2fd0, 1);
        g.fillRect(0, 0, 16, 16);
        g.fillStyle(0xffffff, 1);
        g.fillRect(5, 5, 6, 6);
        g.generateTexture(PROBE_ICON_TEXTURE, 16, 16);
        g.destroy();
      }
      this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, buildProbeSpriteRegistry());

      // Synthetic safe-room world: equipment changes require a safe context.
      this.world = createGameWorld({ seed: LAB_SEED });
      this.world.floor = 1;
      this.world.state = 'safe_room';
      this.world.floorMap = buildProbeFloorMap();
      this.playerEid = spawnPlayer(this.world, GAME.WIDTH / 2, GAME.HEIGHT / 2);
      initializeBaseStats(this.world, this.playerEid);

      const bag = this.world.inventories.get(this.playerEid);
      if (bag) {
        addItem(bag, MERCHANTS_CHARM_DEF.id, 1);
      }

      this.inventoryUI = createInventoryUI(this);
      this.equipmentUI = createEquipmentUI(this);
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
      if (this.inventoryUI?.isOpen()) {
        this.inventoryUI.refresh(this.world);
      }
      if (this.equipmentUI?.isOpen()) {
        this.equipmentUI.refresh(this.world);
      }
      this.minimap?.sync(this.world, this.playerEid);
    }

    private closeOverlays(): void {
      if (this.inventoryUI?.isOpen()) this.inventoryUI.toggle(this.world);
      if (this.equipmentUI?.isOpen()) this.equipmentUI.toggle(this.world);
      if (this.minimap?.isOverlayOpen()) this.minimap.toggle();
      if (this.levelUpUI?.isOpen()) this.levelUpUI.close();
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
        isTooltipVisible: () => this.inventoryUI?.isTooltipVisible() ?? false,
        isTooltipPinned: () => this.inventoryUI?.isTooltipPinned() ?? false,

        openEquipment: () => {
          this.closeOverlays();
          if (this.equipmentUI && !this.equipmentUI.isOpen()) {
            this.equipmentUI.toggle(this.world);
          }
          this.equipmentUI?.refresh(this.world);
        },
        isEquipmentOpen: () => this.equipmentUI?.isOpen() ?? false,
        getCharisma: () => getEffectiveStats(this.world, this.playerEid).charisma,
        equipCharm: () => {
          const result = equip(this.world, this.playerEid, MERCHANTS_CHARM_DEF);
          if (result.ok) {
            this.equipmentUI?.refresh(this.world);
          }
          return result.ok;
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
        openMinimap: () => probeWindow.__uiProbe?.openMinimapOverlay(),
        openLevelUp: () => probeWindow.__uiProbe?.openLevelUp(3),
        equipCharm: () => probeWindow.__uiProbe?.equipCharm(),
        closeOverlays: () => probeWindow.__uiProbe?.closeOverlays(),
      };
      const folder = labGui.addFolder('UI Surfaces');
      folder.add(actions, 'openInventory').name('Open Inventory');
      folder.add(actions, 'openEquipment').name('Open Equipment (Gear)');
      folder.add(actions, 'openMinimap').name('Open Minimap Overlay');
      folder.add(actions, 'openLevelUp').name('Open Level-Up (3 pts)');
      folder.add(actions, 'equipCharm').name('Equip Charm');
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
