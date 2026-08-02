import Phaser from 'phaser';
import { SHEETS } from '../sprites/index.js';
import { MainGameScene } from './MainGameScene.js';
import { createLogger } from '../../shared/logger.js';
import {
  fetchGeneratedSpriteRegistry,
  GENERATED_SPRITE_REGISTRY_KEY,
  preloadGeneratedSprites,
} from '../generatedAssets/index.js';
import {
  emptyGeneratedSpriteRegistry,
  type GeneratedSpriteRegistry,
} from '../../shared/generated-assets.js';
import { preloadTerrainPacks } from '../sprites/terrain-pack-visuals.js';

const logger = createLogger('engine:boot-scene');
const GENERATED_SPRITE_LOAD_TIMEOUT_MS = 15000;

/** Mark a named boot stage in the browser performance timeline (no-op in Node). */
function markBoot(label: string): void {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    performance.mark(label);
  }
}

export class BootScene extends Phaser.Scene {
  static readonly KEY = 'BootScene';
  private startedMainGame = false;
  /**
   * Manifest fetch kicked off in preload() so it runs in parallel with sprite
   * sheet loading.  create() awaits this Promise instead of starting a fresh
   * fetch, eliminating the sequential preload→fetch gap.
   */
  private pendingRegistryFetch: Promise<GeneratedSpriteRegistry> | undefined;

  constructor() {
    super({ key: BootScene.KEY });
  }

  preload(): void {
    markBoot('boot:preload-start');
    if (!this.load) {
      logger.warn('Phaser loader unavailable during preload');
      return;
    }

    // Failures are non-fatal: PhaserBridge falls back to procedural
    // textures whenever a Kenney sheet fails to load.
    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      logger.warn('Sprite asset failed to load; falling back to procedural texture', {
        key: file.key,
        url: file.url,
      });
    });

    logger.info('Preloading all sprite sheets', { count: SHEETS.length });

    for (const sheet of SHEETS) {
      logger.debug('Queueing sprite sheet', { key: sheet.key, path: sheet.path });
      this.load.spritesheet(sheet.key, sheet.path, {
        frameWidth: sheet.frameWidth,
        frameHeight: sheet.frameHeight,
        margin: sheet.margin,
        spacing: sheet.spacing,
      });
    }

    // Queue every registered runtime terrain pack's atlas/pool/door textures.
    // Phaser auto-runs the preload() loader before create(), so these are
    // resident before MainGameScene bakes terrain — without this, a floor that
    // wires `terrainPackId` (e.g. Floor 2 → industrial-cave) silently falls
    // through the renderer's `textures.exists()` guard to the legacy path.
    preloadTerrainPacks(this.load);

    // Seed an empty registry so consumers (e.g. InventoryUI) always read
    // a non-null value even before the manifest fetch resolves.
    this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, emptyGeneratedSpriteRegistry());

    // Kick off the manifest fetch immediately so it runs in parallel with the
    // sprite sheet loading above.  create() will await the result.
    this.pendingRegistryFetch = fetchGeneratedSpriteRegistry();
    markBoot('boot:manifest-fetch-start');
  }

  create(): void {
    markBoot('boot:preload-end');
    // Fetch and queue generated sprites, then start the main game scene once
    // the sprites are loaded. This ensures approved custom art is available
    // before MainGameScene renders any entities.
    void this.loadGeneratedSpritesAndStartGame();
  }

  private async loadGeneratedSpritesAndStartGame(): Promise<void> {
    try {
      // Reuse the fetch that was started in preload(); fall back to a fresh
      // call if preload() was skipped (e.g. headless test environments).
      const registry = await (this.pendingRegistryFetch ?? fetchGeneratedSpriteRegistry());
      markBoot('boot:manifest-fetch-end');
      this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, registry);

      if (registry.size === 0 || !this.load) {
        logger.info('No generated sprites to load; starting game now');
        this.startMainGame();
        return;
      }

      const queued = preloadGeneratedSprites(this.load, registry);
      if (queued.length === 0) {
        logger.info('No sprites queued; starting game now');
        this.startMainGame();
        return;
      }

      logger.info('Waiting for generated sprites to load before starting main game', {
        count: queued.length,
      });

      // Wait for all generated sprite loads to complete, then start the game.
      // If the load cycle stalls, continue after a timeout so boot cannot hang.
      markBoot('boot:sprites-load-start');
      await new Promise<void>((resolve) => {
        let settled = false;
        const onComplete = (): void => {
          logger.info('Generated sprites loaded; starting main game scene', {
            count: queued.length,
          });
          finalize();
        };
        const finalize = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          this.load.off(Phaser.Loader.Events.COMPLETE, onComplete);
          clearTimeout(timeoutId);
          resolve();
        };

        this.load.on(Phaser.Loader.Events.COMPLETE, onComplete);
        const timeoutId = setTimeout(() => {
          logger.warn('Generated sprite load timed out; starting game with built-in sprites', {
            count: queued.length,
            timeoutMs: GENERATED_SPRITE_LOAD_TIMEOUT_MS,
          });
          finalize();
        }, GENERATED_SPRITE_LOAD_TIMEOUT_MS);
        this.load.start();
      });
      markBoot('boot:sprites-load-end');
      this.startMainGame();
    } catch (err) {
      logger.warn('Generated sprite load failed; continuing with built-in sprites', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.startMainGame();
    }
  }

  private startMainGame(): void {
    if (this.startedMainGame) {
      return;
    }
    this.startedMainGame = true;
    markBoot('boot:game-start');
    this.scene.start(MainGameScene.KEY);
  }
}
