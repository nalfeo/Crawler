import GUI from 'lil-gui';
import Phaser from 'phaser';
import { addComponent, set } from 'bitecs';
import { BroadcastScore } from '../../core/components.js';
import { createGameWorld, spawnPlayer, type GameWorld } from '../../core/index.js';
import {
  getEffectiveStats,
  getEquipmentState,
  initializeBaseStats,
  resolveEquipmentInstance,
} from '../../core/systems/equipmentSystem.js';
import { isInSafeContext } from '../../core/safe-space.js';
import { createEquipmentUI } from '../../engine/EquipmentUI.js';
import {
  fetchGeneratedSpriteRegistry,
  GENERATED_SPRITE_REGISTRY_KEY,
  preloadGeneratedSprites,
} from '../../engine/generatedAssets/index.js';
import { createInventoryUI } from '../../engine/InventoryUI.js';
import { createPhaserBridge } from '../../engine/PhaserBridge.js';
import { GAME } from '../../shared/constants.js';
import { emptyGeneratedSpriteRegistry } from '../../shared/generated-assets.js';
import equipmentDefsTestSeams from '../../shared/equipmentDefs.test-seams.js';
import {
  computeEquippedWeightLb,
  getCarryThresholdLb,
  getEncumbranceBand,
  ENCUMBRANCE_BAND_LABELS,
  ENCUMBRANCE_HEAVY_FACTOR,
} from '../../shared/encumbrance.js';
import {
  addItem,
  createInventoryBag,
  listStaticInventorySlots,
  type InventoryBag,
} from '../../shared/inventory.js';
import { getItemById } from '../../shared/items.js';
import { pxToFt } from '../../shared/units.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface EquipmentLabSettings {
  selectedItemId: string;
  addQuantity: number;
  keepSafeRoomContext: boolean;
}

const LAB_SEED = 42424;
const DEFAULT_EQUIP_LOADOUT: readonly string[] = [
  'merchants-stained-charm',
  'iron-sword',
  'frost-bow',
  'bone-club',
  'plasma-pistol',
];

function createEquipmentLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.background = 'radial-gradient(circle at top, #10213a 0%, #08111f 45%, #04080f 100%)';

  const gameHost = document.createElement('div');
  gameHost.style.width = '100%';
  gameHost.style.height = '100%';

  const hud = document.createElement('div');
  hud.style.position = 'absolute';
  hud.style.top = '16px';
  hud.style.left = '16px';
  hud.style.padding = '12px 14px';
  hud.style.borderRadius = '12px';
  hud.style.background = 'rgba(10, 15, 30, 0.84)';
  hud.style.border = '1px solid rgba(255, 255, 255, 0.14)';
  hud.style.color = '#f8fafc';
  hud.style.lineHeight = '1.5';
  hud.style.whiteSpace = 'pre-line';
  hud.style.pointerEvents = 'none';

  const hint = document.createElement('p');
  hint.textContent =
    'Real UI path: press [G] for Equipment and [I] for Inventory. Select a slot in equipment to filter matching bag gear, then equip through the inventory panel.';
  hint.style.marginTop = '16px';
  hint.style.color = '#7ee0ff';
  hint.style.lineHeight = '1.6';

  controls.append(hint);
  root.append(gameHost, hud);
  canvasHost.append(root);

  const equippableIds = equipmentDefsTestSeams.getCatalogEquippableItemIds();
  const initialItemId = equippableIds[0] ?? 'merchants-stained-charm';
  const settings: EquipmentLabSettings = {
    selectedItemId: initialItemId,
    addQuantity: 1,
    keepSafeRoomContext: true,
  };

  let openInventoryFromGui: () => void = () => {};
  let openEquipmentFromGui: () => void = () => {};
  let addSelectedItemFromGui: () => void = () => {};
  let addDefaultLoadoutFromGui: () => void = () => {};
  let resetWorldFromGui: () => void = () => {};
  let clearBagFromGui: () => void = () => {};
  let syncSafeRoomContextFromGui: () => void = () => {};

  class EquipmentLabScene extends Phaser.Scene {
    private bridge?: ReturnType<typeof createPhaserBridge>;

    private inventoryUI?: ReturnType<typeof createInventoryUI>;

    private equipmentUI?: ReturnType<typeof createEquipmentUI>;

    private playerEid = -1;

    private world!: GameWorld;

    constructor() {
      super({ key: 'EquipmentLabScene' });
    }

    create(): void {
      openInventoryFromGui = () => this.openInventory();
      openEquipmentFromGui = () => this.openEquipment();
      addSelectedItemFromGui = () => this.addSelectedItem();
      addDefaultLoadoutFromGui = () => this.addDefaultLoadout();
      resetWorldFromGui = () => this.resetWorld();
      clearBagFromGui = () => this.clearBag();
      syncSafeRoomContextFromGui = () => this.syncSafeRoomContext();

      this.cameras.main.setBackgroundColor('#07101c');
      this.bridge = createPhaserBridge(this);
      this.inventoryUI = createInventoryUI(this);
      this.equipmentUI = createEquipmentUI(this, {
        onSlotFilterChange: (slotId) => this.inventoryUI?.setEquipmentSlotFilter(slotId),
      });

      this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, emptyGeneratedSpriteRegistry());
      void this.warmGeneratedSprites();

      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'i' || event.key === 'I') {
          event.preventDefault();
          this.openInventory();
          return;
        }
        if (event.key === 'g' || event.key === 'G') {
          event.preventDefault();
          this.openEquipment();
          return;
        }
        if (event.key === 'r' || event.key === 'R') {
          event.preventDefault();
          this.resetWorld();
        }
      };
      this.input.keyboard?.on('keydown', onKeyDown);

      this.resetWorld();

      this.events.once('shutdown', () => {
        openInventoryFromGui = () => undefined;
        openEquipmentFromGui = () => undefined;
        addSelectedItemFromGui = () => undefined;
        addDefaultLoadoutFromGui = () => undefined;
        resetWorldFromGui = () => undefined;
        clearBagFromGui = () => undefined;
        syncSafeRoomContextFromGui = () => undefined;
        this.input.keyboard?.off('keydown', onKeyDown);
        this.inventoryUI?.destroy();
        this.equipmentUI?.destroy();
        this.bridge?.destroy();
        this.inventoryUI = undefined;
        this.equipmentUI = undefined;
        this.bridge = undefined;
      });
    }

    update(): void {
      if (!this.world) return;
      this.bridge?.sync(this.world);
      this.inventoryUI?.refresh(this.world);
      this.equipmentUI?.refresh(this.world);
      this.renderHud();
    }

    private async warmGeneratedSprites(): Promise<void> {
      try {
        const registry = await fetchGeneratedSpriteRegistry();
        this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, registry);
        if (registry.size === 0 || !this.load) return;
        const queued = preloadGeneratedSprites(this.load, registry);
        if (queued.length === 0) return;
        this.load.once(Phaser.Loader.Events.COMPLETE, () => {
          this.inventoryUI?.refresh(this.world);
          this.equipmentUI?.refresh(this.world);
        });
        this.load.start();
      } catch {
        // Non-fatal in labs: text fallback icons still let equipment flow run.
      }
    }

    private resetWorld(): void {
      this.world = createGameWorld({ seed: LAB_SEED });
      this.world.floor = 1;
      this.world.state = settings.keepSafeRoomContext ? 'safe_room' : 'playing';
      this.world.playerInSafeRoom = settings.keepSafeRoomContext;
      this.world.featureUnlocks.inventory = true;
      this.world.featureUnlocks.equipment = true;
      this.world.featureUnlocks.equipmentPanel = true;

      this.playerEid = spawnPlayer(this.world, pxToFt(GAME.WIDTH / 2), pxToFt(GAME.HEIGHT / 2));
      initializeBaseStats(this.world, this.playerEid);
      addComponent(this.world.ecs, this.playerEid, set(BroadcastScore, { current: 0 }));
      this.addDefaultLoadout();
      this.inventoryUI?.refresh(this.world);
      this.equipmentUI?.refresh(this.world);
    }

    private getBag(): InventoryBag | null {
      return this.world.inventories.get(this.playerEid) ?? null;
    }

    private addDefaultLoadout(): void {
      const bag = this.getBag();
      if (!bag) return;
      for (const itemId of DEFAULT_EQUIP_LOADOUT) {
        addItem(bag, itemId, 1);
      }
      addItem(bag, 'iron-ore', 6);
      addItem(bag, 'health-vial', 2);
    }

    private addSelectedItem(): void {
      const bag = this.getBag();
      if (!bag) return;
      addItem(bag, settings.selectedItemId, settings.addQuantity);
      this.inventoryUI?.refresh(this.world);
      this.equipmentUI?.refresh(this.world);
    }

    private clearBag(): void {
      if (!this.world.inventories.has(this.playerEid)) return;
      this.world.inventories.set(this.playerEid, createInventoryBag());
      this.inventoryUI?.refresh(this.world);
      this.equipmentUI?.refresh(this.world);
    }

    private openInventory(): void {
      if (!this.inventoryUI) return;
      this.inventoryUI.toggle(this.world);
      this.inventoryUI.refresh(this.world);
    }

    private openEquipment(): void {
      if (!this.equipmentUI) return;
      this.equipmentUI.toggle(this.world);
      if (this.equipmentUI.isOpen() && this.inventoryUI && !this.inventoryUI.isOpen()) {
        this.inventoryUI.toggle(this.world);
      }
      this.inventoryUI?.refresh(this.world);
      this.equipmentUI.refresh(this.world);
    }

    private syncSafeRoomContext(): void {
      this.world.state = settings.keepSafeRoomContext ? 'safe_room' : 'playing';
      this.world.playerInSafeRoom = settings.keepSafeRoomContext;
      this.inventoryUI?.refresh(this.world);
      this.equipmentUI?.refresh(this.world);
    }

    private renderHud(): void {
      const bag = this.getBag();
      const state = getEquipmentState(this.world, this.playerEid);
      const equippedInstanceIds =
        state == null ? [] : Object.values(state.equipped).filter((inst) => inst !== null);
      const equippedCount = new Set(equippedInstanceIds).size;
      const effective = getEffectiveStats(this.world, this.playerEid);
      const charisma = effective.charisma;
      const slotFilter = this.inventoryUI?.getEquipmentSlotFilter() ?? 'none';

      const gearLb = computeEquippedWeightLb(state, (instanceId) =>
        state ? resolveEquipmentInstance(this.world, state, instanceId) : undefined,
      );
      const str = Math.max(1, Math.floor(effective.strength ?? 1));
      const capLb = getCarryThresholdLb(str);
      const band = getEncumbranceBand(gearLb, str);
      const bandLabel = ENCUMBRANCE_BAND_LABELS[band];
      const gearStr = `${parseFloat(gearLb.toFixed(2))} lb / ${parseFloat((capLb * ENCUMBRANCE_HEAVY_FACTOR).toFixed(2))} lb max (STR ${str})`;

      hud.textContent = [
        `Safe context: ${isInSafeContext(this.world) ? 'yes' : 'no'} (state=${this.world.state})`,
        `Overlays: inventory=${this.inventoryUI?.isOpen() ? 'open' : 'closed'} · equipment=${this.equipmentUI?.isOpen() ? 'open' : 'closed'}`,
        `Inventory slots: ${bag ? listStaticInventorySlots(bag).length : 0} · Equipped items: ${equippedCount}`,
        `Active slot filter: ${slotFilter}`,
        `Effective charisma: ${charisma}`,
        `Gear load: ${gearStr} → ${bandLabel}`,
        'Keys: [I] inventory · [G] equipment · [R] reset',
      ].join('\n');
    }
  }

  const itemChoices = Object.fromEntries(
    equippableIds.map((itemId) => {
      const item = getItemById(itemId);
      return [item ? `${item.name} (${itemId})` : itemId, itemId];
    }),
  );

  const actions = {
    openInventory: () => openInventoryFromGui(),
    openEquipment: () => openEquipmentFromGui(),
    addItem: () => addSelectedItemFromGui(),
    addLoadout: () => addDefaultLoadoutFromGui(),
    clearBag: () => clearBagFromGui(),
    reset: () => resetWorldFromGui(),
  };

  const panel = gui.addFolder('Equipment Lab Controls');
  panel.add(actions, 'openEquipment').name('Open Equipment [G]');
  panel.add(actions, 'openInventory').name('Open Inventory [I]');
  panel.add(settings, 'selectedItemId', itemChoices).name('Bag item');
  panel.add(settings, 'addQuantity', 1, 5, 1).name('Quantity');
  panel.add(actions, 'addItem').name('Add selected item');
  panel.add(actions, 'addLoadout').name('Add default loadout');
  panel.add(actions, 'clearBag').name('Clear bag');
  panel
    .add(settings, 'keepSafeRoomContext')
    .name('Safe-room context')
    .onChange(() => syncSafeRoomContextFromGui());
  panel.add(actions, 'reset').name('Reset world [R]');

  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: gameHost,
    width: GAME.WIDTH,
    height: GAME.HEIGHT,
    autoRound: true,
    roundPixels: true,
    backgroundColor: '#07101c',
    scene: [EquipmentLabScene],
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  };

  const game = new Phaser.Game(config);
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

registerLab('equipment-lab', {
  category: 'Items & Equipment' as LabCategory,
  name: 'Equipment Lab',
  description:
    'Phaser lab using the real EquipmentUI + InventoryUI integration path with slot filtering and safe-context controls.',
  create: createEquipmentLab,
});
