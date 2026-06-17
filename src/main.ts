import Phaser from 'phaser';
import { BootScene, MainGameScene } from './engine/index.js';
import { GAME } from './shared/constants.js';
import {
  createLogger,
  getGlobalLogLevel,
  setGlobalLogLevel,
  type LogLevel,
} from './shared/logger.js';

const logger = createLogger('main');

declare global {
  interface Window {
    crawlerLogs?: {
      setLevel: (level: LogLevel) => void;
      getLevel: () => LogLevel;
    };
  }
}

if (typeof window !== 'undefined') {
  window.crawlerLogs = {
    setLevel: setGlobalLogLevel,
    getLevel: getGlobalLogLevel,
  };
}

logger.info('Game bootstrapped', {
  width: GAME.WIDTH,
  height: GAME.HEIGHT,
  logLevel: getGlobalLogLevel(),
});

async function bootstrapGame(): Promise<void> {
  const { createFloor1MainSceneOptions } = await import('./bootstrap/floor1-main-scene-options.js');
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: 'game-container',
    width: GAME.WIDTH,
    height: GAME.HEIGHT,
    backgroundColor: '#111111',
    pixelArt: true,
    roundPixels: true,
    physics: {
      default: 'arcade',
      arcade: {
        gravity: { x: 0, y: 0 },
        debug: false,
      },
    },
    scene: [BootScene, new MainGameScene(createFloor1MainSceneOptions())],
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  };
  new Phaser.Game(config);
}

void bootstrapGame();
