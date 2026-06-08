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

    logger.info('Preloading sprite sheets', { sheetCount: SHEETS.length });

    for (const sheet of SHEETS) {
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
    // The generated-sprite manifest is fetched in `create` (not `preload`)
    // because Phaser's preload loader auto-starts as soon as `preload`
    // returns, and we need an async hop to read the manifest. Running this
    // pass in `create` lets us queue more loads and trigger a second
    // loader pass before starting MainGameScene.
    void this.loadGeneratedSpritesThenStart();
  }

  private async loadGeneratedSpritesThenStart(): Promise<void> {
    try {
      const registry = await fetchGeneratedSpriteRegistry();
      this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, registry);

      if (registry.size === 0 || !this.load) {
        logger.info('No generated sprites to load; starting main scene');
        this.scene.start(MainGameScene.KEY);
        return;
      }

      const queued = preloadGeneratedSprites(this.load, registry);
      if (queued.length === 0) {
        this.scene.start(MainGameScene.KEY);
        return;
      }

      // Second loader pass for the generated sprites; only start the
      // main scene once the loader signals 'complete'.
      this.load.once(Phaser.Loader.Events.COMPLETE, () => {
        logger.info('Generated sprite loads complete; starting main scene', {
          count: queued.length,
        });
        this.scene.start(MainGameScene.KEY);
      });
      this.load.start();
    } catch (err) {
      logger.warn('Generated sprite load pass errored; starting main scene anyway', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.scene.start(MainGameScene.KEY);
    }
  }
}
