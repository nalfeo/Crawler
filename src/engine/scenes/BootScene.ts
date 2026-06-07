import Phaser from 'phaser';
import { SHEETS } from '../sprites/index.js';
import { MainGameScene } from './MainGameScene.js';
import { createLogger } from '../../shared/logger.js';

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
  }

  create(): void {
    logger.info('Boot complete; starting main scene');
    this.scene.start(MainGameScene.KEY);
  }
}
