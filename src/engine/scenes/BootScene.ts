import Phaser from 'phaser';
import { SHEETS } from '../sprites/index.js';
import { MainGameScene } from './MainGameScene.js';
import { createLogger } from '../../shared/logger.js';
import {
  fetchGeneratedSpriteRegistry,
  GENERATED_SPRITE_REGISTRY_KEY,
  preloadGeneratedSprites,
} from '../generatedAssets/index.js';
import { emptyGeneratedSpriteRegistry } from '../../shared/generated-assets.js';

const logger = createLogger('engine:boot-scene');
const CRITICAL_SHEET_KEYS = new Set(['kenney-tiny-dungeon', 'custom-pixel-sprites']);

export class BootScene extends Phaser.Scene {
  static readonly KEY = 'BootScene';

  constructor() {
    super({ key: BootScene.KEY });
  }

  preload(): void {
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

    const criticalSheets = SHEETS.filter((sheet) => CRITICAL_SHEET_KEYS.has(sheet.key));
    logger.info('Preloading critical sprite sheets', {
      criticalCount: criticalSheets.length,
      deferredCount: SHEETS.length - criticalSheets.length,
    });

    for (const sheet of criticalSheets) {
      logger.debug('Queueing sprite sheet', { key: sheet.key, path: sheet.path });
      this.load.spritesheet(sheet.key, sheet.path, {
        frameWidth: sheet.frameWidth,
        frameHeight: sheet.frameHeight,
        margin: sheet.margin,
        spacing: sheet.spacing,
      });
    }

    // Seed an empty registry so consumers (e.g. InventoryUI) always read
    // a non-null value even before the manifest fetch resolves.
    this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, emptyGeneratedSpriteRegistry());
  }

  create(): void {
    this.scene.start(MainGameScene.KEY);
    void this.warmGeneratedSprites();
  }

  private async warmGeneratedSprites(): Promise<void> {
    try {
      const registry = await fetchGeneratedSpriteRegistry();
      this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, registry);

      if (registry.size === 0 || !this.load) {
        logger.info('No generated sprites to warm after startup');
        return;
      }

      const queued = preloadGeneratedSprites(this.load, registry);
      if (queued.length === 0) {
        return;
      }

      this.load.once(Phaser.Loader.Events.COMPLETE, () => {
        logger.info('Generated sprite warm load complete', {
          count: queued.length,
        });
      });
      this.load.start();
    } catch (err) {
      logger.warn('Generated sprite warm load errored; continuing with built-in sprites', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
