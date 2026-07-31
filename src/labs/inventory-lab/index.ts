import { addComponent, set } from 'bitecs';
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { BroadcastScore } from '../../core/components.js';
import {
  collisionSystem,
  createGameWorld,
  damageSystem,
  healthSystem,
  itemPickupSystem,
  movementSystem,
  playerInputSystem,
  projectileCleanupSystem,
  spawnDroppedItem,
  spawnPlayer,
  type GameWorld,
} from '../../core/index.js';
import {
  fetchGeneratedSpriteRegistry,
  GENERATED_SPRITE_REGISTRY_KEY,
  preloadGeneratedSprites,
} from '../../engine/generatedAssets/index.js';
import { createInputCapture } from '../../engine/InputCapture.js';
import { createInventoryUI } from '../../engine/InventoryUI.js';
import { createPhaserBridge } from '../../engine/PhaserBridge.js';
import { emptyGeneratedSpriteRegistry } from '../../shared/generated-assets.js';
import { GAME, PLAYER_SPEED } from '../../shared/constants.js';
import { createInputState, type InputState } from '../../shared/input.js';
import { addItem, listStaticInventorySlots } from '../../shared/inventory.js';
import { ITEM_CATALOG } from '../../shared/items.js';
import { ftToPx, pxToFt } from '../../shared/units.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface InventoryLabSettings {
  playerSpeed: number;
  autoSpawnItems: boolean;
  spawnIntervalMs: number;
  spawnRadius: number;
  directAddItem: string;
  directAddQty: number;
}

const LAB_SEED = 7777;
const MAX_STEPS_PER_FRAME = 4;

function createInventoryLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.background = 'radial-gradient(circle at top, #0d1a2b 0%, #070d14 45%, #030508 100%)';

  const gameHost = document.createElement('div');
  gameHost.style.width = '100%';
  gameHost.style.height = '100%';

  const hud = document.createElement('div');
  hud.style.position = 'absolute';
  hud.style.top = '16px';
  hud.style.left = '16px';
  hud.style.padding = '12px 14px';
  hud.style.borderRadius = '12px';
  hud.style.background = 'rgba(10, 15, 30, 0.82)';
  hud.style.border = '1px solid rgba(255, 255, 255, 0.12)';
  hud.style.color = '#f8fafc';
  hud.style.lineHeight = '1.5';
  hud.style.whiteSpace = 'pre-line';
  hud.style.pointerEvents = 'none';

  const hint = document.createElement('p');
  hint.textContent =
    'Move with WASD. Press Tab or I to open inventory. Walk over items to pick them up. Use controls to spawn items.';
  hint.style.marginTop = '16px';
  hint.style.color = '#7ee0ff';
  hint.style.lineHeight = '1.6';

  controls.append(hint);
  root.append(gameHost, hud);
  canvasHost.append(root);

  const settings: InventoryLabSettings = {
    playerSpeed: PLAYER_SPEED,
    autoSpawnItems: true,
    spawnIntervalMs: 2000,
    spawnRadius: 25,
    directAddItem: ITEM_CATALOG[0]?.id ?? 'iron-ore',
    directAddQty: 5,
  };

  let resetWorldFromGui = () => undefined;
  let directAddFromGui = () => undefined;

  class InventoryLabScene extends Phaser.Scene {
    private accumulator = 0;

    private bridge?: ReturnType<typeof createPhaserBridge>;

    private inputCapture?: ReturnType<typeof createInputCapture>;

    private inputState!: InputState;

    private inventoryUI?: ReturnType<typeof createInventoryUI>;

    private lastSpawnMs = 0;

    private playerEid = -1;

    private world!: GameWorld;

    constructor() {
      super({ key: 'InventoryLabScene' });
    }

    create(): void {
      resetWorldFromGui = () => {
        this.resetWorld();
      };

      directAddFromGui = () => {
        this.directAddItem();
      };

      this.inputState = createInputState();
      this.inputCapture = createInputCapture(this, {
        getFollowOrigin: () =>
          this.playerEid < 0
            ? undefined
            : {
                // Camera world-space is pixels; scale the player's feet position.
                x: ftToPx(this.world.stores.position.x[this.playerEid] ?? 0),
                y: ftToPx(this.world.stores.position.y[this.playerEid] ?? 0),
              },
      });
      this.accumulator = 0;

      this.cameras.main.setBackgroundColor('#070d14');
      this.bridge = createPhaserBridge(this);
      this.inventoryUI = createInventoryUI(this);

      // Seed an empty registry so InventoryUI always reads a non-null value,
      // then warm the generated sprites so inventory cells render icons
      // instead of falling back to text labels (mirrors BootScene).
      this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, emptyGeneratedSpriteRegistry());
      void this.warmGeneratedSprites();

      // Toggle inventory on Tab or I
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Tab' || event.key === 'i' || event.key === 'I') {
          event.preventDefault();
          this.inventoryUI?.toggle(this.world);
        }
      };
      this.input.keyboard?.on('keydown', onKeyDown);

      this.resetWorld();

      const handleResize = () => {
        // Noop — UI uses fixed coordinates
      };
      this.scale.on('resize', handleResize);
      this.events.once('shutdown', () => {
        resetWorldFromGui = () => undefined;
        directAddFromGui = () => undefined;
        this.scale.off('resize', handleResize);
        this.input.keyboard?.off('keydown', onKeyDown);
        this.inputCapture?.destroy();
        this.inputCapture = undefined;
        this.inventoryUI?.destroy();
        this.inventoryUI = undefined;
        this.bridge?.destroy();
        this.bridge = undefined;
      });
    }

    update(_time: number, delta: number): void {
      if (!this.bridge || !this.inputCapture) return;

      // Skip game tick if inventory is open
      if (this.inventoryUI?.isOpen()) {
        this.bridge.sync(this.world);
        return;
      }

      if (this.world.state === 'playing') {
        this.inputCapture.poll(this.inputState);
        this.accumulator += delta;
        let steps = 0;

        while (
          this.accumulator >= GAME.DELTA_MS &&
          steps < MAX_STEPS_PER_FRAME &&
          this.world.state === 'playing'
        ) {
          this.world.frameCount += 1;
          this.world.elapsedMs += GAME.DELTA_MS;

          playerInputSystem(this.world, this.inputState);
          this.applyPlayerSpeedSetting();
          movementSystem(this.world);

          const collisions = collisionSystem(this.world);
          damageSystem(this.world, collisions);
          itemPickupSystem(this.world, collisions);
          healthSystem(this.world);
          projectileCleanupSystem(this.world);

          // Auto-spawn items
          if (settings.autoSpawnItems) {
            this.maybeSpawnItem();
          }

          this.accumulator -= GAME.DELTA_MS;
          steps += 1;
        }

        if (this.accumulator > GAME.DELTA_MS * MAX_STEPS_PER_FRAME) {
          this.accumulator = 0;
        }
      }

      this.bridge.sync(this.world);
      this.inventoryUI?.refresh(this.world);
      this.updateHud();
    }

    private async warmGeneratedSprites(): Promise<void> {
      try {
        const registry = await fetchGeneratedSpriteRegistry();
        this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, registry);

        if (registry.size === 0 || !this.load) {
          return;
        }

        const queued = preloadGeneratedSprites(this.load, registry);
        if (queued.length === 0) {
          return;
        }

        this.load.once(Phaser.Loader.Events.COMPLETE, () => {
          this.inventoryUI?.refresh(this.world);
        });
        this.load.start();
      } catch {
        // Non-fatal: cells fall back to text labels if warming fails.
      }
    }

    private applyPlayerSpeedSetting(): void {
      if (this.playerEid < 0) {
        return;
      }

      const scale = PLAYER_SPEED > 0 ? settings.playerSpeed / PLAYER_SPEED : 1;
      const velocityX = (this.world.stores.velocity.x[this.playerEid] ?? 0) * scale;
      const velocityY = (this.world.stores.velocity.y[this.playerEid] ?? 0) * scale;

      this.world.stores.velocity.x[this.playerEid] = velocityX;
      this.world.stores.velocity.y[this.playerEid] = velocityY;
    }

    private directAddItem(): void {
      const bag = this.world.inventories.get(this.playerEid);
      if (!bag) return;
      addItem(bag, settings.directAddItem, settings.directAddQty);
      this.inventoryUI?.refresh(this.world);
    }

    private maybeSpawnItem(): void {
      if (this.world.elapsedMs - this.lastSpawnMs < settings.spawnIntervalMs) return;
      this.lastSpawnMs = this.world.elapsedMs;

      const playerX = this.world.stores.position.x[this.playerEid] ?? 0;
      const playerY = this.world.stores.position.y[this.playerEid] ?? 0;

      const angle = this.world.rng.next() * Math.PI * 2;
      const dist = this.world.rng.next() * settings.spawnRadius + 5;
      const x = playerX + Math.cos(angle) * dist;
      const y = playerY + Math.sin(angle) * dist;

      const itemIndex = Math.floor(this.world.rng.next() * ITEM_CATALOG.length);
      spawnDroppedItem(this.world, x, y, itemIndex);
    }

    private resetWorld(): void {
      this.accumulator = 0;
      this.lastSpawnMs = 0;
      this.world = createGameWorld({ seed: LAB_SEED });

      const w = pxToFt(this.getSimulationWidth());
      const h = pxToFt(this.getSimulationHeight());
      this.playerEid = spawnPlayer(this.world, w / 2, h / 2);
      addComponent(this.world.ecs, this.playerEid, set(BroadcastScore, { current: 0 }));

      // Spawn a handful of starter items nearby
      for (let i = 0; i < 15; i++) {
        const angle = this.world.rng.next() * Math.PI * 2;
        const dist = this.world.rng.next() * 15 + 3.75;
        const x = w / 2 + Math.cos(angle) * dist;
        const y = h / 2 + Math.sin(angle) * dist;
        const itemIndex = Math.floor(this.world.rng.next() * ITEM_CATALOG.length);
        spawnDroppedItem(this.world, x, y, itemIndex);
      }

      this.bridge?.sync(this.world);
      this.inventoryUI?.refresh(this.world);
      this.updateHud();
    }

    private getSimulationWidth(): number {
      return Math.max(1, Math.round(this.scale.width || this.cameras.main.width || GAME.WIDTH));
    }

    private getSimulationHeight(): number {
      return Math.max(1, Math.round(this.scale.height || this.cameras.main.height || GAME.HEIGHT));
    }

    private updateHud(): void {
      const bag = this.world.inventories.get(this.playerEid);
      const staticSlots = bag ? listStaticInventorySlots(bag) : [];
      const totalItems = staticSlots.reduce((sum, slot) => sum + slot.quantity, 0);
      const uniqueItems = staticSlots.length;

      hud.textContent = [
        `Items: ${totalItems} (${uniqueItems} unique)`,
        `Floor: ${this.world.floor}`,
        `Press Tab/I for inventory`,
      ].join('\n');
    }
  }

  // Build item name list for the dropdown
  const itemNames: Record<string, string> = {};
  for (const item of ITEM_CATALOG) {
    itemNames[`${item.name} (${item.rarity})`] = item.id;
  }

  const controlsApi = {
    reset: () => resetWorldFromGui(),
    directAdd: () => directAddFromGui(),
  };

  const spawnFolder = gui.addFolder('Item Spawning');
  spawnFolder.add(settings, 'autoSpawnItems').name('Auto-Spawn');
  spawnFolder.add(settings, 'spawnIntervalMs', 500, 10000, 100).name('Spawn Interval (ms)');
  spawnFolder.add(settings, 'spawnRadius', 6.25, 62.5, 1.25).name('Spawn Radius');

  const directFolder = gui.addFolder('Direct Add to Bag');
  directFolder.add(settings, 'directAddItem', itemNames).name('Item');
  directFolder.add(settings, 'directAddQty', 1, 99, 1).name('Quantity');
  directFolder.add(controlsApi, 'directAdd').name('Add to Inventory');

  gui.add(settings, 'playerSpeed', 0.125, 1.875, 0.0125).name('Player Speed');
  gui.add(controlsApi, 'reset').name('Reset World');

  const getSize = () => ({
    width: Math.max(1, Math.round(gameHost.clientWidth || GAME.WIDTH)),
    height: Math.max(1, Math.round(gameHost.clientHeight || GAME.HEIGHT)),
  });

  const initialSize = getSize();
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: gameHost,
    width: initialSize.width,
    height: initialSize.height,
    autoRound: true,
    roundPixels: true,
    backgroundColor: '#070d14',
    scene: [InventoryLabScene],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  };

  const game = new Phaser.Game(config);
  const resizeObserver = new ResizeObserver(() => {
    const nextSize = getSize();
    game.scale.resize(nextSize.width, nextSize.height);
  });
  resizeObserver.observe(gameHost);

  return () => {
    resizeObserver.disconnect();
    game.destroy(true);
    hint.remove();
    root.remove();
  };
}

registerLab('inventory-lab', {
  category: 'Items & Equipment' as LabCategory,
  name: 'Inventory Lab',
  description:
    'Test the inventory system: auto-pickup, bag management, dynamic tabs, search, sorting, and item tooltips.',
  create: createInventoryLab,
});
