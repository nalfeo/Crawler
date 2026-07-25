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
import { preloadTerrainPacks } from '../sprites/terrain-pack-visuals.js';

const logger = createLogger('engine:boot-scene');
const GENERATED_SPRITE_LOAD_TIMEOUT_MS = 15000;
const CRITICAL_SHEET_KEYS = new Set([
  'kenney-tiny-dungeon',
  'kenney-tiny-town',
  'kenney-roguelike-rpg-pack',
  'custom-pixel-sprites',
]);

export class BootScene extends Phaser.Scene {
  static readonly KEY = 'BootScene';
  private startedMainGame = false;

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

    // Queue all terrain-pack images (wall atlas, floor/corridor pool variants,
    // and door textures) at boot so every pack-backed floor (e.g. Floor 2's
    // `industrial-cave`) has its assets ready before MainGameScene renders.
    preloadTerrainPacks(this.load);

    // Seed an empty registry so consumers (e.g. InventoryUI) always read
    // a non-null value even before the manifest fetch resolves.
    this.game.registry.set(GENERATED_SPRITE_REGISTRY_KEY, emptyGeneratedSpriteRegistry());
  }

  create(): void {
    // Fetch and queue generated sprites, then start the main game scene once
    // the sprites are loaded. This ensures approved custom art is available
    // before MainGameScene renders any entities.
    void this.loadGeneratedSpritesAndStartGame();
  }

  private async loadGeneratedSpritesAndStartGame(): Promise<void> {
    try {
      const registry = await fetchGeneratedSpriteRegistry();
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
    this.scene.start(MainGameScene.KEY);
  }
}
